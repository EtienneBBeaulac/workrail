#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ ! -x node_modules/.bin/vitest ]; then
  npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
fi

case "${1:-}" in
  handoff) npx vitest run tests/unit/v2/prompt-renderer.test.ts -t 'preserves a child model request' ;;
  precedence) npx vitest run tests/unit/v2/model-selection.test.ts -t 'explicit precedence' ;;
  routing) npx vitest run tests/unit/v2/model-selection.test.ts -t 'supports native|rejects an invalid route|accepts valid client routing' ;;
  recovery) npx vitest run tests/unit/v2/model-selection.test.ts -t 'recovers run-start' ;;
  observation) npx vitest run tests/unit/v2/start.test.ts tests/unit/v2/session-metrics-projection.test.ts ;;
  native) node scripts/verify-model-selection-native.mjs ;;
  client) npx vitest run tests/unit/v2/model-selection.test.ts -t 'plans client launches' ;;
  wire) npx vitest run tests/integration/mcp-model-selection.test.ts ;;
  child) npx vitest run tests/unit/v2/prompt-renderer.test.ts -t 'parent override|before launch' ;;
  *) echo 'Expected: handoff, precedence, routing, recovery, observation, child, wire, client, native' >&2; exit 2 ;;
esac
