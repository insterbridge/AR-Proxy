#!/usr/bin/env bash
# Throwaway smoke test for tools/agentrouter-retry-proxy/proxy.ts
set -uo pipefail
cd "$(dirname "$0")"

PASS=0
FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

PROBE_PORT=15722
PROXY_PORT=15723
PROXY=./proxy.ts

sleep 0.5

nohup bun run ./probe-server.ts > /tmp/smoke-probe.log 2>&1 < /dev/null &
PROBE_PID=$!
nohup bun run "$PROXY" --port $PROXY_PORT --upstream http://127.0.0.1:$PROBE_PORT \
  --base-delay 300 --max-delay 800 --keepalive 100 --max-attempts 3 \
  > /tmp/smoke-proxy.log 2>&1 < /dev/null &
PROXY_PID=$!
trap 'kill "$PROBE_PID" "$PROXY_PID" 2>/dev/null' EXIT
sleep 1.5

if ! curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/ping"; then bad "probe server up"; exit 1; fi
if ! curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROXY_PORT/ping"; then bad "retry proxy up"; exit 1; fi
ok "servers up"

MSG='{"model":"fable","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
STREAM_MSG='{"model":"fable","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}'

# 1. healthy non-streaming request passes through
out=$(curl -s -m 10 -o /tmp/o1 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/ok/v1/messages" -H 'content-type: application/json' -d "$MSG")
if [ "$out" = "200" ] && grep -q PROBE_OK /tmp/o1; then ok "healthy non-stream passthrough (200, body intact)"; else bad "healthy non-stream (got $out: $(head -c 120 /tmp/o1))"; fi

# 2. healthy streaming request passes through chunked
out=$(curl -s -N -m 15 -o /tmp/o2 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/ok/v1/messages" -H 'content-type: application/json' -d "$STREAM_MSG")
if [ "$out" = "200" ] && grep -q PROBE_OK /tmp/o2 && grep -q 'event: message_stop' /tmp/o2; then ok "healthy stream passthrough (SSE intact)"; else bad "healthy stream (got $out: $(head -c 200 /tmp/o2))"; fi

# 3. genuine 422 format error is NOT retried (single upstream hit)
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
before=$(grep -c 'mode=fmt422' /tmp/smoke-probe.log)
out=$(curl -s -m 10 -o /tmp/o3 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/fmt422/v1/messages" -H 'content-type: application/json' -d "$MSG")
after=$(grep -c 'mode=fmt422' /tmp/smoke-probe.log)
if [ "$out" = "422" ] && [ "$((after-before))" = "1" ] && grep -q "unknown parameter 'foo'" /tmp/o3; then ok "format 422 not retried (1 attempt, body intact)"; else bad "format 422 (status $out, attempts $((after-before)))"; fi

# 4. rate-limit 422 non-streaming retries and recovers
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
out=$(curl -s -m 20 -o /tmp/o4 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/flaky422/v1/messages" -H 'content-type: application/json' -d "$MSG")
hits=$(grep -c 'flaky422 request' /tmp/smoke-probe.log)
if [ "$out" = "200" ] && grep -q RECOVERED /tmp/o4 && [ "$hits" = "3" ]; then ok "rate-limit 422 non-stream retried -> 200 after 3 attempts"; else bad "non-stream retry (status $out, hits $hits: $(head -c 150 /tmp/o4))"; fi

# 5. rate-limit 422 streaming: keepalive pings during backoff, then recovery
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
out=$(curl -s -N -m 20 -o /tmp/o5 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/flaky422/v1/messages" -H 'content-type: application/json' -d "$STREAM_MSG")
if [ "$out" = "200" ] && grep -q RECOVERED /tmp/o5 && grep -q 'event: ping' /tmp/o5 && grep -q 'event: message_stop' /tmp/o5; then
  ok "rate-limit 422 stream: 200 SSE, keepalive pings sent, upstream stream spliced"
else
  bad "stream retry (status $out: $(head -c 300 /tmp/o5))"
fi

# 6. exhausting retries surfaces the last upstream 422
out=$(curl -s -m 20 -o /tmp/o6 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/rate422/v1/messages" -H 'content-type: application/json' -d "$MSG")
hits=$(grep -c 'mode=rate422' /tmp/smoke-probe.log)
if [ "$out" = "422" ] && grep -q too_many_requests /tmp/o6 && [ "$hits" = "3" ]; then ok "exhausted retries return last upstream 422 body"; else bad "exhaustion (status $out, hits $hits)"; fi

# 6b. "Responses upstream failed before output" carries no rate-limit wording but
#     is transient (stream aborted before any event), so it must be retried.
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
out=$(curl -s -m 20 -o /tmp/o6b -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/flakybefore/v1/messages" -H 'content-type: application/json' -d "$MSG")
hits=$(grep -c 'flakybefore request' /tmp/smoke-probe.log)
if [ "$out" = "200" ] && grep -q RECOVERED_BEFORE_OUTPUT /tmp/o6b && [ "$hits" = "2" ]; then ok "before-output 422 retried -> 200 after 2 attempts"; else bad "before-output retry (status $out, hits $hits: $(head -c 150 /tmp/o6b))"; fi

# 6c. peak-load rejection ("experiencing high demand") must also be retried
out=$(curl -s -m 20 -o /tmp/o6c -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/highdemand/v1/messages" -H 'content-type: application/json' -d "$MSG")
hits=$(grep -c 'mode=highdemand' /tmp/smoke-probe.log)
if [ "$out" = "422" ] && [ "$hits" = "3" ]; then ok "peak-load 422 retried (3 attempts before exhaustion)"; else bad "high-demand retry (status $out, hits $hits)"; fi

# 6d. 502 "upstream connect failed" is transient -> retried, then recovers
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
out=$(curl -s -m 25 -o /tmp/o6d -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/flakyconn/v1/messages" -H 'content-type: application/json' -d "$MSG")
hits=$(grep -c 'flakyconn request' /tmp/smoke-probe.log)
if [ "$out" = "200" ] && grep -q RECOVERED_CONN /tmp/o6d && [ "$hits" = "3" ]; then ok "502 connect failure retried -> 200 after 3 attempts"; else bad "502 retry (status $out, hits $hits: $(head -c 150 /tmp/o6d))"; fi

# 6e. 503 "service unavailable" is transient -> retried until exhaustion
out=$(curl -s -m 25 -o /tmp/o6e -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/unavail503/v1/messages" -H 'content-type: application/json' -d "$MSG")
hits=$(grep -c 'mode=unavail503' /tmp/smoke-probe.log)
if [ "$out" = "503" ] && [ "$hits" = "3" ]; then ok "503 unavailable retried (3 attempts before exhaustion)"; else bad "503 retry (status $out, hits $hits)"; fi

# 6f. a 502 carrying a deterministic rejection must NOT be retried
out=$(curl -s -m 25 -o /tmp/o6f -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/reject502/v1/messages" -H 'content-type: application/json' -d "$MSG")
hits=$(grep -c 'mode=reject502' /tmp/smoke-probe.log)
if [ "$out" = "502" ] && [ "$hits" = "1" ]; then ok "non-transient 502 not retried (1 attempt)"; else bad "reject502 (status $out, hits $hits)"; fi

# 6g. HTTP 200 whose SSE body opens with a rate-limit error event is retried.
#     AgentRouter reports Responses-API token limits this way, so a status-only
#     check would hand the client a "successful" stream that contains an error.
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
out=$(curl -s -N -m 25 -o /tmp/o6g -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/flakysse200/v1/responses" \
  -H 'content-type: application/json' -d '{"model":"gpt-6.1-sol","stream":true,"input":"hi"}')
hits=$(grep -c 'flakysse200 request' /tmp/smoke-probe.log)
if [ "$out" = "200" ] && grep -q RECOVERED_SSE /tmp/o6g && grep -q 'event: response.completed' /tmp/o6g && [ "$hits" = "2" ]; then
  ok "200-with-error-frame retried -> recovered SSE (2 attempts)"
else
  bad "sse200 retry (status $out, hits $hits: $(head -c 200 /tmp/o6g))"
fi

# 6h. a 200 SSE that is healthy must pass through byte-for-byte (no truncation)
out=$(curl -s -N -m 25 -o /tmp/o6h -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/flakysse200/v1/responses" \
  -H 'content-type: application/json' -d '{"model":"gpt-6.1-sol","stream":true,"input":"hi"}')
if [ "$out" = "200" ] && grep -q 'event: response.created' /tmp/o6h && grep -q RECOVERED_SSE /tmp/o6h && grep -q 'event: response.completed' /tmp/o6h; then
  ok "healthy 200 SSE passes through intact (created -> delta -> completed)"
else
  bad "sse passthrough (status $out: $(head -c 200 /tmp/o6h))"
fi

# 7. exhaustion on a streaming request degrades to an Anthropic error event
out=$(curl -s -N -m 20 -o /tmp/o7 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/rate422/v1/messages" -H 'content-type: application/json' -d "$STREAM_MSG")
if [ "$out" = "200" ] && grep -q 'event: error' /tmp/o7 && grep -q too_many_requests /tmp/o7; then ok "stream exhaustion emits Anthropic error event"; else bad "stream exhaustion (status $out: $(head -c 200 /tmp/o7))"; fi

# 9. stale-reasoning: 400 "different backend resource" strips bridge items once and recovers
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
python3 - <<'PYEOF'
import json
body = {"model":"m","stream":True,"messages":[
  {"role":"user","content":"hi"},
  {"role":"assistant","content":[
    {"type":"thinking","thinking":"t","signature":"ccswitch-openai-reasoning-v1:eyJ0eXBlIjoicmVhc29uaW5nIn0"},
    {"type":"text","text":"ok"}]},
  {"role":"user","content":"again"}]}
open("/tmp/smoke-azure.json","w").write(json.dumps(body))
PYEOF
out=$(curl -s -N -m 20 -o /tmp/o9 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/azureres/v1/messages" -H 'content-type: application/json' --data-binary @/tmp/smoke-azure.json)
if [ "$out" = "200" ] && grep -q AZURE_RECOVERED /tmp/o9 && grep -q "stale-reasoning" /tmp/smoke-proxy.log; then ok "stale-reasoning 400 stripped and recovered (200)"; else bad "stale-reasoning recovery (status $out)"; fi

# 10. stale-reasoning must not loop: always-400 yields exactly 2 upstream hits
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
before=$(grep -c 'mode=azurealways' /tmp/smoke-probe.log)
out=$(curl -s -m 20 -o /tmp/o10 -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/azurealways/v1/messages" -H 'content-type: application/json' --data-binary @/tmp/smoke-azure.json)
after=$(grep -c 'mode=azurealways' /tmp/smoke-probe.log)
if [ "$out" = "400" ] && [ "$((after-before))" = "2" ] && grep -q "different Azure OpenAI resource" /tmp/o10; then ok "stale-reasoning retries once then passes the real 400 through"; else bad "stale-reasoning no-loop (status $out, hits $((after-before)))"; fi

# 11. unrelated 400 must not trigger the strip path
curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PROBE_PORT/reset"
before=$(grep -c "stale-reasoning" /tmp/smoke-proxy.log)
out=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PROXY_PORT/fmt422/v1/messages" -H 'content-type: application/json' --data-binary @/tmp/smoke-azure.json)
after=$(grep -c "stale-reasoning" /tmp/smoke-proxy.log)
if [ "$out" = "422" ] && [ "$before" = "$after" ]; then ok "non-resource error does not trigger stale-reasoning handling"; else bad "stale-reasoning misfire (status $out, log delta $((after-before)))"; fi

echo "--- retry proxy log ---"
cat /tmp/smoke-proxy.log
echo "--- $PASS passed, $FAIL failed ---"
exit $FAIL
