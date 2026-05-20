# Design Review: Artifact Schema Enrichment

**Date:** 2026-05-15
**Selected direction:** Candidate B -- explicit optional fields on ReviewVerdictArtifactV1Schema finding sub-object

---

## Tradeoff Review

**T1: Minor YAGNI violation (five optional fields before a downstream coordinator reads them)**
- Acceptable: fields are known/stable, producer already wants to emit them, optional dead fields are reversible
- Unacceptable condition: wr.mr-review Phase 6 not updated within 2-3 sprints after engine PR lands
- Hidden assumption: engine PR and workflow Phase 6 update are a paired delivery, not independent

**T2: Criterion 3 partially met (sixth enrichment field still needs an engine PR)**
- Acceptable: five-field set covers all current needs, no sixth field planned
- Unacceptable condition: review workflow overhaul generates a stream of new enrichment fields
- Hidden assumption: enrichment needs are stable in the near term

---

## Failure Mode Review

**FM1 (highest risk): Engine PR lands, workflow Phase 6 never updated to emit fields**
- Result: five dead optional fields, zero behavioral change, embarrassing YAGNI violation
- Mitigation: treat engine PR and workflow Phase 6 update as paired delivery in same milestone

**FM2: Workflow author adds arbitrary enrichment beyond the five fields**
- Mitigated: explicit optional fields (not .passthrough()) -- unknown fields still rejected by Zod unless sub-schema is separately relaxed

**FM3: Extensible contract registration never built**
- Residual: coupling between engine schema and workflow enrichment persists indefinitely
- Acceptable: backlog item exists, five-field approach explicitly labeled as intermediate step

---

## Runner-Up / Simpler Alternative

Runner-up (D: consumer-first, no schema change) offers one valuable discipline: **paired delivery**. Adopt this: the engine PR should not be merged without the workflow update either in the same commit or as an explicitly tracked follow-on within the same sprint.

Simpler variant (add only `file?` + `startLine?`, defer rest): not worth it -- the five fields were identified as a stable set together; splitting increases friction without meaningful YAGNI savings.

No hybrid needed.

---

## Philosophy Alignment

- **Types must constrain, not just label**: SATISFIED -- explicit typed optionals, not `unknown`
- **Make illegal states unrepresentable**: SATISFIED -- outer .strict() preserved, routing fields still required
- **Validate at boundaries, trust inside**: SATISFIED -- boundary validation unchanged
- **YAGNI with discipline**: MILD TENSION (acceptable -- known stable fields, not speculation)
- **Architectural fixes over patches**: MILD TENSION (acceptable -- five-field approach is labeled as intermediate, not final architecture)

---

## Findings

**YELLOW: Paired delivery discipline must be enforced**
The engine PR and wr.mr-review Phase 6 workflow update are a two-part delivery. Merging the engine PR without the workflow update produces a schema change with zero observable effect. This is FM1 and the highest-risk failure mode. Mitigation: file a GitHub issue for the workflow update when opening the engine PR, and link them explicitly.

**YELLOW: Sub-object schema strictness must be preserved**
The design adds explicit optional fields -- it does NOT add `.passthrough()` on the finding sub-object. Future PRs that relax the sub-schema further should reference this design decision and justify the relaxation explicitly.

No RED or ORANGE findings. The design is sound.

---

## Recommended Revisions

None to the selected direction. One delivery discipline addition:

**Add to the engine PR description:** "This PR is paired with [linked issue]: wr.mr-review Phase 6 prompt update to emit file/startLine/endLine/causalLink/remediation in the typed artifact. The schema change has no observable effect until that update ships."

---

## Residual Concerns

1. Extensible contract registration (backlog item) is the right long-term architecture. The five-field approach does not foreclose it -- explicit optional fields can be migrated to coordinator-declared schemas when that system is built.
2. The five-field set was derived from wr.mr-review's review use case. If other workflows want enrichment fields with different shapes, the per-field engine PR requirement applies. Monitor backlog.
