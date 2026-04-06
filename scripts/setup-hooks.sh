#!/usr/bin/env bash
# Configures git to use the tracked .git-hooks/ directory.
#
# Run once after cloning: ./scripts/setup-hooks.sh
#
# Using core.hooksPath keeps hooks in sync with the repo automatically --
# no copying required. Any update to .git-hooks/ takes effect immediately.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not in a git repository. Skipping hook setup."
  exit 0
fi

# Point git at the tracked hooks directory
git config core.hooksPath .git-hooks

echo "Git hooks configured (core.hooksPath = .git-hooks)."
echo ""
echo "Active hooks:"
for hook in .git-hooks/*; do
  name=$(basename "$hook")
  echo "  $name"
done
echo ""
echo "To skip a hook on a specific commit: git commit --no-verify"
