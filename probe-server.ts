// Local test upstream. The first path segment selects a failure or recovery case.
// No provider credentials or external connections are needed.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sseChunks = (text: string) => [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_probe", type: "message", role: "assistant", model: "probe-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
];

function sseResponse(text: string, gapMs: number): Response {
  const encoder = new TextEncoder();
  const chunks = sseChunks(text);
  let cancelled = false;
  const body = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (cancelled) return;
        controller.enqueue(encoder.encode(chunk));
        if (gapMs) await sleep(gapMs);
      }
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "proxy_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type ProbeRequest = { mode: string; method: string; path: string; body: string; headers: Headers };

export function createProbeServer({ port = 15722, gapMs = 250, slowMs = 75_000, quiet = false } = {}) {
  const counters = new Map<string, number>();
  const requests: ProbeRequest[] = [];
  const log = (message: string) => {
    if (!quiet) console.log(`${new Date().toISOString()} ${message}`);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const mode = parts[0] ?? "ok";
      const body = await req.text();
      requests.push({ mode, method: req.method, path: `${url.pathname}${url.search}`, body, headers: new Headers(req.headers) });
      log(`HIT mode=${mode} ${req.method} ${url.pathname} len=${body.length} auth=${req.headers.has("authorization")} xapikey=${req.headers.has("x-api-key")}`);

      if (mode === "reset") {
        counters.clear();
        requests.length = 0;
        return new Response("ok");
      }
      if (mode === "flaky422") {
        const n = (counters.get("flaky") ?? 0) + 1;
        counters.set("flaky", n);
        log(`  flaky422 request #${n}`);
        if (n <= 2) {
          return jsonError(422, "请求/响应转换错误: Responses upstream too_many_requests: Your requests to gpt-6-astra for *** in *** have exceeded token rate limit.");
        }
        return sseResponse("RECOVERED", 0);
      }
      if (mode === "rate422") {
        return jsonError(422, "格式转换错误: Responses upstream too_many_requests: Your requests to gpt-6-astra for *** in *** have exceeded token rate limit.");
      }
      if (mode === "beforeoutput") {
        // A converter can report an interrupted stream without rate-limit wording.
        return jsonError(422, "格式转换错误: Responses upstream failed: Responses upstream failed before output");
      }
      if (mode === "flakybefore") {
        const n = (counters.get("before") ?? 0) + 1;
        counters.set("before", n);
        log(`  flakybefore request #${n}`);
        if (n <= 1) {
          return jsonError(422, "格式转换错误: Responses upstream failed: Responses upstream failed before output");
        }
        return sseResponse("RECOVERED_BEFORE_OUTPUT", 0);
      }
      if (mode === "highdemand") {
        return jsonError(422, "格式转换错误: Responses upstream too_many_requests: The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load.");
      }
      if (mode === "connfail") {
        // cc-switch cannot reach the upstream at all.
        return jsonError(502, "请求转发失败: 上游连接失败: error sending request");
      }
      if (mode === "flakyconn") {
        const n = (counters.get("conn") ?? 0) + 1;
        counters.set("conn", n);
        log(`  flakyconn request #${n}`);
        if (n <= 2) return jsonError(502, "请求转发失败: 上游连接失败: error sending request");
        return sseResponse("RECOVERED_CONN", 0);
      }
      if (mode === "unavail503") {
        return jsonError(503, "Upstream service unavailable [trace_id=3c1a88fd8539a86fd3895b9f53062305]");
      }
      if (mode === "reject502") {
        // 502 that carries a deterministic upstream rejection: must NOT retry.
        return jsonError(502, "Upstream rejected the request as invalid [trace_id=8b251dd360dec9ab571620428e3a9cb1]");
      }
      if (mode === "sse200limit") {
        // Reproduce a rate-limit error carried inside a nominally successful SSE response.
        const enc = new TextEncoder();
        const body = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_x", status: "in_progress" } })}\n\n`));
            c.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "too_many_requests", code: "rate_limit_exceeded", message: "Your requests to gpt-6.1-sol for gpt-6.1-sol in eastus2 have exceeded token rate limit." } })}\n\n`));
            c.enqueue(enc.encode(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { id: "resp_x", status: "failed" } })}\n\n`));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (mode === "flakysse200") {
        const n = (counters.get("sse200") ?? 0) + 1;
        counters.set("sse200", n);
        log(`  flakysse200 request #${n}`);
        const enc = new TextEncoder();
        if (n <= 1) {
          const body = new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_x", status: "in_progress" } })}\n\n`));
              c.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "too_many_requests", code: "rate_limit_exceeded", message: "exceeded token rate limit" } })}\n\n`));
              c.close();
            },
          });
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        const body = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_y", status: "in_progress" } })}\n\n`));
            c.enqueue(enc.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "RECOVERED_SSE" })}\n\n`));
            c.enqueue(enc.encode(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_y", status: "completed" } })}\n\n`));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (mode === "azurealways") {
        // Still reject the stripped payload, to check that recovery cannot loop.
        return jsonError(
          400,
          'OpenAI Responses bad request: The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [trace_id=deadbeef]',
        );
      }
      if (mode === "azureres" || mode === "azureres2") {
        // Recover only after the bridge reasoning items have been removed.
        const hasBridgeItems = body.includes("ccswitch-openai-reasoning-v1:");
        log(`  azureres: bridge items present=${hasBridgeItems}`);
        if (hasBridgeItems) {
          return jsonError(
            400,
            mode === "azureres2"
              ? 'OpenAI Responses bad request: The requested item was created under a different OpenAI resource. Use the same resource that created the item to access it. [trace_id=deadbeef]'
              : 'OpenAI Responses bad request: The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [trace_id=deadbeef]',
          );
        }
        return sseResponse("AZURE_RECOVERED", 0);
      }
      if (mode === "fmt400") {
        return jsonError(400, "No tool call found for function call output with call_id fixture_missing.");
      }
      if (mode === "fmt422") {
        return jsonError(422, "格式转换错误: Responses upstream returned a 2xx failure: invalid_request_error: unknown parameter 'foo'");
      }
      if (mode === "slow75") {
        await sleep(slowMs);
        return sseResponse("SLOW_OK", 0);
      }
      return sseResponse("PROBE_OK", gapMs);
    },
  });
  log(`probe listening on ${server.url}`);
  return { server, requests };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun probe-server.ts [--port <0–65535>] (default 15722)");
  } else {
    try {
      if (args.length && (args.length !== 2 || args[0] !== "--port")) throw new Error("Expected --port <n>");
      const port = args.length ? Number(args[1]) : 15722;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer between 0 and 65535");
      createProbeServer({ port });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
