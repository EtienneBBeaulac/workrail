# Spec: GateKind Discriminated Union

## Feature summary

Workflow steps can declare what kind of gate they need via `requireConfirmation: { "kind": "coordinator_eval" | "human_approval" }`. The daemon routes gate_parked sessions to the appropriate evaluator based on this declaration -- autonomous LLM evaluator for `coordinator_eval`, human draft review approval for `human_approval`. `wr.mr-review` uses `human_approval` so reviewer-assigned review sessions route directly to the operator's GitHub draft review instead of spawning `wr.gate-eval-generic`.

## Acceptance criteria

**AC1.** A workflow step with `requireConfirmation: { "kind": "human_approval" }` in a daemon session produces `WorkflowRunGateParked` with `gateKind: 'human_approval'`.

**AC2.** A workflow step with `requireConfirmation: true` (boolean) in a daemon session produces `WorkflowRunGateParked` with `gateKind: 'coordinator_eval'` (backward compat default).

**AC3.** TriggerRouter routes `gateKind: 'coordinator_eval'` to `evaluateGate()` / `wr.gate-eval-generic` (existing behavior unchanged).

**AC4.** TriggerRouter routes `gateKind: 'human_approval'` to `maybeRunPostWorkflowActions()` directly, skipping `wr.gate-eval-generic` entirely.

**AC5.** `wr.mr-review` phase-6 has `requireConfirmation: { "kind": "human_approval" }`. A reviewer-assigned review session no longer spawns `wr.gate-eval-generic` or stalls waiting for an autonomous evaluation.

**AC6.** `npm run build` clean, `npx vitest run` passes, `npm run validate:authoring-spec` passes.

## Non-goals

- No changes to `wr.gate-eval-generic` behavior
- No new gate evaluator workflow
- No MCP session behavior changes (gate never fires for MCP sessions)
- No crash recovery for gate-parked sessions

## External interface contract

**Workflow JSON** -- `requireConfirmation` now accepts an object form:
```json
{ "kind": "coordinator_eval" }   // routes to wr.gate-eval-generic (same as true)
{ "kind": "human_approval" }     // routes to human draft review mechanism
```
Boolean `true` remains valid and maps to `coordinator_eval`. Boolean `false` / absent remains valid (no gate).

**`WorkflowRunGateParked`** gains a required `gateKind: 'coordinator_eval' | 'human_approval'` field.

## Edge cases and failure modes

| Case | Expected behavior |
|------|------------------|
| `requireConfirmation: true` (existing workflows) | `gateKind: 'coordinator_eval'` -- no behavior change |
| `human_approval` in MCP session | Gate never fires (is_autonomous guard) -- step advances to success normally |
| `human_approval` + no `reviewerIdentity` | `maybeRunPostWorkflowActions()` exits early (no reviewerIdentity = no draft review action) -- no error, session completes |
| Existing snapshot with `gateKind: 'confirmation_required'` | Schema accepts it as legacy value; routes to `coordinator_eval` |

## Verification per AC

| AC | Verification |
|----|-------------|
| AC1 | Unit test: daemon session with `human_approval` step → `WorkflowRunGateParked.gateKind === 'human_approval'` |
| AC2 | Unit test: daemon session with `requireConfirmation: true` → `WorkflowRunGateParked.gateKind === 'coordinator_eval'` |
| AC3 | Unit test: TriggerRouter with `gateKind: 'coordinator_eval'` → calls `evaluateGate()`, not `maybeRunPostWorkflowActions()` |
| AC4 | Unit test: TriggerRouter with `gateKind: 'human_approval'` → calls `maybeRunPostWorkflowActions()`, not `evaluateGate()` |
| AC5 | Lifecycle test: `wr.mr-review` session with reviewer trigger → no `wr.gate-eval-generic` session spawned |
| AC6 | `npm run build` + `npx vitest run` + `npm run validate:authoring-spec` all pass |
