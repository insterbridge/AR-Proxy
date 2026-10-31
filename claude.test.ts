import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureProxy, launchClaude, routeSettings as createRouteSettings } from "./claude";
import { createProxyServer } from "./proxy";

const cleanups: Array<() => Promise<void>> = [];
const directories: string[] = [];
const servers: Array<{ stop(force?: boolean): unknown }> = [];
const detached: ChildProcess[] = [];
const cliPids: number[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "ar-proxy-launcher-"));
  directories.push(path);
  return path;
}

async function routeSettings(...args: Parameters<typeof createRouteSettings>) {
  const routed = await createRouteSettings(...args);
  cleanups.push(routed.cleanup);
  return routed.args;
}

async function routed(args: string[]) {
  return JSON.parse(await readFile(args[args.indexOf("--settings") + 1], "utf8"));
}

function fixtureServer() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
  servers.push(server);
  return server;
}

async function launcherFixture(port: number, upstream: string) {
  const path = await directory();
  const executable = join(path, "fake cli.ts");
  const capture = join(path, "captured args.json");
  const overlay = join(path, "settings input.json");
  await writeFile(executable, `
    const args = process.argv.slice(2);
    const settingsPath = args[args.indexOf("--settings") + 1];
    const settings = await Bun.file(settingsPath).json();
    const { stat } = await import("node:fs/promises");
    await Bun.write(process.env.CAPTURE_PATH!, JSON.stringify({ args, settings, settingsPath, mode: (await stat(settingsPath)).mode & 0o777 }));
    process.exitCode = Number(process.env.FAKE_EXIT || "0");
  `);
  await writeFile(overlay, JSON.stringify({ env: { KEEP: "value", ANTHROPIC_BASE_URL: "https://before.example.invalid" }, permissions: { allow: [] } }));
  const env = {
    ...process.env,
    AGENTROUTER_RETRY_ACTIVE: "",
    AGENTROUTER_RETRY_CLAUDE: process.execPath,
    AGENTROUTER_RETRY_PORT: String(port),
    AGENTROUTER_RETRY_UPSTREAM: upstream,
    AGENTROUTER_RETRY_SETTINGS: overlay,
    AGENTROUTER_RETRY_LOG: join(path, "logs", "proxy.log"),
    AGENTROUTER_RETRY_MIRROR: "",
    AGENTROUTER_RETRY_RESPONSES_UPSTREAM: "",
    AGENTROUTER_RETRY_BIG_CTX_TOKENS: "60000",
    AGENTROUTER_RETRY_BIG_CTX_CONCURRENCY: "1",
    CAPTURE_PATH: capture,
    TMPDIR: path, TEMP: path, TMP: path,
  };
  return { path, executable, capture, overlay, env };
}

async function runWrapper(fixture: Awaited<ReturnType<typeof launcherFixture>>, args: string[] = []) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./claude.ts", import.meta.url)), fixture.executable, ...args], {
    env: fixture.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill(); } catch { /* It may have exited already. */ }
    await child.exited;
  }
  for (const pid of cliPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* The CLI should already have exited. */ }
  }
  for (const child of detached.splice(0)) child.kill();
  for (const server of servers.splice(0)) server.stop(true);
  await Bun.sleep(20);
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("settings routing", () => {
  test("creates a private overlay when no settings file is supplied", async () => {
    const args = await routeSettings(["--verbose", "prompt"], "http://127.0.0.1:12345");
    expect(args.slice(0, 2)).toEqual(["--verbose", "prompt"]);
    expect(await routed(args)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:12345" } });
  });

  test("preserves other settings and accepts whitespace before inline JSON", async () => {
    const args = await routeSettings(["--settings", '  {"env":{"KEEP":"value"},"permissions":{"allow":[]}}', "--verbose"], "http://127.0.0.1:12345");
    expect(await routed(args)).toEqual({ env: { KEEP: "value", ANTHROPIC_BASE_URL: "http://127.0.0.1:12345" }, permissions: { allow: [] } });
    expect(args.at(-1)).toBe("--verbose");
  });

  test("reads a settings file without modifying it", async () => {
    const path = join(await directory(), "settings with spaces.json");
    const original = '{ "env": { "KEEP": "value" } }\n';
    await writeFile(path, original);
    const args = await routeSettings([`--settings=${path}`], "http://127.0.0.1:12345");
    expect((await routed(args)).env.KEEP).toBe("value");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(args).not.toContain(path);
  });

  test("uses the last settings value once", async () => {
    const args = await routeSettings(["--settings", '{"env":{"VALUE":"first"}}', "--verbose", '--settings={"env":{"VALUE":"last"}}'], "http://127.0.0.1:12345");
    expect(args.filter((arg) => arg === "--settings")).toHaveLength(1);
    expect((await routed(args)).env.VALUE).toBe("last");
    expect(args[0]).toBe("--verbose");
  });

  test("does not interpret arguments after -- as settings flags", async () => {
    const args = await routeSettings(["--", "--settings", "prompt text"], "http://127.0.0.1:12345");
    expect(args.slice(2)).toEqual(["--", "--settings", "prompt text"]);
    expect((await routed(args)).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:12345");
  });

  test("reads an optional overlay, but does not require one", async () => {
    const path = join(await directory(), "overlay.json");
    const missing = await routeSettings([], "http://127.0.0.1:12345", { overlayPath: path, overlayOptional: true });
    expect((await routed(missing)).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:12345");
    await writeFile(path, '{"env":{"KEEP":"value"}}');
    const existing = await routeSettings([], "http://127.0.0.1:12345", { overlayPath: path });
    expect((await routed(existing)).env.KEEP).toBe("value");
    expect(await readFile(path, "utf8")).toBe('{"env":{"KEEP":"value"}}');
  });

  test("a configured overlay path must exist", async () => {
    await expect(routeSettings([], "http://127.0.0.1:12345", { overlayPath: join(await directory(), "missing.json") })).rejects.toThrow();
  });

  test.each([
    ["--settings"], ["--settings="], ["--settings", "{bad json}"],
    ["--settings", '{"env":null}'], ["--settings", '{"env":[]}'], ["--settings", '{"env":"invalid"}'],
  ])("fails clearly on invalid settings %j", async (...args) => {
    await expect(routeSettings(args, "http://127.0.0.1:12345")).rejects.toThrow();
  });
});

describe("launcher", () => {
  test("requires an executable before starting a proxy", async () => {
    await expect(launchClaude([], { AGENTROUTER_RETRY_CLAUDE: join(await directory(), "missing-executable") })).rejects.toThrow("not found");
  });

  test("validates environment options before starting anything", async () => {
    await expect(launchClaude([], { AGENTROUTER_RETRY_CLAUDE: process.execPath, AGENTROUTER_RETRY_PORT: "1.5" })).rejects.toThrow("integer");
    await expect(launchClaude([], { AGENTROUTER_RETRY_ACTIVE: "1" })).rejects.toThrow("Recursive launcher");
  });

  test("reuses a proxy and routes through the configured port without editing settings", async () => {
    const upstream = fixtureServer();
    const proxy = createProxyServer({ port: 0, upstream: upstream.url.toString() }, () => {});
    servers.push(proxy);
    const fixture = await launcherFixture(proxy.port!, upstream.url.toString());
    const original = await readFile(fixture.overlay, "utf8");
    const result = await runWrapper(fixture, ["--verbose"]);
    expect(result.code).toBe(0);
    const captured = JSON.parse(await readFile(fixture.capture, "utf8"));
    const args = captured.args;
    expect(captured.settings.env).toEqual({ KEEP: "value", ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}` });
    expect(args).toContain("--verbose");
    expect(await readFile(fixture.overlay, "utf8")).toBe(original);
  });

  test("routes explicit file and inline settings and preserves the CLI exit code", async () => {
    const upstream = fixtureServer();
    const proxy = createProxyServer({ port: 0, upstream: upstream.url.toString() }, () => {});
    servers.push(proxy);
    const fixture = await launcherFixture(proxy.port!, upstream.url.toString());
    const file = await runWrapper(fixture, ["--settings", fixture.overlay]);
    expect(file.code).toBe(0);
    expect(JSON.parse(await readFile(fixture.capture, "utf8")).settings.env.KEEP).toBe("value");
    Object.assign(fixture.env, { FAKE_EXIT: "7" });
    const inline = await runWrapper(fixture, ['--settings={"env":{"INLINE":"yes"}}']);
    expect(inline.code).toBe(7);
    expect(JSON.parse(await readFile(fixture.capture, "utf8")).settings.env.INLINE).toBe("yes");
  });

  test("refuses an occupied port that does not identify as this proxy", async () => {
    const other = fixtureServer();
    const fixture = await launcherFixture(other.port!, other.url.toString());
    const result = await runWrapper(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("occupied by another service or an older proxy");
    expect(await Bun.file(fixture.capture).exists()).toBe(false);
  });

  test.skipIf(process.platform === "win32")("forwards SIGTERM to the CLI instead of leaving it running", async () => {
    const upstream = fixtureServer();
    const proxy = createProxyServer({ port: 0, upstream: upstream.url.toString() }, () => {});
    servers.push(proxy);
    const fixture = await launcherFixture(proxy.port!, upstream.url.toString());
    const signalPath = join(fixture.path, "received signal.txt");
    await writeFile(fixture.executable, `
      process.on("SIGTERM", async () => {
        await Bun.write(process.env.SIGNAL_PATH!, "SIGTERM");
        process.exit(0);
      });
      await Bun.write(process.env.CAPTURE_PATH!, JSON.stringify({ pid: process.pid }));
      setInterval(() => {}, 1000);
    `);
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./claude.ts", import.meta.url)), fixture.executable], {
      env: { ...fixture.env, SIGNAL_PATH: signalPath }, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    children.push(child);
    let pid: number | undefined;
    for (let i = 0; i < 200; i++) {
      try { pid = JSON.parse(await readFile(fixture.capture, "utf8")).pid; } catch { /* Wait for startup. */ }
      if (pid) break;
      await Bun.sleep(10);
    }
    expect(pid).toBeDefined();
    if (pid) cliPids.push(pid);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await readFile(signalPath, "utf8")).toBe("SIGTERM");
    let alive = false;
    try { process.kill(pid!, 0); alive = true; } catch { /* Reaped by the launcher. */ }
    expect(alive).toBe(false);
  }, 15000);

  test("starts a detached proxy using a portable log path and keeps it alive after the CLI exits", async () => {
    const reservation = fixtureServer();
    const port = reservation.port!;
    reservation.stop(true);
    const upstream = fixtureServer();
    const fixture = await launcherFixture(port, upstream.url.toString());
    const child = await ensureProxy(port, ["--port", String(port), "--upstream", upstream.url.toString()], fixture.env.AGENTROUTER_RETRY_LOG, fixture.env);
    expect(child).toBeDefined();
    if (child) detached.push(child);
    const result = await runWrapper(fixture);
    expect(result.code).toBe(0);
    const health = await (await fetch(`http://127.0.0.1:${port}/__ar_proxy/health`)).json();
    expect(health.pid).toBe(child!.pid);
    expect(await readFile(fixture.env.AGENTROUTER_RETRY_LOG, "utf8")).toContain("listening on");
  });
});

describe("review regressions", () => {
  test("routes large secret-bearing settings through a private file and removes it", async () => {
    const upstream = fixtureServer();
    const proxy = createProxyServer({ port: 0, upstream: upstream.url.toString() }, () => {});
    servers.push(proxy);
    const fixture = await launcherFixture(proxy.port!, upstream.url.toString());
    const settings = { env: { ANTHROPIC_API_KEY: "fixture-not-a-real-key" }, permissions: { allow: Array.from({ length: 7000 }, (_, i) => `Read(/fixture/path-${i}/**)`) } };
    const original = JSON.stringify(settings);
    await writeFile(fixture.overlay, original, { mode: 0o600 });
    const result = await runWrapper(fixture, ["--settings", fixture.overlay]);
    expect(result.code).toBe(0);
    const captured = JSON.parse(await readFile(fixture.capture, "utf8"));
    expect(captured.settings.env.ANTHROPIC_API_KEY).toBe("fixture-not-a-real-key");
    expect(captured.settings.permissions.allow).toHaveLength(7000);
    expect(captured.args.join(" ")).not.toContain("fixture-not-a-real-key");
    expect(captured.args.join(" ").length).toBeLessThan(1000);
    if (process.platform !== "win32") expect(captured.mode).toBe(0o600);
    expect(await Bun.file(captured.settingsPath).exists()).toBe(false);
    expect((await readdir(fixture.path)).filter((name) => name.startsWith("AR-Proxy-settings-"))).toEqual([]);
    expect(await readFile(fixture.overlay, "utf8")).toBe(original);
  });

  test("removes the private settings copy if proxy startup fails", async () => {
    const other = fixtureServer();
    const fixture = await launcherFixture(other.port!, other.url.toString());
    const result = await runWrapper(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("occupied");
    expect((await readdir(fixture.path)).filter((name) => name.startsWith("AR-Proxy-settings-"))).toEqual([]);
  });

  test("settings cleanup is idempotent", async () => {
    const route = await createRouteSettings([], "http://127.0.0.1:12345");
    cleanups.push(route.cleanup);
    const path = route.args[route.args.indexOf("--settings") + 1];
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await route.cleanup();
    await route.cleanup();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test.skipIf(process.platform === "win32")("refuses a symlink log before starting a proxy", async () => {
    const reservation = fixtureServer();
    const port = reservation.port!;
    reservation.stop(true);
    const path = await directory();
    const target = join(path, "owned target.txt");
    const link = join(path, "proxy.log");
    await writeFile(target, "unchanged", { mode: 0o600 });
    await symlink(target, link);
    await expect(ensureProxy(port, ["--port", String(port)], link, process.env)).rejects.toThrow("not a link");
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });

  test.skipIf(process.platform === "win32")("refuses existing logs with public permissions", async () => {
    const reservation = fixtureServer();
    const port = reservation.port!;
    reservation.stop(true);
    const log = join(await directory(), "public.log");
    await writeFile(log, "unchanged");
    await chmod(log, 0o644);
    await expect(ensureProxy(port, ["--port", String(port)], log, process.env)).rejects.toThrow("mode 0600");
    expect(await readFile(log, "utf8")).toBe("unchanged");
  });

  test.skipIf(process.platform === "win32")("delivers a foreground-group interrupt to the CLI only once", async () => {
    const upstream = fixtureServer();
    const proxy = createProxyServer({ port: 0, upstream: upstream.url.toString() }, () => {});
    servers.push(proxy);
    const fixture = await launcherFixture(proxy.port!, upstream.url.toString());
    const signals = join(fixture.path, "interrupts.txt");
    await writeFile(fixture.executable, `
      import { appendFileSync } from "node:fs";
      let count = 0;
      process.on("SIGINT", () => {
        appendFileSync(process.env.SIGNAL_PATH!, "SIGINT\\n");
        if (++count > 1) process.exit(99);
        setTimeout(() => process.exit(0), 100);
      });
      await Bun.write(process.env.CAPTURE_PATH!, JSON.stringify({ pid: process.pid }));
      setInterval(() => {}, 1000);
    `);
    const shim = join(fixture.path, "terminal launcher.ts");
    await writeFile(shim, `
      import { launchClaude } from ${JSON.stringify(fileURLToPath(new URL("./claude.ts", import.meta.url)))};
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      process.exitCode = await launchClaude(process.argv.slice(2));
    `);
    // Own the whole group so the test never signals the user's terminal/session.
    const child = spawn(process.execPath, [shim, fixture.executable], {
      detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...fixture.env, SIGNAL_PATH: signals },
    });
    detached.push(child);
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    let pid: number | undefined;
    for (let i = 0; i < 200; i++) {
      try { pid = JSON.parse(await readFile(fixture.capture, "utf8")).pid; } catch { /* Wait for handlers to be installed. */ }
      if (pid) break;
      await Bun.sleep(10);
    }
    expect(pid).toBeDefined();
    if (pid) cliPids.push(pid);
    process.kill(-child.pid!, "SIGINT");
    expect(await exited).toBe(0);
    expect(await readFile(signals, "utf8")).toBe("SIGINT\n");
    expect((await readdir(fixture.path)).filter((name) => name.startsWith("AR-Proxy-settings-"))).toEqual([]);
  }, 15_000);
});
