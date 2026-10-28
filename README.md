# agentrouter-retry-proxy

A retry hop for AgentRouter: it absorbs the rate-limit and transient failures
AgentRouter reports in ways a plain HTTP client cannot see, and it serializes the
oversized requests that cause them.

```
Anthropic harness  ─┐
                    ├─▶ retry hop :15720 ─▶ AgentRouter
OpenAI Responses   ─┘
```

The hop is transport-agnostic: it forwards whatever path it receives and applies
the same retry policy to both wires. It can sit in front of AgentRouter
directly, or behind an intermediate router (see
[One deployment](#one-deployment-cc-switch--claude-code)).

## Install

Requires [Bun](https://bun.sh) (uses `Bun.serve`).

```bash
git clone <this repo> && cd agentrouter-retry-proxy
bun proxy.ts --help          # no build step; proxy.ts runs directly
```

Run it:

```bash
bun proxy.ts                                    # 127.0.0.1:15720 -> 127.0.0.1:15721
bun proxy.ts --upstream https://agentrouter.org # or straight to the provider
bun proxy.ts --big-ctx-tokens 0                 # disable the context gate
```

Then point your harness's base URL at `http://127.0.0.1:15720`.

`claude.sh` is an optional launcher for Claude Code that starts the hop if it is
not already listening and rewrites `--settings` to route through it. If you do
not use Claude Code, ignore it — `proxy.ts` is the whole tool.

## Why it exists

AgentRouter reports token-rate-limit exhaustion *inside* the response payload
rather than as a retryable status. Two distinct shapes show up depending on the
wire:

- **Anthropic wire** (`/v1/messages`): an intermediate router such as cc-switch
  converts the upstream error into `ProxyError::TransformError`, which surfaces
  as HTTP **422 格式转换错误**. Its own failover loop classifies 422 as
  `NonRetryable`, so the error reaches the client on the first attempt.
- **Responses wire** (`/v1/responses`): the status line is **200**, and the
  failure arrives as an SSE `event: error` frame. A status-only check sees
  success.

Measured against `gpt-6.1-sol` (10–14 requests each, plus live session logs),
these failure modes show up:

| upstream behaviour | status seen by client | retried? |
|---|---|---|
| SSE `error` / `rate_limit_exceeded`: “exceeded token rate limit” | 422 | yes |
| SSE `error` / `too_many_requests`: “experiencing high demand … exceeds the maximum usage size” | 422 | yes |
| stream aborted before any event (or `response.failed`) | 422 “Responses upstream **failed before output**” | yes |
| connection could not be established | **502** `请求转发失败: 上游连接失败: error sending request` | yes |
| AgentRouter reports itself down | **503** `Upstream service unavailable [trace_id=…]` | yes |
| HTTP 200 whose SSE body opens with an error frame | **200** | yes |
| 400 “different backend resource” (stale reasoning item) | **400** | yes — once, with the items stripped |
| request shape rejected (orphan tool call, empty content, …) | **400** with a specific message | no — deterministic |

The 422 “failed before output” case occurs roughly 1 in 10 requests, independent
of rate-limit pressure, and carries no rate-limit wording — so it needs its own
signals. It is safe to replay because the message says *before output*: no bytes
reached the client.

**Some 400s are retryable and some are not**, and the status alone cannot tell
you which. A 400 saying the reasoning item was minted by a different backend
resource is recoverable: the payload is at fault, not the conversation, so the
hop strips the offending items and replays once (see
[mechanism 3](#3-stale-reasoning-recovery-400-different-backend-resource)).

The rest are genuinely deterministic. Measured against the live upstream, each
carries a specific cause:

```
No tool output found for function call tu_1.
No tool call found for function call output with call_id tu_missing.
Missing required parameter: 'input[0].content'.
One of 'input' or 'instructions' is required.
```

Retrying those would loop forever — the body is identical every time and nothing
in it is strippable — so they pass through. When a conversation accumulates one
of these, the fix is to change the conversation (drop the dangling tool call) or
restart it, not to retry.

## Three mechanisms

### 1. Retry

- retries only the statuses in `--retry-status` (default 422, 429) **whose body
  matches a rate-limit or transient-failure phrase** (`too_many_requests`,
  `rate limit`, `token rate`, `quota exceeded`, `overloaded`, `failed before
  output`, `experiencing high demand`, …);
- a 422 whose body is a genuine format error passes through untouched, as does
  every other status;
- **502/503/504 are retried regardless of body wording**, because they mean the
  gateway could not complete the call. The exception is a 5xx whose body carries
  `invalid_request_error` / `rejected the request as invalid`: that is a
  deterministic rejection, so it passes through on the first attempt;
- **HTTP 200 with an SSE error frame is retried.** The hop buffers only the
  stream prefix and checks for an `event: error` / `event: response.failed`
  before forwarding. The error always precedes content, so nothing the client
  would act on is lost. Disable with `--no-inspect-sse`;
- exponential backoff with ±25% jitter, `--base-delay` → `--max-delay`, bounded
  by `--max-attempts` and `--deadline`;
- on streaming requests it answers `200 text/event-stream` immediately and emits
  Anthropic `ping` events every `--keepalive` ms while waiting, so client
  first-byte/idle timers never fire during backoff. The retried upstream stream
  is then spliced in verbatim;
- exhausted retries emit an `error` SSE event on streams, and return the last
  upstream status/body **plus a `Retry-After`** on non-streaming requests so the
  client's own loop waits instead of rescheduling at 0s.

### 2. Prevention (the big-context gate)

Detection is slow because AgentRouter queues the request before rejecting it:
measured 3s when the bucket is idle but **100–180s once it is saturated**.
Retrying therefore costs minutes. The limit is a *token* rate limit and context
size is what drives it — measured TTFT for `gpt-6-astra`:

| context | requests | avg TTFT |
|---|---|---|
| < 50k | 47 | 4.5s |
| 50–100k | 44 | 10.6s |
| > 100k | 32 | 48.1s |

So requests whose estimated input exceeds `--big-ctx-tokens` (default 60000,
~4 chars/token over the raw body) are serialized through a semaphore
(`--big-ctx-concurrency`, default 1). Small requests — subagents, titles, cheap
models — bypass the gate entirely and stay parallel.

The gate is **global, not keyed per model**. The hop only sees the client's
model name, and an intermediate router may rewrite it (`claude-fable-5` →
`gpt-6-astra`), so keying on that name would hand two aliases of the same
upstream bucket separate permits and silently disable the gate. Gating globally
is slightly stricter than AgentRouter's per-model limit — the safe direction,
since it can only reduce concurrent load.

The permit is held until the response body has actually drained, not merely
until headers arrive — fetch resolves on headers while the upstream keeps
generating for tens of seconds afterwards.

### 3. Stale-reasoning recovery (400 "different backend resource")

AgentRouter multiplexes across Azure/OpenAI deployments. An intermediate router
may round-trip each OpenAI reasoning item inside a thinking block's `signature`
(prefixed `ccswitch-openai-reasoning-v1:`) so stateless tool loops stay lossless.
When a conversation's earlier turns were served by resource A and a later turn
lands on resource B, the upstream rejects the replay:

```
400 The requested item was created under a different Azure OpenAI resource.
    Use the same resource that created the item to access it.
```

An intermediate router does not recover from this: its thinking rectifier
matches `"invalid request"` (spaced) and never sees `invalid_request_error`
(underscored), and its other patterns are about signature *validity*, not
resource ownership.

The failure is deterministic in the sense that a plain replay would fail
identically — the offending items travel with the conversation, so resending the
same body just reproduces the error. What makes it recoverable is that the
*payload* can be changed: the hop strips every `ccswitch-openai-reasoning-v1:`
carrier — whole `thinking` / `redacted_thinking` blocks plus stray `signature`
fields — and replays **once**. Text and tool calls survive; only the model's
private reasoning is lost, which is the only way forward since that reasoning is
unreadable to anything but the resource that minted it.

If the stripped replay also fails, the real 400 is passed through rather than
looped (verified: exactly 2 upstream hits, never more). This is why the strip
runs at most once per request: an unlimited strip-and-retry would spin forever
against an error it cannot fix.

## Two upstreams

`/v1/messages` and `/v1/responses` can target different upstreams, because an
intermediate router usually speaks only one wire:

```bash
bun proxy.ts --responses-upstream https://agentrouter.org
```

With that flag, `/v1/responses` requests go straight to AgentRouter while
everything else keeps flowing through `--upstream`. Retry policy is identical on
both, which is the point: AgentRouter's Responses wire is where token limits are
reported as 200-plus-error-frame, so routing it through the hop is what makes
those retries possible.

## Responses-API harnesses (Codex and others)

Any harness that speaks the OpenAI Responses API can use the hop. Point its base
URL at the hop and let `--responses-upstream` reach AgentRouter:

```bash
bun proxy.ts --responses-upstream https://agentrouter.org
```

```
harness base URL:  http://127.0.0.1:15720/v1
wire:              OpenAI Responses  (POST /v1/responses)
```

The hop forwards the path unchanged and applies the same retry, backoff, and
context gate as on the Anthropic wire. Nothing about the request body is
rewritten, so a harness sees AgentRouter's SSE events exactly as emitted —
including the 200-plus-error-frame limit reports, which the hop retries before
the harness ever sees them.

This matters for Responses harnesses specifically: because the failure arrives
under a 200 status, a harness that checks `response.ok` alone will treat an
exhausted rate limit as a successful empty turn.

## Client allowlist (401 unauthorized client detected)

AgentRouter gates access on a client allowlist and keys it on the **User-Agent**
header. Requests from an unrecognized client are rejected before the endpoint
matters:

```
401 {"error":{"message":"unauthorized client detected, contact support for
     assistance at https://discord.gg/HgekCyHJqB"},"message":"UNAUTHENTICATED",
     "success":false,"type":"unauthorized_client_error"}
```

This is not a proxy bug and not a bad key: the same token works from a client on
the list. It applies to every route — `/v1/models`, `/v1/chat/completions`,
`/v1/messages`, `/v1/responses` — and cannot be bypassed with another header
(`x-client-name`, `x-app`, `x-title`, `?client=` are all ignored). An
intermediate router forwards the client's `User-Agent` verbatim, so putting one
in the chain does not change the outcome.

If you hit this, set the `User-Agent` header your harness sends to one of the
clients AgentRouter documents as supported — their docs list the current set.
Most harnesses expose this through provider-level headers, so it is usually
configuration rather than a code change.

Two caveats. AgentRouter documents some clients that its allowlist does not
currently accept, so a page existing is not proof the client passes — verify
with a single request before relying on it. And deliberately impersonating a
client you are not is a policy question, not a technical one; the sustainable
fix is asking AgentRouter to allowlist your harness.

The hop does not touch `User-Agent` and never rewrites it — whatever the harness
sends is what reaches AgentRouter.

## Logging

Lines go to stdout and, with `--mirror-log <path>`, are also appended to that
file **in cc-switch's log format** so hop activity sits inline with a router's
own output:

```
[2026-09-30][20:29:25][INFO][agentrouter-retry-proxy] [POST /v1/messages?beta=true] attempt 1 -> 200 in 4.7s ctx=~12k passthrough
```

Each line carries `ctx=~Nk` (estimated input tokens), `queue=Xs` when the gate
made it wait, and attempt timings — enough to see *why* a turn was slow.

## One deployment: cc-switch + Claude Code

This is the setup the project was built for. It is one valid arrangement, not a
requirement — the hop works standalone.

```
Claude Code ──▶ retry hop :15720 ──▶ cc-switch :15721 ──▶ AgentRouter /v1/responses
```

Claude Code speaks the Anthropic Messages API; AgentRouter serves some models
only through the Responses API. cc-switch bridges the two, and the hop absorbs
the failures cc-switch classifies as non-retryable.

Claude Code's `~/.claude/settings.json` `env` block overrides the process
environment, and cc-switch rewrites that block whenever it attaches the proxy.
Do not edit `settings.json` by hand. `claude.sh` covers both launch shapes:

- **no `--settings`** → appends `~/.claude/retry-proxy.json`, which wins over
  `settings.json`.
- **`--settings <file-or-json>`** → rewrites `ANTHROPIC_BASE_URL` inside that
  value. This is what cc-switch's "launch in terminal" button needs: it runs
  `claude --settings <cc-switch temp config>` pointing at its own port, and a
  second `--settings` cannot override it (the later flag wins, and cc-switch's
  comes last). A non-JSON value launches unchanged with a warning.

### Surviving a cc-switch exit

cc-switch has no headless mode. When it quits it rewrites `settings.json` to a
direct upstream URL but leaves `~/.cc-switch/live-state.json` declaring
`"mode": "proxy"`. Launching against that stale direct URL skips the router
*and* the hop, and AgentRouter's Anthropic-compat endpoint then routes
non-Anthropic models through `/v1/chat/completions`:

```
400 Function tools with reasoning_effort are not supported for gpt-6.1-sol
    in /v1/chat/completions. To use function tools, use /v1/responses
```

(`gpt-6.1-sol` advertises `supported_endpoint_types: ["openai"]`; cc-switch is
what knows to reach it via `/v1/responses`.)

The optional `~/.local/bin/claude` wrapper handles this: it reads
`live-state.json` before deciding. Proxy intent + a remote base means the direct
URL is merely stale, so it starts cc-switch, waits for the router, and re-reads
`settings.json` — which cc-switch rewrites back to port 15721 — before handing
off to the hop. An explicit `--settings` is exempt, and `"mode": "direct"` still
goes straight to the real binary.

Sessions started before the hop existed keep talking to cc-switch directly (a
running Claude process resolves its settings once at startup and never re-reads
them) — restart them to get retries.

Environment overrides: `AGENTROUTER_RETRY_PORT`, `AGENTROUTER_RETRY_LOG`,
`AGENTROUTER_RETRY_SETTINGS`, `AGENTROUTER_RETRY_MIRROR`,
`AGENTROUTER_RETRY_BIG_CTX_TOKENS`, `AGENTROUTER_RETRY_BIG_CTX_CONCURRENCY`,
`AGENTROUTER_RETRY_RESPONSES_UPSTREAM`.

## Test

```bash
./smoke.sh    # spins up probe-server.ts as a fake upstream, 18 checks
```

`probe-server.ts` is the fixture: `/ok`, `/flaky422` (fails twice then
recovers), `/rate422` (always rate-limited), `/beforeoutput` (always “failed
before output”), `/flakybefore` (fails once with it, then recovers),
`/highdemand` (always peak-load rejection), `/connfail` (always 502),
`/flakyconn` (502 twice then recovers), `/unavail503`, `/reject502` (a 502 that
must not be retried), `/sse200limit` (HTTP 200 carrying an error frame),
`/flakysse200` (fails once that way, then streams a healthy response),
`/fmt422` (genuine format error), `/slow75`.

## Prior art

Surveyed existing AgentRouter proxies before building this. Observations that
shaped the design:

- No surveyed project retries the 422 by matching rate-limit wording in the body;
  most ignore 422 or refuse to retry any 4xx.
- None detect the token-rate condition earlier than the full response; the
  100–180s latency is upstream-side. This is why the prevention gate exists.
- Mechanisms that reduce *hitting* the limit are local rate limiting + queueing
  (RPM limiters, pre-emptive checks with a bounded queue), which is the shape the
  big-context gate follows.
- The `Retry-After` injection on exhaustion follows the approach of the more
  mature proxies in this space.
- Deliberately not implemented: prompt mutation to evade the provider's WAF
  (corrupts code and circumvents provider controls), and runtime self-update
  from GitHub (an unpinned remote-code channel).

## License

MIT — see [LICENSE](LICENSE).
