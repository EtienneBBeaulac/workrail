# WorkTrain Task Queue: Design Review Findings

_Review of Candidate B (Hybrid) -- the selected direction._

---

## Tradeoff Review

### Tradeoff 1: Optional body section (~10-15% of issues will use it)

- Does not violate any acceptance criterion. Body section is optional; an issue with no section is valid.
- Hidden assumption: the `## WorkTrain` section header is stable. If it changes after v1, existing issues with the section become unparseable.
- Condition for failure: section is never used in practice (0% of issues). If this happens, simplify to Candidate A.
- **Verdict: acceptable.**

### Tradeoff 2: Body content fetched at workflow runtime (not routing time)

- Does not violate any acceptance criterion. Routing is label-only; body fetch is a workflow execution cost.
- Hidden assumption: upstream_spec is not a routing gate. Current evidence (Phase 0.5 runs inside coding workflow after pipeline selection) supports this.
- Condition for failure: coordinator is built to make routing decisions based on upstream_spec presence/absence.
- **Verdict: acceptable with a known extension point (`worktrain:has-spec` label) if the assumption fails.**

---

## Failure Mode Review

### FM1: Human omits required label (maturity or type)

- **Severity: Low.** Issue is not processed, not broken.
- Design handles it: partially. Schema defines required labels; GitHub does not enforce them.
- Missing mitigation: schema doc must specify coordinator behavior on missing labels (log warning, add `worktrain:needs-labels` label to issue, skip dispatch).

### FM2: Malformed `## WorkTrain` body section

- **Severity: Low.** Phase 0.5 falls back to format-agnostic search. Graceful degradation.
- Design handles it: yes.
- Missing mitigation: coordinator context-injection path (if pre-fetching upstream_spec) must also handle parse failure gracefully (log and continue, do not fail dispatch).

### FM3: upstream_spec becomes a routing signal (not enrichment)

- **Severity: High.** If the coordinator needs upstream_spec presence/absence to select the pipeline, the body must be fetched at routing time and the labels-only routing architecture breaks.
- Design handles it: no -- this assumption is baked in.
- Extension point: add `worktrain:has-spec` label. Presence signals 'an upstream spec exists in the body' without requiring a body fetch. This is the escape valve if the assumption fails. Document it as an explicit extension point in v1.

---

## Runner-Up / Simpler Alternative Review

**Runner-up: Candidate A (Labels-only)**

- A is simpler, no body section, zero added documentation weight.
- A satisfies all 5 success criteria if Phase 0.5's format-agnostic search is sufficient for upstream spec discovery (no coordinator-injection use case).
- A does NOT satisfy criterion 4 if coordinator context-injection requires deterministic extraction of upstream_spec.
- **Decision: B wins on criterion 4 (coordinator-injection). A is the fallback if context injection is never implemented.**

**Simplest version of B:** identical to B as specified. No simplification is available that retains the upstream_spec benefit.

---

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Exhaustiveness everywhere | Satisfied -- closed enum for maturity/type, exhaustive routing switch |
| Validate at boundaries, trust inside | Satisfied -- coordinator validates labels at entry |
| Determinism over cleverness | Satisfied -- routing is a pure function of (maturity, type) |
| YAGNI with discipline | Satisfied -- no speculative required fields |
| Immutability by default | Satisfied -- routing table is pure, no mutable routing state |
| Make illegal states unrepresentable | Tension -- GitHub stringly-typed; coordinator validates at boundary as mitigation |
| Prefer explicit domain types | Minor tension -- body section is key: value text parsing |

Both tensions are acceptable given GitHub's stringly-typed constraints.

---

## Findings

### Red (blocking)

None.

### Orange (important, fix before production use)

**O1: Missing coordinator error behavior on absent required labels.** The schema doc does not specify what the coordinator does when maturity or type labels are absent. Without this, different coordinator implementations may handle the error differently (skip vs. full-pipeline fallback vs. error). Specify in the schema doc: add `worktrain:needs-labels` label to the issue, skip dispatch, emit structured log entry.

### Yellow (notable, address in documentation)

**Y1: `worktrain:has-spec` extension label not documented.** The schema should explicitly name this label as a known extension point for the case where upstream_spec presence/absence becomes a routing signal. Prevents a future coordinator developer from inventing an incompatible convention.

**Y2: `## WorkTrain` section header stability.** The schema doc should state that this header name is frozen after v1 and must not be changed. Issues with the section would silently break if the header name changes.

**Y3: `upstream_spec` type is unvalidated.** The body section key accepts any string. The schema doc should state that `upstream_spec` must be a valid http/https URL. Coordinator and Phase 0.5 should log a warning if the value is not a URL.

---

## Recommended Revisions

1. Add to schema doc: coordinator behavior on missing required labels (O1)
2. Add to schema doc: `worktrain:has-spec` as a documented extension label (Y1)
3. Add to schema doc: stability note for `## WorkTrain` header (Y2)
4. Add to schema doc: `upstream_spec` must be a valid http/https URL (Y3)
5. Add to Decision Log: simplify to Candidate A if coordinator-injection use case is never implemented

---

## Residual Concerns

- **The coordinator does not yet exist.** This schema is designed before its primary consumer is implemented. There is a risk that the routing table (especially the handling of `rough` vs `idea` vs `specced`) turns out to need more nuance once a real coordinator is being built. The schema should be versioned so that adding a new maturity value (e.g. `groomed`) does not break existing issues.
- **Label namespace collisions.** The `worktrain:` prefix namespace is informal. If WorkRail adds other labels with the same prefix for different purposes, conflicts could arise. The schema doc should be the authoritative namespace registry for `worktrain:` labels.
