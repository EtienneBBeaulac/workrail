# Worktree Review Findings - Design Review

## Tradeoff Review

| Tradeoff | Acceptance Criteria Impact | Hidden Assumptions | Verdict |
|---|---|---|---|
| 24h orphan window for non-autoCommit worktree sessions | None -- startup recovery handles this | Daemon restarts at least once per 24h | Acceptable |
| Empty string token fallback in persistTokens() | None -- sidecar still tracks worktreePath for orphan recovery | startContinueToken is always set before worktree creation (verified in code flow) | Acceptable |
| sessionId absent for spawn_agent child sessions | None -- children never use branchStrategy:'worktree' | No caller reads WorkflowRunSuccess.sessionId except the one being updated | Acceptable |

## Failure Mode Review

| Failure Mode | Handled By | Missing Mitigation | Risk |
|---|---|---|---|
| Crash after runWorkflow() returns, before maybeRunDelivery() cleans up | Startup recovery (24h) | None needed | Low |
| maybeRunDelivery() fails partway | Cleanup runs regardless of deliveryResult._tag | None | Low |
| startContinueToken genuinely undefined at worktree creation | persistTokens() still writes worktreePath; sidecar cleaned on next start | None | Low (theoretical only) |
| Regex rejects valid but unusual git branch name | Fail-fast with clear config error | None -- review specifies this regex | Low |

## Runner-Up / Simpler Alternative Review

- Runner-up (cleanup in queue callback): not worth borrowing -- review explicitly identifies maybeRunDelivery() as the correct cleanup location.
- Simpler variants (skip Minor 2 or Minor 3): not acceptable -- each finding has a specific correctness justification, not just cosmetic preference.
- No hybrid opportunities identified.

## Philosophy Alignment

All 7 fixes align with CLAUDE.md principles:
- Architectural fix: cleanup moved to correct layer
- Errors-as-data: TriggerStoreError for validation
- Make illegal states unrepresentable: sessionId as typed field
- Validate at boundaries: branchPrefix/baseBranch at parse time
- Document 'why': JSDoc on makeSpawnAgentTool
- YAGNI: only the 7 specified fixes implemented

No philosophy conflicts.

## Findings

### Yellow: Immediate-Complete Path Missing sessionWorkspacePath/sessionId

The review asks to fix both the success path AND the immediate-complete path for the CRITICAL bug (remove worktree cleanup). But the current immediate-complete return at line 3062 also lacks `sessionWorkspacePath` and `sessionId` spreading. Without these, a single-step workflow with branchStrategy='worktree' would return success with no delivery context, and maybeRunDelivery() would use trigger.workspacePath (wrong directory) for delivery.

**Severity**: Yellow. The review mentions fixing both paths for cleanup removal, but doesn't explicitly call out the missing return fields. However, omitting them would make the cleanup fix incomplete for the immediate-complete case.

**Recommended fix**: Add the same spreading pattern used in the main success return to the immediate-complete return:
```typescript
return {
  _tag: 'success',
  workflowId: trigger.workflowId,
  stopReason: 'stop',
  ...(sessionWorktreePath !== undefined ? { sessionWorkspacePath: sessionWorktreePath } : {}),
  ...(sessionWorktreePath !== undefined ? { sessionId } : {}),
};
```

## Recommended Revisions

1. **Apply Yellow finding**: Add sessionWorkspacePath and sessionId to the immediate-complete return at line 3062 when sessionWorktreePath is defined.
2. All other 7 review findings: apply as specified.

## Residual Concerns

- The 24h orphan window for non-autoCommit worktree sessions is accepted. If this pattern becomes common in production, consider adding explicit cleanup in the queue callback.
- The regex for branchPrefix/baseBranch is slightly narrower than git's full rules. This is intentional (clear config errors > cryptic git failures) and matches the review spec.
