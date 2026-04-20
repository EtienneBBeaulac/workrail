# Implementation Plan: WorkTrain Stuck-Escalation

*2026-04-19 | Pitch: .workrail/current-pitch.md*

---

## 1. Problem Statement

When a WorkTrain daemon session enters a `repeated_tool_call` loop, the session
currently burns turns until wall-clock or max-turn timeout. The result is
`_tag: 'timeout'`, indistinguishable from a legitimate slow session. Automated
routing is impossible without string-parsing.

---

## 2. Acceptance Criteria

1. `WorkflowRunStuck` interface exported from `workflow-runner.ts` with fields:
   `_tag: 'stuck'`, `workflowId`, `reason`, `message`, `stopReason`, `issueSummaries?`
2. `WorkflowRunResult` union includes `WorkflowRunStuck`.
3. `ChildWorkflowRunResult` union includes `WorkflowRunStuck` (SAME COMMIT as #2).
4. `WorkflowTrigger.agentConfig` has `stuckAbortPolicy?` and `noProgressAbortEnabled?`.
5. `TriggerDefinition.agentConfig` has the same two fields.
6. When `repeated_tool_call` fires and `stuckAbortPolicy !== 'notify_only'`:
   outbox entry written, `agent.abort()` called, `stuckReason = 'repeated_tool_call'`.
7. When `notify_only` is set: outbox written, abort NOT called.
8. When `noProgressAbortEnabled: true` and `no_progress` fires with `stuckAbortPolicy !== 'notify_only'`:
   same abort + outbox write.
9. Return path returns `{ _tag: 'stuck', ... }` before `timeoutReason` check.
10. `trigger-router.ts` `route()` and `dispatch()` handle `stuck` without assertNever fallthrough.
11. `notification-service.ts` `buildNotificationBody()` and `buildDetail()` handle `stuck`.
12. `NotificationPayload.outcome` union includes `'stuck'`.
13. `makeSpawnAgentTool` handles `stuck` child result, returns `outcome: 'stuck'`.
14. All 6 test cases in `workflow-runner-stuck-escalation.test.ts` pass.
15. `npm run build` clean. `npx vitest run` no regressions.

---

## 3. Non-Goals

- No `onStuck:` hook in TriggerDefinition (follow-up)
- No console live panel stuck indicator
- No `worktrain logs` formatting changes
- No automatic retry on stuck
- No Signal 5 (wall-clock at 80%) wiring
- No new heuristics beyond Signal 1 and 2
- No changes to `src/mcp/`
- No `trigger-store.ts` parser changes

---

## 4. Philosophy-Driven Constraints

- All new fields `readonly`
- `issueSummaries` spread to new readonly array when included in return value
- `writeStuckOutboxEntry` is fire-and-forget (void + catch)
- `stuckReason` flag: first-writer-wins (same as `timeoutReason`)
- Outbox write and abort are independent effects (write before abort gate check)

---

## 5. Invariants

- **I1**: `ChildWorkflowRunResult` and `WorkflowRunResult` updates ship in the same commit.
- **I2**: `stuckReason` is checked BEFORE `timeoutReason` in the return path.
- **I3**: Outbox write fires regardless of `stuckAbortPolicy`.
- **I4**: `no_progress` never aborts unless `noProgressAbortEnabled: true`.
- **I5**: `repeated_tool_call` abort fires on the same turn as detection.
- **I6**: First writer wins on `stuckReason` (guard: `stuckReason === null && timeoutReason === null`).

---

## 6. Selected Approach

New `_tag: 'stuck'` discriminated union variant. Wire abort in `turn_end` subscriber
after Signal 1 and Signal 2 emitter calls. Return stuck result before `timeoutReason`
check. Update both union types atomically. Add `writeStuckOutboxEntry` module-level
helper. Propagate to trigger-router, notification-service, makeSpawnAgentTool.

**Runner-up rejected**: Extend `WorkflowRunTimeout.reason` -- violates make-illegal-states-unrepresentable.

---

## 7. Vertical Slices

### Slice 1: Core types (workflow-runner.ts)
- Add `WorkflowRunStuck` interface after `WorkflowRunTimeout`
- Add to `WorkflowRunResult` union
- Add to `ChildWorkflowRunResult` union (ATOMIC with above)
- Add `stuckAbortPolicy?` and `noProgressAbortEnabled?` to `WorkflowTrigger.agentConfig`
- **Done when**: `npm run build` clean after this slice

### Slice 2: TriggerDefinition.agentConfig (types.ts)
- Add `stuckAbortPolicy?` and `noProgressAbortEnabled?` after `maxTurns`
- **Done when**: `npm run build` clean

### Slice 3: Runtime wiring (workflow-runner.ts)
- Add `sessionStartMs` constant after `maxTurns` resolution
- Add `stuckReason` flag after `timeoutReason` flag
- Add `writeStuckOutboxEntry` module-level helper
- Wire abort after Signal 1 emitter call in `turn_end`
- Wire abort after Signal 2 emitter call in `turn_end`
- Add stuck return path before `timeoutReason` check
- Update `makeSpawnAgentTool` resultObj type + add `stuck` arm before `assertNever`
- **Done when**: `npm run build` clean

### Slice 4: Caller propagation (trigger-router.ts, notification-service.ts)
- Add `stuck` arm in `route()` exhaustive chain
- Add `stuck` arm in `dispatch()` exhaustive chain
- Add `'stuck'` to `NotificationPayload.outcome` union
- Add `stuck` case in `buildNotificationBody()`
- Add `stuck` case in `buildDetail()`
- **Done when**: `npm run build` clean

### Slice 5: Tests
- Write `tests/unit/workflow-runner-stuck-escalation.test.ts` with 6 test cases
- **Done when**: all 6 tests pass, no regressions

---

## 8. Test Design

File: `tests/unit/workflow-runner-stuck-escalation.test.ts`

Pattern: replicate turn_end subscriber logic (same as workflow-runner-stuck-detection.test.ts).

**Test 1**: `stuckAbortPolicy: 'abort'` default -- repeated_tool_call fires, stuckReason set, abort called, would return _tag:'stuck'
**Test 2**: `stuckAbortPolicy: 'notify_only'` -- abort NOT called, emitter still fires
**Test 3**: `noProgressAbortEnabled: false` default -- no_progress does NOT set stuckReason
**Test 4**: `noProgressAbortEnabled: true` -- no_progress sets stuckReason = 'no_progress', abort called
**Test 5**: Compile-time assignability test: `WorkflowRunStuck` is assignable to `ChildWorkflowRunResult`
**Test 6**: trigger-router exhaustive switch handles 'stuck' (import trigger-router, verify no assertNever path hit)

---

## 9. Risk Register

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| ChildWorkflowRunResult not updated atomically | Low | High | Single-PR, Slice 1 includes both updates, Test 5 catches gap |
| NotificationPayload.outcome union gap | Low | Medium | Slice 4 adds 'stuck'; build catches it |
| stuckReason/timeoutReason race | Low | Low | Guard condition (both null check) |
| writeStuckOutboxEntry silent failure | Low | Low | Fire-and-forget with console.warn |

---

## 10. PR Packaging Strategy

Single PR: `feat/stuck-escalation`
Single atomic commit with all 4 source files + test file.
PR title: `feat(daemon): WorkflowRunStuck result variant with abort and outbox notification`

---

## 11. Philosophy Alignment Per Slice

| Slice | Principle | Status |
|-------|-----------|--------|
| Slice 1 (types) | Make illegal states unrepresentable | Satisfied |
| Slice 1 (types) | Exhaustiveness everywhere | Satisfied |
| Slice 1 (types) | Type safety as first line of defense | Satisfied (ChildWorkflowRunResult updated) |
| Slice 3 (runtime) | Errors are data | Satisfied |
| Slice 3 (runtime) | Determinism over cleverness | Satisfied (simple flag) |
| Slice 3 (runtime) | Fire-and-forget side effects | Satisfied (outbox write) |
| Slice 4 (callers) | Exhaustiveness everywhere | Satisfied (all assertNever guards updated) |
| Slice 5 (tests) | Prefer fakes over mocks | Satisfied (replicate subscriber logic, not vi.mock) |

---

**unresolvedUnknownCount**: 0
**planConfidenceBand**: High
**estimatedPRCount**: 1
