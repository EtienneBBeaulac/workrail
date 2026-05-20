# Cortex Hint/Scaffold Content Design

**Status:** Discovery in progress (2026-05-20)

## Context / Ask

**Reframed problem:** When the SessionCortex injects recovery guidance after an engine validation failure, the content of that guidance is undefined -- it is unclear whether agents receive enough specific, accurate information to correct their mistakes, or just a generic message as confusing as the original error.

**Path:** `landscape_first` -- the critical question was empirical: what does the agent actually see, and what specific gaps exist in the current feedback chain?

## Landscape Packet

### What the agent sees at each failure point

**Failure 1+2 (blocked response from complete_step/continue_workflow):**
```
## Step blocked -- action required

Missing required output (contractRef=wr.contracts.loop_control).

What to do: Call continue_workflow without output to rehydrate the current step, then retry with output.notesMarkdown that satisfies the step output requirements.

Retry the same step: call complete_step again with corrected notes.
```

**Three critical problems with this message:**
1. `suggestedFix` says "fix `notesMarkdown`" for ALL non-assessment artifact contracts -- this is wrong. For `wr.loop_control`, the agent should fix `output.artifacts`, not `notesMarkdown`. This is copy-paste from the legacy prose validation path.
2. No scaffold/example in the message -- the suggestedFix budget is 1024 bytes (plenty), but it contains only procedural instructions with no JSON example.
3. The step prompt says "Output exactly: `{ artifacts: [...] }`" but never says this goes in `output.artifacts` inside the `complete_step` call. The tool parameter path is never mentioned.

**Failure 3 (blocked_attempt_limit_exceeded -- hardcoded wrong type):**
```
complete_step failed: precondition_failed -- Assessment gate failed after 3 attempts. Submit a valid wr.assessment artifact. Required format: { "artifacts": [{ "kind": "wr.assessment", ... }] }
```
- Wrong type (`wr.assessment` instead of `wr.loop_control`)
- No contractRef from the blocker
- No validation issues
- Does contain a scaffold but for the wrong type

### What the engine already knows

Every artifact contract schema file already has:
- A full Zod schema (enabling minimal valid instance generation)
- A `getBlockedMessage()` function with the canonical example
- `CONTRACT_BLOCKED_MESSAGES` lookup in `prompt-renderer.ts` routing contractRef to this function
- These examples are already injected into the step prompt's `OUTPUT REQUIREMENTS (System):` section on every render

**The agent has the canonical example in its step prompt before the first attempt.** The step prompt failure means something else is wrong -- not lack of information.

### The real failure modes (4 boundary conditions)

**Case A -- Wrong field value (e.g. `decision: "yes"`):** Engine returns `INVALID_REQUIRED_OUTPUT` with Zod validation issues surfaced in `validation.issues`. Agent sees the field-path error. Reasonably handled except suggestedFix says wrong parameter name.

**Case B -- Correct kind in notes JSON, not in `output.artifacts`:** Engine sees `artifacts` array as empty. Returns `MISSING_REQUIRED_OUTPUT` with suggestedFix saying to fix `notesMarkdown` -- exactly the wrong advice, actively reinforcing the wrong behavior.

**Case C -- No artifacts at all (the dc0d6457 pattern):** Same as Case B. `suggestedFix` says fix `notesMarkdown`. Agent receives no signal that it needed to pass `output: { artifacts: [...] }` as a tool parameter.

**Case D -- Wrong kind submitted (e.g. wr.assessment when wr.loop_control needed):** Engine silently drops the wrong-kind artifact (validator filters by kind). Reports `MISSING_REQUIRED_ARTIFACT` as if nothing was submitted. Agent receives no feedback that it submitted the wrong type -- it just looks like a missing artifact.

### Where the canonical scaffold already exists

`getLoopControlBlockedMessage()` in `loop-control.ts` already produces:
```
- Artifact contract: wr.contracts.loop_control
- Provide an artifact with kind: "wr.loop_control"
- Required field: decision ("continue" | "stop")
- Do NOT include loopId — the engine matches automatically
- Canonical format:
  { "artifacts": [{ "kind": "wr.loop_control", "decision": "stop" }] }
```

This is already in the step prompt. The agent has seen it. The gap is not the scaffold -- it is that the `suggestedFix` in the blocker actively misdirects.

### Notable contradictions

1. The step prompt tells the agent what JSON to produce; the blocker tells the agent to fix `notesMarkdown`. These are contradictory.
2. `blocked_attempt_limit_exceeded` provides a scaffold but for `wr.assessment` (always), not the actual required type.
3. The engine has everything it needs to fix both problems at the source -- `reasonToBlocker` has the `contractRef`, `reason-model.ts` has a dispatch path for assessment vs non-assessment, and each schema has `getBlockedMessage()`. Both fixes are one-liners in existing functions.

## Candidate Directions

Five candidates generated; synthesized to four distinct mechanisms. C1 (engine source fix) selected as primary after structural challenge revealed C3 (dynamic tool description) is architecturally incompatible with the MCP server's static tool list.

See `docs/plans/hint-candidates-A.md` and `docs/plans/hint-candidates-B.md` for full candidate details.

## Decision Log

**2026-05-20: Selected C1 (Engine source fixes) as primary recommendation**

*Why C1 won:* Three targeted fixes in three engine files. Corrects the root cause (wrong guidance content) at the authoritative source. Benefits all entry points (MCP + daemon). Does not add any new layer or abstraction.

*Why C3 was initially selected then revised:* C3 (dynamic tool description per step) addresses the quality-aspirational criterion most directly -- tool definitions are sent in every API call, structurally immune to context depth. The adversarial challenge correctly identified that the real failure mode is "contract ignorance" (the tool description only mentions wr.assessment, never other artifact kinds). C3 would fix this. However, the MCP server's `tools/list` handler returns a static array built at startup (server.ts:354,378) -- per-session dynamic tool descriptions are architecturally incompatible. C3 cannot satisfy criterion 5 (all entry points) without a significant MCP architectural change. C1 elevated to primary; C3 deferred as daemon-only follow-on.

*C3 as future direction:* If C1 ships and daemon sessions still fail (high turn count / context depth cases), C3 is the right next step. Both use the same `getBlockedMessage()` registry; C3 just places the scaffold in the tool definition instead of the blocked response.

## Final Summary

**Recommendation: C1 -- Engine source fixes**
**Confidence: High**
**Selection tier: strong_recommendation**

### What to build (3 targeted changes)

**Change 1: Extract blocked-messages registry to shared module**
Create `src/v2/durable-core/schemas/artifacts/blocked-messages.ts` with `ARTIFACT_BLOCKED_MESSAGES: Record<ArtifactContractRef, () => string>`. Populate with `getBlockedMessage()` output from each contract schema file. Add `wr.contracts.assessment` entry (currently missing from the registry).

**Change 2: Wire reason-model.ts to use the registry**
Replace the binary `ASSESSMENT_CONTRACT_REF` dispatch in `reasonToBlocker()` with a registry lookup. For any contractRef in the registry: set `suggestedFix` to the scaffold from `getBlockedMessage()` with a prefix "Pass this artifact in `output.artifacts` of your `complete_step` call:". For unknown contractRefs: fall back to a generic "Check the step's outputContract for the required artifact format and pass it in `output.artifacts`."

**Change 3: Fix advance.ts circuit-breaker message**
In `blocked_attempt_limit_exceeded` at line 137: load the contractRef from `primaryReason.pointer` (which has kind `output_contract` and carries `contractRef`). Replace hardcoded `"wr.assessment"` with the actual contractRef and its scaffold from the registry. Fallback to generic if no registry entry.

**Change 4: Wrong-kind detection in artifact-contract-validator.ts**
Before kind-filtering in `validateLoopControlContract` and other contract validators: capture any submitted artifacts that have a mismatched kind. If the artifact array is non-empty but no artifact matches the required kind, add the submitted kinds to the blocker message: "You submitted [kinds], but this step requires kind='wr.loop_control'."

### Residual risks

1. **[ORANGE] Circular import risk** -- `reason-model.ts` importing from `blocked-messages.ts` (new) is fine; the key is that `blocked-messages.ts` must not import from `reason-model.ts`. Extract the registry to the artifact schema layer where there are no circular dependencies.

2. **[YELLOW] Compact scaffold budget** -- `getBlockedMessage()` functions should show minimal valid examples (2-5 fields), not full schema documentation. Cap at ~300 chars.

3. **[INFO] assessment contract getBlockedMessage() missing** -- `reason-model.ts` has inline assessment guidance but it's not in the `CONTRACT_BLOCKED_MESSAGES` registry. Must be added when creating the shared module.

4. **[INFO] C3 follow-on** -- if daemon session failures continue after C1 ships (modal failure case shifts to 80+ turns), add C3 (dynamic daemon tool description) as a follow-on using the same registry.

### Updated residual risks (post-falsification check)

1. **[ORANGE] Verify pointer.contractRef is populated on all MISSING_REQUIRED_OUTPUT paths** before wiring Change 2. If any blocking path does not populate the pointer, the registry lookup silently falls back to generic -- the fix is a no-op for that path.
2. **[ORANGE] Empty artifacts case must be covered by Change 2.** The dc0d6457 failure had `artifacts=False` on all complete_step calls -- the most common failure is not wrong-kind but no-artifacts. When outputContract is declared and artifacts is empty, the suggestedFix must say "your output.artifacts was empty -- pass it as: [scaffold]."
3. **[ORANGE] assessment getBlockedMessage() missing** -- must be added to the registry before shipping or assessment contract failures get the worst-quality message.
4. **[YELLOW] Circular import** -- blocked-messages registry must be in the artifact schema layer, not importing from reason-model.ts.
5. **[YELLOW] Compact scaffold** -- max ~300 chars per example.
6. **[INFO] C3 follow-on** -- dynamic daemon tool description if failures persist after C1.

### Prerequisite before Phase 3/4 SessionCortex implementation

These engine fixes are independent of the SessionCortex and should ship first. The SessionCortex hint injection (Phase 1+2 of the harness) should be designed to complement, not duplicate, the engine's own blocked feedback. After C1, the blocked message content is correct -- the SessionCortex hint at tier 1 can amplify it by injecting the same scaffold as a pre-turn steer message (making it appear adjacent to the upcoming call, not just in the prior failed call's tool result).
