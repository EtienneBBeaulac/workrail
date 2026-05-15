# Design Review: GateKind Discriminated Union

## Tradeoff Review

| Tradeoff | Acceptable? | Failure condition | Hidden assumption |
|----------|-------------|-------------------|-------------------|
| 'confirmation_required' legacy literal maps to coordinator_eval | Yes | No test fixtures encode it; replay path already handles arbitrary gateKind values | No production sessions need different routing after the change |
| RenderedStep.gateKind is optional | Yes | Accepted: only meaningful when requireConfirmation is true; advance core reads it only inside the gate path | Developer adds a third gate kind and forgets to set it on RenderedStep -- caught by assertNever at TriggerRouter level |
| gateKind not in crash recovery sidecar | Yes (non-blocking) | Startup recovery already discards gate-parked sessions -- sidecar gap is irrelevant for this PR | Future crash-recovery for gate-parked sessions will need sidecar extension (filed as follow-up) |

## Failure Mode Review

| Failure mode | Handled? | Risk |
|-------------|----------|------|
| gateKind missing from TerminalSignal.gate_parked | **Fixed in this PR** -- add to type, onGateParked callback, setTerminalSignal, buildSessionResult | Was blocking without fix |
| assertNever becomes stale on third gate kind | Handled by design -- compile error forces update | Zero risk |
| human_approval gate fires in MCP session | Non-issue -- gate path requires is_autonomous:'true', MCP sessions never set it | Zero risk |
| gateKind missing from crash recovery sidecar | Non-blocking -- startup recovery discards gate_parked sessions, doesn't resume them | Follow-up ticket |

## Runner-Up / Simpler Alternative Review

No viable runner-up. Context-variable approach ruled out by explicit user decision (coupling infra into workflow violates philosophy). No simpler design exists that keeps gateKind as typed first-class data -- any simplification would require TriggerRouter to string-parse the snapshot, violating the typed-contracts constraint.

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Make illegal states unrepresentable | Satisfied -- GateKind is a union literal, invalid values unrepresentable |
| Exhaustiveness everywhere | Satisfied -- assertNever in TriggerRouter |
| Zero LLM turns for routing | Satisfied -- TriggerRouter switch is pure TypeScript |
| Typed contracts at phase boundaries | Satisfied -- WorkflowRunGateParked carries typed gateKind |
| Functional core / imperative shell | Satisfied -- workflow declares intent; TriggerRouter routes |
| Validate at boundaries, trust inside | Satisfied -- validated at schema compile, trusted downstream |

## Findings

### No RED findings.

### ORANGE
**O1: out.gateKind exists in continue-workflow.ts:324 but is not passed to onGateParked() or stored in TerminalSignal.**
This is the central gap. Without fixing it, `WorkflowRunGateParked.gateKind` will always be missing and TriggerRouter cannot route. Must be fixed in this PR. Specific locations:
- `src/daemon/state/terminal-signal.ts:36` -- add `gateKind: GateKind` to `gate_parked` variant
- `src/daemon/tools/continue-workflow.ts:91` and `322` -- pass `out.gateKind` to `onGateParked()`
- `src/daemon/core/session-result.ts:141-150` -- read `signal.gateKind` into `WorkflowRunGateParked`

### YELLOW
**Y1: gateKind not in crash recovery gate sidecar** -- follow-up ticket, non-blocking.
**Y2: RenderedStep.gateKind is optional** -- acceptable tension, TypeScript limitation, not a correctness risk.
**Y3: spec/authoring-spec.json and validate:authoring-spec must be updated** -- mandatory but mechanical.

## Recommended Revisions

1. **Fix O1 before any other code** -- the gate kind chain is broken without it.
2. Add `GateKind = 'coordinator_eval' | 'human_approval'` as a named export from `src/v2/durable-core/constants.ts` (alongside EVENT_KIND).
3. Update `spec/authoring-spec.json` with a rule covering the new `requireConfirmation` object form.
4. Update `wr.mr-review` phase-6: `requireConfirmation: { "kind": "human_approval" }`.

## Residual Concerns

- The `complete_step` tool (makeCompleteStepTool) may also have an `onGateParked` callback path -- verify it handles gateKind the same way as `continue_workflow`.
- The authoring spec change requires `npm run validate:authoring-spec` and `npm run validate:feature-coverage` to pass before the PR can merge.
