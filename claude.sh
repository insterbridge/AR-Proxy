#!/usr/bin/env bash
# Claude Code wrapper: make sure the retry proxy is up, then exec Claude Code
# pointed at it.
#
#   claude.sh [claude args…]
#
# `command claude` below resolves to ~/.local/bin/claude, the cc-switch router
# wrapper: it makes sure cc-switch's port 15721 is listening before the real
# binary starts, then execs it with these arguments unchanged.
#
# Ensures the hop is used either way:
#   * `claude --settings <file-or-json>` (cc-switch's terminal-launch button runs
#     this, pointing at its own port) -> that settings value is rewritten to the
#     hop. The overlay cannot win here: with two --settings flags the later one
#     takes precedence, and cc-switch's comes last.
#   * no --settings -> the overlay is appended, which wins over ~/.claude/settings.json.
#
# Without this, a stopped retry proxy makes `claude` fail to connect at all.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${AGENTROUTER_RETRY_PORT:-15720}"
LOG="${AGENTROUTER_RETRY_LOG:-/tmp/agentrouter-retry-proxy.log}"
OVERLAY="${AGENTROUTER_RETRY_SETTINGS:-$HOME/.claude/retry-proxy.json}"
HOP_URL="http://127.0.0.1:$PORT"

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

if ! port_open; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "claude.sh: bun not found, cannot start the retry proxy" >&2
    exit 1
  fi
  echo "claude.sh: retry proxy not listening on 127.0.0.1:$PORT, starting it (log: $LOG)" >&2
  # The big-context gate serializes >60k-token requests (concurrency 1) because
  # those are what trip AgentRouter's token rate limit; small requests stay
  # parallel. The mirror writes hop lines into cc-switch's own log so failures
  # show up in its terminal output.
  #
  # --responses-upstream is optional and its value is a URL, so it goes through
  # an array: an unquoted ${VAR:+...} expansion would word-split the URL.
  RESPONSES_ARGS=()
  if [ -n "${AGENTROUTER_RETRY_RESPONSES_UPSTREAM:-}" ]; then
    RESPONSES_ARGS=(--responses-upstream "$AGENTROUTER_RETRY_RESPONSES_UPSTREAM")
  fi
  setsid nohup bun run "$HERE/proxy.ts" \
    --port "$PORT" \
    --big-ctx-tokens "${AGENTROUTER_RETRY_BIG_CTX_TOKENS:-60000}" \
    --big-ctx-concurrency "${AGENTROUTER_RETRY_BIG_CTX_CONCURRENCY:-1}" \
    "${RESPONSES_ARGS[@]}" \
    --mirror-log "${AGENTROUTER_RETRY_MIRROR:-$HOME/.cc-switch/logs/cc-switch.log}" \
    >>"$LOG" 2>&1 </dev/null &
  for _ in $(seq 1 40); do
    port_open && break
    sleep 0.25
  done
  if ! port_open; then
    echo "claude.sh: retry proxy failed to start; see $LOG" >&2
    exit 1
  fi
fi

ARGS=()
SETTINGS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --settings)
      if [ "$#" -ge 2 ]; then
        SETTINGS="$2"
        shift 2
        continue
      fi
      ;;
    --settings=*)
      SETTINGS="${1#--settings=}"
      shift
      continue
      ;;
  esac
  ARGS+=("$1")
  shift
done

if [ -z "$SETTINGS" ]; then
  exec command claude --settings "$OVERLAY" "${ARGS[@]}"
fi

# A real file: rewrite it in place. cc-switch regenerates its temp config on
# every launch, so the edit does not stick past this invocation.
if [ -f "$SETTINGS" ]; then
  if jq -e . "$SETTINGS" >/dev/null 2>&1; then
    REWRITTEN="$(jq --arg url "$HOP_URL" '.env.ANTHROPIC_BASE_URL = $url' "$SETTINGS")" \
      && printf '%s\n' "$REWRITTEN" >"$SETTINGS" \
      && echo "claude.sh: pointed $SETTINGS at the retry hop ($HOP_URL)" >&2
  else
    echo "claude.sh: $SETTINGS is not valid JSON, launching unchanged (no retries)" >&2
  fi
  exec command claude --settings "$SETTINGS" "${ARGS[@]}"
fi

# Inline JSON (Claude Code accepts `--settings '<json>'`): rewrite the value itself.
if [ "${SETTINGS:0:1}" = "{" ]; then
  if REWRITTEN="$(printf '%s' "$SETTINGS" | jq --arg url "$HOP_URL" '.env.ANTHROPIC_BASE_URL = $url')"; then
    echo "claude.sh: pointed inline --settings at the retry hop ($HOP_URL)" >&2
    exec command claude --settings "$REWRITTEN" "${ARGS[@]}"
  fi
  echo "claude.sh: inline --settings is not valid JSON, launching unchanged (no retries)" >&2
fi

exec command claude --settings "$SETTINGS" "${ARGS[@]}"
