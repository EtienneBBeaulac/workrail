# Design Review Findings: WorkTrain Worktree Isolation + Auto-commit (Issue #627)

**Date:** 2026-04-19
**Design:** Worktree isolation for coding sessions + branch assertion in delivery-action
**Status:** No blocking findings. Proceed to implementation.

## Tradeoff Review

| Tradeoff | Verdict |
|----------|---------|
| `sessionWorkspacePath?` on `WorkflowRunSuccess` | Acceptable. Optional field, backward-compatible. Refactor to `sessionMetadata` sub-object if more fields accumulate. |
| Keep worktree on failure/timeout | Acceptable per spec. Disk bounded by concurrent sessions * repo size. |
| git worktree remove best-effort on success | Acceptable. Best-effort + recovery within 24h. |
| No injectable execFn in runWorkflow() worktree creation | Acceptable. Tests use real git repos in temp dirs. |

## Failure Mode Review

| Failure Mode | Coverage | Risk |
|-------------|----------|------|
| Crash between worktree creation and sidecar write | Partially mitigated (tiny window, untracked worktrees recoverable via directory scan as future improvement) | Low |
| git fetch fails (credentials) | Clean error path, no orphan worktree | Medium operationally, Low architecturally |
| git worktree remove fails on success | Best-effort, logged, 24h recovery | Very Low |
| Branch mismatch in delivery | Asserted before push, returns DeliveryResult error | Low |
| Disk space from concurrent worktrees | Not handled. Deferred per YAGNI. | Low (local dev), Medium (production burst) |

## Runner-Up / Simpler Alternative Review

- Candidate B (assertion in runWorkflow): rejected -- violates spec placement, would corrupt main checkout.
- Simpler (skip branch assertion): rejected -- spec acceptance criterion.
- Simpler (always pass trigger.workspacePath to delivery): rejected -- would stage/commit in main checkout instead of worktree.

## Philosophy Alignment

All principles satisfied. Two acceptable tensions:
- `WorkflowRunSuccess.sessionWorkspacePath` is optional -- accurate domain model (no worktree when branchStrategy=none).
- Direct execFileAsync in runWorkflow() for worktree creation -- consistent with existing bash tool usage; spec doesn't require injectable execFn here.

## Findings

**No RED findings.**

**ORANGE (fix before shipping):**
- None.

**YELLOW (watch during implementation):**
- Y1: `runStartupRecovery()` needs injectable `execFn` parameter for testability. Do not call execFileAsync directly in the recovery path.
- Y2: The sidecar write with `worktreePath` must happen immediately after `git worktree add` -- do not defer or batch with other work.
- Y3: The `git worktree remove --force` call on the success path should be wrapped in try/catch (same pattern as `fs.unlink()` for the session file at line 3294).

## Recommended Revisions

None. Design is sound. YELLOW items are implementation-time reminders, not design changes.

## Residual Concerns

- FM1 (crash between worktree creation and sidecar write): accepted. A directory scan of `~/.workrail/worktrees/` as a future improvement would fully close this.
- FM5 (disk space under burst load): accepted. Deferred to a future maxConcurrentSessions + disk-space guard.
