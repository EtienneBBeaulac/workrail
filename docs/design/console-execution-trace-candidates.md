# Design Candidates: WorkRail Console Execution-Trace Explainability

*Source: discovery scoping pass on the engine's event log vs. console DTO gaps*
*Full landscape packet: `console-explainability-discovery.md`*

---

## Problem Understanding

### Core Tensions

1. **Completeness vs. UI coherence.** The engine records 23 categories of invisible data across 16 event kinds. Surfacing all of them is completeness. But showing 23 new data items without progressive disclosure creates an overwhelming console. The tension: show everything the engine knows vs. show what helps the specific user understand the specific confusion.

2. **DTO stability vs. extensibility.** The console DTOs (`ConsoleDagRun`, `ConsoleNodeDetail`) are in use. Adding assessment, capability, and blocker fields requires extension without breaking consumers. The codebase philosophy says 'make illegal states unrepresentable' -- this favors discriminated union shapes over bare nullable fields.

3. **Projection cost vs. information value.** Some projections are already computed (`executionTraceSummary` is in the DTO). Others require new `console-service.ts` calls per session detail request (assessments, capabilities, preferences). Wiring all projections simultaneously increases response latency.

### Likely Seam

The real seam is the `console-service.ts` -> `console-types.ts` boundary -- where projection data is selected and shaped into DTOs. The symptom appears at the UI; the root is the service-to-DTO translation. The DAG topology projection (`projectRunDagV2`) is the structural source of truth; edge cause codes should flow through it, not around it.

### What Makes This Hard

Three different kinds of work are required:
- **Tier 1 (rendering only):** `ConsoleDagRun.executionTraceSummary` is already computed and in the wire format -- the UI panel is simply not implemented.
- **Tier 2 (service wiring):** `projectAssessmentsV2`, `projectAssessmentConsequencesV2`, `projectCapabilitiesV2` are complete projections, but `console-service.ts` never calls them.
- **Tier 3 (DTO + projection change):** Blocker detail, gap reason detail, edge cause codes, full context object, preferences changes -- require new DTO fields and projection output changes.

A junior developer would treat all 23 gaps as equivalent work items and try to fix them simultaneously, not recognizing the tier structure.

---

## Philosophy Constraints

From `CLAUDE.md` and confirmed by codebase observation:

- **Make illegal states unrepresentable** -- new DTO fields should use discriminated union shapes (e.g. `{ present: true; data: ... } | { present: false }`) rather than bare `null` to distinguish 'not recorded' from 'recorded as empty'.
- **Architectural fixes over patches** -- extending `ConsoleDagEdge` with cause codes properly is better than a separate edge-explanation projection.
- **YAGNI with discipline** -- design clear seams; add progressively. Favors Tier 1 first with clean extension points for Tier 2 and Tier 3.
- **Errors are data** -- all projection calls must return `Result<T, ProjectionError>` with graceful degradation, not exceptions.
- **Immutability by default** -- all new DTO fields must use `readonly`.

---

## Impact Surface

Beyond the immediate task, changes touch:
- `console-types.ts` -- DTO shape changes affect any consumer reading the session detail API
- `console-service.ts` -- new projection calls affect session detail response latency
- `run-execution-trace.ts` -- extending `CONTEXT_KEYS_TO_ELEVATE` affects which context keys appear in the execution trace
- `run-dag.ts` -> `ConsoleDagEdge` -- adding cause codes requires changes to the DAG projection DTO boundary
- Frontend session detail panel -- every new DTO field needs a rendering path

---

## Candidates

### Candidate A: Tier-Organized Scoping (simplest useful output)

**Summary:** Organize the gap list by implementation effort tier so engineering can estimate scope immediately.

**Tiers:**
- Tier 1 (rendering only, 0 backend changes): implement the `executionTraceSummary` panel in the UI -- data is already in `ConsoleDagRun.executionTraceSummary`. Covers: selected_next_step, evaluated_condition, entered_loop, exited_loop, detected_non_tip_advance, divergence items, taskComplexity context fact.
- Tier 2 (service wiring + DTO extension): call `projectAssessmentsV2`, `projectAssessmentConsequencesV2`, `projectCapabilitiesV2` from `console-service.ts`. Add `assessmentSummary`, `capabilityStatus` to `ConsoleNodeDetail`.
- Tier 3 (DTO shape change): add `cause` to `ConsoleDagEdge`, add `blockers` to `ConsoleAdvanceOutcome`, add `reason` + `evidenceRefs` to `ConsoleNodeGap`, extend `ConsoleExecutionTraceFact` with more context keys, add `ConsolePreferencesChange` to `ConsoleDagRun`.

**Tensions resolved:** DTO stability (sequential tiers), projection cost (Tier 1 costs nothing).
**Tensions accepted:** User story coherence (tiers don't map to user jobs-to-be-done).

**Boundary solved at:** console-service.ts / console-types.ts. Correct seam.

**Failure mode:** Teams prioritize Tier 1 (cheapest) but the dominant user confusion (blocked_attempt nodes, assessment gate results) lives in Tier 2-3.

**Repo pattern:** Follows the `executionTraceSummary` staging precedent exactly.

**Gains:** Immediately actionable for engineering sprint planning.
**Losses:** Design team gets a backlog, not a user-facing vision for progressive disclosure.

**Scope judgment:** Too narrow for a design initiative kickoff; best-fit for an engineering readiness doc.

**Philosophy fit:** Honors YAGNI, architectural layering. No conflicts.

---

### Candidate B: User-Question-Organized (recommended)

**Summary:** Organize the 23 gaps by the user question they answer, with tier noted per item, so the design team can build the right progressive-disclosure model.

**Structure:**

*"Why did the run skip phases / take this path?"*
- decision trace entries (selected_next_step, evaluated_condition) -- Tier 1, already in executionTraceSummary
- taskComplexity context fact -- Tier 1, already in executionTraceSummary.contextFacts
- full run context object (other routing keys) -- Tier 3, requires DTO extension
- edge cause codes (idempotent_replay, intentional_fork, non_tip_advance) -- Tier 3, requires ConsoleDagEdge.cause field

*"Why is this node blocked?"*
- blocker codes (10-value enum: USER_ONLY_DEPENDENCY, MISSING_REQUIRED_OUTPUT, etc.) -- Tier 3, requires ConsoleAdvanceOutcome.blockers
- blocker pointer (context_key, capability, output_contract, workflow_step) -- Tier 3
- blocker message + suggestedFix -- Tier 3
- validation failure linkage (which validation caused the block) -- Tier 2

*"What did the quality gate decide?"*
- assessment dimensions (dimensionId, level, rationale) -- Tier 2, requires projectAssessmentsV2 wiring
- assessment summary -- Tier 2
- assessment normalization notes -- Tier 2
- assessment consequence (triggered follow-up, guidance) -- Tier 2, requires projectAssessmentConsequencesV2 wiring

*"What happened in this loop?"*
- entered_loop / exited_loop trace entries -- Tier 1, already in executionTraceSummary
- loop iteration count -- Tier 3, requires engine state loop stack data

*"Why did run behavior change mid-execution?"*
- preferences_changed events (autonomy mode, riskPolicy, who changed it) -- Tier 3, not in any projection DTO

*"Why did the run use a degraded path?"*
- capability probe results (delegation/web_browsing available/unavailable/unknown) -- Tier 2, requires projectCapabilitiesV2 wiring
- capability failure codes (tool_missing, tool_error, policy_blocked) -- Tier 2

*"What does the gap mean?"*
- gap reason category (user_only_dependency, contract_violation, capability_missing, unexpected) -- Tier 3, requires ConsoleNodeGap.reason field
- gap evidence refs -- Tier 3

**Tensions resolved:** UI coherence (maps to user mental models), covers all three stakeholder groups.
**Tensions accepted:** Engineering must read more carefully to extract tier information per item.

**Boundary solved at:** Same seam -- the user-question grouping doesn't change where the fix lives.

**Failure mode:** Design team sees a clean user story per question but underestimates cross-cutting implementation work (e.g., "why blocked?" requires Tier 2 validation linkage AND Tier 3 blocker detail simultaneously).

**Repo pattern:** Adapts the staging precedent -- same tier model, user-question organization.

**Gains:** Design team gets a vision and can design progressive disclosure correctly. Engineering can still extract tier information.
**Losses:** Slightly more reading overhead for pure engineering scope estimation.

**Scope judgment:** Best-fit for a design initiative kickoff.

**Philosophy fit:** Honors all principles. The tier notation per item ensures YAGNI and architectural layering are preserved.

---

### Candidate C: Minimum Viable Explainability

**Summary:** Surface only the items that explain the three specific user confusion patterns named in the problem statement, deferring all others.

The three confusion patterns and their minimum data requirements:
1. **Fast-path phase skips:** execution trace entries (`selected_next_step`, `evaluated_condition`) + taskComplexity context fact. Status: Tier 1 rendering only -- data is already in DTO.
2. **blocked_attempt nodes:** blocker codes + messages from `advance_recorded` outcome. Status: Tier 3 -- requires `ConsoleAdvanceOutcome.blockers` field addition.
3. **Loop structural jumps:** `entered_loop`, `exited_loop` trace entries with loop_id refs. Status: Tier 1 rendering only -- data is already in DTO.

Result: only one Tier 3 change needed (blocker detail on ConsoleAdvanceOutcome) plus one Tier 1 UI implementation (execution trace panel).

**Tensions resolved:** YAGNI, fastest path to user-visible improvement for the named pain points.
**Tensions accepted:** Assessment results, capability degradation, preferences, gap reason detail, edge cause codes all deferred.

**Boundary solved at:** Same seam; minimal scope.

**Failure mode:** Assessment and capability gaps are high-value for workflow authors (a primary stakeholder). Deferring them leaves a key user group underserved.

**Repo pattern:** Most conservative; only extends what is explicitly necessary.

**Gains:** Fastest path to user-visible improvement; lowest implementation risk.
**Losses:** Does not address workflow author or platform maintainer needs; defers 20 of 23 gaps.

**Scope judgment:** Best-fit for a quick-win sprint; too narrow for a full design initiative.

**Philosophy fit:** Honors YAGNI most strongly. No conflicts.

---

## Comparison and Recommendation

| | Candidate A | Candidate B | Candidate C |
|---|---|---|---|
| Completeness vs. UI coherence | Accepts UI gap | Resolves both | Accepts completeness |
| DTO stability | Explicit tier ordering | Noted per item | Minimal scope |
| YAGNI | Middle | Middle | Best |
| User story mapping | Weakest | Best | Partial |
| Scope fit (design kickoff) | Too narrow | Best-fit | Too narrow |
| Stakeholder coverage | Engineering only | All three | Operators only |
| Reversibility | High | High | High |
| Philosophy fit | Full | Full | Full |

**Recommendation: Candidate B.**

Candidate B is the best fit for the stated goal (design initiative scoping) because:
1. Design teams need user-question framing to build progressive-disclosure models, not backlog lists.
2. Tier information is preserved per item -- engineering can extract a sprint plan from the same doc.
3. All three stakeholder groups are covered.
4. The current `console-explainability-discovery.md` doc already implements this organization.

---

## Self-Critique

**Strongest counter-argument:** Candidate C is faster and directly solves the three named pain points from the problem statement. If the brief's "three confusion patterns" are the complete acceptance criteria (not just illustrative examples), Candidate C is sufficient and Candidate B is over-scoped.

**Narrower option:** Candidate C lost because it leaves assessment and capability gaps entirely unaddressed. Workflow authors -- a named primary stakeholder -- need assessment visibility to verify their gate logic.

**Broader option:** Adding implementation patterns (DTO shape specifications, code changes) would be Candidate D. Rejected: out of scope for discovery scoping. The ask is 'what should be visible', not 'how to implement it'.

**Invalidating assumption:** If user research shows that 90% of user confusion is resolved by the execution trace panel alone (Tier 1 rendering), the design initiative scope collapses to a single UI change and Candidates A and C converge.

---

## Open Questions for the Main Agent

1. Are the "three confusion patterns" from the problem statement the full acceptance criteria, or illustrative examples? (Determines A/B/C choice)
2. Is there user research on whether users are primarily debugging blocked/confused runs vs. auditing successful ones? (Determines priority order within Candidate B)
3. Should the design initiative include a progressive-disclosure model proposal, or only the gap list? (Determines whether this doc is the complete deliverable)
4. Are there performance constraints on the session detail API that would limit Tier 2 projection wiring? (Affects feasibility of wiring all three projections simultaneously)
