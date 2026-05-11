# Implementation Plan: SessionEventContext + provider/modelId on DaemonEvent

## Problem statement

Every per-session daemon event emit passes sessionId and workrailSessionId as separate positional parameters (via withWorkrailSession()). provider and modelId attribution is either absent or only present in llm_turn_started. There is no typed struct that groups these per-session constants, so adding provider/modelId requires updating all 29 emit call sites scattered across tools/, runner/, and workflow-runner.ts individually.

## Acceptance criteria

1. `SessionEventContext = { sessionId: RunId; provider: string; modelId: string }` exported from `daemon-events.ts`.
2. `withSessionContext(ctx: SessionEventContext, workrailSessionId?: string | null)` helper in `_shared.ts` replaces `withWorkrailSession()` -- spreads all four fields, omitting workrailSessionId when null.
3. All 14 per-session event interfaces gain optional `provider?: string` and `modelId?: string` fields.
4. `buildAgentClient()` returns `{ agentClient, modelId, provider: string }` -- provider is 'amazon-bedrock' or 'anthropic'.
5. `SessionEventContext` is constructed once in `buildAgentReadySession()` and added to `SessionScope`.
6. All 29 emit call sites use `withSessionContext(ctx, state.workrailSessionId)` instead of `withWorkrailSession(state.workrailSessionId)`.
7. `npx tsc --noEmit` passes. `npx vitest run` passes.

## Non-goals

- Do not remove `withWorkrailSession()` -- it may still be used outside daemon/ scope.
- Do not change the DaemonEventEmitter itself.
- Do not make provider/modelId required on event interfaces (backward-compatible, optional only).
- Do not add SessionEventContext to non-daemon code.

## Philosophy-driven constraints

- Single source of state truth: SessionEventContext constructed once, not rebuilt at each emit.
- workrailSessionId remains dynamic (passed separately) -- it starts null, set after token decode.
- Validate at boundaries: provider derived once in buildAgentClient(), not re-derived at call sites.

## Invariants

1. `SessionEventContext.workrailSessionId` is NOT a field -- it is always passed dynamically to `withSessionContext()`.
2. `buildAgentClient()` returns `provider: 'amazon-bedrock' | 'anthropic'` from all three code paths.
3. `SessionScope.ctx: SessionEventContext | undefined` -- undefined only in test contexts that don't inject a full session.
4. `withWorkrailSession()` is not deleted (may have other callers).

## Selected approach

1. Add `provider: string` to `buildAgentClient()` return -- all three paths (`agentConfig.model` explicit, bedrock default, direct API default).
2. Define `SessionEventContext` in `daemon-events.ts` alongside RunId.
3. Add optional `provider?` and `modelId?` to all 14 per-session event interfaces.
4. Add `withSessionContext(ctx, workrailSessionId?)` to `_shared.ts`.
5. Add `ctx?: SessionEventContext` to `SessionScope` in `session-scope.ts`.
6. Construct `ctx` in `buildAgentReadySession()` from `preAgentSession.modelId + provider + sessionId`.
7. Update all 29 emit call sites to use `withSessionContext(scope.ctx, ...)` or direct ctx access.

## Vertical slices

### S1: Add provider to buildAgentClient()
**File:** `src/daemon/core/agent-client.ts`  
**Done when:** Return type includes `provider: string`, all three return paths set it. tsc clean.

### S2: Define SessionEventContext + withSessionContext()
**Files:** `src/daemon/daemon-events.ts`, `src/daemon/tools/_shared.ts`  
**Done when:** Type exported, helper exported, tsc clean.

### S3: Add provider?/modelId? to event interfaces
**File:** `src/daemon/daemon-events.ts` (14 interface fields)  
**Done when:** All 14 per-session interfaces have the optional fields.

### S4: Add ctx to SessionScope and construct in buildAgentReadySession()
**Files:** `src/daemon/session-scope.ts`, `src/daemon/runner/agent-loop-runner.ts`  
**Done when:** SessionScope.ctx field exists, built from preAgentSession in buildAgentReadySession(). tsc clean.

### S5: Update all 29 emit call sites
**Files:** `runner/agent-loop-runner.ts`, `runner/finalize-session.ts`, `workflow-runner.ts`, all 7 `tools/*.ts`, `runner/construct-tools.ts`  
**Note:** `construct-tools.ts` passes `sid` and `workrailSid` to all tool factories -- these become `scope.ctx` after S4 adds ctx to SessionScope.  
**Strategy:** Compiler-guided -- after S4, tsc finds mismatches where ctx is not used.  
**Done when:** tsc exit 0 and npx vitest run passes.

## Test design

No new tests required. Compiler enforces all call sites. Existing daemon-events tests verify event shapes. No behavioral change -- only additive optional fields.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| workrailSessionId passed as stale null | None | It's passed live at emit time, not captured in ctx |
| provider missing in default path | Low | S1 explicitly covers all three return paths in buildAgentClient |
| withWorkrailSession() broken by refactor | None | Not removed, not changed |

## PR packaging

Single PR off a new branch, created after #972 merges. Branch: `feat/etienneb/session-event-context`

## Philosophy alignment

| Principle | Status |
|---|---|
| Single source of state truth | Satisfied -- one ctx, not scattered params |
| Explicit domain types | Satisfied -- provider typed, not implicit |
| Validate at boundaries | Satisfied -- provider from buildAgentClient() once |
| YAGNI | Mild tension (29 emit sites update) -- necessary for the improvement |
