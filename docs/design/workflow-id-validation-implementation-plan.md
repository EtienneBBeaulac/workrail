# Implementation Plan: Workflow ID Validation at Daemon Startup

**Status:** Ready to implement  
**Branch:** `fix/workflow-id-validation-at-startup`  
**Date:** 2026-04-16

---

## 1. Problem Statement

When a user writes an incorrect `workflowId` in `triggers.yml` (e.g., `coding-task-workflow-agentic.lean.v2` instead of `coding-task-workflow-agentic`), the daemon starts successfully, accepts webhooks, but every dispatch silently fails with `workflow_not_found`. The error only appears in logs during actual webhook events -- not at startup. This is a silent-failure bug.

---

## 2. Acceptance Criteria

- [x] At daemon startup, after loading and indexing triggers, validate that each trigger's `workflowId` resolves to a known workflow
- [x] Triggers with unknown `workflowId` are logged with a clear warning (naming the triggerId and the bad workflowId) and removed from the active index
- [x] Triggers with valid `workflowId` start normally
- [x] If `getWorkflowByIdFn` throws or rejects, that trigger is also warned+skipped (not a daemon crash)
- [x] Existing behavior when `getWorkflowByIdFn` is not provided: validation is skipped (backward compat, logged)
- [x] Existing tests continue to pass without modification

---

## 3. Non-Goals

- No hard-fail policy (daemon does not refuse to start; it starts with fewer triggers)
- No validation of `onComplete.workflowId` (secondary workflow ID -- follow-up ticket)
- No changes to `trigger-store.ts` or `TriggerDefinition` type
- No re-validation on webhook arrival
- No dynamic reload / hot-reload of trigger config
- No change to `trigger-router.ts` (it already handles `workflow_not_found` at dispatch)

---

## 4. Philosophy-Driven Constraints

- **Dependency injection**: `getWorkflowByIdFn` must be injectable -- no direct `ctx.workflowService` access
- **Validate at boundaries**: validation runs at `startTriggerListener` (startup boundary), not inside routing
- **Errors are data**: validation failures are warnings + skip, not thrown exceptions
- **Document why**: implementation must include WHY comments on the key decisions
- **Warn+skip over hard-fail**: consistent with `loadTriggerConfig` existing behavior

---

## 5. Invariants

1. The `triggerIndex` passed to `TriggerRouter` contains ONLY triggers whose `workflowId` was confirmed to exist (when `getWorkflowByIdFn` is provided)
2. The validation loop MUST NOT mutate `triggerIndex` during iteration (collect unknowns first, delete after)
3. A `getWorkflowByIdFn` rejection/throw MUST NOT propagate -- it is caught, the trigger is warned+skipped
4. When `getWorkflowByIdFn` is absent, validation is skipped entirely (backward compat) and a log message says so
5. `DefaultWorkflowService.getWorkflowById` delegates directly to storage (no compilation cache interference) -- validation results are authoritative

---

## 6. Selected Approach

**Add `getWorkflowByIdFn?: (id: string) => Promise<boolean>` to `StartTriggerListenerOptions`.**

In `startTriggerListener`, after `buildTriggerIndex()` returns ok, if `getWorkflowByIdFn` is provided:
1. Iterate `triggerIndex` entries (read-only pass), collect unknown workflowIds
2. For each, try `await getWorkflowByIdFn(trigger.workflowId)` -- catch rejection, treat as false
3. Collect trigger IDs where result is false or threw
4. After iteration: delete collected IDs from `triggerIndex`, log warnings
5. Log summary if any were skipped

Production default (not on the option -- called inline): `async (id) => (await ctx.workflowService?.getWorkflowById(id)) !== null`.

**Runner-up:** Candidate B (ctx direct with null guard) -- lost because `FAKE_CTX = {} as V2ToolContext` makes the behavior untestable.

---

## 7. Vertical Slices

### Slice 1 -- Core validation logic in `startTriggerListener`

**Files:** `src/trigger/trigger-listener.ts`

**Changes:**
- Add `getWorkflowByIdFn?: (id: string) => Promise<boolean>` to `StartTriggerListenerOptions`
- After `buildTriggerIndex()` returns ok (before `new TriggerRouter`): add validation block
- Validation block logic:
  ```
  if (getWorkflowByIdFn) {
    const unknownTriggerIds: string[] = []
    for (const [triggerId, trigger] of triggerIndex) {
      let found: boolean
      try {
        found = await getWorkflowByIdFn(trigger.workflowId)
      } catch (e) {
        found = false
        console.warn(`[TriggerListener] Error validating workflowId '${trigger.workflowId}' for trigger '${triggerId}': ${e}`)
      }
      if (!found) {
        unknownTriggerIds.push(triggerId)
        console.warn(`[TriggerListener] Skipping trigger '${triggerId}': workflowId '${trigger.workflowId}' not found`)
      }
    }
    for (const id of unknownTriggerIds) { triggerIndex.delete(id) }
    if (unknownTriggerIds.length > 0) {
      console.warn(`[TriggerListener] Skipped ${unknownTriggerIds.length} trigger(s) with unknown workflowId(s)`)
    }
  } else {
    console.log(`[TriggerListener] workflowId validation skipped (no resolver provided)`)
  }
  ```
- Add production default invocation: pass `async (id) => (await ctx.workflowService?.getWorkflowById(id)) !== null` as the default when option not provided

**Acceptance criterion:** Unknown workflowId triggers are not present in the index passed to `TriggerRouter`.

### Slice 2 -- Tests in `trigger-router.test.ts`

**Files:** `tests/unit/trigger-router.test.ts`

**New test cases (in a new describe block `startTriggerListener workflowId validation`):**
1. Triggers with unknown workflowId are warned and skipped (index excludes them, server starts)
2. Triggers with valid workflowId are kept in the index
3. When `getWorkflowByIdFn` is not provided, validation is skipped and all triggers are kept
4. When `getWorkflowByIdFn` rejects, that trigger is warned and skipped (daemon doesn't crash)
5. Mix: some valid, some invalid -- only valid triggers remain

**Acceptance criterion:** All 5 test cases pass.

---

## 8. Test Design

**Pattern to follow:** `startTriggerListener` tests in `trigger-router.test.ts` (~line 432). Same structure:
- Use `tmpPath()` for workspacePath
- `env: { WORKRAIL_TRIGGERS_ENABLED: 'true' }`
- `port: 0` for OS-assigned port
- `runWorkflowFn: vi.fn()`
- `workspaces: {}` to skip workspace config loading

**Fixtures needed:**
- A minimal `triggers.yml` with two triggers: one with valid workflowId, one with invalid
- `getWorkflowByIdFn` stub: `vi.fn().mockImplementation(async (id: string) => id === 'coding-task-workflow-agentic')`

**Note:** Tests write real `triggers.yml` files to `tmpPath()` directories (pattern established in existing tests). Check how existing `startTriggerListener` tests set up workspace directories.

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `ctx.workflowService` undefined in production | Low | Medium | Optional chaining `?.` in default fn |
| FM1: getWorkflowByIdFn throws | Low-Medium | High | try/catch per call, warn+skip |
| FM3: Map mutation during iteration | Low (easy to avoid) | Medium | Two-pass (collect then delete) |
| False positive (valid workflow not found due to I/O error) | Low | Low | Same as FM1 -- warn+skip, operator can restart |
| `onComplete.workflowId` still silent-fails | Medium | Low | Accepted, documented, follow-up ticket |

---

## 10. PR Packaging

**Single PR.** Small task, all changes in 2 files. Branch: `fix/workflow-id-validation-at-startup`.

PR title: `fix(trigger): warn and skip triggers with unknown workflowId at startup`

---

## 11. Philosophy Alignment Per Slice

| Principle | Slice 1 | Slice 2 |
|-----------|---------|---------|
| Dependency injection for boundaries | Satisfied -- fn injectable | Satisfied -- tests inject stub |
| Validate at boundaries | Satisfied -- startup boundary | N/A |
| Errors are data | Satisfied -- warn+skip, no throw | Satisfied -- tests verify no crash |
| Document why | Satisfied -- WHY comments required | N/A |
| Warn+skip over hard-fail | Satisfied | Verified by tests |
| Immutability by default | Tension -- triggerIndex mutated, but local scope | N/A |

---

## 12. Follow-up Tickets

- `onComplete.workflowId` validation (secondary workflow IDs in completion hooks)

---

**unresolvedUnknownCount:** 0  
**planConfidenceBand:** High  
**estimatedPRCount:** 1
