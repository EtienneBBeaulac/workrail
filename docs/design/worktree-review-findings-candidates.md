# Worktree Review Findings - Design Candidates

## Problem Understanding

### Core Tensions

1. **Cleanup location vs result completeness**: `runWorkflow()` knows when a session succeeds; `trigger-router` knows when delivery completes. Cleanup must happen after delivery, but the result type must carry enough context for delivery to work -- hence `sessionWorkspacePath` in `WorkflowRunSuccess`. The existing architecture already threads this context; the bug is that runWorkflow() also tries to clean up before returning, racing with the delivery.

2. **Crash-safety vs orphan-free**: Worktree path must be persisted before any crash could make it untracked. The `if (startContinueToken)` guard on the second `persistTokens()` call means that if `startContinueToken` is falsy at worktree creation time, the sidecar never records the worktree path -- creating an untracked orphan if the process crashes.

3. **Type safety vs path coupling**: `sessionId` is currently extracted via `result.sessionWorkspacePath.split('/').at(-1)` -- a fragile string operation that couples branch-naming convention (UUID in path) to the calling code. Threading sessionId as a typed field on `WorkflowRunSuccess` eliminates this coupling.

4. **Fail-fast validation vs runtime discovery**: Validating `branchPrefix`/`baseBranch` at parse time (trigger-store) produces a clear config error. Waiting until worktree creation produces a cryptic `git checkout` error deep in the session setup.

### What Makes This Hard

The key insight for the CRITICAL bug: the cleanup code at trigger-router.ts lines 365-377 is inside `maybeRunDelivery()`, but `maybeRunDelivery()` returns early (line 293) when `autoCommit !== true`. This means worktree sessions with `autoCommit: false` would accumulate orphan worktrees if the runWorkflow() cleanup is removed without a compensating change. The review accepts this -- startup recovery (24h threshold) handles the edge case.

For Minor 1, the `persistTokens()` function already handles `worktreePath?: string` (omits the field when undefined). The guard `if (startContinueToken)` was added to avoid writing a blank token to the sidecar, but it incorrectly prevents worktreePath from being persisted when the token is falsy. The fix must decouple the worktreePath persistence from the token presence check.

## Philosophy Constraints

From CLAUDE.md:
- **Architectural fixes over patches**: Move cleanup to the correct layer (trigger-router), not patch runWorkflow().
- **Errors are data**: Use `TriggerStoreError` with `kind: 'invalid_field_value'` for validation failures.
- **Make illegal states unrepresentable**: `sessionId?: string` on `WorkflowRunSuccess` makes path-parsing unnecessary.
- **Explicit domain types**: typed sessionId instead of stringly-typed split.
- **Validate at boundaries**: branchPrefix/baseBranch validation belongs at parse time, not at worktree creation.
- **Document 'why'**: JSDoc on makeSpawnAgentTool must explain the architectural reason for branchStrategy:'none'.

No philosophy conflicts detected.

## Impact Surface

- **WorkflowRunSuccess interface**: Adding optional `sessionId?: string` is additive. Immediate-complete path (line 3062) must also be updated to include sessionId when applicable.
- **trigger-router.ts maybeRunDelivery()**: Line 321 changes from `.split('/').at(-1)` to `result.sessionId`. No interface contract changes for callers of TriggerRouter.
- **trigger-store.ts**: New validation added before existing branchStrategy/baseBranch/branchPrefix are assembled into the trigger. No changes to the TriggerDefinition shape.
- **spawn_agent tool**: JSDoc addition only -- no behavior change, no callers affected.
- **persistTokens()**: No signature change. Guard removal makes the second call unconditional.

## Candidates

### Candidate A: Follow Review Verbatim (Recommended)

**Summary**: Apply all 7 findings exactly as specified, accepting that non-autoCommit worktree sessions (a rare/unlikely combination) have worktrees cleaned up by runStartupRecovery after 24h.

**Tensions resolved**:
- CRITICAL: delivery no longer races with worktree removal
- Minor 2: sessionId no longer requires path parsing
- Minor 3: validation catches bad git chars at daemon startup

**Tensions accepted**:
- Non-autoCommit worktree sessions accumulate for up to 24h before startup recovery cleans them

**Boundary**: runWorkflow() owns session execution; trigger-router owns delivery lifecycle including post-delivery cleanup.

**Failure mode**: If a worktree session has autoCommit=false (unusual -- why use worktree isolation without autoCommit?), the worktree persists for 24h. Acceptable given startup recovery already handles this.

**Repo-pattern relationship**: Follows. The `sessionWorkspacePath` threading pattern, `TriggerStoreError` validation, and startup recovery cleanup are all existing patterns.

**Gains**: Minimal diff, matches review intent exactly, no new abstractions.

**Losses**: Minor 24h worktree leak for non-autoCommit sessions.

**Scope**: Best-fit.

**Philosophy**: Honors architectural fixes over patches, errors-as-data, explicit domain types, validate at boundaries.

### Candidate B: Move Cleanup to Queue Callback

**Summary**: Move worktree cleanup out of `maybeRunDelivery()` to the queue callback that orchestrates `runWorkflow()` + `maybeRunDelivery()`, so cleanup always runs regardless of autoCommit.

**Tensions resolved**: Worktree leak for non-autoCommit sessions eliminated.

**Tensions accepted**: More invasive change, modifies both trigger-router internals and cleanup location.

**Failure mode**: Cleanup logic now in two places (maybeRunDelivery for autoCommit=true sessions, queue callback for all). Harder to reason about.

**Scope**: Too broad. Review doesn't ask for this, and it changes the cleanup location the review identifies as correct.

**Philosophy conflict**: YAGNI with discipline -- adding complexity without evidence the non-autoCommit+worktree combination is a real use case.

## Comparison and Recommendation

**Recommendation: Candidate A**

The review is the upstream spec. It explicitly says "The cleanup in `maybeRunDelivery()` (in trigger-router) is the architecturally correct location and should be the sole success-path removal." Candidate A follows this exactly. The 24h cleanup window for the edge case is handled by an existing mechanism (runStartupRecovery).

## Self-Critique

**Strongest counter-argument**: Moving cleanup out of runWorkflow() creates a window where the process crashes between runWorkflow() returning and maybeRunDelivery() cleaning up -- leaving an orphan. But startup recovery already handles this case, and the review explicitly accepts this tradeoff.

**Pivot condition**: If evidence emerges that branchStrategy='worktree' without autoCommit is a common pattern, Candidate B becomes justified.

**Invalidating assumption**: If the review misidentified the cleanup location in trigger-router as correct. But the comment at lines 355-357 of trigger-router.ts is the author's own documentation of the invariant, making this self-consistent.

## Open Questions for Main Agent

1. When implementing Minor 1: should the second `persistTokens()` call use `startContinueToken ?? ''` (write empty string) or `currentContinueToken` (same value at that point)? Both work since startup recovery handles malformed sidecars. Prefer `startContinueToken ?? ''` to be explicit about the fallback.

2. The immediate-complete path at line 3062 returns `{ _tag: 'success', workflowId: trigger.workflowId, stopReason: 'stop' }` without `sessionWorkspacePath`. Should it also include `sessionId` and `sessionWorkspacePath`? Yes -- if a single-step workflow with branchStrategy='worktree' completes immediately, delivery still needs to run from the worktree.
