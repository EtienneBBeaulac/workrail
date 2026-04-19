# Implementation Plan: POST /api/v2/sessions/:sessionId/steer

**Branch:** `feat/session-steer-endpoint`
**Confidence:** High
**PR count:** 1

---

## Problem Statement

A coordinator script needs to inject text into an agent's next turn during a running daemon session.
The `steer()` mechanism in `AgentLoop` already delivers injected text. The gap is a bridge between
an HTTP endpoint and the closure-scoped `pendingSteerText` variable in `runWorkflow()`.

Additionally, the existing `pendingSteerText: string | null` is a single-value field that silently
drops coordinator steers when overwritten by `onAdvance()`. This must be fixed first (R1 finding).

---

## Acceptance Criteria

1. `POST /api/v2/sessions/:sessionId/steer` with body `{ "text": "..." }` returns HTTP 200
   `{ "success": true }` when the sessionId belongs to an active daemon session.
2. The injected text is delivered to the agent via `agent.steer()` on the next `turn_end` event,
   concatenated after the step text from `onAdvance()`.
3. Returns HTTP 404 `{ "success": false, "error": "Session not found or not a daemon session" }`
   when the sessionId is not in the registry.
4. Returns HTTP 503 `{ "success": false, "error": "Steer not available..." }` in standalone console
   mode (no steerRegistry injected).
5. Returns HTTP 400 for missing or non-string `text` body.
6. Multiple calls to the endpoint between `turn_end` events: all injected texts are delivered in the
   same steer message, joined with `\n\n`.
7. After the session completes, calling the endpoint returns 404.
8. The existing `pendingSteerText` variable is replaced by `pendingSteerParts: string[]` and
   `onAdvance()` behavior is unchanged from the caller's perspective (step advance still works).

---

## Non-Goals

- Auth token on the endpoint (v1 is localhost-only, network binding is the security layer)
- `waitForCoordinator` blocking gate mechanism (Phase 2B, separate task)
- `wr.coordinator_signal` artifact schema (Phase A, separate task)
- MCP-mode injection (deferred to v2)
- Crash recovery for in-flight steers (in-memory only, v1 known limitation)
- Structured request body beyond `{ text: string }` (v2 concern)

---

## Philosophy-Driven Constraints

- **DI for boundaries**: `SteerRegistry` must be injected into `mountConsoleRoutes()` and
  `runWorkflow()`. No module-level singletons.
- **Errors as data**: HTTP responses use `{ success: bool, error?: string }` shape. No thrown
  exceptions at the route level.
- **Validate at boundaries**: 400 for invalid body, 503 for disabled, 404 for not-found -- all
  checked before touching the registry.
- **YAGNI**: Only what's listed in acceptance criteria. No speculative extension points.
- **Explicit domain types**: Named type alias `SteerRegistry` (not raw `Map<string, fn>` literal).

---

## Invariants

1. `pendingSteerParts` is only mutated in two places: `onAdvance()` (push step text) and the steer
   callback registered in the `SteerRegistry` (push coordinator text). No other writer.
2. `pendingSteerParts` is only read and drained in the `turn_end` subscriber. Single reader.
3. JavaScript single-threaded event loop: no race between push and drain.
4. The steer callback is registered after `workrailSessionId` is decoded from the continueToken,
   and deregistered in `runWorkflow()`'s `finally` block. No stale entries possible.
5. The endpoint is only active when `steerRegistry` is provided to `mountConsoleRoutes()`.
   The standalone console does not provide it.
6. The `steerRegistry` param is optional on all functions. No existing callers are broken.

---

## Selected Approach

**Hybrid (type alias + parameter injection):**
- Named type alias `export type SteerRegistry = Map<string, (text: string) => void>` in
  `src/daemon/workflow-runner.ts`.
- `pendingSteerText: string | null` replaced by `const pendingSteerParts: string[] = []`.
- `onAdvance()` uses `pendingSteerParts.push(stepText)`.
- turn_end subscriber drains with `const parts = pendingSteerParts.splice(0)` and calls
  `agent.steer(buildUserMessage(parts.join('\n\n')))` if `parts.length > 0`.
- `runWorkflow()` gains optional `steerRegistry?: SteerRegistry` param. After workrailSessionId
  is decoded, calls `steerRegistry?.set(workrailSessionId, (text) => pendingSteerParts.push(text))`.
  In `finally`: `steerRegistry?.delete(workrailSessionId)`.
- `mountConsoleRoutes()` gains optional `steerRegistry?: SteerRegistry` param after `triggerRouter`.
- `POST /api/v2/sessions/:sessionId/steer` endpoint added in `console-routes.ts`.
- `TriggerRouter` constructor gains optional `steerRegistry?: SteerRegistry`; passes to
  `runWorkflowFn()` calls in `route()` and `dispatch()`.
- `RunWorkflowFn` type in `trigger-router.ts` extended with optional 6th param.

**Runner-Up:** C2 (SteerRegistry class). Loses only for having a new file for 3 trivial operations.
Use if the registry gains additional methods or needs isolated unit tests.

---

## Vertical Slices

### Slice 1: Fix `pendingSteerText` -> `pendingSteerParts` (R1 prerequisite)

**Files:** `src/daemon/workflow-runner.ts` only.

**Change:**
- Rename `pendingSteerText: string | null` to `const pendingSteerParts: string[] = []`.
- Update `onAdvance()`: `pendingSteerText = stepText` -> `pendingSteerParts.push(stepText)`.
- Update turn_end subscriber drain:
  - Before: `if (pendingSteerText !== null && !isComplete) { ... }`
  - After: `if (!isComplete) { const parts = pendingSteerParts.splice(0); if (parts.length > 0) { agent.steer(buildUserMessage(parts.join('\n\n'))); } }`
- Note: `isComplete` guard moves outside the `splice(0)` -- drain always happens, steer only if not complete and parts non-empty.

**Acceptance:** Existing behavior unchanged. Session still receives step text on each advance.
No coordinator injection yet. Build+type-check passes. Existing tests pass.

**Risk:** Low. Pure refactor, no behavior change from external perspective.

---

### Slice 2: SteerRegistry type alias + runWorkflow() registration

**Files:** `src/daemon/workflow-runner.ts`.

**Change:**
- Add: `export type SteerRegistry = Map<string, (text: string) => void>;`
- Add optional param to `runWorkflow()`: `steerRegistry?: SteerRegistry`
- After `workrailSessionId` is decoded (line ~2190): register callback:
  ```typescript
  if (steerRegistry && workrailSessionId) {
    steerRegistry.set(workrailSessionId, (text: string) => { pendingSteerParts.push(text); });
  }
  ```
- In `finally` block: `if (steerRegistry && workrailSessionId) { steerRegistry.delete(workrailSessionId); }`
- Add code comment on the `set()` call documenting the registration gap.

**Acceptance:** `runWorkflow()` compiles with new optional param. Existing callers unchanged.
Manual test: if a steerRegistry Map is passed and a callback is registered/called during a session,
text is pushed to `pendingSteerParts`.

**Risk:** Low. Additive change, no behavior change when `steerRegistry` is undefined.

---

### Slice 3: TriggerRouter wiring

**Files:** `src/trigger/trigger-router.ts`.

**Change:**
- Import `SteerRegistry` from `workflow-runner.js`.
- Extend `RunWorkflowFn` type with optional 6th param:
  `steerRegistry?: SteerRegistry` after `emitter?`.
- Add `private readonly steerRegistry?: SteerRegistry` to `TriggerRouter`.
- Add `steerRegistry?: SteerRegistry` to TriggerRouter constructor params.
- Assign in constructor: `this.steerRegistry = steerRegistry`.
- Update `route()` call: `this.runWorkflowFn(workflowTrigger, this.ctx, this.apiKey, undefined, this.emitter, this.steerRegistry)`
- Update `dispatch()` call: same.

**Acceptance:** TriggerRouter compiles. `runWorkflow` in production TriggerRouter path passes
steerRegistry to the agent loop. Existing trigger tests unaffected (registry is optional).

**Risk:** Low. Additive param. All existing test calls to `TriggerRouter` pass `undefined` or
omit the param.

---

### Slice 4: HTTP endpoint in console-routes.ts

**Files:** `src/v2/usecases/console-routes.ts`.

**Change:**
- Import `SteerRegistry` from `../../daemon/workflow-runner.js`.
- Add `steerRegistry?: SteerRegistry` to `mountConsoleRoutes()` param list (after `triggerRouter`).
- Add endpoint after the `POST /api/v2/auto/dispatch` block:

```typescript
// POST /api/v2/sessions/:sessionId/steer
// Injects text into a running daemon session's next agent turn.
// Daemon-only: requires steerRegistry to be provided at server startup.
// Auth: localhost-only (127.0.0.1 binding). No token auth in v1.
// TODO(v2): Add token auth before any multi-user or remote deployment.
app.post('/api/v2/sessions/:sessionId/steer', express.json(), (req: Request, res: Response) => {
  if (!steerRegistry) {
    res.status(503).json({ success: false, error: 'Steer not available (not a daemon context).' });
    return;
  }
  const { sessionId } = req.params;
  const body = req.body as { text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ success: false, error: 'text is required and must be a non-empty string.' });
    return;
  }
  const callback = steerRegistry.get(sessionId);
  if (!callback) {
    res.status(404).json({ success: false, error: 'Session not found or not a daemon session.' });
    return;
  }
  callback(text);
  res.json({ success: true });
});
```

**Acceptance:** All 5 HTTP response cases work correctly (200, 400, 404, 503). Session receives
injected text on next turn_end. Standalone console returns 503.

**Risk:** Low. New endpoint, no changes to existing routes.

---

### Slice 5: Daemon wiring in daemon-console.ts

**Files:** `src/trigger/daemon-console.ts`.

**Change:**
- Import `SteerRegistry` from `../daemon/workflow-runner.js`.
- Before constructing `TriggerRouter`: `const steerRegistry: SteerRegistry = new Map();`
- Pass to `TriggerRouter` constructor: `new TriggerRouter(index, ctx, apiKey, runWorkflow, execFn, ..., steerRegistry)`
- Pass to `mountConsoleRoutes()`: add `steerRegistry` as the last argument (after `triggerRouter`).
- Also update the direct `runWorkflow()` call in `console-routes.ts` `POST /auto/dispatch` path
  (when `triggerRouter` is absent): pass `steerRegistry` as 6th arg.

**Acceptance:** End-to-end: daemon starts, `POST /auto/dispatch` creates a session, coordinator
calls `POST /sessions/:id/steer`, agent receives injected text on next turn.

**Risk:** Medium. This is the wiring step that connects all slices. Most likely source of missed
call sites.

---

## Test Design

### Unit tests (workflow-runner.ts)
- Test that `onAdvance()` pushes to `pendingSteerParts`.
- Test that turn_end subscriber joins and steers when `pendingSteerParts.length > 0`.
- Test that multiple pushes (simulate both `onAdvance` and steer callback) produce joined text.
- Test that `steerRegistry.set()` is called after workrailSessionId decoded.
- Test that `steerRegistry.delete()` is called in finally (mock registry, verify delete).

### Integration test (console-routes.ts)
- Mock `steerRegistry` with a Map. POST to endpoint with valid body -> 200, callback called.
- POST with empty body -> 400.
- POST with unknown sessionId -> 404.
- POST without steerRegistry injected -> 503.

### Regression: existing tests
- All existing `runWorkflow()` tests must pass unchanged (optional param, default undefined).
- All existing `mountConsoleRoutes()` tests must pass unchanged.
- All existing TriggerRouter tests must pass unchanged.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Missed call site for steerRegistry in dispatch/route | Medium | High | Search for all `runWorkflowFn(` calls in trigger-router.ts before submitting |
| `pendingSteerParts.splice(0)` stale closure ref | Low | High | splice(0) mutates in-place; closure over array variable (not array contents) is safe |
| Registration gap causes 404 for early steers | Very low | Low | Document with code comment; coordinator retries on 404 |
| `mountConsoleRoutes` callers not updated | Low | Medium | Only 3 callers: daemon-console.ts, standalone-console.ts (no change), console-routes.ts |

---

## PR Packaging Strategy

Single PR on branch `feat/session-steer-endpoint`. All 5 slices together. The R1 fix (Slice 1) is
small enough that it doesn't need its own PR. The endpoint is only usable when all slices are present.

PR title: `feat(console): add POST /api/v2/sessions/:sessionId/steer for coordinator injection`

---

## Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| S1 pendingSteerParts | Immutability by default | Tension (mutable array) -- acceptable, mutation bounded |
| S1 pendingSteerParts | Compose with small pure functions | Satisfied -- drain is one expression |
| S2 SteerRegistry type | Explicit domain types | Satisfied -- named alias |
| S2 runWorkflow registration | DI for boundaries | Satisfied -- injected, not global |
| S3 TriggerRouter | Make illegal states unrepresentable | Satisfied -- optional param can't be confused with required |
| S4 HTTP endpoint | Validate at boundaries | Satisfied -- 400/503/404 before touching registry |
| S4 HTTP endpoint | Errors as data | Satisfied -- { success: bool } shape |
| S5 daemon wiring | YAGNI | Satisfied -- single Map, no extra abstraction |
