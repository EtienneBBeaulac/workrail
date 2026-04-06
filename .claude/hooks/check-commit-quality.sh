#!/usr/bin/env bash
# PreToolUse hook: intercepts git commit commands that lack --no-verify.
#
# Blocks every commit and shows a quality checklist so the agent consciously
# evaluates the message before it lands. If the message is good, re-run the
# exact same command with --no-verify appended to bypass this gate.

set -euo pipefail

# Read the Bash tool input from stdin
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['tool_input']['command'])" 2>/dev/null || true)

# Only intercept git commit commands that don't already have --no-verify
if ! echo "$COMMAND" | grep -qE "git commit"; then
  exit 0
fi
if echo "$COMMAND" | grep -q -- "--no-verify"; then
  exit 0
fi

# Extract the commit message for display (best-effort)
MSG=$(echo "$COMMAND" | sed -n 's/.*-m[[:space:]]*"\([^"]*\)".*/\1/p' || true)
if [ -z "$MSG" ]; then
  MSG=$(echo "$COMMAND" | sed -n "s/.*-m[[:space:]]*'\([^']*\)'.*/\1/p" || true)
fi
if [ -z "$MSG" ]; then
  MSG="(could not extract -- check the command directly)"
fi

OUTPUT=$(cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "block",
    "permissionDecisionReason": "Commit quality gate: review your message before proceeding.\n\nMessage you are about to commit:\n  \"${MSG}\"\n\nQuality checklist -- answer YES to each before re-running with --no-verify:\n\n  1. SPECIFIC  -- Does the subject describe exactly what changed, not just that\n                  something changed? ('fix scroll bug' is vague; 'fix scroll\n                  position not restored on back-nav from SessionDetail' is good.)\n\n  2. USER-FACING -- Would someone reading the release notes understand why they\n                  care? Avoid internal labels (phase2a, slice4, task-123).\n\n  3. CORRECT TYPE -- Is the type right?\n                  feat=new feature, fix=user-visible bug, chore=everything else.\n                  Use chore for CI/deps/build/tooling -- not fix(ci).\n\n  4. VALID SCOPE -- Is the scope a product area?\n                  Allowed: console  mcp  workflows  engine  schema  docs\n                  Not allowed: phase2a  ci  deps  build  (or omit scope entirely)\n\n  5. FORMAT PASS -- Does it match: <type>(<scope>): <subject>  (max 72 chars)?\n\nIf all YES: re-run the same command with --no-verify added.\nIf any NO: fix the message first, then re-run with --no-verify.\n\nExample of a good message:\n  feat(console): add Workflows tab with tag filtering and detail panel\n  fix(mcp): include examples field in list_workflows output\n  chore: update dependabot to restrict to patch and minor versions"
  }
}
EOF
)

echo "$OUTPUT"
