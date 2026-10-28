// Test upstream for the retry proxy. Path prefix selects behaviour:
//   /ok/...        valid Anthropic SSE, 3 chunks 250ms apart (streaming pass-through)
//   /flaky422/...  first 2 requests -> 422 rate-limit JSON, then recovers
//   /rate422/...   always 422 rate-limit JSON
//   /fmt422/...    always 422 format-error JSON (must NOT be retried)
//   /slow75/...    waits 75s, then 200 SSE
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const counters = new Map<string, number>();
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
  const body = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        if (gapMs) await sleep(gapMs);
      }
      controller.close();
    },
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

Bun.serve({
  hostname: "127.0.0.1",
  port: 15722,
  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const mode = parts[0] ?? "ok";
    const body = await req.text();
    log(`HIT mode=${mode} ${req.method} ${url.pathname} len=${body.length} auth=${req.headers.get("authorization")} xapikey=${req.headers.get("x-api-key")} accept-encoding=${req.headers.get("accept-encoding")}`);

    if (mode === "reset") {
      counters.clear();
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
      // AgentRouter aborts the SSE stream before emitting any event; cc-switch
      // reports it without a rate-limit phrase. Transient, so it must be retried.
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
      // AgentRouter's Responses wire reports token limits as HTTP 200 followed by
      // an error event. A status-only check treats this as success.
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
      // Always reject, even with no bridge items: proves the strip runs at most
      // once per request and cannot loop.
      return jsonError(
        400,
        'OpenAI Responses bad request: The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it. [trace_id=deadbeef]',
      );
    }
    if (mode === "azureres" || mode === "azureres2") {
      // Reject the first request whose body still carries bridge reasoning items;
      // succeed once they have been stripped.
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
    if (mode === "fmt422") {
      return jsonError(422, "格式转换错误: Responses upstream returned a 2xx failure: invalid_request_error: unknown parameter 'foo'");
    }
    if (mode === "slow75") {
      await sleep(75000);
      return sseResponse("SLOW_OK", 0);
    }
    return sseResponse("PROBE_OK", 250);
  },
});
log("probe listening on http://127.0.0.1:15722");
