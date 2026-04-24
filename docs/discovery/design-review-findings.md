# Design Review Findings: Issue #393 Stale Tracker Close

**Reviewed design:** Candidate A -- Close Issue #393 with evidence comment  
**Review date:** 2026-04-23  
**Reviewer:** wr.discovery session (design_first / QUICK path)

---

## Tradeoff Review

**Tradeoff 1: Close comment mentions why auto-close did not fire**
- Does not violate any decision criterion -- in fact satisfies Criterion 5 (captures the learning)
- Tone risk (sounds like blame): mitigated by using technical/mechanical language
- Hidden assumption: maintainer reads close comments -- reasonable for a 1-person repo
- **Verdict: Acceptable**

**Tradeoff 2: No AGENTS.md update -- pattern prevention sacrificed**
- Actively satisfies Criterion 3 (no new problems) by not touching a protected human-maintained file
- Only one observed instance of the failure mode (PR #790) -- insufficient evidence of a recurring pattern
- The learning is captured in the close comment itself, which is more contextually located than AGENTS.md
- **Verdict: Acceptable**

---

## Failure Mode Review

**FM1: Maintainer re-opens because they wanted to close personally**
- Design handles it: close comment provides full evidence chain; re-open is 5-second CLI command; no data loss
- Likelihood: Low (0 comments, 2-day stale, daemon assignee, no checkbox activity)
- Severity if occurs: Minimal (issue re-opens, maintainer closes manually, traceability comment persists)
- Missing mitigations: None needed

**FM2: CI secretly failing for the test file**
- Design handles it: 14/14 passing verified locally immediately before action; test is isolated unit coverage
- No related CI failure issues exist in the open issues list for this test file
- Severity if occurs: Low (tracker close is orthogonal to CI state; no test regression introduced)
- Missing mitigations: None needed

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate B -- close + AGENTS.md note):**
- Candidate B's only distinct value (keyword failure mode documentation) is fully absorbed into Candidate A's close comment
- No element of B is orphaned; no hybrid needed

**Simpler variant (close without comment):**
- Fails Criterion 2 (no traceability) and Criterion 5 (no learning capture)
- Not viable -- the comment is load-bearing, not decorative

---

## Philosophy Alignment

**Clearly satisfied:**
- Validate at boundaries, trust inside -- all validation done before action
- Observability -- close comment makes the state transition and rationale fully visible
- Document "why" not "what" -- comment explains rationale, not just action
- Atomicity -- single CLI call, no partial state possible
- Architectural fixes over patches -- reframe correctly identified the real problem (stale tracker) before acting

**Under tension:**
- Agent authority over human-filed issues -- mild tension; resolved by reversibility + transparent comment
- **Verdict: Acceptable tension, not risky**

---

## Findings

No RED or ORANGE findings. All challenges and reviews converge.

**YELLOW -- Tone of close comment (INFO)**
- Risk: the explanation of why auto-close did not fire could read as attributing a mistake to the PR author
- Mitigation: use mechanical/technical language ("GitHub requires `Closes #NNN` syntax; PR #790 used different phrasing") rather than evaluative language
- Action: word the comment accordingly -- no structural change to the design needed

---

## Recommended Revisions

**Revision 1 (from YELLOW finding): Prescribe exact comment wording**

Use this comment text:

> All acceptance criteria for this issue are satisfied on `main`.
>
> - `loadSessionNotes` is exported at `src/daemon/workflow-runner.ts` (added in PR #790)
> - All 4 failure paths (token decode, store load, projection, unexpected exception) and the happy path are covered by `tests/unit/workflow-runner-load-session-notes.test.ts` (added in PR #782)
> - 14 tests pass: `npx vitest run tests/unit/workflow-runner-load-session-notes.test.ts`
>
> Note: PR #790 referenced this issue as "Closes issue #393 pre-existing test failures" but GitHub's auto-close requires the exact syntax `Closes #393` -- the non-standard phrasing is why the issue was not automatically closed on merge.

This wording is factual, neutral, and gives any future reader everything they need to verify or re-open.

---

## Residual Concerns

**RC1 (low): Pattern recurrence unaddressed**
If the PR keyword failure mode recurs on a second PR, the case for Candidate B (AGENTS.md note) strengthens. This is not actionable now but should be noted for future monitoring.

**RC2 (very low): Open CI failures on main**
There are 10+ open "CI failure on main blocking release" issues. These are unrelated to the test file in question (verified locally). If main CI is broken in a way that affects this test file, the close would be slightly premature. Probability is very low given local verification.

---

**Overall verdict: PROCEED with Candidate A as designed, using the prescribed comment wording from Revision 1.**
