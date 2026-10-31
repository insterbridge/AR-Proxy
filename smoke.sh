#!/usr/bin/env bash
# Run the same local test suite as `bun test`, without curl or fixed ports.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun test "$HERE"
