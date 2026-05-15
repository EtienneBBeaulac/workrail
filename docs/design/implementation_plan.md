# Implementation Plan: GateKind Discriminated Union

## 1. Problem statement

The `requireConfirmation` gate system has a single hardcoded kind (`confirmation_required`) that always routes to `wr.gate-eval-generic` (autonomous LLM evaluator). When a workflow step's gate should be evaluated by a human (reviewer-assigned MR review), the autonomous evaluator fires unnecessarily, receives empty inputs, returns `uncertain`, and stalls the session. The workflow has no way to declare that it needs a human evaluator rather than a coordinator evaluator.

## 2. Acceptance criteria

- [ ] `requireConfirmation` in workflow JSON accepts `{ "kind": "coordinator_eval" }` and `{ "kind": "human_approval" }` object forms alongside the existing boolean/condition forms
- [ ] `gateKind` flows as a typed field through: RenderedStep → AdvanceContext → execution snapshot → WorkflowRunGateParked
- [ ] TriggerRouter routes `gate_parked` results by `gateKind` with `assertNever` exhaustiveness: `coordinator_eval` → existing `wr.gate-eval-generic` path; `human_approval` → `maybeRunPostWorkflowActions()` directly
- [ ] `wr.mr-review` phase-6 `requireConfirmation` changed from `true` to `{ "kind": "human_approval" }`
- [ ] Existing sessions with `gateKind: 'confirmation_required'` in their snapshots route to `coordinator_eval` (backward compat)
- [ ] `npx vitest run` passes
- [ ] `npm run build` clean
- [ ] `npm run validate:authoring-spec` passes
- [ ] `npm run validate:feature-coverage` passes

## 3. Non-goals

- No new gate evaluator workflow
- No changes to MCP session behavior (gate never fires for MCP sessions -- `is_autonomous` guard unchanged)
- No changes to `wr.gate-eval-generic` workflow
- No crash recovery for gate-parked sessions (separate follow-up)
- No gate kind beyond `coordinator_eval` and `human_approval` in this PR

## 4. Philosophy-driven constraints

- **[PHILOSOPHY]** `GateKind` is a discriminated union (`'coordinator_eval' | 'human_approval'`) -- no string widening, no optional routing, no instanceof checks. New kinds must extend the union and update TriggerRouter.
- **[PHILOSOPHY]** TriggerRouter uses `assertNever(result.gateKind)` -- any future gate kind that isn't handled is a compile error, not a runtime fallthrough.
- **[PHILOSOPHY]** `gateKind` travels as typed data on `WorkflowRunGateParked` -- TriggerRouter never reads the session snapshot to determine routing.
- **[CONVENTION]** `execution-snapshot.v1.ts` widens `gateKind: z.literal('confirmation_required')` to `z.enum(['coordinator_eval', 'human_approval', 'confirmation_required'])` -- `confirmation_required` is a legacy alias for `coordinator_eval`.
- **[TEAM_RULE]** `spec/authoring-spec.json` must document the new `requireConfirmation` object form; `validate:authoring-spec` and `validate:feature-coverage` must pass.

## 5. Invariants

1. `gateKind: 'coordinator_eval'` is the default when `requireConfirmation: true` (boolean form) -- no behavior change for existing workflows
2. `gateKind` on `WorkflowRunGateParked` is non-optional -- every gate_parked result carries a kind
3. Gate only fires in daemon sessions (`is_autonomous: 'true'` context key guard at v2-advance-core/index.ts:313 is unchanged)
4. Gate only fires on `mode.kind === 'fresh'` (retry guard unchanged)
5. `assertNever` in TriggerRouter is the exhaustiveness contract -- every gate kind must have an explicit routing branch

## 6. Selected approach

Thread `GateKind = 'coordinator_eval' | 'human_approval'` through 9 locations as typed data. `TerminalSignal.gate_parked` gains `gateKind`, closing the gap where `out.gateKind` was discarded in `continue-workflow.ts`.

**Rationale:** workflow declares intent via step definition; routing is deterministic TypeScript; no coupling of infrastructure concerns into workflow content.

**Runner-up:** None. Context-variable approach rejected by user (couples infra into workflow).

## 7. Vertical slices

### Slice 1: Type layer (no behavior change)
**Files:**
- `src/v2/durable-core/constants.ts` -- add `export type GateKind = 'coordinator_eval' | 'human_approval'`; keep `'confirmation_required'` as legacy value in snapshot schema only
- `src/v2/durable-core/schemas/execution-snapshot/execution-snapshot.v1.ts` -- widen `gateKind: z.literal('confirmation_required')` to `z.enum(['coordinator_eval', 'human_approval', 'confirmation_required'])`
- `src/v2/durable-core/domain/gate-checkpoint-builder.ts` -- accept `gateKind: GateKind` parameter (default `'coordinator_eval'`); store it in snapshot
- `src/v2/durable-core/domain/prompt-renderer.ts` -- add `gateKind?: GateKind` to `RenderedStep`; extract `gateKind` from the object form BEFORE calling `evaluateCondition()`; normalize object form to `true` for the boolean `requireConfirmation` evaluation (so `evaluateCondition()` is never called with the object form); default `'coordinator_eval'` for boolean true. Specifically: `if (rc is object with .kind) { gateKind = rc.kind; rc = true; }` before line 550.
- `src/daemon/state/terminal-signal.ts` -- add `gateKind: GateKind` to `gate_parked` variant
- `src/daemon/types.ts` -- add `gateKind: GateKind` to `WorkflowRunGateParked`

**Done when:** `npm run build` clean with no type errors across all changed files.

### Slice 2: Wire gateKind through the call chain
**Files:**
- `src/mcp/handlers/v2-advance-core/index.ts` -- pass `gateKind` from `v.gateKind` (RenderedStep) to `buildGateCheckpointOutcome()`
- `src/mcp/handlers/v2-advance-core/outcome-gate-checkpoint.ts` -- accept and pass `gateKind` to `buildGateCheckpointSnapshot()`
- `src/daemon/tools/continue-workflow.ts` -- update both `onGateParked()` calls (lines ~91, ~322) to include `out.gateKind`; update callback signature to `(gateToken: string, stepId: string, gateKind: GateKind) => void`
- `src/daemon/core/session-result.ts` -- read `signal.gateKind` when constructing `WorkflowRunGateParked`
- `src/daemon/runner/construct-tools.ts` and `src/daemon/runner/agent-loop-runner.ts` -- update `onGateParked` callback to match new signature

**Done when:** `npx vitest run` passes. The `gateKind` field is populated on all `WorkflowRunGateParked` results.

### Slice 3: TriggerRouter routing + workflow update
**Files:**
- `src/trigger/trigger-router.ts` -- update `gate_parked` branch in both `route()` and `dispatch()`: switch on `result.gateKind`, `coordinator_eval` → existing evaluator path, `human_approval` → `maybeRunPostWorkflowActions()` directly, `assertNever` on the union
- `workflows/mr-review-workflow.agentic.v2.json` -- change phase-6 `requireConfirmation: true` to `{ "kind": "human_approval" }`
- `spec/authoring-spec.json` -- add rule documenting `requireConfirmation` object form and valid `kind` values
- `spec/workflow.schema.json` -- extend `confirmationRule` to accept `{ "kind": "coordinator_eval" | "human_approval" }` object form

**Done when:** `npx vitest run` passes; `npm run validate:authoring-spec` passes; `npm run validate:feature-coverage` passes.

## 8. Test design

**Existing tests to verify pass unchanged:** lifecycle tests for `wr.mr-review`, gate-related unit tests in `tests/unit/`.

**New test coverage needed:**
- Unit test: `WorkflowRunGateParked.gateKind === 'human_approval'` when workflow step has `{ kind: 'human_approval' }`
- Unit test: `WorkflowRunGateParked.gateKind === 'coordinator_eval'` when workflow step has `requireConfirmation: true` (backward compat)
- Unit test: TriggerRouter routes `human_approval` to `maybeRunPostWorkflowActions()`, not `evaluateGate()`
- Unit test: TriggerRouter routes `coordinator_eval` to `evaluateGate()` (existing path unchanged)

## 9. Risk register

| Risk | Mitigation |
|------|-----------|
| `npm run validate:feature-coverage` fails -- new gate kind requires feature-registry entry | Add `wr.features.human_approval_gate` to feature-registry if validate:feature-coverage requires it |
| Golden token test fixtures encode snapshot with `gateKind:'confirmation_required'` | Confirmed no fixtures encode this value (grep verified). No risk. |
| `complete_step` tool has same `onGateParked` gap as `continue_workflow` | Slice 2 explicitly covers both tools via construct-tools.ts callback signature update |

## 10. PR packaging

Single PR. All three slices are coupled -- Slice 3 requires Slice 2 which requires Slice 1.

## 11. Follow-up tickets

1. Add `gateKind` to gate crash recovery sidecar (for future gate-parked session resume)

## 12. Philosophy alignment per slice

### Slice 1
- Make illegal states unrepresentable → satisfied -- GateKind union literal
- Typed contracts at phase boundaries → satisfied -- RenderedStep and WorkflowRunGateParked carry typed gateKind

### Slice 2
- Validate at boundaries, trust inside → satisfied -- gateKind validated at schema compile, trusted downstream
- Functional core / imperative shell → satisfied -- workflow declares intent; daemon carries it through

### Slice 3
- Zero LLM turns for routing → satisfied -- TriggerRouter switch is pure TypeScript
- Exhaustiveness everywhere → satisfied -- assertNever on GateKind union

## Plan confidence: High

No unresolved unknowns. All call sites identified by grep. No test fixtures at risk. The 9-location chain is fully mapped.
