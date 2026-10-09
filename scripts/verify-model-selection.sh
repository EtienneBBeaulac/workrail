#!/bin/bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ ! -x node_modules/.bin/vitest ]; then
  npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
fi

case "${1:-}" in
  boundary) npx vitest run tests/architecture/model-selection-boundaries.test.ts ;;
  handoff) npx vitest run tests/unit/v2/prompt-renderer.test.ts -t 'preserves a child model request' ;;
  precedence) npx vitest run tests/unit/v2/model-selection.test.ts -t 'explicit precedence' ;;
  targets) npx vitest run tests/unit/v2/model-selection.test.ts -t 'supports native' ;;
  missing) npx vitest run tests/unit/v2/model-selection.test.ts -t 'keeps missing client bindings' ;;
  schema) npx vitest run tests/unit/v2/model-selection.test.ts -t 'accepts valid client routing|rejects an invalid route' ;;
  routing) npx vitest run tests/unit/v2/model-selection.test.ts -t 'supports native|rejects an invalid route|accepts valid client routing' ;;
  recovery) npx vitest run tests/unit/v2/model-selection.test.ts -t 'recovers run-start' ;;
  observation) npx vitest run tests/unit/v2/start.test.ts tests/unit/v2/session-metrics-projection.test.ts ;;
  docs) npx vitest run tests/architecture/model-selection-authoring.test.ts && npm run validate:authoring-spec && npm run validate:feature-coverage && npm run validate:authoring-docs ;;
  native) npx vitest run tests/unit/v2/model-selection-native-evidence.test.ts && node scripts/verify-model-selection-native.mjs ;;
  client) npx vitest run tests/unit/v2/model-selection.test.ts -t 'plans client launches' ;;
  wire) npx vitest run tests/integration/mcp-model-selection.test.ts ;;
  child) npx vitest run tests/unit/v2/prompt-renderer.test.ts -t 'parent override|before launch' ;;
  *) echo 'Expected: handoff, precedence, routing, recovery, observation, child, wire, client, native, docs' >&2; exit 2 ;;
esac
