#!/usr/bin/env bash
# Bash entry point. On Windows, run `bun claude.ts` directly.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$HERE/claude.ts" "$@"
