# Design Review Findings: Adaptive Coordinator Context Passing

*Review of selected direction: Hybrid D + A (wr.discovery_handoff artifact for D->S + goal string/notes for other transitions)*

---

## Tradeoff Review

**Tradeoff 1: 1 workflow change to wr.discovery Phase 7**
- Acceptable. Phase 7 already has all required context variables (`selectedDirection`, `designDocPath`, `recommendationConfidenceBand`) set by prior steps. Agent can construct the artifact reliably.
- Safe with versioned workflows: fallback path (notes parsing) exists, so old versions degrade gracefully.

**Tradeoff 2: Two-tier fallback complexity for D->S**
- Acceptable. Exact same pattern as wr.review_verdict + parseFindingsFromNotes. Code structure is proven. No novel complexity.

**Tradeoff 3: Agent must emit artifact or fallback activates**
- Acceptable with monitoring. wr.review_verdict evidence shows agents reliably emit typed artifacts when explicitly instructed. Fallback logs a `[WARN]`, not silent.

---

## Failure Mode Review

**FM1: Agent doesn't emit artifact**
- Design handles it (fallback to notes). **Missing mitigation:** coordinator should check `lastStepNotes.trim().length > 50` before using notes as fallback. Without this check, an empty notes string causes shaping to start from scratch with no information.
- Severity: YELLOW

**FM2: Artifact emitted with wrong schema**
- Handled (Zod rejects, WARN logged, fallback activates). Same as wr.review_verdict. No action needed.
- Severity: GREEN

**FM3: pitch.md not found by Phase 0.5 (Shaping->Coding)**
- Phase 0.5 does active search but success is probabilistic. **Missing mitigation:** coordinator should pass `pitchPath: '.workrail/current-pitch.md'` explicitly in the Shaping->Coding spawn context. Cost: zero (trigger context injection already works). Without this, a missed Phase 0.5 search results in unnecessary design ideation.
- Severity: ORANGE

**FM4: Discovery session fails before Phase 7**
- Not a design gap. Coordinator checks session outcome (`_tag: 'success'`) before reading artifacts. Standard pattern.
- Severity: GREEN

**FM5: Stale context**
- Not a risk. Coordinator awaits discovery before reading results.
- Severity: GREEN

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate A only) strengths incorporated:**
- Coordinator always composes a rich goal string using `selectedDirection` from the artifact (if present) or from notes parsing (fallback). Goal string is the first orientation signal; it must be rich regardless of other context injection.

**Simpler variant (plain context key instead of Zod artifact) analysis:**
- Collapsed back to Candidate A with a named key. Same silent failure mode (notes format changes break the value without error). D is justified only when coordinator needs a validated `selectedDirection` string. Simpler variant is NOT simpler for decision-critical routing.

**Hybrid opportunity (implementation sequencing):**
- Define schema + coordinator parsing FIRST; update wr.discovery Phase 7 SECOND (after confirming structured routing is needed in practice). This prevents a premature workflow change.

---

## Philosophy Alignment

**Satisfied clearly:** Immutability, errors-as-data, dependency injection, compose-small-pure-functions, YAGNI

**Under acceptable tension:**
- "Make illegal states unrepresentable": fully satisfied for D-path (typed artifact); notes-based A-path is unconstrained. Acceptable because A-path transitions don't require coordinator routing decisions.
- "Validate at boundaries": D-path uses Zod. A-path notes fallback is a weak boundary. Acceptable: notes are informational only.

**Inherent limitation (not a design flaw):**
- Type safety at LLM inference boundary: trigger context keys are read by LLM inference, not TypeScript. No compile-time guarantee on how the session interprets `selectedDirection`. Monitor via prompt engineering quality.

---

## Findings

### RED (must fix before finalizing)
- None

### ORANGE (should fix -- meaningful risk if missed)
- **O1: Missing pitchPath injection for S->C transition.** Coordinator should pass `pitchPath: '.workrail/current-pitch.md'` in the Shaping->Coding spawn context to guarantee Phase 0.5 finds the pitch even if file search misses it. Zero additional code complexity; just an extra key in the spawn context.

### YELLOW (low risk, but worth noting)
- **Y1: Missing notes length check in fallback.** Coordinator should check `lastStepNotes.trim().length > 50` before using notes as assembledContextSummary fallback. Prevents shaping from starting completely blind if discovery notes are empty.
- **Y2: Implementation ordering.** Define schema and coordinator parsing code first, before updating the wr.discovery Phase 7 workflow. This avoids a premature workflow change and provides a validation checkpoint.
- **Y3: Trigger context injection undocumented.** The fact that ALL trigger.context keys are injected as JSON in the initial prompt (`Trigger context: { ... }`) is an important coordinator-authoring invariant that must be documented in the design doc. It is currently only visible by reading workflow-runner.ts lines 3191-3193.

---

## Recommended Revisions

1. **Add pitchPath injection** to the Shaping->Coding spawn context specification in the design doc
2. **Add notes length check** to the coordinator implementation requirements
3. **Document trigger context injection mechanism** explicitly in the design doc (it is how structured fields reach the downstream session)
4. **State implementation ordering** explicitly in the design doc: schema + parsing code first, workflow change second

---

## Residual Concerns

1. **LLM inference reliability** at the trigger context boundary: the downstream session must correctly interpret `selectedDirection` from the `Trigger context: { ... }` JSON block. Prompt engineering quality of the wr.shaping Step 1 prompt determines this. Not solvable at the coordinator design level; worth monitoring in early pipeline runs.

2. **Two-tier fallback debt** for D->S: the fallback (notes parsing for Discovery->Shaping) is a weak boundary that may accumulate technical debt as wr.discovery evolves. Consider adding an integration test that checks the coordinator falls back gracefully when wr.discovery Phase 7 does not emit the artifact.

3. **No contract for Coding->PR transition:** the design explicitly leaves this as "goal string with PR number." If the adaptive coordinator needs to know the PR number programmatically (to verify it was created correctly, to pass it to the review coordinator), this should be documented as a known gap rather than left implicit.
