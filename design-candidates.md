# Design Candidates: WorkTrain Worktree Isolation + Auto-commit Wire-up (Issue #627)

**Date:** 2026-04-19
**Status:** Candidate A selected -- implementation in progress

## Problem Understanding

### Tensions

1. **Data flow for sessionWorkspacePath**: `runWorkflow()` creates the worktree (and therefore knows `sessionWorkspacePath`). `maybeRunDelivery()` in trigger-router needs the path for `runDelivery()`. The return value channel (`WorkflowRunSuccess`) is the natural bridge -- adding `sessionWorkspacePath?` to that type surfaces it without coupling trigger-router to runWorkflow internals.

2. **WorkflowTrigger vs TriggerDefinition split**: `runWorkflow()` receives `WorkflowTrigger` (internal type), not `TriggerDefinition` (external type). The trigger-router maps TriggerDefinition -> WorkflowTrigger at route() time. New fields `branchStrategy/baseBranch/branchPrefix` must be added to both types AND the mapping. The existing `soulFile` field is the exact precedent.

3. **Delivery-action branch assertion seam**: The spec places branch assertion in delivery-action.ts "before git push". This requires `expectedBranch?: string` as a new parameter to `runDelivery()`. The alternative (assertion in runWorkflow()) is simpler but violates the architectural principle that delivery concerns belong in delivery-action.

4. **Multi-exit cleanup**: runWorkflow() has multiple exit paths (success, error, timeout, early error). Worktree removal must happen on success only; failure/timeout keeps the worktree for debugging. The pre-created worktree must be tracked so the success path can remove it.

### Likely Seam

The real seam is in `runWorkflow()` immediately after `persistTokens()`. This is explicitly called out in the spec: "Right after `persistTokens()`, when `trigger.branchStrategy === 'worktree'`...". The worktree creation is a session-lifecycle concern that belongs at the same point as crash-recovery state creation.

### What Makes This Hard

- **Multiple exit paths**: `let worktreeCreated = false` must be tracked so early errors (before worktree creation) don't try to remove a non-existent worktree.
- **Crash between worktree creation and sidecar write**: if the process dies after `git worktree add` but before `persistTokens(worktreePath)`, the worktree is untracked. Mitigation: persist `worktreePath` in the sidecar JSON immediately after worktree creation.
- **Recovery in tests**: `runStartupRecovery()` calls `git worktree remove` -- tests can't run real git commands. Solution: injectable `execFn` parameter (same pattern as delivery-action).

## Philosophy Constraints

- **execFile not exec** (CLAUDE.md + spec): all git commands use `execFileAsync`, never `execAsync`. No shell injection.
- **Immutability by default**: `trigger.workspacePath` is never mutated. `sessionWorkspacePath` is a derived local variable.
- **Make illegal states unrepresentable**: `branchStrategy: 'worktree' | 'none'` union type catches typos at compile time.
- **Errors as data**: `runDelivery()` returns `DeliveryResult` discriminated union. Branch assertion on mismatch returns `{ _tag: 'error', phase: 'commit', details: '...' }` rather than throwing.
- **Validate at boundaries**: new YAML fields parsed and validated in `validateAndResolveTrigger()` at load time.
- **Prefer fakes over mocks**: tests use real temp dirs (following existing crash-recovery test pattern).
- **YAGNI with discipline**: no WorktreeManager class, no abstraction beyond what the spec requires.

No philosophy conflicts found. Spec, CLAUDE.md, and repo patterns are aligned.

## Impact Surface

- `src/trigger/types.ts`: `TriggerDefinition` gains 3 optional fields.
- `src/daemon/workflow-runner.ts`: `WorkflowTrigger` gains 3 optional fields; `WorkflowRunSuccess` gains `sessionWorkspacePath?`; `persistTokens()` signature changes (2 internal call sites); `OrphanedSession` type gains `worktreePath?`; `readAllDaemonSessions()` returns `worktreePath`; `runStartupRecovery()` gains injectable `execFn` parameter.
- `src/trigger/delivery-action.ts`: `runDelivery()` signature gains `expectedBranch?: string` parameter (1 call site in trigger-router).
- `src/trigger/trigger-router.ts`: `maybeRunDelivery()` gains worktree-path pass-through; WorkflowTrigger mapping gains 3 fields.
- `triggers.yml`: test-task and mr-review triggers updated.

## Candidates

### Candidate A: Spec-literal implementation (SELECTED)

Thread `branchStrategy/baseBranch/branchPrefix` through the type hierarchy; derive `sessionWorkspacePath` as a `let` variable in `runWorkflow()`; thread to tool factories; surface in `WorkflowRunSuccess`; add branch assertion to `runDelivery()`.

- Resolves all four tensions
- Follows soulFile/referenceUrls/agentConfig extension pattern exactly
- Honors all philosophy principles
- Minimal blast radius

### Candidate B: Branch assertion inside runWorkflow

Rejected -- spec explicitly places assertion in delivery-action.

### Candidate C: WorktreeManager class

Rejected -- YAGNI, spec doesn't call for this abstraction.

## Recommendation

**Candidate A.** Spec is solution-fixed. All three candidates converge on the same data flow. Candidates B and C are ruled out by spec requirements and YAGNI respectively.

## Self-Critique

**Counter-argument**: `sessionWorkspacePath?` on `WorkflowRunSuccess` could become a grab-bag. A `sessionMetadata?` sub-object would be cleaner.

**Response**: Premature abstraction. One field, one use case. Refactor to sub-object if a second session-scoped metadata field is needed.

**Pivot condition**: If a second PR adds more session-scoped metadata, introduce `sessionMetadata` sub-object at that point.
