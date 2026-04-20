# Design Review: Stuck Escalation for Overnight-Autonomous WorkTrain Sessions

> Findings from adversarial review of the selected direction (Candidate B, adjusted).

## Tradeoff Review

| Tradeoff | Verdict | Condition That Invalidates It |
|---|---|---|
| 5-file maintenance surface for type safety | ACCEPTABLE | Union grows to 20+ consumers without a code-gen layer |
| `sessionStartMs` must be added | TRIVIALLY ACCEPTABLE | None |
| `no_progress` abort gated by `noProgressAbortEnabled` (default false) | ACCEPTABLE | Production evidence shows `no_progress` is the dominant failure mode |

## Failure Mode Review

| Failure Mode | Design Handling | Missing Mitigation | Risk |
|---|---|---|---|
| `ChildWorkflowRunResult` not updated | Called out in design doc as required update | Add explicit WARNING comment at cast site (line 2014) | HIGH -- silent compile-time pass, runtime crash |
| `await` in `turn_end` subscriber blocks abort | Fire-and-forget pattern specified explicitly | Add WHY comment at the outbox write call | MEDIUM -- junior devs may add await by analogy |
| `maybeRunDelivery` not updated | Existing gate `if (result._tag !== 'success') return` already handles it | None needed | LOW -- already handled |

## Runner-Up / Simpler Alternative Review

**Candidate C element borrowed:** `issueSummaries?: readonly string[]` added to `WorkflowRunStuck`. The `issueSummaries` array is already tracked in session closures (zero new collection code). Adds coordinator-readiness at near-zero cost.

**Simplest alternative:** Abort on `repeated_tool_call` only, no `no_progress` gate, no `issueSummaries`. Satisfies all 6 acceptance criteria. Excluded because `issueSummaries` and `noProgressAbortEnabled` add meaningful value at minimal cost.

**Hybrid result:** Candidate B adjusted = Candidate B + `issueSummaries` field (borrowed from C) + `noProgressAbortEnabled: boolean` gate (default false) for `no_progress` abort.

## Philosophy Alignment

| Principle | Alignment |
|---|---|
| Make illegal states unrepresentable | FULL -- new discriminant, not reused timeout |
| Exhaustiveness everywhere | FULL -- all assertNever guards updated |
| Errors are data | FULL -- result value, not exception |
| Immutability by default | FULL -- all new fields readonly |
| Fire-and-forget observability | FULL -- outbox write is void+detached+swallowed |
| YAGNI | TENSION -- 5-file surface; resolved in favor of structural correctness |
| Determinism over cleverness | TENSION -- no_progress is a heuristic; resolved by gating it behind explicit opt-in |

## Findings

### RED (Blocking)
None. No design-correctness violations found.

### ORANGE (High Risk)
**Finding O1: `ChildWorkflowRunResult` update is easy to miss.**\nThe coding agent must update `ChildWorkflowRunResult` alongside `WorkflowRunResult`. If missed, a `_tag: 'stuck'` result from a child session spawned via `makeSpawnAgentTool` will reach `assertNever` at runtime and crash. The design doc mentions it but the failure mode is severe enough to warrant a WARNING comment in the code at the cast site (line 2014 in workflow-runner.ts).\n\n**Recommended action:** Add to design doc: 'CRITICAL: Update ChildWorkflowRunResult on the SAME commit as WorkflowRunResult. Do not split across commits.'

### YELLOW (Medium Risk)
**Finding Y1: `no_progress` false-positive rate is unvalidated.**\nThe 80%-turns threshold with 0 step advances can fire on legitimate deep-research sessions. The `noProgressAbortEnabled: false` default mitigates this but means the feature is effectively inactive until explicitly enabled. Users who expect `no_progress` to work out-of-the-box will be surprised.\n\n**Recommended action:** Document the default explicitly in the trigger YAML schema comment and in the CLI help text.

**Finding Y2: Fire-and-forget outbox write timing.**\nThe outbox write initiates in `turn_end` as a detached Promise but the `WorkflowRunStuck` result reaches TriggerRouter before the write completes. If the process exits immediately after TriggerRouter logs the result (e.g. during a rapid daemon shutdown), the outbox write may be lost.\n\n**Recommended action:** Accept this risk -- it is the same risk accepted by `DaemonEventEmitter`. Document it in the code with a WHY comment.

## Recommended Revisions to Design Doc

1. Add a **CRITICAL** callout in the '5-File Change Estimate' section: 'ChildWorkflowRunResult must be updated in the same commit as WorkflowRunResult. A cast at line 2014 allows a stuck result to bypass the makeSpawnAgentTool switch's assertNever if ChildWorkflowRunResult is not updated.'

2. Add `issueSummaries?: readonly string[]` to the `WorkflowRunStuck` interface definition. Update the outbox entry schema to include `issueSummaries`.

3. Add `noProgressAbortEnabled?: boolean` (default: false) to `WorkflowTrigger.agentConfig` as a separate field from `stuckAbortPolicy`. The abort policy controls whether to abort or notify; this flag controls whether `no_progress` is an active trigger at all.

4. Update the '5-File Change Estimate' table to show 5 files clearly (the confusion is that workflow-runner.ts has multiple edit locations).

## Residual Concerns

1. **`repeated_tool_call` false-positive rate**: Not empirically validated. The `stuckAbortPolicy: 'notify_only'` escape hatch is the mitigation. If the false-positive rate is high in production, the recommended path is: set `stuckAbortPolicy: 'notify_only'` by default and make `'abort'` opt-in, reversing the current default.

2. **Coordinator consumption of outbox.jsonl**: `outbox.jsonl` has no automated consumer today. The stuck entry will persist in the file until a human or coordinator reads it. This is a 'build it now, connect it later' tradeoff -- acceptable for the initial design.

3. **No shadow-mode validation**: Ideally, the heuristics would run in shadow mode (emit but never abort) for 20+ production sessions before enabling abort. This design does not include shadow mode. The `stuckAbortPolicy: 'notify_only'` setting can serve as a manual shadow mode.
