# SessionCortex Phase 1+2: Hint and Scaffold Injection

## Problem

When WorkTrain runs `wr.mr-review` autonomously overnight, the session hits an engine validation error (the agent submits `complete_step` without the required artifact), receives a misleading "submit a valid `wr.assessment` artifact" error regardless of what the step actually requires, gets no recovery guidance, spirals into a `repeated_tool_call` stuck state, and terminates with no output. Today 0 of 13 `wr.mr-review` sessions succeed because there is no mechanism to detect the failure pattern across turns, inject corrective guidance, or prevent the spiral before termination.

## Appetite

Medium -- 3 to 7 days.

## Solution

The session receives targeted guidance when it fails, not just a confusing error message it cannot act on.

**Breadboard:**

**Places:**
- **Active Step** -- a step the agent is currently working on
- **Failed Step** -- a step where complete_step was rejected by the engine
- **Hint State** -- the step has failed once; a hint is queued
- **Scaffold State** -- the step has failed twice; a scaffolded example is queued
- **Recovered Step** -- the agent submitted the correct artifact; step advanced normally
- **Escalated Step** -- the step has failed 3+ times; cortex stops injecting, existing stuck detectors handle it
- **Session Event Log** -- durable record of all cortex interventions visible via `worktrain session events`

**Affordances:**
- Active Step: pre-turn reminder on the first turn if the step has an unsatisfied output contract
- Failed Step: failure recorded; hint or scaffold queued depending on failure count
- Hint State: agent receives targeted guidance (what artifact is required, what the error means)
- Scaffold State: agent receives a copy-pasteable example derived from the step's required contract
- Session Event Log: each intervention recorded with step ID, tier, and timestamp

**Connections:**
- Active Step → Hint State when complete_step is rejected by the engine for the first time on this step
- Hint State → agent receives hint message before the next LLM turn
- Hint State → Recovered Step when agent submits the correct artifact
- Hint State → Scaffold State when complete_step is rejected a second time
- Scaffold State → agent receives scaffolded example before the next LLM turn
- Scaffold State → Recovered Step when agent submits the correct artifact
- Scaffold State → Escalated Step when complete_step is rejected a third time
- Escalated Step → existing stuck detectors take over (no new cortex injection)
- Any state → Session Event Log when cortex fires an intervention
- Daemon restart → cortex reads Session Event Log and restores current state for in-flight steps

**Elements:**

| Name | Description | Classification |
|---|---|---|
| Pre-turn outputContract reminder | On the first LLM turn of a step with an unsatisfied output contract, the agent receives a brief reminder of what artifact is required | Interface |
| Immediate error message fix | The engine's circuit-breaker error is corrected to name the actual required artifact type for the failing step, not a hardcoded 'wr.assessment' | Interface |
| Tier-1 hint message | After the first engine rejection on a step, the agent receives a targeted explanation: which artifact is required, what the error means, and the correct tool call shape | Interface |
| Tier-2 scaffold message | After the second engine rejection on a step, the agent receives a complete copy-pasteable example of a valid tool call for this step, derived from the step's required contract | Interface |
| Failure count per step | Each step tracks how many times complete_step was rejected by the engine; count resets when the step advances | Invariant |
| Intervention recorded in event log | Every cortex intervention is recorded with step ID, tier level, and timestamp; visible in session diagnostics and survives daemon restarts | Invariant |
| Guidance derived from step's requirement | Hints and scaffolds are generated from the specific contract the current step declares; different steps produce different guidance | Invariant |
| Crash recovery restores cortex state | If the daemon restarts while a step is in Hint or Scaffold State, the cortex reads its event log and resumes at the correct tier | Invariant |
| No tool result modification | The cortex does not modify, intercept, or delay tool results; guidance arrives as a separate message before the next turn | Exclusion |
| Cortex stops at tier 2 | After two injections on a step, the cortex stops and lets existing stuck detectors handle further failures; rewind and escalation are not in this phase | Exclusion |

## Rabbit Holes

**Scaffold content generation (critical):** Once the builder starts generating schema examples from outputContract at runtime, they'll want to handle every edge case -- optional fields, oneOf, nested objects, loop body steps with dynamic context. This could become a full schema-to-example serializer.

*Mitigation:* Scaffold content is drawn from a fixed registry of known contractRefs (`wr.contracts.loop_control`, `wr.contracts.review_verdict`, `wr.contracts.assessment`, etc.) with hand-authored minimal examples. Dynamic schema introspection is out of scope. If a contractRef is unknown, the hint says "check the step prompt for the required artifact format."

**Pre-turn reminder flooding (medium):** The pre-turn reminder could fire on every single turn of a step, flooding the agent with repeated reminders and degrading its attention to the actual work.

*Mitigation:* Pre-turn reminder fires only on turn 1 of a step -- a one-shot injection when the agent first sees the step. Subsequent turns use hint/scaffold injection if failures occur.

**Cortex log unbounded growth (medium):** The cortex event log accumulates indefinitely and is never cleaned up, eventually creating unbounded files per session.

*Mitigation:* Cortex log shares the session sidecar lifecycle -- deleted when the sidecar is deleted. Maximum 50 entries per session log.

## No-Gos

- No modification to `_executeTools()` or the tool result pipeline -- guidance arrives as a pre-turn steer message only
- No dynamic JSON schema introspection for scaffold generation -- scaffold content drawn from a fixed registry of known contractRefs with hand-authored minimal examples
- No new stuck detector or replacement of the existing `repeated_tool_call` / `no_progress` / `stall` detectors -- the cortex is complementary, not a replacement
- No operator-facing UI changes or new CLI commands -- cortex interventions appear only in the existing session event log via `worktrain session events`
- No step rewind, session suspension, or operator escalation -- those are Phases 3+4 with unresolved design prerequisites
