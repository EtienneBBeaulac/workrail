#!/bin/bash
# Setup git hooks for workflow validation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
GIT_DIR="$PROJECT_ROOT/.git"
HOOKS_DIR="$GIT_DIR/hooks"

# Check if we're in a git repository
if [ ! -d "$GIT_DIR" ]; then
    # Try parent directory (monorepo case)
    GIT_DIR="$(dirname "$PROJECT_ROOT")/.git"
    HOOKS_DIR="$GIT_DIR/hooks"
    
    if [ ! -d "$GIT_DIR" ]; then
        echo "❌ Not in a git repository. Skipping hook installation."
        exit 0
    fi
fi

echo "🔧 Setting up git hooks..."

# Create hooks directory if it doesn't exist
mkdir -p "$HOOKS_DIR"

# Copy pre-commit hook
cp "$PROJECT_ROOT/.git-hooks/pre-commit" "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/pre-commit"

echo "✅ Git hooks installed!"
echo ""
echo "Pre-commit hook will validate workflow files before each commit."
echo "To skip validation: git commit --no-verify (not recommended)"















