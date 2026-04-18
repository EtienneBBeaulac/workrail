# Authoring Doc Staleness Enforcement -- Design Review Findings

**Reviewing:** Hybrid A+ (Candidate A feature coverage + Candidate B staleness with per-rule fallback)
**Date:** 2026-04-16

---

## Tradeoff Review

| Tradeoff | Criteria impact | What tips it | Hidden assumption |
|---|---|---|---|
| Text search (floor, not quality gate) | Passes Criterion 1 as stated | First incident of misleading minimal coverage | Authors add meaningful coverage by intent, not because the check forces depth |
| No staleness signal in PR 1 | Criterion 2 deferred to PR 2 | Second PR never ships | Follow-up PR ships within weeks |
| Regex brittleness (mitigated by guard) | Handled -- guard makes failure loud | IDs become dynamically generated | feature-registry.ts remains the single source |

---

## Failure Mode Review

| Failure mode | Handling | Missing mitigation | Risk |
|---|---|---|---|
| Regex extracts zero IDs | Guard clause fails CI loudly | Could assert `>= N` minimum count | Low |
| CI wiring omitted from PR | Not self-enforcing -- depends on author following checklist | Add explicit ci.yml step to AGENTS.md checklist | **HIGH** -- most likely silent failure |
| Staleness fires on cosmetic touches | Advisory mode (warn, don't fail) | Add action comment in CI step | Medium |
| feature-registry.ts is split | Not handled | Add assumption comment at top of script | Low-medium |

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate C -- per-rule dates):** Worth borrowing one element: the `rule.lastReviewed ?? spec.lastReviewed` fallback pattern. Costs zero extra implementation and creates the organic migration path from B to C. **Incorporated into Hybrid A+.**

**Simpler alternative (just add validate:authoring-spec to CI):** Too narrow -- does not catch `wr.features.capabilities`. Insufficient for Criterion 1.

**No hybrid opportunity was found that reduces complexity** relative to the already-minimal Hybrid A+.

---

## Philosophy Alignment

| Principle | Alignment |
|---|---|
| Make illegal states unrepresentable | STRONG -- CI-time violation for undocumented features |
| Validate at boundaries | STRONG -- CI wiring closes the enforcement gap |
| Errors are data | STRONG -- aggregate-then-fail pattern followed |
| Determinism | STRONG -- git log + regex are deterministic |
| Architectural fixes over patches | TENSION (acceptable) -- text search is a floor, not structural link |
| YAGNI | STRONG -- spec-level date, no premature structural fields |

---

## Findings

### Red (blocking)
None. No blocking issues identified.

### Orange (important, requires action)
**O1: CI wiring is the highest-risk gap**
If `validate:authoring-spec` and `validate:feature-coverage` are not added to `.github/workflows/ci.yml` in the same PR that introduces the scripts, both checks become permanently advisory-only. This is the most likely silent failure mode. The AGENTS.md checklist must include an explicit ci.yml verification step.

### Yellow (track but not blocking)
**Y1: Staleness check deferred to PR 2**
Criterion 2 (staleness signal) is not met by the first PR. Risk is low if PR 2 ships promptly. Mitigation: create a GitHub issue for PR 2 at the same time as PR 1.

**Y2: feature-registry.ts assumption undocumented**
If the registry is refactored, the regex may break in a way the zero-guard doesn't catch. Add a comment at the top of `validate-feature-coverage.js` documenting this assumption.

**Y3: Coverage is text presence, not quality**
A one-line antiPattern mention satisfies the check. The AGENTS.md checklist is the quality gate; the script is only the floor gate. Document this distinction explicitly in the script's comment header.

---

## Recommended Revisions

1. **Add ci.yml verification to AGENTS.md checklist** (Orange O1). The checklist should read: 'Verify that `.github/workflows/ci.yml` `validate-workflows` job runs both `validate:authoring-spec` and `validate:feature-coverage`.'

2. **Add assumption comment to validate-feature-coverage.js** (Yellow Y2):
   ```js
   // Assumption: wr.features.* IDs are defined as string literals in
   // src/application/services/compiler/feature-registry.ts.
   // If the registry is refactored (split files, dynamic IDs), update this script.
   ```

3. **Create GitHub issue for PR 2 (staleness check)** when PR 1 merges (Yellow Y1). Do not treat it as deferred-indefinitely.

4. **Include per-rule lastReviewed fallback in Candidate B implementation** (Hybrid A+ improvement from runner-up analysis):
   ```js
   const ruleDate = rule.lastReviewed ? new Date(rule.lastReviewed) : new Date(spec.lastReviewed);
   ```

---

## Residual Concerns

1. **Quality floor vs quality gate**: The coverage check verifies presence, not adequacy. This is a deliberate choice (YAGNI), but it means a PR could satisfy CI with a one-word mention. The AGENTS.md checklist is the only quality gate for coverage depth.

2. **Advisory staleness drift**: If Candidate B stays advisory forever (never promoted to hard-fail), it provides diminishing value as contributors learn to ignore it. The upgrade condition (promote to hard-fail after per-rule dates are backfilled) should be explicitly tracked as a GitHub issue.

3. **wr.features.capabilities gap**: This is confirmed undocumented, but the design doc raises the open question of whether it's intentionally undocumented. Before PR 1 lands, confirm with the project owner that `wr.features.capabilities` should be in `authoring-spec.json`. If it's intentionally excluded (e.g., internal/experimental), the feature coverage check would need an allowlist mechanism.
