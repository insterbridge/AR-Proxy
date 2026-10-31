import { afterEach, describe, expect, test } from "bun:test";
import { createProbeServer } from "./probe-server";
import { createProxyServer, parseArgs, type Options } from "./proxy";

const servers: Array<{ stop(force?: boolean): unknown }> = [];
const encoder = new TextEncoder();
const content = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"HELLO"}\n\n';
const errorFrame = 'event: error\ndata: {"type":"error","message":"rate limit exceeded"}\n\n';
const message = { model: "probe-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

function upstream(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handler });
  servers.push(server);
  return server;
}

function proxy(base: string, options: Partial<Options> = {}, logger = (_message: string) => {}) {
  const server = createProxyServer({
    listen: "127.0.0.1", port: 0, upstream: base,
    baseDelayMs: 5, maxDelayMs: 10, keepaliveMs: 5,
    maxAttempts: 3, deadlineMs: 2000, upstreamTimeoutMs: 2000,
    ...options,
  }, logger);
  servers.push(server);
  return server;
}

function probe(mode: string, options: Partial<Options> = {}) {
  const fixture = createProbeServer({ port: 0, gapMs: 0, quiet: true });
  servers.push(fixture.server);
  const server = proxy(new URL(mode, fixture.server.url).toString(), options);
  return { ...fixture, proxy: server };
}

function post(server: { url: URL }, body: unknown = message, path = "/v1/messages", signal?: AbortSignal) {
  return fetch(new URL(path, server.url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

function streamResponse(chunks: string[], gapMs = 0): Response {
  let cancelled = false;
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (cancelled) return;
        controller.enqueue(encoder.encode(chunk));
        if (gapMs) await Bun.sleep(gapMs);
      }
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for a test condition");
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Bun.sleep(5);
});

describe("options", () => {
  test("defaults and disable switches", () => {
    expect(parseArgs([]).port).toBe(15720);
    expect(parseArgs([]).retryStatuses).toEqual([422, 429]);
    const opts = parseArgs(["--keepalive", "0", "--big-ctx-tokens", "0", "--no-inspect-sse"]);
    expect(opts.keepaliveMs).toBe(0);
    expect(opts.bigCtxTokens).toBe(0);
    expect(opts.inspectSse).toBe(false);
  });

  test.each([
    ["--port", "0"], ["--port", "65536"], ["--port", "1.5"],
    ["--big-ctx-concurrency", "0.5"], ["--max-attempts", "1.5"],
    ["--deadline", "2147483648"], ["--keepalive", "-1"],
    ["--retry-status", "wat"], ["--retry-status", "200"], ["--retry-status", "422,"],
    ["--upstream", "file:///tmp/example"], ["--upstream", "https://example.invalid/?token=secret"],
    ["--upstream", "https://user:secret@example.invalid"], ["--responses-upstream", "not-a-url"],
    ["--big-ctx-tokens", ""],
  ])("rejects invalid %s %s", (flag, value) => {
    expect(() => parseArgs([flag, value])).toThrow();
  });

  test("rejects missing values and unknown flags", () => {
    expect(() => parseArgs(["--upstream"])).toThrow();
    expect(() => parseArgs(["--upstream", "--no-inspect-sse"])).toThrow();
    expect(() => parseArgs(["--port"])).toThrow();
    expect(() => parseArgs(["--unknown"])).toThrow();
    expect(() => parseArgs(["constructor", "1"])).toThrow();
    expect(() => parseArgs(["__proto__", "1"])).toThrow();
  });
});

describe("HTTP forwarding", () => {
  test("health checks stay local", async () => {
    let hits = 0;
    const fixture = upstream(() => { hits++; return new Response("upstream"); });
    const server = proxy(fixture.url.toString());
    const response = await fetch(new URL("/__ar_proxy/health", server.url));
    expect((await response.json()).service).toBe("AR-Proxy");
    expect(hits).toBe(0);
  });

  test.each([false, true])("healthy Messages streams pass through intact (stream=%s)", async (stream) => {
    const fixture = probe("ok");
    const response = await post(fixture.proxy, { ...message, stream });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("PROBE_OK");
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("event: ping");
    expect(fixture.requests.length).toBe(1);
  });

  test("preserves request bytes, path, query, and client headers", async () => {
    const bytes = new Uint8Array([0, 255, 254, 128, 65]);
    let seen: { path: string; userAgent: string | null; key: string | null } | undefined;
    const fixture = upstream(async (req) => {
      const url = new URL(req.url);
      seen = { path: `${url.pathname}${url.search}`, userAgent: req.headers.get("user-agent"), key: req.headers.get("x-api-key") };
      return new Response(await req.arrayBuffer(), { headers: { "content-type": "application/octet-stream" } });
    });
    const server = proxy(new URL("/prefix", fixture.url).toString());
    const response = await fetch(new URL("/echo?beta=true", server.url), {
      method: "POST", body: bytes,
      headers: { "content-type": "application/octet-stream", "user-agent": "test-client", "x-api-key": "test-key" },
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(seen).toEqual({ path: "/prefix/echo?beta=true", userAgent: "test-client", key: "test-key" });
  });

  test("strips headers named by Connection in both directions", async () => {
    let privateHeader: string | null = "not checked";
    const fixture = upstream((req) => {
      privateHeader = req.headers.get("x-private");
      return new Response("ok", { headers: { connection: "x-hidden", "x-hidden": "remove", "x-visible": "keep" } });
    });
    const server = proxy(fixture.url.toString());
    const response = await fetch(server.url, { headers: { connection: "x-private", "x-private": "remove" } });
    expect(await response.text()).toBe("ok");
    expect(privateHeader).toBeNull();
    expect(response.headers.get("x-hidden")).toBeNull();
    expect(response.headers.get("x-visible")).toBe("keep");
  });

  test("forwards redirects without following them upstream", async () => {
    let hits = 0;
    const fixture = upstream((req) => {
      hits++;
      return new Response(null, { status: 307, headers: { location: new URL("/target", req.url).toString() } });
    });
    const response = await fetch(proxy(fixture.url.toString()).url, { redirect: "manual" });
    expect(response.status).toBe(307);
    expect(hits).toBe(1);
    await response.text();
  });

  test("does not retain content-encoding after decompression", async () => {
    const fixture = upstream(() => new Response(Bun.gzipSync(encoder.encode("compressed body")), {
      headers: { "content-encoding": "gzip", "content-type": "text/plain" },
    }));
    const response = await fetch(proxy(fixture.url.toString()).url);
    expect(await response.text()).toBe("compressed body");
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("HEAD and no-content responses do not acquire a body", async () => {
    const fixture = upstream(() => new Response(null, { status: 204 }));
    const response = await fetch(proxy(fixture.url.toString()).url, { method: "HEAD" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("routes only /v1/responses and its subpaths to the second upstream", async () => {
    const first = upstream(() => new Response("primary"));
    const second = upstream((req) => new Response(new URL(req.url).pathname));
    const server = proxy(first.url.toString(), { responsesUpstream: second.url.toString() });
    expect(await (await fetch(new URL("/v1/responses?x=1", server.url))).text()).toBe("/v1/responses");
    expect(await (await fetch(new URL("/v1/responses/resp_1", server.url))).text()).toBe("/v1/responses/resp_1");
    expect(await (await fetch(new URL("/v1/responses-other", server.url))).text()).toBe("primary");
    expect(await (await fetch(new URL("/v1/messages", server.url))).text()).toBe("primary");
  });
});

describe("retry policy", () => {
  test.each(["flaky422", "flakybefore", "flakyconn"])("recovers from %s", async (mode) => {
    const fixture = probe(mode);
    const response = await post(fixture.proxy);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("RECOVERED");
    expect(fixture.requests.length).toBe(mode === "flakybefore" ? 2 : 3);
  });

  test.each(["rate422", "beforeoutput", "highdemand", "unavail503", "connfail"])("bounds attempts for %s", async (mode) => {
    const fixture = probe(mode);
    const response = await post(fixture.proxy);
    expect(response.status).toBe(mode === "unavail503" ? 503 : mode === "connfail" ? 502 : 422);
    expect(response.headers.get("retry-after")).toBe("1");
    await response.text();
    expect(fixture.requests.length).toBe(3);
  });

  test.each(["fmt422", "fmt400", "reject502"])("passes through deterministic %s errors once", async (mode) => {
    const fixture = probe(mode);
    const response = await post(fixture.proxy);
    expect(response.status).toBe(mode === "fmt422" ? 422 : mode === "fmt400" ? 400 : 502);
    await response.text();
    expect(fixture.requests.length).toBe(1);
  });

  test("a deterministic rejection wins over rate-limit wording", async () => {
    let hits = 0;
    const fixture = upstream(() => {
      hits++;
      return new Response("invalid_request_error: invalid rate limit parameter", { status: 422 });
    });
    const response = await post(proxy(fixture.url.toString()));
    expect(response.status).toBe(422);
    await response.text();
    expect(hits).toBe(1);
  });

  test("retries a connection failure on the first attempt", async () => {
    const reservation = upstream(() => new Response("unused"));
    const base = reservation.url.toString();
    reservation.stop(true);
    const logs: string[] = [];
    const server = proxy(base, {}, (line) => logs.push(line));
    const response = await post(server);
    expect(response.status).toBe(502);
    expect((await response.json()).error.type).toBe("proxy_error");
    expect(logs.filter((line) => line.includes("transport error"))).toHaveLength(3);
  });

  test("honors Retry-After seconds and preserves upstream error headers", async () => {
    const times: number[] = [];
    const fixture = upstream(() => {
      times.push(Date.now());
      return times.length === 1
        ? new Response("rate limit", { status: 429, headers: { "retry-after": "1", "x-error-id": "fixture" } })
        : new Response("recovered");
    });
    expect(await (await post(proxy(fixture.url.toString()))).text()).toBe("recovered");
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(950);
    const always = upstream(() => new Response("rate limit", { status: 429, headers: { "retry-after": "2", "x-error-id": "fixture" } }));
    const exhausted = await post(proxy(always.url.toString(), { maxAttempts: 1 }));
    expect(exhausted.headers.get("retry-after")).toBe("2");
    expect(exhausted.headers.get("x-error-id")).toBe("fixture");
    await exhausted.text();
  });

  test("honors HTTP-date Retry-After", async () => {
    const times: number[] = [];
    const date = new Date(Date.now() + 1500).toUTCString();
    const expectedWait = Date.parse(date) - Date.now();
    const fixture = upstream(() => {
      times.push(Date.now());
      return times.length === 1 ? new Response("rate limit", { status: 429, headers: { "retry-after": date } }) : new Response("ok");
    });
    expect(await (await post(proxy(fixture.url.toString()))).text()).toBe("ok");
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(expectedWait - 50);
  });

  test.each([false, true])("deadline stops backoff without an extra attempt (stream=%s)", async (stream) => {
    const fixture = probe("rate422", { deadlineMs: 60, baseDelayMs: 1000, maxDelayMs: 1000 });
    const started = Date.now();
    const response = await post(fixture.proxy, { ...message, stream });
    await response.text();
    expect(Date.now() - started).toBeLessThan(350);
    expect(fixture.requests.length).toBe(1);
    expect(response.status).toBe(stream ? 200 : 422);
  });

  test("deadline includes the first upstream call", async () => {
    const fixture = upstream(async () => { await Bun.sleep(150); return new Response("late"); });
    const started = Date.now();
    const response = await post(proxy(fixture.url.toString(), { deadlineMs: 40 }));
    expect(response.status).toBe(504);
    await response.text();
    expect(Date.now() - started).toBeLessThan(300);
  });

  test("the retry deadline does not truncate an accepted healthy stream", async () => {
    const fixture = upstream(() => streamResponse([content, "event: response.completed\ndata: {}\n\n"], 60));
    const response = await post(proxy(fixture.url.toString(), { deadlineMs: 30, upstreamTimeoutMs: 1000 }), { stream: true }, "/v1/responses");
    expect(await response.text()).toContain("response.completed");
  });
});

describe("SSE inspection and recovery", () => {
  test("retries a complete error even when its event and data arrive separately", async () => {
    let hits = 0;
    const fixture = upstream(() => ++hits === 1
      ? streamResponse(["event:error\r\n", 'data: {"type":"error",\r\ndata: "message":"rate limit exceeded"}\r\n\r\n'], 25)
      : streamResponse([content]));
    const response = await post(proxy(fixture.url.toString()), { stream: true }, "/v1/responses");
    expect(await response.text()).toContain("HELLO");
    expect(hits).toBe(2);
  });

  test("detects a data-only error by its type", async () => {
    let hits = 0;
    const fixture = upstream(() => streamResponse([++hits === 1 ? 'data: {"type":"error","message":"rate limit"}\n\n' : content]));
    expect(await (await post(proxy(fixture.url.toString()))).text()).toContain("HELLO");
    expect(hits).toBe(2);
  });

  test.each([200, 422])("retries service-unavailable errors carried under HTTP %s", async (status) => {
    let hits = 0;
    const text = "Upstream service unavailable [trace_id=fixture]";
    const fixture = upstream(() => {
      if (++hits > 1) return streamResponse([content]);
      return status === 200
        ? streamResponse([`event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: text })}\n\n`])
        : new Response(JSON.stringify({ error: { type: "proxy_error", message: text } }), {
            status, headers: { "content-type": "application/json" },
          });
    });
    const response = await post(proxy(fixture.url.toString()), { stream: true }, "/v1/responses");
    expect(await response.text()).toContain("HELLO");
    expect(hits).toBe(2);
  });

  test("never replays a late error coalesced with content", async () => {
    let hits = 0;
    const fixture = upstream(() => { hits++; return streamResponse([content + errorFrame]); });
    const response = await post(proxy(fixture.url.toString()), { stream: true }, "/v1/responses");
    expect(await response.text()).toBe(content + errorFrame);
    expect(hits).toBe(1);
  });

  test("passes a non-retryable SSE error through unchanged", async () => {
    let hits = 0;
    const text = 'event: error\ndata: {"type":"invalid_request_error","message":"invalid rate limit parameter"}\n\n';
    const fixture = upstream(() => { hits++; return streamResponse([text]); });
    expect(await (await post(proxy(fixture.url.toString()))).text()).toBe(text);
    expect(hits).toBe(1);
  });

  test("can disable SSE inspection", async () => {
    const fixture = probe("sse200limit", { inspectSse: false });
    const response = await post(fixture.proxy, { stream: true }, "/v1/responses");
    expect(await response.text()).toContain("too_many_requests");
    expect(fixture.requests.length).toBe(1);
  });

  test("exhausted HTTP 200 SSE errors are not HTTP 200 for a non-streaming client", async () => {
    const fixture = probe("sse200limit");
    const response = await post(fixture.proxy, { stream: false }, "/v1/responses");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("too_many_requests");
    expect(fixture.requests.length).toBe(3);
  });

  test.each(["/v1/messages", "/v1/responses"])("uses the right keepalive and error envelope for %s", async (path) => {
    const fixture = probe("rate422", { baseDelayMs: 30, maxDelayMs: 30, maxAttempts: 2 });
    const response = await post(fixture.proxy, { stream: true }, path);
    const text = await response.text();
    const data = JSON.parse(text.split("event: error\ndata: ")[1].trim());
    if (path === "/v1/responses") {
      expect(text).toContain(": keepalive\n\n");
      expect(text).not.toContain("event: ping");
      expect(data.code).toBe("rate_limit_exceeded");
      expect(data.error).toBeUndefined();
    } else {
      expect(text).toContain("event: ping");
      expect(data.error.type).toBe("rate_limit_error");
    }
  });

  test("does not insert keepalives between recovered partial frames", async () => {
    let hits = 0;
    const fixture = upstream(() => ++hits === 1 ? new Response("rate limit", { status: 422 }) : streamResponse(["event: response.output_text.delta\n", content.split("\n").slice(1).join("\n")], 30));
    const response = await post(proxy(fixture.url.toString(), { inspectSse: false, baseDelayMs: 20, maxDelayMs: 20 }), { stream: true }, "/v1/responses");
    const text = await response.text();
    expect(text).toContain(": keepalive");
    expect(text.slice(text.indexOf("event: response.output_text.delta"))).toBe(content);
  });

  test("converts a later deterministic HTTP error to SSE after streaming headers were sent", async () => {
    let hits = 0;
    const fixture = upstream(() => ++hits === 1 ? new Response("rate limit", { status: 422 }) : new Response("invalid request shape", { status: 400 }));
    const response = await post(proxy(fixture.url.toString()), { stream: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"message":"invalid request shape"');
    expect(hits).toBe(2);
  });

  test("turns a redirect after retries begin into an SSE error", async () => {
    let hits = 0;
    const fixture = upstream(() => ++hits === 1
      ? new Response("rate limit", { status: 429 })
      : new Response(null, { status: 307, headers: { location: "https://example.invalid/new-endpoint" } }));
    const response = await post(proxy(fixture.url.toString()), { stream: true }, "/v1/responses");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).toContain("HTTP 307 redirect to https://example.invalid/new-endpoint");
    expect(hits).toBe(2);
  });

  test("does not label a before-output failure as a rate limit", async () => {
    const fixture = probe("beforeoutput", { maxAttempts: 1 });
    const response = await post(fixture.proxy, { stream: true });
    const payload = JSON.parse((await response.text()).split("event: error\ndata: ")[1].trim());
    expect(payload.error.type).toBe("api_error");
  });

  test("forwards an undecidable prefix beyond the inspection limit intact", async () => {
    const text = ": " + "x".repeat(70_000) + "\n\n" + content;
    const fixture = upstream(() => streamResponse([text]));
    expect(await (await post(proxy(fixture.url.toString()))).text()).toBe(text);
  });
});

describe("stale reasoning", () => {
  const signature = "ccswitch-openai-reasoning-v1:fixture";
  const body = {
    ...message,
    messages: [{ role: "assistant", content: [
      { type: "thinking", thinking: "private", signature },
      { type: "redacted_thinking", data: signature },
      { type: "text", text: "keep", signature },
      { type: "tool_use", id: "call_1", name: "test", input: {} },
      { type: "thinking", thinking: "native", signature: "native-signature" },
    ] }],
  };

  test.each(["azureres", "azureres2"])("strips only bridge carriers and recovers from %s", async (mode) => {
    const fixture = probe(mode);
    expect(await (await post(fixture.proxy, body)).text()).toContain("AZURE_RECOVERED");
    expect(fixture.requests.length).toBe(2);
    expect(JSON.parse(fixture.requests[1].body).messages[0].content).toEqual([
      { type: "text", text: "keep" },
      { type: "tool_use", id: "call_1", name: "test", input: {} },
      { type: "thinking", thinking: "native", signature: "native-signature" },
    ]);
  });

  test("does not loop when the stripped request is still rejected", async () => {
    const fixture = probe("azurealways");
    const response = await post(fixture.proxy, body);
    expect(response.status).toBe(400);
    await response.text();
    expect(fixture.requests.length).toBe(2);
  });

  test("recovery counts toward max-attempts", async () => {
    const fixture = probe("azurealways", { maxAttempts: 1 });
    const response = await post(fixture.proxy, body);
    expect(response.status).toBe(400);
    await response.text();
    expect(fixture.requests.length).toBe(1);
  });

  test("does not rewrite unrelated 400 errors or native Responses input", async () => {
    const unrelated = probe("fmt400");
    const response = await post(unrelated.proxy, body);
    expect(response.status).toBe(400);
    await response.text();
    expect(unrelated.requests[0].body).toBe(JSON.stringify(body));
    const native = probe("azurealways");
    const input = { input: [{ type: "reasoning", encrypted_content: signature }] };
    const rejected = await post(native.proxy, input, "/v1/responses");
    expect(rejected.status).toBe(400);
    await rejected.text();
    expect(native.requests.length).toBe(1);
    expect(native.requests[0].body).toBe(JSON.stringify(input));
  });
});

describe("large-request gate and cancellation", () => {
  const large = (id: string) => ({ id, input: "x".repeat(200) });

  test("holds a permit through response drain while small requests bypass it", async () => {
    const order: string[] = [];
    let ended = 0;
    let secondStarted = 0;
    const fixture = upstream(async (req) => {
      const { id } = await req.json();
      order.push(id);
      if (id === "second") secondStarted = Date.now();
      if (id !== "first") return new Response(id);
      let cancelled = false;
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("first"));
          await Bun.sleep(100);
          ended = Date.now();
          if (!cancelled) controller.close();
        },
        cancel() { cancelled = true; },
      }));
    });
    const server = proxy(fixture.url.toString(), { bigCtxTokens: 20 });
    const first = await post(server, large("first"));
    const second = post(server, large("second"));
    expect(await (await post(server, { id: "small" })).text()).toBe("small");
    expect(await first.text()).toBe("first");
    expect(await (await second).text()).toBe("second");
    expect(order).toEqual(["first", "small", "second"]);
    expect(secondStarted).toBeGreaterThanOrEqual(ended);
  });

  test("removes cancelled requests from the queue", async () => {
    const ids: string[] = [];
    const fixture = upstream(async (req) => {
      const { id } = await req.json();
      ids.push(id);
      if (id === "first") await Bun.sleep(150);
      return new Response(id);
    });
    const server = proxy(fixture.url.toString(), { bigCtxTokens: 20 });
    const first = post(server, large("first"));
    await until(() => ids.length === 1);
    const abort = new AbortController();
    const cancelled = post(server, large("cancelled"), "/v1/messages", abort.signal).then(() => false, () => true);
    await Bun.sleep(20);
    abort.abort();
    expect(await cancelled).toBe(true);
    const third = post(server, large("third"));
    await (await first).text();
    expect(await (await third).text()).toBe("third");
    expect(ids).toEqual(["first", "third"]);
  });

  test("queued requests have a deadline and never reach upstream after it", async () => {
    const ids: string[] = [];
    const fixture = upstream(async (req) => {
      const { id } = await req.json();
      ids.push(id);
      return id === "first" ? streamResponse([content, content], 90) : new Response(id);
    });
    const server = proxy(fixture.url.toString(), { bigCtxTokens: 20, deadlineMs: 50 });
    const first = await post(server, large("first"));
    const queued = await post(server, large("queued"));
    expect(queued.status).toBe(504);
    await queued.text();
    await first.text();
    expect(ids).toEqual(["first"]);
  });

  test("a disconnect stops retries and releases the permit", async () => {
    const ids: string[] = [];
    const fixture = upstream(async (req) => {
      const { id } = await req.json();
      ids.push(id);
      return id === "cancel" ? new Response("rate limit", { status: 422 }) : new Response(id);
    });
    const server = proxy(fixture.url.toString(), { bigCtxTokens: 20, baseDelayMs: 150, maxDelayMs: 150 });
    const abort = new AbortController();
    const response = await post(server, { ...large("cancel"), stream: true }, "/v1/messages", abort.signal);
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    const next = await post(server, large("next"));
    expect(await next.text()).toBe("next");
    await Bun.sleep(180);
    expect(ids).toEqual(["cancel", "next"]);
  });

  test.each([0, 2])("gate concurrency behaves correctly with threshold=%s", async (threshold) => {
    let active = 0;
    let peak = 0;
    const fixture = upstream(async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(30);
      active--;
      return new Response("ok");
    });
    const server = proxy(fixture.url.toString(), { bigCtxTokens: threshold, bigCtxConcurrency: 2 });
    await Promise.all([1, 2, 3, 4].map(async (id) => (await post(server, large(String(id)))).text()));
    expect(peak).toBe(threshold === 0 ? 4 : 2);
  });
});

describe("review regressions", () => {
  test.each([400, 422, 503])("preserves inspected HTTP %s error bytes", async (status) => {
    const bytes = new Uint8Array([0, 255, 254, 128, 65]);
    const fixture = upstream(() => new Response(bytes, { status, headers: { "content-type": "application/octet-stream" } }));
    const response = await post(proxy(fixture.url.toString()));
    expect(response.status).toBe(status);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("preserves HEAD representation length and encoding", async () => {
    const fixture = upstream(() => new Response(null, { headers: { "content-length": "12345", "content-encoding": "gzip" } }));
    const response = await fetch(proxy(fixture.url.toString()).url, { method: "HEAD" });
    expect(response.headers.get("content-length")).toBe("12345");
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await response.text()).toBe("");
  });

  test("leaves unsupported content encodings and their bytes intact", async () => {
    const bytes = new Uint8Array([0, 255, 254, 128, 65]);
    const fixture = upstream(() => new Response(bytes, { headers: { "content-encoding": "fixture-unsupported" } }));
    const response = await fetch(proxy(fixture.url.toString()).url, { decompress: false });
    expect(response.headers.get("content-encoding")).toBe("fixture-unsupported");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test.each(["gzip", "deflate", "brotli", "zstd"])("decodes supported %s responses explicitly", async (format) => {
    const compressed = await new Response(new Blob(["compressed fixture"]).stream().pipeThrough(new CompressionStream(format as CompressionFormat))).arrayBuffer();
    const fixture = upstream(() => new Response(compressed, { headers: { "content-encoding": format === "brotli" ? "br" : format } }));
    const response = await fetch(proxy(fixture.url.toString()).url, { decompress: false });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("compressed fixture");
  });

  test("decodes stacked encodings in reverse order", async () => {
    const compressed = await new Response(new Blob(["stacked fixture"]).stream()
      .pipeThrough(new CompressionStream("gzip"))
      .pipeThrough(new CompressionStream("brotli" as CompressionFormat))).arrayBuffer();
    const fixture = upstream(() => new Response(compressed, { headers: { "content-encoding": "gzip, br" } }));
    const response = await fetch(proxy(fixture.url.toString()).url, { decompress: false });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("stacked fixture");
  });

  test("inspects compressed SSE errors before retrying", async () => {
    let hits = 0;
    const fixture = upstream(() => new Response(Bun.gzipSync(encoder.encode(++hits === 1 ? errorFrame : content)), {
      headers: { "content-encoding": "gzip", "content-type": "text/event-stream" },
    }));
    expect(await (await post(proxy(fixture.url.toString()), { stream: true }, "/v1/responses")).text()).toContain("HELLO");
    expect(hits).toBe(2);
  });

  test("keeps followed redirects and authorization inside the proxy", async () => {
    const seen: Array<{ path: string; auth: string | null }> = [];
    const logs: string[] = [];
    const fixture = upstream((req) => {
      const path = new URL(req.url).pathname;
      seen.push({ path, auth: req.headers.get("authorization") });
      return path === "/bridge/target" ? new Response("target")
        : new Response(null, { status: 307, headers: { location: new URL("/bridge/target", req.url).toString() } });
    });
    const server = proxy(new URL("/bridge", fixture.url).toString(), {}, (line) => logs.push(line));
    const response = await fetch(new URL("/entry", server.url), { headers: { authorization: "Bearer fixture" } });
    expect(await response.text()).toBe("target");
    expect(new URL(response.url).origin).toBe(server.url.origin);
    expect(seen).toEqual([{ path: "/bridge/entry", auth: "Bearer fixture" }, { path: "/bridge/target", auth: "Bearer fixture" }]);
    expect(logs.filter((line) => line.includes("] attempt"))).toHaveLength(2);
  });

  test("rejects redirects to an unconfigured origin without sending credentials", async () => {
    let targetHits = 0;
    let initialHits = 0;
    const target = upstream(() => { targetHits++; return new Response("unexpected"); });
    const fixture = upstream(() => { initialHits++; return new Response(null, { status: 307, headers: { location: target.url.toString() } }); });
    const response = await fetch(proxy(fixture.url.toString()).url, { headers: { "x-api-key": "fixture" } });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("redirect leaves the configured proxy route");
    expect(initialHits).toBe(1);
    expect(targetHits).toBe(0);
  });

  test("rejects redirects that would switch the selected upstream route", async () => {
    const fixture = upstream((req) => new Response(null, { status: 307, headers: { location: new URL("/responses/other", req.url).toString() } }));
    const server = proxy(new URL("/primary", fixture.url).toString(), { responsesUpstream: new URL("/responses", fixture.url).toString() });
    const response = await post(server, {}, "/v1/responses");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("redirect leaves the configured proxy route");
  });

  test("retains CORS headers on synthetic retry streams", async () => {
    let hits = 0;
    const headers = { "access-control-allow-origin": "https://fixture.example", "access-control-allow-credentials": "true", vary: "Origin" };
    const fixture = upstream(() => ++hits === 1 ? new Response("rate limit", { status: 429, headers }) : streamResponse([content]));
    const response = await post(proxy(fixture.url.toString()), { stream: true });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://fixture.example");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(await response.text()).toContain("HELLO");
  });

  test.each(["/v1/chat/completions", "/custom/stream"])("uses neutral keepalives for %s", async (path) => {
    let hits = 0;
    const chat = 'data: {"choices":[{"delta":{"content":"HELLO"}}]}\n\n';
    const fixture = upstream(() => ++hits === 1 ? new Response("rate limit", { status: 429 }) : streamResponse([chat]));
    const response = await post(proxy(fixture.url.toString(), { baseDelayMs: 30, maxDelayMs: 30 }), { stream: true }, path);
    const text = await response.text();
    expect(text).toContain(": keepalive");
    expect(text).not.toContain("event: ping");
    expect(text).toContain(chat);
  });

  test("uses a Chat Completions error object rather than a Messages event", async () => {
    const fixture = upstream(() => new Response("rate limit", { status: 429 }));
    const response = await post(proxy(fixture.url.toString(), { maxAttempts: 1 }), { stream: true }, "/v1/chat/completions");
    const text = await response.text();
    expect(text).not.toContain("event:");
    expect(JSON.parse(text.slice("data: ".length)).error.type).toBe("rate_limit_error");
  });

  test.each(["/v1/messages", "/v1/responses", "/v1/chat/completions"])("keeps invalid-request precedence in %s errors", async (path) => {
    let hits = 0;
    const fixture = upstream(() => ++hits === 1 ? new Response("rate limit", { status: 429 })
      : new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "invalid rate limit parameter" } }), { status: 422 }));
    const text = await (await post(proxy(fixture.url.toString()), { stream: true }, path)).text();
    const frame = text.split("\n\n").find((value) => value.startsWith("event: error") || value.startsWith('data: {"error":'))!;
    const payload = JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
    expect(path === "/v1/responses" ? payload.code : payload.error.type).toBe("invalid_request_error");
    expect(hits).toBe(2);
  });

  test.each([[401, "authentication_error"], [403, "permission_error"], [404, "not_found_error"], [413, "request_too_large"]])(
    "maps final HTTP %s to %s", async (status, type) => {
      let hits = 0;
      const fixture = upstream(() => ++hits === 1 ? new Response("rate limit", { status: 429 }) : new Response("deterministic failure", { status: status as number }));
      const text = await (await post(proxy(fixture.url.toString()), { stream: true })).text();
      expect(JSON.parse(text.split("event: error\ndata: ")[1]).error.type).toBe(type);
    });

  test("extracts the actual SSE error after a long preamble", async () => {
    const preamble = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "x".repeat(300) } })}\n\n`;
    const failure = 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_error","message":"Upstream service unavailable [trace_id=fixture]"}}}\n\n';
    const fixture = upstream(() => streamResponse([preamble + failure]));
    const text = await (await post(proxy(fixture.url.toString(), { maxAttempts: 1 }), { stream: true }, "/v1/responses")).text();
    const error = JSON.parse(text.split("event: error\ndata: ")[1]);
    expect(error.message).toBe("Upstream service unavailable [trace_id=fixture]");
    expect(error.code).toBe("server_error");
  });

  test("retries an early failure after response.queued", async () => {
    let hits = 0;
    const queued = 'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.queued\ndata: {"type":"response.queued"}\n\n';
    const fixture = upstream(() => streamResponse([++hits === 1 ? queued + errorFrame : content]));
    expect(await (await post(proxy(fixture.url.toString()), { stream: true }, "/v1/responses")).text()).toContain("HELLO");
    expect(hits).toBe(2);
  });

  test("keeps the deadline and pings active while reading a final HTTP error", async () => {
    let hits = 0;
    const fixture = upstream(() => ++hits === 1 ? new Response("rate limit", { status: 429 })
      : new Response(streamResponse(["partial failure", "tail"], 250).body, { status: 401 }));
    const server = proxy(fixture.url.toString(), { deadlineMs: 120, upstreamTimeoutMs: 1000 });
    const start = Date.now();
    const text = await (await post(server, { stream: true })).text();
    expect(Date.now() - start).toBeLessThan(400);
    expect(text).toContain("event: ping");
    expect(text).toContain("retry deadline exceeded");
    expect(hits).toBe(2);
  });

  test("reports per-attempt timeouts as HTTP 504", async () => {
    const fixture = upstream(async () => { await Bun.sleep(100); return new Response("late"); });
    const response = await post(proxy(fixture.url.toString(), { upstreamTimeoutMs: 20, deadlineMs: 500, maxAttempts: 1 }));
    expect(response.status).toBe(504);
    expect((await response.json()).error.message).toContain("timed out");
  });

  test("preserves numeric tokens when removing stale reasoning", async () => {
    const bodies: string[] = [];
    const fixture = upstream(async (req) => {
      bodies.push(await req.text());
      return bodies.length === 1 ? new Response("The requested item was created under a different deployment", { status: 400 }) : new Response("recovered");
    });
    const body = '{"max_tokens":16,"messages":[{"role":"assistant","content":[{"type":"thinking","signature":"ccswitch-openai-reasoning-v1:fixture"},{"type":"tool_use","id":"t","name":"lookup","input":{"id":9007199254740993,"decimal":0.123456789012345678901,"negative_zero":-0}}]}]}';
    const response = await fetch(new URL("/v1/messages", proxy(fixture.url.toString()).url), { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(await response.text()).toBe("recovered");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('"id":9007199254740993');
    expect(bodies[1]).toContain('"decimal":0.123456789012345678901');
    expect(bodies[1]).toContain('"negative_zero":-0');
    expect(bodies[1]).not.toContain("ccswitch-openai-reasoning");
  });

  test("the slow probe survives Bun's default idle timeout", async () => {
    const fixture = createProbeServer({ port: 0, gapMs: 0, slowMs: 13_000, quiet: true });
    servers.push(fixture.server);
    const response = await fetch(new URL("/slow75", fixture.server.url));
    expect(await response.text()).toContain("SLOW_OK");
  }, 20_000);
});

describe("additional review edge cases", () => {
  test("does not turn a double-slash redirect path into an external origin", async () => {
    const fixture = upstream((req) => new Response(null, { status: 307, headers: { location: new URL("/bridge//example.invalid/target", req.url).toString() } }));
    const server = proxy(new URL("/bridge", fixture.url).toString());
    const response = await fetch(server.url, { redirect: "manual" });
    const target = new URL(response.headers.get("location")!, server.url);
    expect(target.origin).toBe(server.url.origin);
    expect(target.pathname).toBe("//example.invalid/target");
    await response.text();
  });

  test("preserves an explicit upstream error type and code after retries", async () => {
    for (const path of ["/v1/messages", "/v1/responses"]) {
      let hits = 0;
      const fixture = upstream(() => ++hits === 1 ? new Response("rate limit", { status: 429 })
        : Response.json({ error: { type: "permission_error", code: "policy_rejected", message: "policy does not allow this request" } }, { status: 500 }));
      const text = await (await post(proxy(fixture.url.toString()), { stream: true }, path)).text();
      const payload = JSON.parse(text.split("event: error\ndata: ")[1]);
      expect(path === "/v1/messages" ? payload.error.type : payload.code).toBe(path === "/v1/messages" ? "permission_error" : "policy_rejected");
    }
  });

  test("skips reasoning recovery rather than rounding numbers without raw JSON support", async () => {
    const json = JSON as typeof JSON & { rawJSON?: (text: string) => unknown };
    const original = json.rawJSON;
    const fixture = probe("azurealways");
    const body = { max_tokens: 16, messages: [{ role: "assistant", content: [{ type: "thinking", signature: "ccswitch-openai-reasoning-v1:fixture" }] }] };
    try {
      json.rawJSON = undefined;
      const response = await post(fixture.proxy, body);
      expect(response.status).toBe(400);
      await response.text();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0].body).toBe(JSON.stringify(body));
    } finally { json.rawJSON = original; }
  });
});

test("rejects a redirect to an upstream base root the proxy cannot address", async () => {
  let hits = 0;
  const fixture = upstream((req) => { hits++; return new Response(null, { status: 301, headers: { location: new URL("/bridge", req.url).toString() } }); });
  const response = await fetch(proxy(new URL("/bridge", fixture.url).toString()).url);
  expect(response.status).toBe(502);
  expect(hits).toBe(1);
  await response.text();
});
