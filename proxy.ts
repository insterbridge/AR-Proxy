import { appendFile } from "node:fs/promises";

/**
 * A local retry proxy for AgentRouter and compatible HTTP upstreams.
 * Large requests share a gate; smaller requests can run in parallel.
 */
export type Options = {
  listen: string;
  port: number;
  upstream: string;
  responsesUpstream: string | null;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  deadlineMs: number;
  upstreamTimeoutMs: number;
  keepaliveMs: number;
  retryStatuses: number[];
  bigCtxTokens: number;
  bigCtxConcurrency: number;
  mirrorLog: string | null;
  inspectSse: boolean;
};

const DEFAULT_OPTIONS: Options = {
  listen: "127.0.0.1",
  port: 15720,
  upstream: "http://127.0.0.1:15721",
  responsesUpstream: null,
  maxAttempts: 8,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  deadlineMs: 300_000,
  upstreamTimeoutMs: 600_000,
  keepaliveMs: 10_000,
  retryStatuses: [422, 429],
  bigCtxTokens: 60_000,
  bigCtxConcurrency: 1,
  mirrorLog: null,
  inspectSse: true,
};

const HELP = `AR-Proxy

Usage: bun proxy.ts [options]

Options:
  --port <n>                  listen port                     (default 15720)
  --listen <addr>             listen address                  (default 127.0.0.1)
  --upstream <url>            upstream base URL               (default http://127.0.0.1:15721)
  --responses-upstream <url>  separate upstream for /v1/responses and its subpaths
  --max-attempts <n>          total tries, including recovery (default 8)
  --base-delay <ms>           initial backoff delay           (default 2000)
  --max-delay <ms>            backoff ceiling, after jitter   (default 30000)
  --deadline <ms>             queue and retry budget          (default 300000)
  --upstream-timeout <ms>     timeout for each upstream call  (default 600000)
  --keepalive <ms>            keepalive gap during retries    (default 10000, 0 disables)
  --retry-status <list>       HTTP error statuses to inspect  (default 422,429)
  --big-ctx-tokens <n>        gate requests at this estimate  (default 60000, 0 disables)
  --big-ctx-concurrency <n>   concurrent large requests       (default 1)
  --mirror-log <path>         also append cc-switch-style log lines to this file
  --inspect-sse               inspect early HTTP 200 SSE errors (default on)
  --no-inspect-sse            forward HTTP 200 SSE without inspection
  -h, --help                  show this help
`;

function validateOptions(opts: Options, allowEphemeralPort = false): void {
  const integers: Array<[string, number, number, number]> = [
    ["--port", opts.port, allowEphemeralPort ? 0 : 1, 65535],
    ["--max-attempts", opts.maxAttempts, 1, Number.MAX_SAFE_INTEGER],
    ["--base-delay", opts.baseDelayMs, 1, 2_147_483_647],
    ["--max-delay", opts.maxDelayMs, 1, 2_147_483_647],
    ["--deadline", opts.deadlineMs, 1, 2_147_483_647],
    ["--upstream-timeout", opts.upstreamTimeoutMs, 1, 2_147_483_647],
    ["--keepalive", opts.keepaliveMs, 0, 2_147_483_647],
    ["--big-ctx-tokens", opts.bigCtxTokens, 0, Number.MAX_SAFE_INTEGER],
    ["--big-ctx-concurrency", opts.bigCtxConcurrency, 1, Number.MAX_SAFE_INTEGER],
  ];
  for (const [flag, value, min, max] of integers) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${flag} needs an integer between ${min} and ${max}, got ${value}`);
    }
  }
  for (const [flag, value] of [["--upstream", opts.upstream], ["--responses-upstream", opts.responsesUpstream]]) {
    if (value === null) continue;
    let url: URL;
    try {
      url = new URL(value!);
    } catch {
      throw new Error(`${flag} needs an absolute HTTP or HTTPS URL`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${flag} needs an HTTP or HTTPS URL without credentials, a query, or a fragment`);
    }
  }
  if (!opts.listen.trim()) throw new Error("--listen needs an address");
  if (!opts.retryStatuses.length || opts.retryStatuses.some((n) => !Number.isInteger(n) || n < 400 || n > 599)) {
    throw new Error("--retry-status needs a comma-separated list of HTTP error statuses (400–599)");
  }
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { ...DEFAULT_OPTIONS, retryStatuses: [...DEFAULT_OPTIONS.retryStatuses] };
  const numeric: Record<string, (n: number) => void> = {
    "--port": (n) => (opts.port = n),
    "--max-attempts": (n) => (opts.maxAttempts = n),
    "--base-delay": (n) => (opts.baseDelayMs = n),
    "--max-delay": (n) => (opts.maxDelayMs = n),
    "--deadline": (n) => (opts.deadlineMs = n),
    "--upstream-timeout": (n) => (opts.upstreamTimeoutMs = n),
    "--keepalive": (n) => (opts.keepaliveMs = n),
    "--big-ctx-tokens": (n) => (opts.bigCtxTokens = n),
    "--big-ctx-concurrency": (n) => (opts.bigCtxConcurrency = n),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const setNumeric = Object.hasOwn(numeric, flag) ? numeric[flag] : undefined;
    if (setNumeric) {
      if (value === undefined || !value.trim()) throw new Error(`${flag} needs a number`);
      setNumeric(Number(value));
      i++;
    } else if (["--listen", "--upstream", "--responses-upstream", "--mirror-log", "--retry-status"].includes(flag)) {
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      if (flag === "--listen") opts.listen = value;
      else if (flag === "--upstream") opts.upstream = value.replace(/\/+$/, "");
      else if (flag === "--responses-upstream") opts.responsesUpstream = value.replace(/\/+$/, "");
      else if (flag === "--mirror-log") opts.mirrorLog = value;
      else opts.retryStatuses = [...new Set(value.split(",").map((s) => Number(s.trim())))];
      i++;
    } else if (flag === "--inspect-sse" || flag === "--no-inspect-sse") {
      opts.inspectSse = flag === "--inspect-sse";
    } else {
      throw new Error(`unknown option ${flag} (try --help)`);
    }
  }
  validateOptions(opts);
  return opts;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const STALE_REASONING_SIGNALS = [
  "created under a different",
  "different azure openai resource",
  "different openai resource",
  "same resource that created the item",
];
// cc-switch uses these prefixes to carry Responses reasoning through Messages.
const REASONING_SIGNATURE_PREFIXES = ["ccswitch-openai-reasoning-v1:", "ccswitch-openai-reasoning-"];
const RATE_LIMIT_SIGNALS = [
  "too_many_requests", "rate limit", "rate_limit", "ratelimit", "token rate",
  "exceeded token", "quota exceeded", "overloaded", "failed before output",
  "experiencing high demand", "exceeds the maximum usage size", "upstream service unavailable",
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PING_FRAME = encoder.encode('event: ping\ndata: {"type":"ping"}\n\n');
const KEEPALIVE_COMMENT = encoder.encode(": keepalive\n\n");

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function shortBody(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

function hasRateLimitSignal(body: string): boolean {
  const lowered = body.toLowerCase();
  return RATE_LIMIT_SIGNALS.some((signal) => lowered.includes(signal));
}

function isInvalidRequest(body: string): boolean {
  const lowered = body.toLowerCase();
  return lowered.includes("invalid_request_error") || lowered.includes("rejected the request as invalid");
}

function isResponsesPath(path: string): boolean {
  const pathname = path.split("?", 1)[0];
  return pathname === "/v1/responses" || pathname.startsWith("/v1/responses/");
}

function copyHeaders(incoming: Headers, head = false): Headers {
  const headers = new Headers(incoming);
  // Connection can name additional headers that apply only to this hop.
  for (const name of (incoming.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of HOP_BY_HOP) {
    if (name !== "content-length" || !head) headers.delete(name);
  }
  return headers;
}

function decodeResponse(upstream: Response, method: string): Response {
  if (method === "HEAD" || !upstream.body) return upstream;
  const coding = upstream.headers.get("content-encoding");
  if (!coding) return upstream;
  const formats: Record<string, string> = {
    gzip: "gzip", "x-gzip": "gzip", deflate: "deflate", br: "brotli", zstd: "zstd",
  };
  const codings = coding.toLowerCase().split(",").map((value) => value.trim());
  if (codings.some((value) => value !== "identity" && !Object.hasOwn(formats, value))) return upstream;
  const transforms: DecompressionStream[] = [];
  try {
    for (const value of codings.reverse()) {
      if (value !== "identity") transforms.push(new DecompressionStream(formats[value] as CompressionFormat));
    }
  } catch {
    // Keep unknown or unsupported encodings intact for the client to decode.
    return upstream;
  }
  let body = upstream.body;
  for (const transform of transforms) body = body.pipeThrough(transform);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function passthrough(upstream: Response, method: string): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyHeaders(upstream.headers, method === "HEAD"),
  });
}

function rebuildStream(response: Response, head: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength) controller.enqueue(head);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: copyHeaders(response.headers) });
}

function sseFrames(text: string): Array<{ event: string; data: string }> {
  const frames = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n\n");
  const result: Array<{ event: string; data: string }> = [];
  for (const frame of frames.slice(0, -1)) {
    let event = "";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length) continue;
    const payload = data.join("\n");
    if (!event) {
      try {
        const parsed = JSON.parse(payload);
        event = typeof parsed?.type === "string" ? parsed.type : "";
      } catch { /* Unknown data is output, not a safe-to-replay preamble. */ }
    }
    result.push({ event, data: payload });
  }
  return result;
}

/** Decide from complete SSE frames, in wire order. Never replay after output. */
function prefixDecision(text: string): "retry" | "pass" | null {
  for (const { event, data } of sseFrames(text)) {
    if (["response.created", "response.queued", "response.in_progress", "message_start", "ping"].includes(event)) continue;
    if (event === "error" || event === "response.failed") {
      return hasRateLimitSignal(data) && !isInvalidRequest(data) ? "retry" : "pass";
    }
    return "pass";
  }
  return null;
}

type Inspection =
  | { retryable: true; text: string }
  | { retryable: false; head: Uint8Array; reader: ReadableStreamDefaultReader<Uint8Array> };

/** Inspect at most 64 KiB, retaining the original bytes for pass-through. */
async function inspectSsePrefix(response: Response): Promise<Inspection | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  const textDecoder = new TextDecoder();
  const maxPrefix = 64 * 1024;
  let text = "";
  let total = 0;
  try {
    while (total < maxPrefix) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      text += textDecoder.decode(value.subarray(0, maxPrefix - total), { stream: true });
      total += value.byteLength;
      const decision = prefixDecision(text);
      if (decision === "retry") {
        await reader.cancel().catch(() => {});
        return { retryable: true, text };
      }
      if (decision === "pass") break;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const head = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { retryable: false, head, reader };
}

type StripResult = { body: string; removedBlocks: number; removedSignatures: number };

/** Drop only cc-switch reasoning carriers; leave text and tool blocks intact. */
function stripStaleReasoning(body: Uint8Array | undefined): StripResult | null {
  if (!body) return null;
  let parsed: { messages?: unknown };
  let lossless = true;
  const rawJSON = (JSON as typeof JSON & { rawJSON?: (text: string) => unknown }).rawJSON;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body),
      (_key, value, context?: { source?: string }) => {
        if (typeof value !== "number") return value;
        // Preserve numeric source tokens, including identifiers above 2^53.
        if (rawJSON && context?.source) return rawJSON(context.source);
        lossless = false;
        return value;
      });
  } catch {
    return null;
  }
  if (!lossless || !Array.isArray(parsed?.messages)) return null;
  let removedBlocks = 0;
  let removedSignatures = 0;
  const isCarrier = (value: unknown) => typeof value === "string" &&
    REASONING_SIGNATURE_PREFIXES.some((prefix) => value.startsWith(prefix));
  for (const message of parsed.messages) {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) continue;
    message.content = message.content.filter((block: unknown) => {
      if (!block || typeof block !== "object") return true;
      const item = block as { type?: string; signature?: unknown; data?: unknown };
      if (["thinking", "redacted_thinking"].includes(item.type ?? "") && (isCarrier(item.signature) || isCarrier(item.data))) {
        removedBlocks++;
        return false;
      }
      if (isCarrier(item.signature)) {
        delete item.signature;
        removedSignatures++;
      }
      return true;
    });
  }
  if (!removedBlocks && !removedSignatures) return null;
  return { body: JSON.stringify(parsed), removedBlocks, removedSignatures };
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
};

/** FIFO gate. Disconnected requests leave the queue without taking a permit. */
class Semaphore {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(size: number) {
    this.available = size;
  }

  get queued(): number { return this.waiters.length; }
  get busy(): boolean { return this.available === 0; }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(once(() => this.release()));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject, signal,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          reject(signal.reason);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve(once(() => this.release()));
    } else {
      this.available++;
    }
  }
}

type Failure = { kind: "error"; status: number; text: string; body: Uint8Array; headers: Headers };
type Attempt = { kind: "ok"; response: Response } | Failure;
type RequestState = {
  opts: Options;
  path: string;
  method: string;
  headers: Headers;
  body: Uint8Array | undefined;
  attempts: number;
  stripped: boolean;
  tag: string;
  requestSignal: AbortSignal;
  retrySignal: AbortSignal;
  upstreamTimeoutSignal?: AbortSignal;
  cancel: AbortController;
  stopDeadline: () => void;
  log: (message: string) => void;
};

function upstreamBase(opts: Options, path: string): string {
  return opts.responsesUpstream && isResponsesPath(path) ? opts.responsesUpstream : opts.upstream;
}

async function routeRedirect(response: Response, state: RequestState, base: string): Promise<Response> {
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) return response;
  const upstream = new URL(base);
  const prefix = upstream.pathname.replace(/\/+$/, "");
  let target: URL | undefined;
  try { target = new URL(location, `${base.replace(/\/+$/, "")}${state.path}`); } catch { /* Reject malformed redirects. */ }
  if (target && !target.username && !target.password && target.origin === upstream.origin &&
      target.pathname.startsWith(`${prefix}/`)) {
    const path = (target.pathname.slice(prefix.length) || "/") + target.search;
    if (new URL(upstreamBase(state.opts, path)).href === upstream.href) {
      const headers = new Headers(response.headers);
      // A dot segment keeps // paths from becoming redirects to another host.
      headers.set("location", `/.${path}${target.hash}`);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  }
  await response.body?.cancel().catch(() => {});
  return Response.json({ error: { type: "proxy_error",
    message: `upstream returned HTTP ${response.status} redirect to ${location}; redirect leaves the configured proxy route` } }, { status: 502 });
}

async function attemptOnce(state: RequestState): Promise<Attempt> {
  const { opts, path } = state;
  const base = upstreamBase(opts, path);
  state.upstreamTimeoutSignal = AbortSignal.timeout(opts.upstreamTimeoutMs);
  const fetched = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    method: state.method,
    headers: state.headers,
    body: state.body,
    signal: AbortSignal.any([state.retrySignal, state.upstreamTimeoutSignal]),
    // Decode explicitly so unsupported encodings and HEAD metadata remain intact.
    decompress: false,
    redirect: "manual",
  });
  if (fetched.status >= 300 && fetched.status < 400) {
    return { kind: "ok", response: await routeRedirect(fetched, state, base) };
  }
  const upstream = decodeResponse(fetched, state.method);
  if (opts.inspectSse && upstream.status === 200 && (upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
    const inspected = await inspectSsePrefix(upstream);
    if (!inspected) return { kind: "ok", response: upstream };
    if (inspected.retryable) {
      return { kind: "error", status: 200, text: inspected.text, body: encoder.encode(inspected.text), headers: copyHeaders(upstream.headers) };
    }
    return { kind: "ok", response: rebuildStream(upstream, inspected.head, inspected.reader) };
  }
  if (TRANSIENT_STATUSES.has(upstream.status) || opts.retryStatuses.includes(upstream.status)) {
    const body = new Uint8Array(await upstream.arrayBuffer());
    const text = decoder.decode(body);
    const headers = copyHeaders(upstream.headers, state.method === "HEAD");
    if (!isInvalidRequest(text) && (TRANSIENT_STATUSES.has(upstream.status) || hasRateLimitSignal(text))) {
      return { kind: "error", status: upstream.status, text, body, headers };
    }
    return { kind: "ok", response: new Response(state.method === "HEAD" ? null : body, { status: upstream.status, headers }) };
  }
  return { kind: "ok", response: upstream };
}

function transportFailure(state: RequestState, error: unknown): Failure {
  state.requestSignal.throwIfAborted();
  const cause = state.retrySignal.aborted ? state.retrySignal.reason : state.upstreamTimeoutSignal?.aborted ? state.upstreamTimeoutSignal.reason : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  const status = state.retrySignal.aborted || state.upstreamTimeoutSignal?.aborted ? 504 : 502;
  state.log(`[${state.tag}] attempt ${state.attempts} transport error: ${message}`);
  const text = JSON.stringify({ error: { type: "proxy_error", message: `upstream request failed: ${message}` } });
  return { kind: "error", status, text, body: encoder.encode(text), headers: new Headers({ "content-type": "application/json" }) };
}

async function nextAttempt(state: RequestState): Promise<Attempt> {
  while (true) {
    state.requestSignal.throwIfAborted();
    state.attempts++;
    try {
      const outcome = await attemptOnce(state);
      if (outcome.kind === "ok" && outcome.response.status === 400 && !state.stripped && state.attempts < state.opts.maxAttempts) {
        const body = new Uint8Array(await outcome.response.arrayBuffer());
        const text = decoder.decode(body);
        const lowered = text.toLowerCase();
        const stripped = STALE_REASONING_SIGNALS.some((signal) => lowered.includes(signal)) ? stripStaleReasoning(state.body) : null;
        if (stripped && !state.retrySignal.aborted) {
          state.stripped = true;
          state.body = encoder.encode(stripped.body);
          state.log(`[${state.tag}] stale-reasoning 400: retrying once without ${stripped.removedBlocks} reasoning block(s) and ${stripped.removedSignatures} signature(s)`);
          continue;
        }
        return { kind: "ok", response: new Response(state.method === "HEAD" ? null : body, { status: 400, headers: copyHeaders(outcome.response.headers, state.method === "HEAD") }) };
      }
      return outcome;
    } catch (error) {
      return transportFailure(state, error);
    }
  }
}

function retryAfterMs(headers: Headers): number {
  const value = headers.get("retry-after");
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(Number(value) * 1000, 2_147_483_647);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 2_147_483_647)) : 0;
}

async function retryUntilDone(state: RequestState, first: Failure): Promise<Attempt> {
  let last = first;
  while (state.attempts < state.opts.maxAttempts && !state.retrySignal.aborted) {
    const exponential = state.opts.baseDelayMs * 2 ** (state.attempts - 1);
    const jittered = Math.round(Math.min(exponential, state.opts.maxDelayMs) * (0.75 + Math.random() * 0.5));
    const waitMs = Math.max(Math.min(jittered, state.opts.maxDelayMs), retryAfterMs(last.headers));
    state.log(`[${state.tag}] attempt ${state.attempts} -> ${last.status}, retrying in ${(waitMs / 1000).toFixed(1)}s: ${shortBody(last.text)}`);
    try {
      await sleep(waitMs, state.retrySignal);
    } catch {
      state.requestSignal.throwIfAborted();
      break;
    }
    if (state.retrySignal.aborted) break;
    const next = await nextAttempt(state);
    if (next.kind === "ok") return next;
    last = next;
  }
  state.requestSignal.throwIfAborted();
  state.log(`[${state.tag}] retries exhausted after ${state.attempts} attempt(s): ${shortBody(last.text)}`);
  return last;
}

function exhaustedResponse(last: Failure, opts: Options, method: string): Response {
  const headers = new Headers(last.headers);
  if (!headers.has("retry-after")) headers.set("retry-after", String(Math.ceil(opts.maxDelayMs / 1000)));
  // An error hidden under HTTP 200 must not look successful to a JSON client.
  return new Response(method === "HEAD" ? null : last.body, { status: last.status === 200 ? 502 : last.status, headers });
}

function wireProtocol(path: string): "responses" | "messages" | "chat" | "generic" {
  if (isResponsesPath(path)) return "responses";
  const pathname = path.split("?", 1)[0];
  if (pathname === "/v1/messages" || pathname.startsWith("/v1/messages/")) return "messages";
  if (pathname === "/v1/chat/completions" || pathname.startsWith("/v1/chat/completions/")) return "chat";
  return "generic";
}

type UpstreamError = { message?: string; type?: string; code?: string };

function upstreamError(text: string): UpstreamError {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    const frame = sseFrames(text).find(({ event }) => event === "error" || event === "response.failed");
    if (frame) {
      try { value = JSON.parse(frame.data); }
      catch { return { message: frame.data }; }
    }
  }
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const envelope = object(value);
  const error = object(envelope?.error) ?? object(object(envelope?.response)?.error) ?? envelope;
  if (!error) return {};
  return {
    message: typeof error.message === "string" ? error.message : undefined,
    type: typeof error.type === "string" ? error.type : undefined,
    code: typeof error.code === "string" ? error.code : undefined,
  };
}

function sseErrorFrame(path: string, status: number, text: string): Uint8Array {
  const error = upstreamError(text);
  const message = shortBody(error.message ?? text);
  const invalid = isInvalidRequest(text);
  const types = new Set(["invalid_request_error", "authentication_error", "permission_error", "not_found_error",
    "request_too_large", "rate_limit_error", "api_error", "overloaded_error"]);
  const limited = !invalid && (status === 429 || /too_many_requests|rate[ _-]?limit|token rate|exceeded token|quota exceeded/i.test(text));
  const statusType: Record<number, string> = {
    400: "invalid_request_error", 401: "authentication_error", 403: "permission_error",
    404: "not_found_error", 413: "request_too_large", 422: "invalid_request_error",
  };
  const mappedType = status === 422 && hasRateLimitSignal(text) ? undefined : statusType[status];
  const type = invalid ? "invalid_request_error"
    : error.type && types.has(error.type) ? error.type
    : mappedType ?? (limited ? "rate_limit_error" : "api_error");
  const code = invalid ? "invalid_request_error" : error.code ??
    (type === "rate_limit_error" ? "rate_limit_exceeded" : ["api_error", "overloaded_error"].includes(type) ? "server_error" : type);
  const protocol = wireProtocol(path);
  if (protocol === "chat") {
    return encoder.encode(`data: ${JSON.stringify({ error: { message, type, code, param: null } })}\n\n`);
  }
  const payload = protocol === "responses" ? { type: "error", code, message, param: null }
    : protocol === "messages" ? { type: "error", error: { type, message } }
    : { error: { code, message } };
  return encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Start keepalives after the first retryable failure, not during the first call. */
function streamingRetry(state: RequestState, first: Failure): Response {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let ready: Promise<void>;
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopPings = () => clearInterval(timer);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (state.opts.keepaliveMs > 0) {
        const frame = wireProtocol(state.path) === "messages" ? PING_FRAME : KEEPALIVE_COMMENT;
        timer = setInterval(() => {
          if (!done) controller.enqueue(frame);
        }, state.opts.keepaliveMs);
      }
      ready = retryUntilDone(state, first).then(async (outcome) => {
        if (done) {
          if (outcome.kind === "ok") await outcome.response.body?.cancel().catch(() => {});
          return;
        }
        if (outcome.kind === "error" || outcome.response.status >= 300) {
          const status = outcome.kind === "error" ? outcome.status : outcome.response.status;
          let text: string;
          let finalStatus = status;
          try { text = outcome.kind === "error" ? outcome.text : await outcome.response.text(); }
          catch (error) {
            const failure = transportFailure(state, error);
            text = failure.text;
            finalStatus = failure.status;
          }
          stopPings();
          state.stopDeadline();
          if (done) return;
          if (outcome.kind === "ok" && status < 400) {
            const location = outcome.response.headers.get("location");
            text = `upstream returned HTTP ${status}${location ? ` redirect to ${location}` : ""}${text ? `: ${text}` : ""}`;
          }
          controller.enqueue(sseErrorFrame(state.path, finalStatus, text));
          done = true;
          controller.close();
        } else {
          // Stop keepalives before forwarding: a ping between partial frames corrupts SSE.
          stopPings();
          state.stopDeadline();
          reader = outcome.response.body?.getReader();
          if (!reader) {
            done = true;
            controller.close();
          }
        }
      }).catch((error) => {
        stopPings();
        state.stopDeadline();
        if (!done) {
          done = true;
          controller.error(error);
        }
      });
    },
    async pull(controller) {
      await ready;
      if (done || !reader) return;
      try {
        const { done: ended, value } = await reader.read();
        if (ended) {
          done = true;
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        done = true;
        controller.error(error);
      }
    },
    async cancel(reason) {
      done = true;
      stopPings();
      state.cancel.abort(reason);
      await ready;
      await reader?.cancel(reason).catch(() => {});
    },
  });
  const headers = copyHeaders(first.headers);
  for (const name of ["content-encoding", "etag", "last-modified", "content-range", "content-md5", "digest", "retry-after"]) headers.delete(name);
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  return new Response(body, { status: 200, headers });
}

/** Keep the permit until the response drains or upstream cancellation completes. */
function releaseWhenDrained(response: Response, release: () => void, cancel: (reason: unknown) => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancel(reason);
      try { await reader.cancel(reason); }
      finally { release(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createProxyServer(options: Partial<Options> = {}, logger?: (message: string) => void) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  validateOptions(opts, true);
  // Model aliases may share an upstream bucket, so the gate is global.
  const gate = new Semaphore(opts.bigCtxConcurrency);
  let mirrorWrites = Promise.resolve();
  let warnedAboutMirror = false;
  const log = (message: string) => {
    const now = new Date();
    if (logger) logger(message);
    else process.stdout.write(`${now.toISOString()} ${message}\n`);
    if (!opts.mirrorLog) return;
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}][${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const level = /\b(transport error|exhausted|failed)/i.test(message) ? "WARN" : "INFO";
    mirrorWrites = mirrorWrites.then(() => appendFile(opts.mirrorLog!, `[${stamp}][${level}][AR-Proxy] ${message}\n`)).catch((error) => {
      if (!warnedAboutMirror) {
        warnedAboutMirror = true;
        console.error(`Cannot append to mirror log ${opts.mirrorLog}: ${error.message}`);
      }
    });
  };
  const server = Bun.serve({
    hostname: opts.listen,
    port: opts.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = `${url.pathname}${url.search}`;
      const method = req.method.toUpperCase();
      if (method === "GET" && url.pathname === "/__ar_proxy/health") {
        return Response.json({ service: "AR-Proxy", pid: process.pid });
      }
      const tag = `${method} ${path}`;
      const started = Date.now();
      // Preserve request bytes, including non-JSON and binary payloads.
      const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
      const bodyText = body ? decoder.decode(body) : "";
      let isStreaming = false;
      try { isStreaming = JSON.parse(bodyText)?.stream === true; } catch { /* Not every route accepts JSON. */ }
      // This is a rough character-based estimate, not a model tokenizer.
      const estimated = Math.round(bodyText.length / 4);
      const gated = opts.bigCtxTokens > 0 && estimated >= opts.bigCtxTokens;
      const cancel = new AbortController();
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(new Error("retry deadline exceeded")), opts.deadlineMs);
      const stopDeadline = once(() => clearTimeout(timer));
      const state: RequestState = {
        opts, path, method, tag, body,
        headers: copyHeaders(req.headers),
        attempts: 0,
        stripped: false,
        cancel, stopDeadline, log,
        requestSignal: AbortSignal.any([req.signal, cancel.signal]),
        retrySignal: AbortSignal.any([req.signal, cancel.signal, budget.signal]),
      };
      let releasePermit: (() => void) | undefined;
      const release = once(() => { stopDeadline(); releasePermit?.(); });
      let handedOff = false;
      try {
        if (gated) {
          if (gate.busy) log(`[${tag}] ctx=~${Math.round(estimated / 1000)}k queued (${gate.queued + 1} waiting)`);
          releasePermit = await gate.acquire(state.retrySignal);
        }
        let outcome = await nextAttempt(state);
        const context = estimated ? ` ctx=~${Math.round(estimated / 1000)}k` : "";
        log(`[${tag}] attempt ${state.attempts} -> ${outcome.kind === "ok" ? outcome.response.status : outcome.status} in ${((Date.now() - started) / 1000).toFixed(1)}s${context}`);
        let response: Response;
        if (outcome.kind === "error" && isStreaming) {
          response = streamingRetry(state, outcome);
        } else {
          if (outcome.kind === "error") outcome = await retryUntilDone(state, outcome);
          stopDeadline();
          response = outcome.kind === "ok" ? passthrough(outcome.response, method) : exhaustedResponse(outcome, opts, method);
        }
        const wrapped = releaseWhenDrained(response, release, (reason) => cancel.abort(reason));
        handedOff = true;
        return wrapped;
      } catch (error) {
        const status = state.requestSignal.aborted ? 499 : state.retrySignal.aborted ? 504 : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status !== 499) log(`[${tag}] request failed: ${message}`);
        return new Response(JSON.stringify({ error: { type: "proxy_error", message } }), {
          status, headers: { "content-type": "application/json" },
        });
      } finally {
        if (!handedOff) release();
      }
    },
  });
  log(`AR-Proxy listening on ${server.url} -> ${opts.upstream}`);
  if (opts.responsesUpstream) log(`/v1/responses upstream: ${opts.responsesUpstream}`);
  log(`max ${opts.maxAttempts} attempts, retry budget ${opts.deadlineMs}ms, big-context gate ${opts.bigCtxTokens ? `>=${opts.bigCtxTokens} estimated tokens @ ${opts.bigCtxConcurrency} concurrent` : "off"}`);
  return server;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
  } else {
    try { createProxyServer(parseArgs(argv)); }
    catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
