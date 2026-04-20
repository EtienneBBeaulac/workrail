# Worktree Review Findings - Implementation Plan

## Problem Statement

PR #630 (`feat/worktree-auto-commit`) has 7 MR review findings (1 critical, 2 major, 4 minor) that must be resolved before merge. The critical bug causes delivery to fail with "not a git repository" because `runWorkflow()` deletes the worktree before `maybeRunDelivery()` runs.

## Acceptance Criteria

1. `runWorkflow()` does NOT remove the worktree on the success path or immediate-complete path.
2. `makeSpawnAgentTool()` has a JSDoc comment documenting that child sessions always use `branchStrategy: 'none'`.
3. `WorkflowRunSuccess` has a `readonly sessionId?: string` field.
4. `runWorkflow()` sets `sessionId` in the success return when `branchStrategy === 'worktree'`.
5. `trigger-router.ts` reads `result.sessionId` instead of `result.sessionWorkspacePath.split('/').at(-1)`.
6. `trigger-store.ts` validates `branchPrefix` and `baseBranch` against `/^[a-zA-Z0-9._/-]+$/` and rejects values starting with `-`.
7. `tests/unit/trigger-router.test.ts` has a test verifying delivery uses the worktree path.
8. `npm run build` compiles clean.
9. `npx vitest run` shows no regressions.
10. `persistTokens()` is called unconditionally after worktree creation (not gated on `startContinueToken`).
11. Immediate-complete path return includes `sessionWorkspacePath` and `sessionId` when `sessionWorktreePath !== undefined`.

## Non-Goals

- Do NOT touch `src/mcp/` in any way.
- Do NOT change delivery logic in `delivery-action.ts`.
- Do NOT change the cleanup location in `maybeRunDelivery()` (lines 365-377 in trigger-router.ts) -- this is correct.
- Do NOT add new abstractions or dependencies.
- Do NOT change workflow definitions or schema files.

## Philosophy-Driven Constraints

- Use `TriggerStoreError` with `kind: 'invalid_field_value'` for validation errors (errors-as-data).
- `WorkflowRunSuccess.sessionId` must be `readonly` (immutability by default).
- JSDoc must explain WHY, not just what (document 'why' principle).
- Validation must happen at the boundary (trigger-store parse time), not at worktree creation time.
- Architectural fix: cleanup moves to the correct layer, not patched at the symptom.

## Invariants

1. Worktree must exist until `maybeRunDelivery()` completes; `runWorkflow()` must NOT remove it on any success path.
2. `persistTokens()` must always record `worktreePath` immediately after worktree creation (not conditional on token presence).
3. The `sessionId` field on `WorkflowRunSuccess` must never require path parsing at the call site.
4. `branchPrefix` and `baseBranch` must be validated before use (fail-fast at daemon startup).

## Selected Approach

Follow review verbatim, with one additional fix: the immediate-complete return path (line 3062) must also include `sessionWorkspacePath` and `sessionId` when a worktree was created (this was missing and discovered during design review).

## Vertical Slices

### Slice 1: CRITICAL -- Remove Premature Worktree Removal
**File**: `src/daemon/workflow-runner.ts`
**Changes**:
- Remove the `if (sessionWorktreePath)` cleanup block at lines 3049-3058 (immediate-complete path).
- Add `sessionWorkspacePath` and `sessionId` spread to the immediate-complete return at line 3062.
- Remove the `// ---- Remove worktree on success ----` comment and `if (sessionWorktreePath)` block at lines 3502-3514 (success path).

**Done when**: `runWorkflow()` returns without any `execFileAsync('git', ['-C', ..., 'worktree', 'remove', ...])` calls on the success path. The worktree cleanup comment in `trigger-router.ts` lines 355-357 remains the sole cleanup on the success path.

### Slice 2: MAJOR -- JSDoc on makeSpawnAgentTool
**File**: `src/daemon/workflow-runner.ts`
**Changes**:
- Add a JSDoc comment block immediately before `export function makeSpawnAgentTool(` (line 2009).
- Content: "Child sessions spawned by this tool always have `branchStrategy: 'none'` -- they operate in the parent's workspace without their own worktree or feature branch. Coordinators that need isolated child sessions should dispatch them via `TriggerRouter.dispatch()` instead."

**Done when**: JSDoc is present and describes the branchStrategy limitation.

### Slice 3: Minor 1 -- Unconditional persistTokens After Worktree Creation
**File**: `src/daemon/workflow-runner.ts`
**Changes**:
- Remove the `if (startContinueToken)` guard from the second `persistTokens()` call (lines 3020-3022).
- Replace with an unconditional call: `await persistTokens(sessionId, startContinueToken ?? currentContinueToken, startCheckpointToken, sessionWorktreePath);`

**Done when**: `persistTokens()` is called unconditionally after worktree creation, ensuring `worktreePath` is always written to the sidecar.

### Slice 4: Minor 2 -- Thread sessionId Through WorkflowRunSuccess
**Files**: `src/daemon/workflow-runner.ts`, `src/trigger/trigger-router.ts`
**Changes in workflow-runner.ts**:
- Add `readonly sessionId?: string` to `WorkflowRunSuccess` interface (after `sessionWorkspacePath`).
- In the main success return (line 3526), add `...(sessionWorktreePath !== undefined ? { sessionId } : {})` (where `sessionId` is the process-local UUID already in scope).
- In the immediate-complete return (line 3062), add `...(sessionWorktreePath !== undefined ? { sessionId } : {})` alongside `sessionWorkspacePath`.

**Changes in trigger-router.ts**:
- Line 321: Replace `result.sessionWorkspacePath.split('/').at(-1) ?? ''` with `result.sessionId ?? ''`.

**Done when**: `WorkflowRunSuccess.sessionId` is set when `branchStrategy === 'worktree'` and trigger-router reads it directly without path manipulation.

### Slice 5: Minor 3 -- Validate git-safe chars for branchPrefix/baseBranch
**File**: `src/trigger/trigger-store.ts`
**Changes**:
- After lines 867-868 where `baseBranch` and `branchPrefix` are extracted, add regex validation.
- For each non-undefined value, check `/^[a-zA-Z0-9._/-]+$/` and that it does not start with `-`.
- Return `err({ kind: 'invalid_field_value', field: '...', triggerId: rawId })` on failure.

**Done when**: A trigger with `branchPrefix: '--bad'` or `baseBranch: '-main'` fails at parse time with `kind: 'invalid_field_value'`.

### Slice 6: Minor 4 -- Add End-to-End Delivery Test for branchStrategy:worktree
**File**: `tests/unit/trigger-router.test.ts`
**Changes**:
- Add a test in the `describe('delivery wiring (autoCommit)')` block.
- The test creates a `WorkflowRunSuccess` with `sessionWorkspacePath: '/worktrees/test-session-id'` and valid `lastStepNotes`.
- Stubs `runWorkflowFn` to return this success result.
- Verifies the first git call uses `/worktrees/test-session-id` as the working directory (not trigger.workspacePath).

**Done when**: Test passes and verifies `execFn` is called with the worktree path.

## Test Design

### Existing Tests to Verify Unchanged
- `tests/unit/trigger-router.test.ts` -- all existing tests must still pass.
- `tests/unit/trigger-store.test.ts` -- all existing validation tests must still pass.

### New Test (Slice 6)
```
describe('delivery wiring (autoCommit)')
  it('uses sessionWorkspacePath as working directory when runWorkflow returns a worktree session')
    - trigger: { autoCommit: true, branchStrategy: 'worktree', workspacePath: '/workspace' }
    - runWorkflowFn returns: { _tag: 'success', sessionWorkspacePath: '/worktrees/abc-session', lastStepNotes: VALID_HANDOFF_NOTES }
    - fakeExec: vi.fn().mockResolvedValue(...)
    - assertion: fakeExec called; first git add call uses cwd '/worktrees/abc-session'
```

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `startContinueToken` is undefined in practice when branchStrategy='worktree' | Very Low | Low | persistTokens writes '' as fallback; startup recovery handles it |
| Removing cleanup breaks non-autoCommit worktree sessions | Low | Low | Startup recovery reaps after 24h; combination is unusual |
| `sessionId` field name collision with WorkRail server sessionId | Low | Low | Field is optional; no ambiguity since it's typed on the interface |

## PR Packaging Strategy

All changes on existing branch `feat/worktree-auto-commit`. Single PR #630.

Commit message: `fix(daemon): address worktree review findings -- move success cleanup, document spawn_agent limitation, thread sessionId, validate git-safe chars`

## Philosophy Alignment

| Principle | Slice | Status |
|---|---|---|
| Architectural fixes over patches | Slice 1 | Satisfied -- cleanup moved to correct layer |
| Errors are data | Slice 5 | Satisfied -- TriggerStoreError returned |
| Make illegal states unrepresentable | Slice 4 | Satisfied -- typed sessionId, no path-parsing |
| Validate at boundaries | Slice 5 | Satisfied -- parse-time validation |
| Document 'why' | Slice 2 | Satisfied -- JSDoc explains architectural reason |
| Immutability by default | Slice 4 | Satisfied -- readonly field added |
| YAGNI | All | Satisfied -- no new abstractions |

## Open Questions

None. All questions resolved during design.

## Unresolved Unknown Count: 0
## Plan Confidence Band: High
