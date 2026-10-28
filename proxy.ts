import { appendFile } from "node:fs/promises";

/**
 * agentrouter-retry-proxy — retry hop + token-rate-limit prevention for AgentRouter.
 *
 *   Claude Code -> this proxy (:15720) -> cc-switch (:15721) -> AgentRouter /v1/responses
 *
 * Two distinct problems, two mechanisms:
 *
 * 1. RETRY. AgentRouter reports token-rate-limit exhaustion inside the Responses
 *    payload ("Responses upstream too_many_requests: ... exceeded token rate
 *    limit"). cc-switch's pre-stream validator turns that into HTTP 422
 *    `格式转换错误`, and its own failover loop classifies 422 as NonRetryable, so
 *    the error reaches Claude Code unretried. This proxy retries exactly those
 *    responses (422/429 whose body matches a rate-limit phrase) with exponential
 *    backoff + jitter. On a streaming request it answers 200 text/event-stream
 *    immediately and emits Anthropic `ping` events while waiting, so client
 *    first-byte/idle timers never fire during backoff.
 *
 * 2. PREVENTION. Detection is slow — AgentRouter queues the request and only
 *    then rejects it (measured 3s when idle, 100-180s when the account is
 *    already saturated). Retrying therefore costs minutes. The limit is a token
 *    rate limit, and large-context requests are what trip it: measured TTFT is
 *    4.5s under 50k context, 10.6s at 50-100k, and 48.1s above 100k. So
 *    requests whose estimated input exceeds `--big-ctx-tokens` are gated
 *    through their own semaphore (`--big-ctx-concurrency`, default 1) instead
 *    of piling up concurrently. Small requests are unaffected and still run in
 *    parallel.
 */

type Options = {
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

const HELP = `agentrouter-retry-proxy

Usage: bun proxy.ts [options]

Options:
  --port <n>                  listen port                     (default 15720)
  --listen <addr>             listen address                  (default 127.0.0.1)
  --upstream <url>            upstream base URL               (default http://127.0.0.1:15721)
  --responses-upstream <url>  upstream for /v1/responses traffic only. Set this
                              to reach an OpenAI-Responses provider directly
                              while /v1/messages keeps going through --upstream.
                              Requests to this upstream are retried the same way.
  --max-attempts <n>          total tries per request         (default 8)
  --base-delay <ms>           first backoff delay             (default 2000)
  --max-delay <ms>            backoff ceiling                 (default 30000)
  --deadline <ms>             per-request retry budget        (default 300000)
  --upstream-timeout <ms>     single upstream call timeout    (default 600000)
  --keepalive <ms>            streaming keepalive ping gap    (default 10000, 0 disables)
  --retry-status <list>       comma-separated status codes    (default 422,429)
  --big-ctx-tokens <n>        estimated input tokens above which a request is
                              gated (default 60000, 0 disables gating)
  --big-ctx-concurrency <n>   concurrent big-context requests (default 1)
  --mirror-log <path>         also append lines to this file, in cc-switch's
                              log format (e.g. ~/.cc-switch/logs/cc-switch.log)
  --inspect-sse               also retry upstream SSE responses that carry a
                              rate-limit error event on an HTTP 200. AgentRouter
                              reports Responses-API limits this way, so a pure
                              status check would pass them through.
                              (default on; use --no-inspect-sse to disable)
  -h, --help                  show this help
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
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
  const numeric: Record<string, (n: number) => void> = {
    "--port": (n) => (opts.port = n),
    "--max-attempts": (n) => (opts.maxAttempts = n),
    "--base-delay": (n) => (opts.baseDelayMs = n),
    "--max-delay": (n) => (opts.maxDelayMs = n),
    "--deadline": (n) => (opts.deadlineMs = n),
    "--upstream-timeout": (n) => (opts.upstreamTimeoutMs = n),
    "--big-ctx-tokens": (n) => (opts.bigCtxTokens = n),
    "--big-ctx-concurrency": (n) => (opts.bigCtxConcurrency = n),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "-h" || flag === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    const setNumeric = numeric[flag];
    if (setNumeric) {
      const n = Number(value);
      const allowZero = flag === "--big-ctx-tokens";
      if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
        throw new Error(`${flag} needs a number ${allowZero ? ">= 0" : "> 0"}, got ${value}`);
      }
      setNumeric(n);
      i++;
      continue;
    }
    if (flag === "--keepalive") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`--keepalive needs a number >= 0, got ${value}`);
      opts.keepaliveMs = n;
      i++;
      continue;
    }
    if (flag === "--listen" || flag === "--upstream" || flag === "--mirror-log" || flag === "--responses-upstream") {
      if (!value) throw new Error(`${flag} needs a value`);
      if (flag === "--listen") opts.listen = value;
      else if (flag === "--upstream") opts.upstream = value.replace(/\/+$/, "");
      else if (flag === "--responses-upstream") opts.responsesUpstream = value.replace(/\/+$/, "");
      else opts.mirrorLog = value;
      i++;
      continue;
    }
    if (flag === "--retry-status") {
      if (!value) throw new Error("--retry-status needs a value");
      opts.retryStatuses = value.split(",").map((s) => Number(s.trim()));
      i++;
      continue;
    }
    if (flag === "--inspect-sse") {
      opts.inspectSse = true;
      continue;
    }
    if (flag === "--no-inspect-sse") {
      opts.inspectSse = false;
      continue;
    }
    throw new Error(`unknown option ${flag} (try --help)`);
  }
  if (opts.maxAttempts < 1) throw new Error("--max-attempts must be >= 1");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

// Rate-limit wording seen from AgentRouter/upstream gateways. A 422 whose body
// says none of this is a real format error and must not be retried.
// Errors meaning "this reasoning item belongs to a different backend resource".
// AgentRouter multiplexes across Azure/OpenAI deployments; a conversation whose
// earlier turns were served by resource A cannot be replayed to resource B. The
// offending payload is the encrypted reasoning item cc-switch round-trips inside
// a thinking signature, and cc-switch's own thinking rectifier does not match
// this wording (it looks for "invalid request", not "invalid_request_error"), so
// it never strips them. Retrying is futile: the fix is to drop the stale
// reasoning items and replay the conversation without them.
const STALE_REASONING_SIGNALS = [
  "different azure openai resource",
  "different openai resource",
  "same resource that created the item",
  "created under a different",
];

// Signature carrier prefixes cc-switch uses to smuggle OpenAI reasoning items
// through the Anthropic Messages protocol.
const REASONING_SIGNATURE_PREFIXES = ["ccswitch-openai-reasoning-v1:", "ccswitch-openai-reasoning-"];

const RATE_LIMIT_SIGNALS = [
  "too_many_requests",
  "rate limit",
  "rate_limit",
  "ratelimit",
  "token rate",
  "exceeded token",
  "quota exceeded",
  "overloaded",
  // Transient upstream failures that never reached the client: AgentRouter
  // returns 200 with an aborted/empty SSE stream, and cc-switch's converter
  // reports it as "Responses upstream failed before output". Nothing was
  // emitted, so replaying the request is safe. Observed roughly 1 in 10
  // requests against gpt-6.1-sol, independent of rate-limit pressure.
  "failed before output",
  "experiencing high demand",
  "exceeds the maximum usage size",
];

const PING_FRAME = new TextEncoder().encode(`event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
const encoder = new TextEncoder();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let mirrorPath: string | null = null;

function log(message: string) {
  const now = new Date();
  process.stdout.write(`${now.toISOString()} ${message}\n`);
  if (!mirrorPath) return;
  // cc-switch's own line format, so hop lines sit inline in its log.
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}][${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const level = /\b(rate limited|transport error|exhausted|failed|unreachable)/i.test(message) ? "WARN" : "INFO";
  appendFile(mirrorPath, `[${stamp}][${level}][agentrouter-retry-proxy] ${message}\n`).catch(() => {});
}

function shortBody(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

/** Anthropic Messages requests resend the whole conversation; ~4 chars/token. */
function estimateTokens(bodyText: string): number {
  return Math.round(bodyText.length / 4);
}

/**
 * Detect a rate-limit failure delivered as an SSE error event on an HTTP 200.
 *
 * AgentRouter's Responses endpoint reports token-rate exhaustion this way: the
 * status line is already 200, then `response.created` is followed immediately by
 * `event: error` / `event: response.failed` and the stream ends. A status-only
 * check sees success. Because the error always precedes any content, buffering
 * just this prefix is safe: nothing the client would have acted on is lost.
 *
 * Returns the buffered prefix and the error text when a retryable failure is
 * found, else null (the caller then streams the prefix through unchanged).
 */
async function inspectSsePrefix(
  response: Response,
): Promise<{ retryable: true; text: string } | { retryable: false; head: Uint8Array; reader: ReadableStreamDefaultReader<Uint8Array> } | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  // Enough for response.created plus the error envelope; content events would
  // only appear after these, so this ceiling never truncates a healthy answer.
  const MAX_PREFIX = 64 * 1024;

  while (total < MAX_PREFIX) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });

    // The outcome is decided by the first terminal event. `response.created` and
    // `response.in_progress` are preamble: AR emits them and then either content
    // or an error, so waiting for them would wrongly treat every stream as
    // retryable. Content or completion means healthy; error/failed means not.
    if (/^event: (response\.(completed|output_item\.added|content_part\.added|output_text\.delta)|content_block_)/m.test(text)) {
      break;
    }
    if (/^event: (error|response\.failed)$/m.test(text)) break;
  }

  const isError = /^event: (error|response\.failed)$/m.test(text);
  if (isError && (hasRateLimitSignal(text) || isTransientFailure(200, text))) {
    await reader.cancel().catch(() => {});
    return { retryable: true, text };
  }

  // Healthy, or an upstream error that is not a limit: hand the bytes read so
  // far back ahead of the live remainder so nothing is lost or reordered.
  const head = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    head.set(c, off);
    off += c.byteLength;
  }
  return { retryable: false, head, reader };
}

/** Rate-limit wording in a body, regardless of the status it arrived with. */
function hasRateLimitSignal(body: string): boolean {
  const lowered = body.toLowerCase();
  return RATE_LIMIT_SIGNALS.some((signal) => lowered.includes(signal));
}

function isRateLimited(status: number, body: string): boolean {
  if (!opts.retryStatuses.includes(status)) return false;
  return hasRateLimitSignal(body);
}

/**
 * Transient upstream/gateway failures. cc-switch answers 502 when it cannot
 * even send the request ("上游连接失败: error sending request") and 503 when
 * AgentRouter reports itself unavailable; both clear on their own and nothing
 * reached the client, so replay is safe. 504 covers the same class at the
 * gateway boundary.
 */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

function isTransientFailure(status: number, body: string): boolean {
  if (!TRANSIENT_STATUSES.has(status)) return false;
  const lowered = body.toLowerCase();
  // A 502 carrying a deterministic upstream rejection is not transient.
  return !lowered.includes("invalid_request_error") && !lowered.includes("rejected the request as invalid");
}

/** Log wording for a retryable status: 5xx is a transient failure, not a limit. */
function retryReason(status: number): string {
  return TRANSIENT_STATUSES.has(status) ? "transient upstream failure" : "rate limited";
}

function isStaleReasoningError(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lowered = body.toLowerCase();
  return STALE_REASONING_SIGNALS.some((signal) => lowered.includes(signal));
}

type StripResult = { body: string; removedBlocks: number; removedSignatures: number };

/**
 * Remove reasoning items that belong to another backend resource.
 *
 * cc-switch carries each OpenAI reasoning item inside a thinking/redacted_thinking
 * block (as `signature`/`data`, prefixed `ccswitch-openai-reasoning-v1:`). When the
 * upstream rejects the conversation because those items were minted by a different
 * deployment, the only recovery is to drop them: the text and tool calls stay, so
 * the turn still makes sense, only the model's private reasoning is lost.
 *
 * Both carriers must go together — a `thinking` block whose `signature` is removed
 * but whose text remains can still be rejected, so the whole block is dropped.
 */
function stripStaleReasoning(bodyText: string): StripResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const messages = (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return null;

  let removedBlocks = 0;
  let removedSignatures = 0;

  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    const kept: unknown[] = [];
    for (const block of content) {
      const type = (block as { type?: unknown })?.type;
      const carrier =
        (block as { signature?: unknown })?.signature ?? (block as { data?: unknown })?.data;
      const isReasoningCarrier =
        (type === "thinking" || type === "redacted_thinking") &&
        typeof carrier === "string" &&
        REASONING_SIGNATURE_PREFIXES.some((prefix) => carrier.startsWith(prefix));
      if (isReasoningCarrier) {
        removedBlocks++;
        continue;
      }
      // A stray bridge signature on a non-thinking block is equally fatal.
      if (
        typeof carrier === "string" &&
        REASONING_SIGNATURE_PREFIXES.some((prefix) => carrier.startsWith(prefix)) &&
        "signature" in (block as object)
      ) {
        delete (block as { signature?: unknown }).signature;
        removedSignatures++;
      }
      kept.push(block);
    }
    (message as { content: unknown }).content = kept;
  }

  if (removedBlocks === 0 && removedSignatures === 0) return null;
  return { body: JSON.stringify(parsed), removedBlocks, removedSignatures };
}

function backoffMs(attempt: number): number {
  const exp = opts.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exp, opts.maxDelayMs);
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

/** Counting semaphore, FIFO. Caps how many big-context requests overlap. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(size: number) {
    this.available = size;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push(resolve);
    return promise;
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
}

// One gate for all big requests, deliberately not keyed per model. The hop only
// sees the client's model name, and cc-switch rewrites it (claude-fable-5 ->
// gpt-6-astra), so keying on it would hand two aliases of the same upstream
// bucket separate permits and silently disable the gate. Gating globally is
// slightly stricter than AgentRouter's per-model limit, which is the safe
// direction: it can only reduce concurrent load.
const bigCtxGate = new Semaphore(Math.max(1, opts.bigCtxConcurrency));

function buildUpstreamHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

function copyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const lowered = key.toLowerCase();
    if (lowered === "content-encoding" || lowered === "content-length") return;
    if (HOP_BY_HOP.has(lowered)) return;
    headers.set(key, value);
  });
  return headers;
}

function passthrough(upstream: Response): Response {
  return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

/**
 * Hold the big-context permit until the body has actually drained. Fetch
 * resolves on headers, but the upstream keeps generating for many seconds
 * afterwards — releasing at headers would let big requests pile up again, which
 * is exactly what the gate exists to prevent.
 */
function releaseWhenDrained(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(wrapped, { status: response.status, headers: response.headers });
}

function errorResponse(status: number, text: string, upstream: Response): Response {
  return new Response(text, { status, headers: copyResponseHeaders(upstream) });
}

type Attempt = { kind: "ok"; response: Response } | { kind: "error"; status: number; text: string };

async function attemptOnce(
  path: string,
  method: string,
  headers: Headers,
  bodyText: string,
): Promise<Attempt> {
  // /v1/responses traffic may target a different upstream than /v1/messages:
  // cc-switch only speaks the Anthropic wire, while a Responses provider has to
  // be reached directly. Everything else about the attempt is identical, so the
  // retry policy applies unchanged.
  const base = opts.responsesUpstream && path.startsWith("/v1/responses") ? opts.responsesUpstream : opts.upstream;
  const upstream = await fetch(`${base}${path}`, {
    method,
    headers,
    body: bodyText === "" ? undefined : bodyText,
    signal: AbortSignal.timeout(opts.upstreamTimeoutMs),
  });
  // 5xx transport failures are transient regardless of body wording, so they
  // bypass the rate-limit phrase check below.
  if (TRANSIENT_STATUSES.has(upstream.status)) {
    const text = await upstream.text();
    if (isTransientFailure(upstream.status, text)) {
      return { kind: "error", status: upstream.status, text };
    }
    return { kind: "ok", response: errorResponse(upstream.status, text, upstream) };
  }
  if (!opts.retryStatuses.includes(upstream.status)) {
    // A 200 whose SSE body opens with a rate-limit error event is a failure in
    // disguise; inspect the prefix before handing it back.
    if (opts.inspectSse && upstream.status === 200 && (upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const inspected = await inspectSsePrefix(upstream);
      if (inspected === null) return { kind: "ok", response: upstream };
      if (inspected.retryable) {
        return { kind: "error", status: 200, text: inspected.text };
      }
      return { kind: "ok", response: rebuildStream(upstream, inspected.head, inspected.reader) };
    }
    return { kind: "ok", response: upstream };
  }
  const text = await upstream.text();
  if (!isRateLimited(upstream.status, text)) {
    return { kind: "ok", response: errorResponse(upstream.status, text, upstream) };
  }
  return { kind: "error", status: upstream.status, text };
}

/** Re-attach the already-read SSE prefix ahead of the live remainder. */
function rebuildStream(response: Response, head: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength > 0) controller.enqueue(head);
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
  return new Response(body, { status: response.status, headers: copyResponseHeaders(response) });
}

function sseErrorFrame(status: number, text: string): Uint8Array {
  const payload = {
    type: "error",
    error: {
      type: status === 429 ? "rate_limit_error" : "api_error",
      message: shortBody(text),
    },
  };
  return encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Streaming path: answer 200 + SSE immediately, ping while retrying, then splice
 * in the upstream bytes. Exhausted retries become an Anthropic `error` SSE event
 * because the status line is already on the wire.
 */
function streamingRetry(
  path: string,
  method: string,
  headers: Headers,
  bodyText: string,
  first: { status: number; text: string },
  tag: string,
): Response {
  const deadline = Date.now() + opts.deadlineMs;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let pinging = true;
      const timer =
        opts.keepaliveMs > 0
          ? setInterval(() => {
              if (!pinging) return;
              try {
                controller.enqueue(PING_FRAME);
              } catch {
                pinging = false;
              }
            }, opts.keepaliveMs)
          : undefined;

      let last = first;
      try {
        for (let attempt = 1; ; attempt++) {
          const exhausted = attempt >= opts.maxAttempts || Date.now() >= deadline;
          if (exhausted) {
            log(
              `[${tag}] attempt ${attempt} -> ${last.status} ${retryReason(last.status)}, retries exhausted, emitting SSE error: ${shortBody(last.text)}`,
            );
            controller.enqueue(sseErrorFrame(last.status, last.text));
            break;
          }
          const waitMs = backoffMs(attempt);
          log(
            `[${tag}] attempt ${attempt} -> ${last.status} ${retryReason(last.status)}, retrying in ${(waitMs / 1000).toFixed(1)}s: ${shortBody(last.text)}`,
          );
          await sleep(waitMs);

          const attemptStart = Date.now();
          let outcome: Attempt;
          try {
            outcome = await attemptOnce(path, method, headers, bodyText);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`[${tag}] attempt ${attempt + 1} transport error: ${message}`);
            last = { status: 502, text: `upstream unreachable: ${message}` };
            continue;
          }
          if (outcome.kind === "error") {
            last = outcome;
            continue;
          }

          log(
            `[${tag}] attempt ${attempt + 1} -> ${outcome.response.status} recovered after ${((Date.now() - attemptStart) / 1000).toFixed(1)}s, streaming`,
          );
          const reader = outcome.response.body?.getReader();
          if (!reader) break;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          break;
        }
      } finally {
        pinging = false;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed by a client disconnect */
        }
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

if (opts.mirrorLog) mirrorPath = opts.mirrorLog;

Bun.serve({
  hostname: opts.listen,
  port: opts.port,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = `${url.pathname}${url.search}`;
    const method = req.method.toUpperCase();
    const tag = `${method} ${path}`;
    const started = Date.now();
    let bodyText = method === "GET" || method === "HEAD" ? "" : await req.text();
    const headers = buildUpstreamHeaders(req.headers);

    let isStreaming = false;
    let model = "";
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText);
        isStreaming = parsed?.stream === true;
        model = typeof parsed?.model === "string" ? parsed.model : "";
      } catch {
        isStreaming = false;
      }
    }

    // Token-rate-limit prevention: serialize big-context requests. Small ones
    // (subagents, titles, cheap models) bypass the gate entirely.
    const estimated = bodyText ? estimateTokens(bodyText) : 0;
    const gated = opts.bigCtxTokens > 0 && estimated >= opts.bigCtxTokens;
    const gate = bigCtxGate;
    const releaseGate = once(() => {
      if (gated) gate.release();
    });
    // Set before returning a response whose body still has to drain; `finally`
    // runs on `return` too, so it must not release in that case.
    let handedOff = false;
    let queuedForMs = 0;
    if (gated) {
      const waitStart = Date.now();
      if (gate.queued > 0) {
        log(
          `[${tag}] ~${Math.round(estimated / 1000)}k-token request (model=${model || "?"}) queued behind ${gate.queued} big request(s)`,
        );
      }
      await gate.acquire();
      queuedForMs = Date.now() - waitStart;
    }

    try {
      let outcome: Attempt;
      try {
        outcome = await attemptOnce(path, method, headers, bodyText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[${tag}] attempt 1 transport error: ${message}`);
        return new Response(
          JSON.stringify({ error: { type: "proxy_error", message: `upstream unreachable: ${message}` } }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }

      const ctx = estimated > 0 ? ` ctx=~${Math.round(estimated / 1000)}k` : "";
      const queued = queuedForMs > 0 ? ` queue=${(queuedForMs / 1000).toFixed(1)}s` : "";

      // A conversation whose earlier turns were served by a different backend
      // resource cannot be replayed as-is. Deterministic, not transient, so it
      // gets exactly one shot with the stale reasoning items stripped.
      if (outcome.kind === "ok" && outcome.response.status === 400 && bodyText) {
        const errorText = await outcome.response.clone().text();
        if (isStaleReasoningError(400, errorText)) {
          const stripped = stripStaleReasoning(bodyText);
          if (stripped) {
            log(
              `[${tag}] stale-reasoning 400 (different backend resource); retrying once without ${stripped.removedBlocks} reasoning block(s) and ${stripped.removedSignatures} stray signature(s)${ctx}`,
            );
            bodyText = stripped.body;
            try {
              outcome = await attemptOnce(path, method, headers, bodyText);
              log(
                `[${tag}] stale-reasoning retry -> ${outcome.kind === "ok" ? outcome.response.status : outcome.status} in ${((Date.now() - started) / 1000).toFixed(1)}s${ctx}`,
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              log(`[${tag}] stale-reasoning retry transport error: ${message}`);
              return new Response(
                JSON.stringify({ error: { type: "proxy_error", message: `upstream unreachable: ${message}` } }),
                { status: 502, headers: { "content-type": "application/json" } },
              );
            }
          } else {
            log(
              `[${tag}] stale-reasoning 400 but no bridge reasoning items found in the request; passing through${ctx}`,
            );
          }
        }
      }

      if (outcome.kind === "ok") {
        log(
          `[${tag}] attempt 1 -> ${outcome.response.status} in ${((Date.now() - started) / 1000).toFixed(1)}s${ctx}${queued} passthrough`,
        );
        handedOff = true;
        return gated
          ? releaseWhenDrained(passthrough(outcome.response), releaseGate)
          : passthrough(outcome.response);
      }

      log(
        `[${tag}] attempt 1 -> ${outcome.status} ${retryReason(outcome.status)} after ${((Date.now() - started) / 1000).toFixed(1)}s${ctx}${queued}: ${shortBody(outcome.text)}`,
      );
      if (isStreaming) {
        handedOff = true;
        const streamed = streamingRetry(path, method, headers, bodyText, outcome, tag);
        return gated ? releaseWhenDrained(streamed, releaseGate) : streamed;
      }

      let last = outcome;
      for (let attempt = 1; ; attempt++) {
        if (attempt >= opts.maxAttempts || Date.now() - started >= opts.deadlineMs) {
          log(
            `[${tag}] attempt ${attempt} -> ${last.status} ${retryReason(last.status)}, retries exhausted after ${((Date.now() - started) / 1000).toFixed(1)}s${ctx}`,
          );
          // Hand the client a Retry-After so its own retry loop waits instead of
          // rescheduling at 0s against an already-exhausted bucket.
          return new Response(last.text, {
            status: last.status,
            headers: { "content-type": "application/json", "retry-after": String(Math.ceil(opts.maxDelayMs / 1000)) },
          });
        }
        const waitMs = backoffMs(attempt);
        log(
          `[${tag}] attempt ${attempt} -> ${last.status} ${retryReason(last.status)}, retrying in ${(waitMs / 1000).toFixed(1)}s: ${shortBody(last.text)}`,
        );
        await sleep(waitMs);
        const attemptStart = Date.now();
        try {
          const next = await attemptOnce(path, method, headers, bodyText);
          if (next.kind === "ok") {
            log(
              `[${tag}] attempt ${attempt + 1} -> ${next.response.status} recovered in ${((Date.now() - attemptStart) / 1000).toFixed(1)}s`,
            );
            handedOff = true;
            const recovered = passthrough(next.response);
            return gated ? releaseWhenDrained(recovered, releaseGate) : recovered;
          }
          last = next;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`[${tag}] attempt ${attempt + 1} transport error: ${message}`);
          last = { status: 502, text: `upstream unreachable: ${message}` };
        }
      }
    } finally {
      // Only error paths (which never hand a body back) release here; success
      // paths release via releaseWhenDrained once the body is fully consumed.
      if (!handedOff) releaseGate();
    }
  },
});

log(
  `agentrouter-retry-proxy listening on http://${opts.listen}:${opts.port} -> ${opts.upstream} ` +
    `(retry ${opts.retryStatuses.join("/")} on rate-limit bodies and 502/503/504 transient failures, max ${opts.maxAttempts} attempts, ` +
    `backoff ${opts.baseDelayMs}-${opts.maxDelayMs}ms, keepalive ${opts.keepaliveMs}ms, ` +
    `big-ctx gate ${opts.bigCtxTokens > 0 ? `>=${Math.round(opts.bigCtxTokens / 1000)}k tokens @ ${opts.bigCtxConcurrency} concurrent` : "off"})`,
);
log(`point Claude Code at it: ANTHROPIC_BASE_URL=http://${opts.listen}:${opts.port}`);
