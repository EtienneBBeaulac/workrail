#!/bin/bash
# DEPRECATED: This script validates files individually, not through the runtime registry.
# Use `npm run validate:registry` (scripts/validate-workflows-registry.ts) instead.
# This script does not test cross-source resolution, variant selection, or duplicate detection.
#
# Original description: Validate all workflows in the workflows directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORKFLOWS_DIR="$PROJECT_ROOT/workflows"

echo "🔍 Validating workflows in: $WORKFLOWS_DIR"
echo ""

FAILED=0
TOTAL=0

for workflow in "$WORKFLOWS_DIR"/*.json; do
    if [ -f "$workflow" ]; then
        TOTAL=$((TOTAL + 1))
        filename=$(basename "$workflow")
        
        if node "$PROJECT_ROOT/dist/cli.js" validate "$workflow" > /dev/null 2>&1; then
            echo "✅ $filename"
        else
            echo "❌ $filename - FAILED"
            node "$PROJECT_ROOT/dist/cli.js" validate "$workflow"
            FAILED=$((FAILED + 1))
        fi
    fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $FAILED -eq 0 ]; then
    echo "✅ All $TOTAL workflows are valid!"
    exit 0
else
    echo "❌ $FAILED of $TOTAL workflows failed validation"
    exit 1
fi
















