# AR-Proxy

A small local proxy that retries selected AgentRouter failures and limits how
many large requests run at once. It is useful when an upstream reports a
rate limit in an error body—or inside a successful-looking SSE response—rather
than through a status your client knows to retry.

```text
client -> AR-Proxy (127.0.0.1:15720) -> upstream
```

AR-Proxy forwards HTTP requests; it does not translate between the Anthropic
Messages API and the OpenAI Responses API. Its **upstream** is simply the next
server it forwards requests to: either AgentRouter itself or a local API bridge.

[cc-switch](https://github.com/farion1231/cc-switch) is a separate desktop app that
manages provider configuration and can translate between API formats through a
local proxy. It is optional—you need it only for the bridged setup below, not
for a direct connection to AgentRouter.

## Getting started

Install [Bun](https://bun.sh), then clone the repository. Use a current Bun
release; AR-Proxy itself needs no build step or package installation.

```sh
git clone "https://github.com/insterbridge/AR-Proxy.git" AR-Proxy
cd AR-Proxy
bun proxy.ts --help
```

Choose one of the following setups. In both, **your client connects to AR-Proxy
on port 15720**. The `--upstream` option determines where AR-Proxy sends the
request next; it does not set the client's base URL.

### Option 1: connect directly to AgentRouter

Use this when your client already speaks an API that your AgentRouter model
supports—for example, a Responses client using a model's Responses endpoint.
No cc-switch installation or local bridge is needed.

```sh
bun proxy.ts --upstream "https://agentrouter.org"
```

AR-Proxy listens on `http://127.0.0.1:15720` and forwards requests to AgentRouter.
Your client supplies its AgentRouter credentials and selects the model.

Claude Code speaks the Messages API. A direct connection from Claude Code is
appropriate only if the chosen provider/model accepts that API. If the model
requires Responses instead, use the bridged setup below; AR-Proxy does not
perform that conversion itself.

### Option 2: put AR-Proxy in front of cc-switch

Use this when you want cc-switch to manage provider routing or API conversion.
For example, cc-switch can translate Claude Code's Messages requests into
Responses requests for an appropriately configured provider. AR-Proxy sits in
front of cc-switch and handles retries; cc-switch forwards to AgentRouter.

Set up the bridge before starting AR-Proxy:

1. [Install cc-switch](https://github.com/farion1231/cc-switch/releases) and keep
   it running while using this setup.
2. Configure the AgentRouter provider in cc-switch with the base URL
   `https://agentrouter.org` and your provider credentials. Select the API format
   required by your model. For Messages-to-Responses conversion, see cc-switch's
   [Claude Code routing guide](https://github.com/farion1231/cc-switch/blob/main/docs/guides/claude-codex-routing-guide-en.md).
3. Enable cc-switch's local proxy/routing mode and check its listening address
   and port. This README uses **`http://127.0.0.1:15721`** because that is
   AR-Proxy's default upstream. It is not a required or universal cc-switch
   port: if your cc-switch instance listens elsewhere, use its actual URL.
4. Start AR-Proxy with that local URL:

```sh
bun proxy.ts --upstream "http://127.0.0.1:15721"
```

With cc-switch running at that address, `bun proxy.ts` without options is
equivalent. Without a server listening there, the default command cannot reach
an upstream—it does not install or start cc-switch for you.

Keep the two local ports distinct:

| Address | Role in this setup |
| --- | --- |
| `http://127.0.0.1:15720` | AR-Proxy; the address your client connects to |
| `http://127.0.0.1:15721` | cc-switch's local listener; AR-Proxy forwards here |
| `https://agentrouter.org` | Remote provider; cc-switch forwards here |

Pointing your client directly at `15721` skips AR-Proxy and its retries.
cc-switch may set that client URL when managing configuration, so use the
[Claude Code launcher](#optional-claude-code-launcher) below to route a new
Claude Code session through `15720` without editing its global settings.

Follow cc-switch's client/authentication configuration for the bridged route,
and keep the client's configured model alias. cc-switch's provider settings
determine the upstream model. Its
[manual](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/README.md)
has the full setup instructions.

### Using both routes at once

If you want Messages traffic to use cc-switch but Responses traffic to go
directly to AgentRouter, configure both destinations:

```sh
bun proxy.ts --upstream "http://127.0.0.1:15721" --responses-upstream "https://agentrouter.org"
```

cc-switch must still be configured and running for the bridged traffic.
`--responses-upstream` applies to `/v1/responses` and `/v1/responses/...`, including
requests with query parameters. Other paths use `--upstream`. A direct Responses
client must supply its AgentRouter credentials; the proxy does not replace a
bridge's local credentials with provider credentials.

### Client URLs and request paths

A Messages client typically takes `http://127.0.0.1:15720`; a Responses client
may expect `http://127.0.0.1:15720/v1`. Check the actual request path your client
sends. Neither client should target cc-switch's port if it needs AR-Proxy's
retry behavior.

The proxy appends the incoming path and query to the selected upstream base.
For example, `--responses-upstream https://agentrouter.org` forwards a request
to `/v1/responses` to `https://agentrouter.org/v1/responses`. A base can include a
path prefix if your upstream requires one. Do not add `/v1` to the upstream base
if the client's request path already includes it.

AR-Proxy has no default model, does not replace the model in your request, and
does not store API keys or grant provider access. Check the provider's current
documentation for available models and supported APIs; this repository does not
maintain a compatibility matrix or a client allowlist.

Redirects that stay on the configured upstream route are rewritten to AR-Proxy
URLs, so a client following them still passes through the retry layer and keeps
its authentication headers. Redirects to another origin, outside the upstream
base path, or onto a different configured route are rejected with HTTP `502`
rather than sending the client around the proxy.

Supported compressed responses are decoded before inspection, and only then is
`Content-Encoding` removed. Unsupported encodings and their bytes are forwarded
unchanged. HEAD responses retain their representation length and encoding.
Inspected HTTP error bodies are retained as bytes rather than decoded and
re-encoded. Synthetic retry streams retain the initial failure's CORS and other
end-to-end headers, but replace metadata for the newly generated stream.

## Optional Claude Code launcher

The proxy can run on its own. If you use Claude Code, `claude.ts` also handles
starting AR-Proxy and routing the launch through it. **By default, the launcher
uses the cc-switch setup above**, so cc-switch must already be configured and
listening on `http://127.0.0.1:15721`. The launcher does not start that bridge.

```sh
bun claude.ts
bun claude.ts --settings "${HOME}/.claude/settings.json"
```

The second command reads the usual global Claude Code settings file from your
home directory; it does not modify that file.

On systems with Bash, `./claude.sh` is a shortcut for the same launcher. On
Windows, use `bun claude.ts` and the native Claude Code executable, rather than
a `.cmd` or `.bat` shim.

The launcher:

- checks whether the chosen port is already running AR-Proxy;
- starts a detached proxy if the port is free, then waits for its health check;
- copies a supplied `--settings` file or inline JSON value, changes
  `env.ANTHROPIC_BASE_URL` in that copy, and passes a private temporary settings
  file to Claude Code;
- leaves the original settings file and `~/.claude/settings.json` untouched,
  and removes its temporary copy when the CLI exits or startup fails;
- returns the Claude Code process's exit code on a normal exit and forwards
  catchable interrupt/termination signals to it.

Without `--settings`, it reads `~/.claude/retry-proxy.json` if that file exists,
otherwise it creates a temporary overlay. No overlay file needs to be created
by hand. Invalid JSON or an invalid `env` block stops the launch with an error
instead of silently launching without retries.

The launcher **does not start cc-switch** or configure an upstream provider.
Start your bridge separately, or set `AGENTROUTER_RETRY_UPSTREAM`. It also does
not replace your `claude` command automatically. If you put your own wrapper on
`PATH`, set `AGENTROUTER_RETRY_CLAUDE` to the real executable to avoid recursion.

Terminal Ctrl+C reaches the CLI through its foreground process group; the
launcher does not send a second interrupt or force the CLI to exit if it handles
that interrupt and stays open. Where the OS supports catchable signals, SIGTERM
and non-terminal SIGINT are forwarded, with up to five seconds for cleanup. Use
SIGTERM for programmatic graceful termination of an interactive launcher.
Unexpected or forced termination may leave the private settings copy behind;
force-killing the launcher cannot be intercepted. Use your OS's
process-management facilities when
terminating a whole process tree.

The temporary file keeps settings credentials and large configurations out of
the child's command line. For secret-bearing input, prefer file-backed
`--settings`: inline JSON is still present in the original command you run. Temporary copies
are owner-only on POSIX systems; on Windows, use your private user temporary
directory rather than a shared location.

A detached proxy stays running after Claude Code exits. Reusing one does not
change its upstream or gate settings: restart it, or choose another port, when
changing those settings. An older proxy without the health endpoint is rejected
rather than mistaken for a compatible instance.

### Launcher environment variables

These variables configure `claude.ts`, not a separately started `proxy.ts`:

| Variable | Default / purpose |
| --- | --- |
| `AGENTROUTER_RETRY_PORT` | `15720` |
| `AGENTROUTER_RETRY_UPSTREAM` | `http://127.0.0.1:15721`; the cc-switch listener in the default bridged setup |
| `AGENTROUTER_RETRY_RESPONSES_UPSTREAM` | Unset; optional Responses upstream |
| `AGENTROUTER_RETRY_BIG_CTX_TOKENS` | `60000`; `0` disables the gate |
| `AGENTROUTER_RETRY_BIG_CTX_CONCURRENCY` | `1` |
| `AGENTROUTER_RETRY_LOG` | `AR-Proxy-15720.log` in the OS temporary directory by default; the filename follows the configured port |
| `AGENTROUTER_RETRY_MIRROR` | Unset; optional additional log file |
| `AGENTROUTER_RETRY_SETTINGS` | Optional overlay input, used when there is no `--settings`; an explicitly configured file must exist |
| `AGENTROUTER_RETRY_CLAUDE` | Claude Code executable found on `PATH`; can be an explicit executable path |

To select the direct AgentRouter route instead, set the upstream override
below. For Claude Code, use this only when your provider/model supports the
Messages API; otherwise keep the cc-switch route.

In Bash or zsh:

```sh
AGENTROUTER_RETRY_UPSTREAM="https://agentrouter.org" bun claude.ts
```

In PowerShell:

```powershell
$env:AGENTROUTER_RETRY_UPSTREAM = "https://agentrouter.org"
bun claude.ts
```

## Retry behavior

Retry decisions use both the status and the response body:

| Response | Behavior |
| --- | --- |
| `422` or `429` with recognized rate-limit or transient-failure wording | Retry with backoff |
| `502`, `503`, or `504` | Retry, unless the body identifies a deterministic invalid request |
| Connection failure or upstream timeout, including the first attempt | Retry within the attempt and time budgets |
| HTTP `200` SSE with an early `error` or `response.failed` frame containing recognized wording | Retry before forwarding the buffered prefix |
| `400` identifying a backend-resource mismatch, with removable cc-switch reasoning carriers in the request | Remove those carriers and retry once |
| Other errors | Pass through |

Recognized wording includes `too_many_requests`, `rate limit`, `quota exceeded`,
`overloaded`, `failed before output`, `experiencing high demand`, and
`Upstream service unavailable`. The last phrase is recognized even when a bridge
wraps it in a `422` or a provider sends it in an early HTTP `200` SSE error.
A `422` format error—or even a `429` without a recognized signal—is not retried by
this body-matching policy. A body containing `invalid_request_error` or
`rejected the request as invalid` takes precedence over rate-limit wording.

Backoff is exponential with ±25% jitter, capped by `--max-delay`. An upstream
`Retry-After` header, expressed as seconds or an HTTP date, sets a minimum wait
and can exceed that cap. The request's deadline still applies.

`--max-attempts` counts **all** upstream calls, including the original call and
any stale-reasoning recovery. The retry deadline starts after the request body
has been read and covers the gate queue, upstream attempts, and backoff. Once a
healthy response is accepted, its body may stream past that deadline; the
separate per-call upstream timeout still applies.

### Streaming details

SSE inspection reads complete frames in order, up to a 64 KiB prefix. It skips
known preamble events and stops at output or an unfamiliar data event. Buffered
bytes and the remaining stream are then forwarded without rewriting them.
Errors arriving **after output has started are not retried**, even if they share
a network chunk with earlier content. Use `--no-inspect-sse` to disable inspection.

For a JSON request with `"stream": true`, a retryable failure starts an HTTP
`200 text/event-stream` response while the proxy retries. During that wait,
Messages requests get `ping` events; Responses, Chat Completions, and other
streaming routes get SSE comments. Keepalives remain active while a final HTTP
error body is read, within the retry deadline. They stop before recovered
upstream bytes are forwarded, so they cannot be inserted into partial frames.

Keepalives are **not** sent during the initial upstream attempt or while waiting
for the large-request gate. They help during retry backoff, but do not guarantee
that every client's first-byte or idle timeout will be avoided.

If retries are exhausted:

- non-streaming requests receive the last error body and headers, with a
  `Retry-After` header added if absent;
- an error hidden under HTTP `200` becomes HTTP `502` for a non-streaming request,
  with the buffered SSE error body retained;
- requests whose streaming headers have already been sent receive an `error`
  SSE event in the Messages or Responses envelope, or a data-only error object
  for Chat Completions, since the status can no longer change. Unknown streaming
  routes receive a generic SSE error. This also applies to a later,
  non-retryable HTTP error or redirect. The proxy extracts the upstream error
  message and preserves recognized error types/codes instead of displaying a
  buffered lifecycle preamble.

Retries are bounded, not a guarantee of success. With a remote provider, the
proxy cannot prove that an interrupted request did no work or incurred no cost.
Use it for request types you are comfortable replaying.

### Large-request gate

The proxy estimates input size as roughly one token per four characters of the
raw request body. This is not a model tokenizer, a provider TPM limit, or an
accurate estimate for images and other encoded data.

Requests at or above `--big-ctx-tokens` share a FIFO gate, with
`--big-ctx-concurrency` permits. The gate is global because different client
model names may map to the same upstream resource. Smaller requests bypass it.

A permit stays held through retries and until the response body drains or is
cancelled—not just until headers arrive. Disconnected and expired requests leave
the queue. Set `--big-ctx-tokens 0` to disable this behavior.

### Stale-reasoning recovery

The special `400` recovery handles cc-switch carriers beginning with
`ccswitch-openai-reasoning-`. It removes matching `thinking` and
`redacted_thinking` blocks from a Messages request, plus matching stray
`signature` fields. Other text, tool blocks, and native signatures are retained.

This deliberately changes the request and discards the carried reasoning. It
runs at most once, only after a recognized resource-mismatch error. If the
changed request is also rejected, that rejection is returned rather than
looped. Numeric values in retained tool inputs are preserved from their JSON
source, including large integers and precise decimals. If the Bun runtime cannot
preserve those values, recovery is skipped rather than changing them. Native
Responses `input` items are **not** rewritten by this mechanism.

## Proxy options

All numeric values must be integers. Time values are in milliseconds.

| Option | Default | Purpose |
| --- | --- | --- |
| `--listen` | `127.0.0.1` | Bind address |
| `--port` | `15720` | Bind port, `1–65535` |
| `--upstream` | `http://127.0.0.1:15721` | Next server: the local cc-switch listener by default, or AgentRouter for a direct connection |
| `--responses-upstream` | Unset | Separate upstream for Responses paths |
| `--max-attempts` | `8` | Total upstream calls per request |
| `--base-delay` | `2000` | Initial backoff |
| `--max-delay` | `30000` | Backoff cap after jitter, excluding `Retry-After` |
| `--deadline` | `300000` | Queue and retry time budget |
| `--upstream-timeout` | `600000` | Timeout for each upstream call, including its body |
| `--keepalive` | `10000` | Keepalive interval during streaming retries; `0` disables |
| `--retry-status` | `422,429` | Body-matched error statuses; does not disable the separate `502/503/504` policy |
| `--big-ctx-tokens` | `60000` | Gate threshold; `0` disables |
| `--big-ctx-concurrency` | `1` | Large requests allowed at once |
| `--mirror-log` | Unset | Additional log file; its parent directory must exist |
| `--inspect-sse` / `--no-inspect-sse` | Enabled | Early SSE error inspection |
| `-h`, `--help` | — | Show command-line help |

Upstream URLs must be absolute HTTP or HTTPS URLs without embedded credentials,
query parameters, or fragments. Authentication belongs in client headers.

## Logging and local access

The standalone proxy writes timestamped lines to stdout. `--mirror-log` also
appends them in a cc-switch-style format; it does not require cc-switch, and a
mirror-file error is reported without stopping the proxy. The launcher redirects
proxy output to its log file in the OS temporary directory unless configured
otherwise. New launcher logs are owner-only on POSIX systems. Existing logs
must belong to the current user and have no group/other permissions; links and
non-regular files are rejected rather than followed. Use a private log location
on Windows as well.

Logs include request paths, approximate context size, queue notices, retries,
and short upstream errors. Treat logs as private: paths, queries, and upstream
error text may contain sensitive information.

`GET /__ar_proxy/health` is a local health endpoint returning the service name
and process ID. It is the one reserved route that is not forwarded upstream.
You can use the process ID to stop a detached instance with your OS's process
manager. A foreground instance can be stopped with Ctrl+C.

The default listener is loopback-only. There is no built-in authentication,
TLS termination, persistent queue, or general request-rate limiter. Do not expose
it to an untrusted network without a separate authenticated boundary. Provided
client headers, including `User-Agent`, are forwarded apart from hop-by-hop
headers. The proxy does not impersonate an approved client or resolve provider
access-policy failures.

## Tests and portability

```sh
bun test
```

The suite uses local fixtures, dynamically assigned ports, and OS-provided
temporary directories. It covers retry classification, SSE framing, deadlines,
request cancellation, the gate, reasoning recovery, and launcher settings.
It makes no live provider calls and needs no API keys, curl, jq, or Python.
`./smoke.sh` runs the same suite if Bash is available.

For manual experiments, the fixture can also run separately:

```sh
bun probe-server.ts --port 15722
bun proxy.ts --upstream "http://127.0.0.1:15722/flaky422"
```

Other fixture prefixes include `/ok`, `/rate422`, `/fmt422`, `/fmt400`,
`/flakybefore`, `/flakyconn`, `/unavail503`, `/reject502`, `/sse200limit`,
`/flakysse200`, and `/azurealways`. They are synthetic test cases, not a claim
about a provider's current behavior.

The proxy, launcher, and tests use Bun and platform-neutral path/process APIs.
The Bash scripts are optional compatibility entry points. A CI matrix is
included for Linux, macOS, and Windows; live-provider behavior still needs to be
checked in your own authorized setup.

## License

MIT. See [LICENSE](LICENSE).
