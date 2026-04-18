# Implementation Plan: spawn_agent Tool

## 1. Problem Statement

Agents running inside WorkRail daemon sessions currently delegate sub-tasks using
`mcp__nested-subagent__Task` (external Claude Code MCP tool). This produces no WorkRail
session, no audit trail, and no structured output. The delegated work is completely invisible
to WorkRail -- it cannot be traced, replayed, or composed into larger orchestrations.

**Three root causes to fix:**
1. No native WorkRail tool for spawning child sessions from within a daemon session
2. No `parentSessionId` link in the session event log (no parent-child graph)
3. No depth enforcement to prevent runaway delegation chains

---

## 2. Acceptance Criteria

- [ ] A daemon agent can call `spawn_agent({ workflowId, goal, workspacePath, context? })` from a workflow step
- [ ] The parent agent blocks until the child session completes (no polling, no fire-and-forget)
- [ ] The child session is created with `parentSessionId` in the session event log (durable, survives crashes)
- [ ] The tool returns `{ childSessionId, outcome: 'success'|'error'|'timeout', notes: string }` as JSON
- [ ] Spawning a child at depth >= `maxSubagentDepth` (default 3) returns a typed error without spawning
- [ ] `spawnDepth` propagates correctly through chains: root=0, child=1, grandchild=2
- [ ] Child sessions are created in-process (no HTTP dispatch, no semaphore involvement)
- [ ] `npm run build` passes with no new TypeScript errors
- [ ] The `spawn_agent` tool is listed in `BASE_SYSTEM_PROMPT` with usage guidance

---

## 3. Non-Goals

- `spawn_session` + `await_sessions` non-blocking parallel spawn (Phase 2)
- `maxTotalAgentsPerTask` width guardrail (Phase 2)
- Bare-prompt child sessions without a `workflowId` (Phase 2)
- Session tree query API (console DAG view reads `parentSessionId`, but no query endpoint in Phase 1)
- Zombie session cleanup (Phase 2)
- Changes to `TriggerRouter`, `dispatch()`, or the HTTP dispatch route
- Changes to the public `V2StartWorkflowInput` MCP schema (external callers are unaffected)

---

## 4. Philosophy-Driven Constraints

- **Errors are data**: All 4 `WorkflowRunResult` variants (`success`, `error`, `timeout`, `delivery_failed`) must be handled exhaustively and mapped to structured JSON return values. `execute()` must NOT throw for child failures.
- **Immutability by default**: New `WorkflowTrigger` fields must be `readonly`.
- **DI for boundaries**: `ctx`, `apiKey`, `runWorkflowFn`, `emitter` injected at factory construction time. No singletons, no global state.
- **Validate at boundaries**: Depth check at the START of `execute()`, before any async operations.
- **Make illegal states unrepresentable**: `childSessionId` must always be present in the result (pre-create guarantees it). `spawnDepth` must be a typed `WorkflowTrigger` field (not in context map).
- **YAGNI**: Phase 1 only. No bare-prompt mode, no `await_sessions`, no width guardrails.
- **Document 'why'**: Add WHY comments consistent with existing code style in `workflow-runner.ts`.

---

## 5. Invariants

1. **Semaphore bypass invariant**: `spawn_agent` must call `runWorkflow()` directly. Calling `TriggerRouter.dispatch()` from within a running session would cause semaphore deadlock.
2. **_preAllocatedStartResponse invariant**: When `trigger._preAllocatedStartResponse` is set, `runWorkflow()` MUST NOT call `executeStartWorkflow()` again. This invariant is already documented in the `WorkflowTrigger` JSDoc.
3. **Depth propagation invariant**: A child session at depth N must always construct its `spawn_agent` tool with `currentDepth = N`. This is enforced by the typed `readonly spawnDepth?: number` field on `WorkflowTrigger`.
4. **Schema strip invariant**: `session_created.data` uses `z.object({})` strip mode. Adding `parentSessionId?: string` is a backward-compatible additive change.
5. **V2StartWorkflowInput unchanged**: The public MCP input schema for `start_workflow` must not be modified. `parentSessionId` flows via `internalContext` only.

---

## 6. Selected Approach + Rationale + Runner-Up

**Selected: Candidate 2 (pre-create session with _preAllocatedStartResponse)**

`execute()` calls `executeStartWorkflow(input, ctx, { parentSessionId })`, decodes `childSessionId`
from the returned `continueToken` via `parseContinueTokenOrFail()`, then calls `runWorkflow()` with
`_preAllocatedStartResponse: startResult.value.response`. This blocks naturally -- `await runWorkflow()`
inside `execute()` pauses the parent's tool execution until the child completes.

**Rationale**: The `_preAllocatedStartResponse` pattern is already proven in `console-routes.ts`
(lines 573-624). This is a direct adaptation of stable existing machinery, not invention.
`childSessionId` is always deterministic (known before child runs). Crash-before-start is
observable (zombie session in store with `parentSessionId` intact).

**Runner-up: Candidate 1 (direct runWorkflow())**
Simpler (~10 fewer lines). Loses: `childSessionId` is unavailable if the run crashes before
AgentLoop starts. Pivot to this if `_preAllocatedStartResponse` is ever removed.

---

## 7. Vertical Slices

### Slice 1: WorkflowTrigger schema extension
**File**: `src/daemon/workflow-runner.ts`
**Change**: Add `readonly parentSessionId?: string` and `readonly spawnDepth?: number` to the `WorkflowTrigger` interface. Update `_preAllocatedStartResponse` JSDoc to list `spawn_agent` as a legitimate internal caller (O2 fix).
**Acceptance**: TypeScript compiles. No existing callers broken (new fields are optional). `_preAllocatedStartResponse` comment updated.
**Risk**: None (additive change).

### Slice 2: session_created.data schema extension
**File**: `src/v2/durable-core/schemas/session/events.ts`
**Change**: Extend `session_created.data` from `z.object({})` to `z.object({ parentSessionId: z.string().optional() })`.
**File**: `src/mcp/handlers/v2-execution/start.ts`
**Change**: Add `parentSessionId?: string` optional parameter to `buildInitialEvents()`. When provided, include it in the `session_created` event's `data` field. Thread `parentSessionId` from `executeStartWorkflow()` (via `internalContext?.['parentSessionId']`) into `buildInitialEvents()`.
**Acceptance**: TypeScript compiles. Existing session creation (without `parentSessionId`) produces `data: {}` (unchanged). Session created with `parentSessionId` produces `data: { parentSessionId: 'sess_...' }`.
**Risk**: Low (Zod strip mode, backward-compatible).

### Slice 3: makeSpawnAgentTool() factory
**File**: `src/daemon/workflow-runner.ts`
**Change**: Add `SpawnAgentParams` JSON Schema to `getSchemas()`. Add `makeSpawnAgentTool()` factory function alongside `makeCompleteStepTool()`, `makeContinueWorkflowTool()`, etc.

Factory signature:
```typescript
export function makeSpawnAgentTool(
  sessionId: string,             // process-local UUID (for logging)
  ctx: V2ToolContext,
  apiKey: string,
  thisWorkrailSessionId: string, // WorkRail sess_xxx ID (becomes parentSessionId)
  currentDepth: number,          // spawn depth of the parent session
  maxDepth: number,              // max depth before blocking spawn
  runWorkflowFn: typeof runWorkflow,
  emitter?: DaemonEventEmitter,
): AgentTool
```

`execute()` logic:
1. Depth check: if `currentDepth >= maxDepth`, return `{ childSessionId: null, outcome: 'error', notes: 'Max spawn depth exceeded ...' }` as JSON
2. Call `executeStartWorkflow({ workflowId, goal, workspacePath, context }, ctx, { parentSessionId: thisWorkrailSessionId })` and match result
3. On start error: return `{ childSessionId: null, outcome: 'error', notes: errorMessage }` as JSON
4. On start success: decode `childSessionId` from `startResult.response.continueToken` via `parseContinueTokenOrFail()`
5. Call `runWorkflowFn({ workflowId, goal, workspacePath, context, spawnDepth: currentDepth + 1, _preAllocatedStartResponse: startResult.response }, ctx, apiKey, undefined, emitter)`
6. Map `WorkflowRunResult` to `{ childSessionId, outcome, notes }`:
   - `success`: `{ outcome: 'success', notes: result.lastStepNotes ?? '' }`
   - `error`: `{ outcome: 'error', notes: result.message }`
   - `timeout`: `{ outcome: 'timeout', notes: result.message }`
   - `delivery_failed`: `{ outcome: 'error', notes: result.deliveryError }`
7. Return `{ content: [{ type: 'text', text: JSON.stringify(resultObj) }] }`

**Acceptance**: TypeScript compiles. Depth check fires at limit. All 4 result variants handled. `childSessionId` present in all returns (null only on depth error and start error).
**Risk**: Low (new function, no existing code changed).

### Slice 4: Inject spawn_agent in runWorkflow()
**File**: `src/daemon/workflow-runner.ts`
**Change**: Read `trigger.spawnDepth ?? 0` and `trigger.agentConfig?.maxSubagentDepth ?? 3` in `runWorkflow()`. Add `makeSpawnAgentTool(...)` to the `tools` array, using the decoded `workrailSessionId` as `thisWorkrailSessionId`.

Note: `workrailSessionId` is decoded from `startContinueToken` AFTER `executeStartWorkflow()`. The tool must be constructed after this decode, but the existing tool list construction already happens after this point (line ~1914).

**Acceptance**: TypeScript compiles. `runWorkflow()` signature unchanged. `spawn_agent` tool is in the tools list passed to `AgentLoop`.
**Risk**: Low. One new tool added to existing list.

### Slice 5: BASE_SYSTEM_PROMPT update
**File**: `src/daemon/workflow-runner.ts`
**Change**: Add `spawn_agent` to the tools section of `BASE_SYSTEM_PROMPT`. Document:
- When to use (delegate sub-tasks to a child WorkRail session)
- What it returns (`{ childSessionId, outcome, notes }`)
- Parent clock warning (maxSessionMinutes keeps ticking)
- Zombie session note (best-effort; cleanup in Phase 2)
- Depth limit note (default max depth 3)
**Acceptance**: Tool listed in system prompt with accurate description.
**Risk**: None.

---

## 8. Test Design

**Note**: No unit tests exist for other tool factories in `workflow-runner.ts` (all integration-style). Adding unit tests for `makeSpawnAgentTool()` is aspirational; the acceptance criterion for Phase 1 is `npm run build` passing.

**What to verify manually**:
1. TypeScript compiles cleanly (`npm run build`)
2. Depth check: create a trigger with `spawnDepth: 3`, verify tool returns error immediately
3. `_preAllocatedStartResponse` path: verify child session is created in store before `runWorkflow()` starts

**If existing tests exist**, run them with `npm test` after each slice.

---

## 9. Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Zombie session (executeStartWorkflow succeeds, runWorkflow fails before AgentLoop) | MEDIUM | Document in tool description, Phase 2 cleanup |
| Parent timeout while child runs | LOW | Document in tool description, user configures maxSessionMinutes |
| session_created.data Zod strictness | LOW | Confirmed strip mode; unverified by migration test |
| _preAllocatedStartResponse removed in future refactor | LOW | Update JSDoc (O2 fix) to protect against this |
| workrailSessionId null at tool construction time | LOW | Tool construction happens AFTER decode; if decode fails, skip spawn_agent tool or construct with empty string |

---

## 10. PR Packaging Strategy

**SinglePR**: `feat/daemon-spawn-agent-tool`

All 5 slices go into one PR. The slices are interdependent (Slice 4 requires Slice 3, Slice 3 uses Slice 2, etc.). Splitting across multiple PRs would leave the codebase in a broken intermediate state.

PR title: `feat(workflows): add spawn_agent tool for in-process child session delegation`

---

## 11. Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| Slice 1 (WorkflowTrigger extension) | Immutability: new fields are readonly | Satisfied |
| Slice 1 | Make illegal states unrepresentable: spawnDepth typed, not in context map | Satisfied |
| Slice 2 (schema extension) | Errors are data: Zod strip mode means extension is non-breaking | Satisfied |
| Slice 3 (makeSpawnAgentTool) | Errors are data: all variants return JSON, no throws | Satisfied |
| Slice 3 | Exhaustiveness: all 4 WorkflowRunResult variants handled | Satisfied |
| Slice 3 | DI for boundaries: ctx, apiKey, emitter injected | Satisfied |
| Slice 3 | Validate at boundaries: depth check first | Satisfied |
| Slice 4 (inject in runWorkflow) | YAGNI: no bare-prompt, no width guardrails | Satisfied |
| Slice 4 | Semaphore bypass invariant: direct runWorkflow(), not dispatch() | Satisfied |
| Slice 5 (system prompt) | Document 'why': parent clock and zombie warnings in tool description | Satisfied |

---

## 12. Plan Metrics

- `implementationPlan`: 5 slices across 3 files
- `slices`: Slice 1 (WorkflowTrigger), Slice 2 (schema + buildInitialEvents), Slice 3 (makeSpawnAgentTool), Slice 4 (inject in runWorkflow), Slice 5 (BASE_SYSTEM_PROMPT)
- `testDesign`: npm run build + manual depth check + manual session creation verification
- `estimatedPRCount`: 1
- `followUpTickets`: Phase 2 (spawn_session + await_sessions), zombie cleanup, session tree query API, maxTotalAgentsPerTask guardrail
- `unresolvedUnknownCount`: 0 (all open questions from design phase resolved)
- `planConfidenceBand`: High
