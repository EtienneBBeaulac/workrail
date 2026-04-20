# Implementation Plan: dispatchCondition Filter and Adaptive Queue Routing

## Problem Statement

Two deficiencies in the trigger system:
1. Generic webhook triggers have no payload-based dispatch filter. In queue use cases (e.g., only fire when `assignee.login === 'worktrain-etienneb'`), every webhook fires regardless of payload content.
2. `github_queue_poll` triggers can silently fall back to `dispatch()` instead of always routing through the adaptive coordinator. This is wrong -- queue poll sessions MUST always use the adaptive coordinator.

## Acceptance Criteria

1. `TriggerDefinition.dispatchCondition` field exists with `payloadPath: string` and `equals: string` subfields (both `readonly`)
2. `dispatchCondition` is parsed from triggers.yml sub-object block (same syntax as `agentConfig`)
3. `dispatchCondition.payloadPath` and `dispatchCondition.equals` are validated as required strings when the block is present
4. In `route()`, when `dispatchCondition` is set and the extracted payload value does NOT strictly equal `equals`: return `{ _tag: 'enqueued' }` silently (no dispatch) with a debug log
5. When condition IS met (or absent): dispatch proceeds normally
6. `doPollGitHubQueue()` ALWAYS calls `dispatchAdaptivePipeline()` -- never falls back to `dispatch()`
7. When `dispatchAdaptivePipeline` is unavailable: throw Error with clear message (NOT silent fallback)
8. `workflowId` is no longer required in triggers.yml for `github_queue_poll` providers
9. Existing triggers.yml files with `workflowId` on a queue trigger still parse without error (log warning it's ignored)
10. `npm run build` clean
11. All specified tests pass, no regressions in `npx vitest run`

## Non-Goals

- No regex matching in `dispatchCondition` (MVP: equals-only)
- No AND/OR or nested conditions
- No changes to `src/mcp/` (scope locked to 4 trigger files)
- No changes to `RouteResult` type variants (reuse `enqueued` for skipped)
- No changes to `WorkflowTrigger.workflowId` type signature

## Philosophy-Driven Constraints

- All new fields in `TriggerDefinition`: `readonly`
- Validate `dispatchCondition` at parse time (trigger-store.ts), not at dispatch time
- Use strict identity (`===`) for `dispatchCondition` comparison -- no type coercion
- Comment at `workflowId` sentinel explaining why `''` is safe
- Throw for missing `dispatchAdaptivePipeline` (programmer error, not domain error)

## Invariants

1. `dispatchCondition` absent = always dispatch (current behavior, unchanged)
2. `dispatchCondition.payloadPath` and `dispatchCondition.equals` always co-present (validated at parse time)
3. `dispatchCondition` check runs AFTER HMAC validation, BEFORE context mapping application
4. `route()` return type never changes -- `{ _tag: 'enqueued' }` for both dispatch and skip
5. `doPollGitHubQueue()` never calls `this.router.dispatch()` -- always `dispatchAdaptivePipeline`
6. `workflowId: ''` sentinel for queue poll -- never forwarded to adaptive dispatcher (only goal/workspace/context)
7. Throw from `doPollGitHubQueue` is caught by `runPollCycle` try/catch -- not a daemon crash

## Selected Approach

**Candidate 1: Exact spec implementation with FM5 correction (strict equals)**

- `types.ts`: Add `dispatchCondition?: { readonly payloadPath: string; readonly equals: string }` to `TriggerDefinition`
- `trigger-store.ts`: Add `dispatchCondition` sub-object block to YAML parser (like `agentConfig`), validate both fields present, assemble onto `TriggerDefinition`
- `trigger-router.ts`: After HMAC check in `route()`, if `trigger.dispatchCondition` set, extract via `extractDotPath()`, check `extracted === condition.equals`, return `{ _tag: 'enqueued' }` with debug log if mismatch
- `polling-scheduler.ts`: Remove type-guard fallback in `doPollGitHubQueue()`, always call `dispatchAdaptivePipeline`, throw Error if unavailable

**Runner-up rejected:** Optional `workflowId` -- cascades to WorkflowTrigger and all builders, unnecessary blast radius.

## Vertical Slices

### Slice 1: types.ts -- Add dispatchCondition to TriggerDefinition
- Add JSDoc comment explaining purpose, payloadPath syntax, when absent behavior
- Both fields `readonly string`
- File: `src/trigger/types.ts`
- Done when: TypeScript compiles, new field visible in TriggerDefinition

### Slice 2: trigger-store.ts -- Parse and validate dispatchCondition
- Add `dispatchCondition?: { payloadPath?: string; equals?: string }` to `ParsedTriggerRaw`
- Add `'dispatchCondition'` to `setTriggerField` as known key (maps to sub-object block)
- Add `if (key === 'dispatchCondition')` block handler in YAML parser (before `rawValue === ''` check)
- Validate both payloadPath and equals present strings when block set, return TriggerStoreError if either missing
- Assemble onto TriggerDefinition in trigger assembly block
- Add workflowId conditional skip for github_queue_poll (with backward-compat warning when present)
- File: `src/trigger/trigger-store.ts`
- Done when: valid YAML with dispatchCondition parses correctly; missing field returns error; queue poll without workflowId parses; queue poll with workflowId logs warning

### Slice 3: trigger-router.ts -- Check dispatchCondition in route()
- After HMAC validation block, before context mapping
- Extract via `extractDotPath(event.payload, condition.payloadPath)`
- If `extracted !== condition.equals`: log `[TriggerRouter] dispatch skipped: condition not met (${payloadPath}=${actual} !== ${equals})`, return `{ _tag: 'enqueued', triggerId: trigger.id }`
- Strictly BEFORE `workflowContext` building and `workflowTrigger` object construction
- File: `src/trigger/trigger-router.ts`
- Done when: condition check blocks dispatch; matching condition allows dispatch; absent condition dispatches normally

### Slice 4: polling-scheduler.ts -- Always use adaptive, throw when unavailable
- Remove the type-guard `if ('dispatchAdaptivePipeline' in this.router && typeof ...) { ... } else { this.router.dispatch(workflowTrigger); }` block
- Replace with: check if `typeof (this.router as { dispatchAdaptivePipeline?: unknown }).dispatchAdaptivePipeline !== 'function'` -> throw Error
- Then call `await this.router.dispatchAdaptivePipeline(workflowTrigger.goal, workflowTrigger.workspacePath, workflowTrigger.context)`
- Add comment: `// Always use adaptive pipeline for queue poll triggers. workflowId from triggers.yml is intentionally ignored -- the adaptive coordinator decides the pipeline based on task content.`
- File: `src/trigger/polling-scheduler.ts`
- Done when: adaptive always called; test fake without method causes throw; log line updated

### Slice 5: Tests
- **trigger-router.test.ts**: 3 new tests for dispatchCondition
- **polling-scheduler.test.ts**: 2 new tests for queue poll adaptive routing + update existing fakes
- Files: `tests/unit/trigger-router.test.ts`, `tests/unit/polling-scheduler.test.ts`
- Done when: all 5 new tests pass; existing tests pass; no regressions

## Test Design

### Tests to Update in polling-scheduler.test.ts
- `makeRouter()` function: add `dispatchAdaptivePipeline: vi.fn().mockResolvedValue({ kind: 'merged' })` to the fake router object. Existing tests that use `makeRouter()` for gitlab_poll/github triggers won't be affected (doPollGitHub doesn't use this method).

### New Tests

**trigger-router.test.ts:**
```typescript
describe('TriggerRouter.route dispatchCondition', () => {
  it('dispatches when dispatchCondition is met (extracted value equals condition.equals)', async () => {
    // trigger with dispatchCondition: { payloadPath: '$.assignee.login', equals: 'worktrain-bot' }
    // payload: { assignee: { login: 'worktrain-bot' } }
    // expect: runWorkflow called
  });
  it('skips dispatch when dispatchCondition not met (wrong value)', async () => {
    // payload: { assignee: { login: 'other-user' } }
    // expect: runWorkflow NOT called, returns { _tag: 'enqueued' }
  });
  it('skips dispatch when dispatchCondition path not found in payload', async () => {
    // payload: {} (no assignee field)
    // expect: runWorkflow NOT called (undefined !== 'worktrain-bot')
  });
});
```

**polling-scheduler.test.ts:**
```typescript
describe('doPollGitHubQueue adaptive routing', () => {
  it('always calls dispatchAdaptivePipeline, never dispatch()', async () => {
    // fake router with dispatchAdaptivePipeline: vi.fn(), dispatch: vi.fn()
    // expect: dispatchAdaptivePipeline called, dispatch NOT called
  });
  it('throws when dispatchAdaptivePipeline is not available on router', async () => {
    // fake router with ONLY dispatch: vi.fn() (no dispatchAdaptivePipeline)
    // expect: doPoll throws Error
    // (runPollCycle catches it and logs warn -- test calls doPoll directly)
  });
});
```

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| YAML parser misses dispatchCondition block | Low | Add key case before rawValue === '' check |
| Strict equals vs coerced comparison (FM5) | Medium | Use extracted === condition.equals |
| Throw in doPollGitHubQueue not caught | Low | runPollCycle try/catch already in place |
| Existing queue poll test fakes break | Low | Update makeRouter() to add dispatchAdaptivePipeline |
| workflowId '' sentinel leaks to delivery | Low | Comment + queue poll never runs route() |

## PR Packaging Strategy

Single PR: `feat/dispatch-condition-and-adaptive-queue`
All 5 slices in one commit: `feat(trigger): add dispatchCondition filter and route queue triggers through adaptive coordinator`

## Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| types.ts | Immutability by default | Satisfied (readonly fields) |
| types.ts | Make illegal states unrepresentable | Satisfied (both fields required when block present) |
| trigger-store.ts | Validate at boundaries | Satisfied (parse-time validation) |
| trigger-store.ts | Errors are data | Satisfied (returns TriggerStoreError) |
| trigger-router.ts | Compose with small pure functions | Satisfied (reuse extractDotPath) |
| trigger-router.ts | Type safety | Satisfied (strict === comparison) |
| polling-scheduler.ts | Errors are data | Tension (throw instead of Result) -- spec overrides |
| polling-scheduler.ts | Exhaustiveness | Satisfied (no fallback path) |
| Tests | Prefer fakes over mocks | Satisfied (fake router with typed methods) |
