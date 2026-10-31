import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants, homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { parseArgs } from "./proxy";

type Settings = Record<string, unknown> & { env?: Record<string, unknown> };

function settingsObject(text: string, source: string): Settings {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${source} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must contain a JSON object`);
  const settings = value as Settings;
  if (settings.env !== undefined && (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env))) {
    throw new Error(`${source}: env must be a JSON object`);
  }
  return settings;
}

/** Route a copy of the settings through the proxy; never edit the source file. */
export async function routeSettings(
  args: string[],
  baseUrl: string,
  { overlayPath, overlayOptional = false }: { overlayPath?: string; overlayOptional?: boolean } = {},
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const forwarded: string[] = [];
  let source: string | undefined;
  let index: number | undefined;
  let separator: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      separator = forwarded.length;
      forwarded.push(...args.slice(i));
      break;
    }
    if (arg === "--settings" || arg.startsWith("--settings=")) {
      source = arg === "--settings" ? args[++i] : arg.slice("--settings=".length);
      if (!source || source.startsWith("--")) throw new Error("--settings needs a JSON object or a JSON file path");
      index = forwarded.length;
    } else forwarded.push(arg);
  }
  let settings: Settings = {};
  if (source !== undefined) {
    const inline = source.trimStart().startsWith("{");
    settings = settingsObject(inline ? source : await readFile(source, "utf8"), inline ? "inline --settings" : source);
  } else if (overlayPath) {
    try { settings = settingsObject(await readFile(overlayPath, "utf8"), overlayPath); }
    catch (error) {
      if (!overlayOptional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  settings.env = { ...settings.env, ANTHROPIC_BASE_URL: baseUrl };
  // Keep credentials and large configurations out of the child's command line.
  const directory = await mkdtemp(join(tmpdir(), "AR-Proxy-settings-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify(settings), { flag: "wx", mode: 0o600 });
    forwarded.splice(index ?? separator ?? forwarded.length, 0, "--settings", path);
    return { args: forwarded, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

async function isProxy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__ar_proxy/health`, {
      signal: AbortSignal.timeout(500), redirect: "manual",
    });
    return response.ok && (await response.json()).service === "AR-Proxy";
  } catch { return false; }
}

function openPrivateLog(path: string): number {
  let existing: ReturnType<typeof lstatSync> | undefined;
  try { existing = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`Proxy log must be a regular file, not a link: ${path}`);
  }
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND |
    (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0), 0o600);
  try {
    const actual = fstatSync(fd);
    const current = lstatSync(path);
    if (!actual.isFile() || current.isSymbolicLink() || current.dev !== actual.dev || current.ino !== actual.ino) {
      throw new Error(`Proxy log changed while opening it: ${path}`);
    }
    if (process.platform !== "win32" &&
        (actual.uid !== process.getuid!() || (actual.mode & 0o077) !== 0)) {
      throw new Error(`Proxy log must be owned by you and private (mode 0600): ${path}`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export async function ensureProxy(port: number, args: string[], logPath: string, env: NodeJS.ProcessEnv): Promise<ReturnType<typeof spawn> | undefined> {
  if (await portOpen(port)) {
    if (await isProxy(port)) return;
    throw new Error(`Port ${port} is occupied by another service or an older proxy. Stop it or set AGENTROUTER_RETRY_PORT to a free port.`);
  }
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openPrivateLog(logPath);
  let child: ReturnType<typeof spawn>;
  try {
    // Detach with the process API rather than platform-specific utilities.
    child = spawn(process.execPath, [fileURLToPath(new URL("./proxy.ts", import.meta.url)), ...args], {
      detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env,
    });
  } finally { closeSync(fd); }
  let startError: Error | undefined;
  let exited = false;
  child.once("error", (error) => { startError = error; });
  child.once("exit", () => { exited = true; });
  child.unref();
  try {
    for (let i = 0; i < 40; i++) {
      if (await isProxy(port)) {
        console.error(`claude.ts: retry proxy started on port ${port} (log: ${logPath})`);
        return child;
      }
      if (startError) throw startError;
      if (exited) throw new Error(`Retry proxy exited during startup; see ${logPath}`);
      await Bun.sleep(250);
    }
    throw new Error(`Retry proxy did not become ready; see ${logPath}`);
  } catch (error) {
    child.kill();
    throw error;
  }
}

export async function launchClaude(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (env.AGENTROUTER_RETRY_ACTIVE === "1") throw new Error("Recursive launcher detected. Set AGENTROUTER_RETRY_CLAUDE to the real Claude Code executable.");
  const cli = Bun.which(env.AGENTROUTER_RETRY_CLAUDE || "claude", { PATH: env.PATH });
  if (!cli) throw new Error("Claude Code was not found on PATH. Install it or set AGENTROUTER_RETRY_CLAUDE to its executable path.");
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cli)) {
    throw new Error("Use the native Claude Code executable on Windows, not a .cmd/.bat shim. Set AGENTROUTER_RETRY_CLAUDE to the .exe path.");
  }
  const port = env.AGENTROUTER_RETRY_PORT || "15720";
  const proxyArgs = ["--port", port];
  const flags: Array<[string, string | undefined]> = [
    ["--upstream", env.AGENTROUTER_RETRY_UPSTREAM],
    ["--responses-upstream", env.AGENTROUTER_RETRY_RESPONSES_UPSTREAM],
    ["--big-ctx-tokens", env.AGENTROUTER_RETRY_BIG_CTX_TOKENS],
    ["--big-ctx-concurrency", env.AGENTROUTER_RETRY_BIG_CTX_CONCURRENCY],
    ["--mirror-log", env.AGENTROUTER_RETRY_MIRROR],
  ];
  for (const [flag, value] of flags) {
    if (value !== undefined && value !== "") proxyArgs.push(flag, value);
  }
  const opts = parseArgs(proxyArgs);
  const routed = await routeSettings(argv, `http://127.0.0.1:${opts.port}`, {
    overlayPath: env.AGENTROUTER_RETRY_SETTINGS || join(homedir(), ".claude", "retry-proxy.json"),
    overlayOptional: !env.AGENTROUTER_RETRY_SETTINGS,
  });
  const logPath = env.AGENTROUTER_RETRY_LOG || join(tmpdir(), `AR-Proxy-${opts.port}.log`);
  try {
    await ensureProxy(opts.port, proxyArgs, logPath, env);
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(cli, routed.args, { stdio: "inherit", env: { ...env, AGENTROUTER_RETRY_ACTIVE: "1" } });
      let receivedSignal: NodeJS.Signals | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const signalCode = (signal: NodeJS.Signals | null) => signal ? 128 + (constants.signals[signal] ?? 0) : 1;
      const forward = (signal: NodeJS.Signals) => {
        receivedSignal = signal;
        child.kill(signal);
        // Give the CLI time to clean up, but do not wait forever on cancellation.
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
      };
      // The CLI owns terminal interrupts, including whether to stay open.
      const interrupt = () => { if (!process.stdin.isTTY) forward("SIGINT"); };
      const terminate = () => forward("SIGTERM");
      const cleanup = () => {
        clearTimeout(killTimer);
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
      };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      child.once("error", (error) => { cleanup(); reject(error); });
      child.once("exit", (code, signal) => {
        cleanup();
        resolve(receivedSignal ? signalCode(receivedSignal) : code ?? signalCode(signal));
      });
    });
  } finally {
    await routed.cleanup();
  }
}

if (import.meta.main) {
  try { process.exitCode = await launchClaude(process.argv.slice(2)); }
  catch (error) {
    console.error(`claude.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
