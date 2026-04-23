# Execution Simulation Report: PR Review Coordinator Failure Paths

*Generated: 2026-04-18*

## Summary

Three failure paths simulated for the PR review coordinator design. All three produce correct outcomes under the proposed design. One gap identified: Rule 3 (go/no-go time check) needs adaptation for CLI context.

## Scenario 1: recapMarkdown is Null

**Setup:** Session completes successfully, but `GET /api/v2/sessions/:id/nodes/:nodeId` returns `recapMarkdown: null`.

**Trace:**
```
getAgentResult('handle-419')
  GET /api/v2/sessions/handle-419 -> runs[0].preferredTipNodeId = 'node-xyz'
  GET /api/v2/sessions/handle-419/nodes/node-xyz -> recapMarkdown = null
  returns null

parseFindingsFromNotes(null) -> err('notes is null or empty')
classifySeverity(err) -> 'unknown'
route('unknown') -> escalate
```

**Divergence from expected:** None -- conservative escalation is the designed behavior.

**Outcome:** PR escalated, not merged. No crash. Clear escalation note written.

## Scenario 2: Fix-Agent Loop Exhaustion (3 Passes, Persistent Minor)

**Setup:** PR #406 has minor findings. Fix agent runs 3 times but each re-review still returns minor.

**Trace:**
```
Pass 1: passCount=0 -> review: 'minor' -> passCount becomes 1 -> spawn fix agent -> re-review
Pass 2: passCount=1 -> review: 'minor' -> passCount becomes 2 -> spawn fix agent -> re-review
Pass 3: passCount=2 -> review: 'minor' -> passCount becomes 3 -> CHECK: 3 >= 3 -> STOP
  -> escalate, write: 'PR #406: 3 fix passes exhausted, still minor. Manual review required.'
```

**Divergence from expected:** None -- loop terminates correctly at pass 3.

**Key invariant verified:** `passCount >= MAX_FIX_PASSES` check happens BEFORE spawning fix agent, not after. This prevents a 4th spawn.

**Outcome:** PR escalated after exactly 3 passes. Not merged.

## Scenario 3: Daemon Not Running (ECONNREFUSED)

**Setup:** No daemon running on port 3456. No lock files present.

**Trace:**
```
discoverPort() -> no lock files -> falls back to 3456
spawnSession('wr.mr-review', 'Review PR #419...', '/workspace')
  POST http://127.0.0.1:3456/api/v2/auto/dispatch
  -> fetch throws Error: ECONNREFUSED 127.0.0.1:3456
  -> spawnSession catches -> returns err('Could not connect to WorkTrain daemon on port 3456')
runPrReviewCoordinator() receives err
  -> deps.stderr('Could not connect to WorkTrain daemon on port 3456. Start with: worktrain daemon')
  -> returns { kind: 'failure', exitCode: 1 }
```

**Divergence from expected:** None.

**Outcome:** Clear error message, exit code 1, no hang, no partial state.

## Divergence Analysis

No divergences found. All 3 scenarios produce correct outcomes.

## Gap Identified: Rule 3 Adaptation for CLI Context

**Problem:** The original Rule 3 (go/no-go time check: don't spawn if remaining time < 20 minutes) was written for daemon sessions that have a `maxSessionMinutes` parameter. A CLI coordinator script has no such parameter.

**Adaptation required:** Track wall-clock time since coordinator script start (`const startTimeMs = deps.now()` at beginning). Before spawning any new child session (review OR fix agent), check: `if (deps.now() - startTimeMs > coordinatorMaxMs - 20 * 60 * 1000)` -> refuse to spawn.

**Default:** `coordinatorMaxMs = 90 * 60 * 1000` (90 minutes). Configurable via `--max-runtime` flag if needed.

## Recommendations

1. Implement `parseFindingsFromNotes(null)` path explicitly -- don't rely on empty string check.
2. Keyword parser priority: BLOCKING/CRITICAL/REQUEST CHANGES takes absolute precedence over APPROVE/CLEAN/LGTM (blocking wins even if both present).
3. Fix-agent loop: check `passCount >= MAX_FIX_PASSES` BEFORE spawning, not after.
4. Add `coordinatorStartMs` tracking and Rule 3 go/no-go check adapted for CLI (wall-clock elapsed time).
5. `gh pr merge` failures: catch, write to stderr, escalate -- do NOT retry automatically.
