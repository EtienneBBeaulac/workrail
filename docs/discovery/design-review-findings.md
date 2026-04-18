# Design Review Findings: wr.discovery Goal Reframing

*Concise, actionable findings for main-agent synthesis. Not a final decision.*
**Date:** 2026-04-18

---

## Tradeoff Review

**Tradeoff 1: goalType classification remains agent judgment**

- Acceptable: this pattern is established in the workflow (rigorMode, pathRecommendation are all agent-derived)
- Classification examples in the procedure reduce misclassification probability
- **Finding: YELLOW.** Add goalType classification examples to procedure text to reduce ambiguity at the problem_framed / opportunity_framed boundary.

**Tradeoff 2: overhead for well-framed goals is nonzero**

- A few additional context variable captures and procedure lines in Phase 0
- Well-framed goals produce minimal output ('goalType = problem_framed, no impliedProblem needed')
- **Finding: NON-ISSUE.** Overhead is trivial.

**Tradeoff 3: Phase 1g always-on for design_first/full_spectrum**

- One additional advance per session for these paths
- Produces trivially short output for well-framed sessions ('pathChangedAfterContext = false')
- **CRITICAL CORRECTION NEEDED:** Phase 1g runCondition must be an OR (`retriageNeeded = true OR pathRecommendation in [design_first, full_spectrum]`) not a replacement. Otherwise landscape_first sessions that explicitly need retriage will not trigger it.
- **Finding: YELLOW.** Runnable as-designed if the OR condition is used correctly.

---

## Failure Mode Review

**Failure mode 1: Agent misclassifies solution-framed goal as opportunity_framed**
- Status: **Partially mitigated.** C3's Phase 1e/1f required 'what would make this framing wrong' output provides a downstream catch. Classification examples in Phase 0 reduce probability.
- Missing mitigation: examples in procedure (address in revisions)
- **Finding: MEDIUM risk, mitigated.**

**Failure mode 2: 'What would make this framing wrong' output is formulaic**
- Status: **Partially mitigated.** Making it required non-empty enforces form but not quality.
- Missing mitigation: specificity instruction ('name ONE concrete condition, not a general caveat')
- **Finding: LOW-MEDIUM risk.**

**Failure mode 3: Phase 1g doesn't surface new insights for well-framed sessions**
- Status: **Non-issue by design.** For well-framed sessions, Phase 1g is a graceful no-op that confirms the path is still correct. One advance wasted, nothing more.
- **Finding: LOW risk, acceptable.**

---

## Runner-Up / Simpler Alternative Review

**C2 (mandatory Phase 0a):** The structural enforcement advantage is real but comes at the cost of a mandatory overhead step for all sessions. The C1+C3 hybrid achieves most of C2's value via procedure-level enforcement plus structural runCondition changes. C2 is the right escalation if the hybrid proves insufficient.

**Simpler variant:** Just one sentence added to Phase 0: 'If the goal is solution-framed, derive the underlying problem.' Too narrow -- no context variables means no downstream reference to the reframing.

**`alternativeFraming` addition from C2:** Borrowing C2's `alternativeFraming` requirement (one reframe even when the original goal seems correct) is high-value, low-cost. Add to Phase 0 design doc entry, not as a context variable.

**Finding: C1+C3 hybrid with two refinements (examples, alternativeFraming) stands. No direction change needed.**

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Validate at boundaries, trust inside | SATISFIED -- Phase 0 becomes an active validator |
| Make illegal states unrepresentable | PARTIALLY SATISFIED -- C3 structural changes help; C2 would fully satisfy |
| YAGNI with discipline | SATISFIED -- no new steps, minimal additions |
| Architectural fixes over patches | SATISFIED -- runCondition changes and required output contracts are structural |
| Determinism over cleverness | SATISFIED -- same goalType input produces same path behavior |

**One explicit philosophy tension:** 'Make illegal states unrepresentable' vs 'YAGNI with discipline' -- deliberately accepted, C2 is escalation path.

---

## Findings

### Yellow findings

**Y1: goalType classification boundary ambiguity**
The boundary between `problem_framed` and `opportunity_framed` is unclear without examples. Add classification examples to Phase 0 procedure to reduce misclassification at this boundary.

**Y2: Phase 1g runCondition must be OR, not replacement**
The retriage step runCondition must be: `retriageNeeded = true OR pathRecommendation == design_first OR pathRecommendation == full_spectrum`. A straight replacement would break landscape_first sessions that legitimately need retriage.

**Y3: 'What would make this framing wrong' needs specificity instruction**
The required output field should specify 'name ONE concrete falsification condition, not a general caveat.' Without this, the field can be satisfied by formulaic responses.

### No Red or Orange findings

The selected C1+C3 direction has no material structural weaknesses.

---

## Recommended Revisions

1. **Add goalType classification examples** to Phase 0 procedure (solution_framed: 'add X', 'implement Y', 'build X'; problem_framed: 'reduce X', 'fix Y'; opportunity_framed: 'explore X', 'decide whether Y'; decision_framed: 'choose between A and B')

2. **Add `alternativeFraming`** as a required design doc entry in Phase 0: 'Before selecting a path, generate one alternative framing -- if the stated goal is wrong, what would a better goal be?'

3. **Use OR condition for Phase 1g runCondition:** `retriageNeeded = true OR pathRecommendation in [design_first, full_spectrum]`

4. **Add specificity instruction** to Phase 1e/1f 'what would make this framing wrong' field: require naming one concrete falsification condition.

---

## Residual Concerns

1. The goalType classification is LLM-dependent. Without empirical testing on real sessions, we cannot confirm the classification is reliable. This is an inherent limitation of the approach.

2. The C1+C3 hybrid does not prevent path-selection bias for the window between Phase 0 path selection and Phase 1g retriage. A session that selects the wrong path in Phase 0 runs several steps in the wrong direction before Phase 1g can correct it. Acceptable for STANDARD rigor; C2 is the correct escalation if this proves problematic.
