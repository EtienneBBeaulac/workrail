# Design Review Findings: WorkRail Attention Gap at Zillow

**Date:** 2026-04-14
**Context:** wr.discovery workflow - landscape_first pass
**Selected direction:** A+D parallel, then B conditional (Zodiac Slack DM + Zillow quickstart + Demo Series)
**Candidates doc:** `/Users/etienneb/git/personal/workrail/design-candidates-nexus-attention-gap.md`

---

## Tradeoff Review

| Tradeoff | Status | Notes |
|----------|--------|-------|
| A has no public visibility | Acceptable | A is step 1 of sequence; B (Demo Series) provides visibility. Sign up for Demo Series slot simultaneously with sending A. |
| A depends on single relationship | Acceptable | This IS the acceptance criterion (Andy Rifken evaluates WorkRail). Not a limitation. |
| D has minimal standalone impact (YAGNI tension) | Acceptable | D is a multiplier, not standalone. Low cost (1-2 days). Survival risk justifies proactive build. |

**Revision from tradeoff review:** Sign up for Demo Series slot simultaneously with sending A, not sequentially. Removes timing risk of slot filling up while waiting for A's response.

---

## Failure Mode Review

| Failure Mode | Severity | Design Handles It? | Missing Mitigation |
|-------------|----------|-------------------|-------------------|
| A: Andy confirms Zodiac already has durability layer | High (informative) | Yes - pivot to C | None needed |
| B: Demo format mismatch (conceptual vs. visceral value) | HIGH | Partial | Pre-draft session-resurrection scenario before Demo Series. Start with "what you'd lose without WorkRail" before showing recovery. |
| C: Peter Yao declines nexus-core MR | Medium | Yes - C is last resort | Send Peter Yao a Slack DM first before opening MR (converts unilateral action to conversation) |
| D: First workflow not compelling after install | Low-medium | Partial | Quickstart should include a Zillow-specific "hello world" example workflow (not generic demo) |

**Highest-risk failure mode:** B (demo format mismatch). A bad company-wide demo creates a lasting negative impression that is harder to reverse than a declined DM.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (B: Demo Series) strength worth borrowing:** Forces construction of a compelling demo scenario. This scenario (session-resurrection: show what's lost without WorkRail, then show recovery) strengthens ALL candidates - A's pitch, C's artifact, D's first-run example.

**Simpler alternative (A alone):** Satisfies only 1 of 4 acceptance criteria. Insufficient standalone.

**Hybrid adopted:** Pre-draft session-resurrection scenario (2 hours) before executing any candidate. Zero downside. Strengthens A's pitch and prepares B without duplicating work.

---

## Philosophy Alignment

| Principle | Status | Notes |
|-----------|--------|-------|
| Architectural fixes over patches | Satisfied | Targets root cause (decision-maker) not symptom (broadcast posting) |
| YAGNI with discipline | Tension (acceptable) | D: building setup script before anyone asks. Justified by survival risk and low cost. |
| Surface information, don't hide it | Satisfied | Complementarity framing is honest and explicit |
| Document "why", not "what" | Satisfied | Session-resurrection scenario focuses on why durability matters |
| User drives decisions (AGENTS.md) | Tension (acceptable) | C involves unilateral action toward Peter Yao. Mitigated: DM Peter first. |
| Deliberate progression (AGENTS.md) | Satisfied | Correct order: scenario -> DM -> demo slot -> quickstart |

---

## Findings

### Yellow - Timing risk in sequencing
**Finding:** The original recommendation had A then B sequentially (wait for A's response before signing up for Demo Series). This creates a timing risk: Demo Series slots could fill up while waiting 2 weeks for A's response.
**Revision:** Sign up for Demo Series slot simultaneously with sending A. The demo pitch can be calibrated after A's response, but the slot should be reserved immediately.

### Yellow - Candidate B demo script gap
**Finding:** The Demo Series failure mode (format mismatch) has no specific mitigation in the current design. The value prop for WorkRail (durability) is harder to make viscerally compelling in 10 minutes than nexus-core's (watch AI write code).
**Revision:** Pre-draft the session-resurrection scenario: (1) show a nexus-core session failing mid-flow with all work lost; (2) show WorkRail's checkpoint/resume recovering the exact session state. This is the specific demo structure that resolves the format mismatch.

### Yellow - Candidate C unilateral action concern
**Finding:** Opening a draft MR to Peter Yao's repo without prior contact is slightly inconsistent with AGENTS.md's "user drives decisions" philosophy.
**Revision:** Send Peter Yao a Slack DM first (a shorter, conversational opener). If he responds with interest, then open the MR. C is last-resort anyway (60+ days), so this adds minimal delay.

---

## Recommended Revisions

1. **Sign up for Demo Series slot simultaneously with sending A** (not after A's response)
2. **Pre-draft the session-resurrection demo scenario** before executing any candidate (2 hours, strengthens all candidates)
3. **Zillow quickstart should include a Zillow-specific first workflow** (not a generic WorkRail demo) to ensure the first run is contextually relevant
4. **For Candidate C:** DM Peter Yao before opening the nexus-core MR

---

## Residual Concerns

1. **Andy Rifken's decision authority:** Cannot confirm from Glean data whether Andy is the actual decision-maker for Zodiac's workflow layer choice, or whether this has already been decided at a higher level. A's DM will surface this quickly, but it remains the primary unknown.

2. **Demo Series slot availability:** The sign-up sheet shows active scheduling but month-by-month availability is not confirmed. Should check the sheet immediately.

3. **Common-ground tooling stability for D:** The Zillow quickstart depends on common-ground's workflow bundle and install patterns being stable. The April 11, 2026 MR suggests active maintenance, but the dependency should be confirmed before publishing setup-zillow.sh.
