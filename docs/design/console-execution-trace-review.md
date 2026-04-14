# Design Review Findings: WorkRail Console Execution-Trace Explainability

*Reviews Candidate B: User-Question-Organized gap list*
*Source discovery doc: `console-explainability-discovery.md`*
*Source candidates doc: `console-explainability-design-candidates.md`*

---

## Tradeoff Review

**Tradeoff 1: Engineering reads user-question organization to extract tier info**
- Acceptable under the stated scope (design initiative, not sprint planning).
- Unacceptable if: primary consumer is an engineering sprint meeting. Mitigation: tier notation is explicit per item.
- Hidden assumption: design and implementation planning are separate phases.

**Tradeoff 2: Cross-cutting complexity hidden inside user questions**
- 'Why blocked?' requires both Tier 2 (validation linkage) and Tier 3 (blocker detail simultaneously). The user question framing obscures this.
- Acceptable under 'what should be visible, not how to implement.'
- Unacceptable if: design initiative owner must produce implementation estimates at kickoff.

**Tradeoff 3: Design team may underestimate implementation cost**
- Acceptable: cost estimation is explicitly out of scope in the brief.
- Unacceptable if: the initiative requires a go/no-go based on cost at kickoff stage.

---

## Failure Mode Review

**Failure Mode 1 (highest risk): Execution trace panel covers 80% of confusion**
- The executionTraceSummary data (6 decision-trace entry kinds + taskComplexity context fact) is already computed and in the DTO. If this single UI change resolves the dominant user confusion, the full 23-item initiative scope is unnecessary.
- Handling: framing risk is named in the discovery doc. Tier notation allows teams to stop at Tier 1.
- Missing mitigation: no recommendation to validate with users before proceeding to full design phase.

**Failure Mode 2: No user research before design**
- 4 open questions are surfaced in the candidates doc. The priority order within Candidate B is assumption-driven.
- Handling: questions are explicit.
- Missing mitigation: no specific lightweight research method recommended.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate C):** Has a real strength -- explicitly names the 3-item minimum that addresses the named confusion patterns. Candidate B should borrow this.

**Hybrid adopted:** Add a 'Priority Zero' callout to the discovery doc that highlights the minimum viable items (execution trace panel + blocker detail) as the recommended fast-win starting point, before the full initiative scope.

**Simplification explored:** Limiting to Tier 1+2 only (cutting all Tier 3 items). Rejected: blocker detail (Tier 3) is the most user-critical item for the 'why blocked?' user question. Cutting it would leave blocked_attempt nodes unexplained.

---

## Philosophy Alignment

**Clearly satisfied:** make illegal states unrepresentable (DTO extension guidance), document 'why' not 'what' (entire doc structure), validate at boundaries (projection architecture respected), YAGNI with discipline (staged tier structure + Priority Zero callout).

**Under acceptable tension:** YAGNI vs. completeness. Resolved by the tier structure and Priority Zero callout that give teams permission to stop at any tier.

**No risky tensions.** Philosophy alignment is solid.

---

## Findings

### Orange: No user research validation before design
**Impact:** The priority order within the 23-item gap list is assumption-driven. If execution trace panel alone resolves dominant confusion, the design initiative scope is over-stated.
**What to watch:** If a 3-session user research pulse shows users can orient once the execution trace panel is rendered, immediately scope down to Candidate C.

### Yellow: Cross-cutting complexity obscured by user-question framing
**Impact:** The 'why blocked?' user question requires both Tier 2 and Tier 3 work. A design team reading only the user question might plan a single sprint for it when it actually needs two distinct work items.
**Mitigation:** Add a note to the 'why blocked?' section flagging the two-tier dependency.

### Yellow: 'Priority Zero' callout not yet in the discovery doc
**Impact:** Without an explicit fast-win callout, the design team sees a 23-item list with no obvious starting point.
**Mitigation:** Add the Priority Zero section (hybrid from runner-up analysis) before presenting the doc.

---

## Recommended Revisions

1. **Add Priority Zero callout** to `console-explainability-discovery.md` that identifies the 3-item minimum: execution trace panel (Tier 1) + blocker detail (Tier 3). Serves as the fast-win path.

2. **Add a user research recommendation** before proceeding to full design phase. Suggest a 30-minute session with 3-5 users watching a confusing run to validate that execution trace panel alone is insufficient.

3. **Add a two-tier dependency note** under the 'why blocked?' section to make cross-cutting complexity visible.

4. **Add research-pulse trigger:** "If users can explain phase-skip confusion after execution trace panel is rendered, switch to Candidate C scope and defer assessment/capability items."

---

## Residual Concerns

- No performance benchmarks exist for session detail API response time with 3 additional projection calls (assessments, capabilities, preferences). If the API is on a latency-sensitive path, Tier 2 projection wiring may need profiling before committing.
- The `CONTEXT_KEYS_TO_ELEVATE` constant in `run-execution-trace.ts` is hardcoded to `['taskComplexity']`. Extending this to surface additional context keys is Tier 1 work but requires knowing which keys are routing-critical across all workflows -- not a codebase-only question.
