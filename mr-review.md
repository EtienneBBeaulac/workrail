# MR Review: feat(engine): allow multiple assessmentRefs with a single consequence

**PR**: https://github.com/EtienneBBeaulac/workrail/pull/305  
**Branch**: `feat/engine/multi-assessmentrefs` -> `main`  
**Review mode**: THOROUGH  
**Date**: 2026-04-10

---

## Recommendation: Approve with minor comments

**Confidence band**: Low

The technical correctness of the change is solid -- no critical or major issues found. The confidence band is Low due to the absence of direct unit tests for the new multi-ref path in `assessment-validation.ts`, and an undocumented behavioral boundary when a workflow author adds a second `assessmentRef` to an existing step.

---

## Summary

This PR relaxes the v1 `assessmentRefs` constraint from exactly-1 to at-least-1. Steps can now declare multiple assessment references alongside one `assessmentConsequences` entry. The consequence fires if any dimension across any referenced assessment equals the trigger level. This enables composing orthogonal assessment vocabularies (quality-gate + coverage-gate) without merging unrelated dimensions into one monolithic definition.

**Breaking change**: `stepContext.assessments` in the `continue_workflow` response is now an **array** (one entry per `assessmentRef`). Callers reading `.assessments.assessmentId` must update to `.assessments[0].assessmentId`.

---

## Findings

### F1 - isSingleRef mode boundary undocumented (Minor)

**Location**: `src/mcp/handlers/v2-advance-core/assessment-validation.ts`, lines 148-155

When `refs.length === 1`, the first `wr.assessment` artifact is accepted regardless of whether it has an `assessmentId` field (backward compatibility). When `refs.length > 1`, artifact matching requires a matching `assessmentId` field.

This behavioral boundary is not documented in the PR's breaking change section. A workflow author who adds a second `assessmentRef` to an existing step will silently break existing agents that submit assessment artifacts without an explicit `assessmentId`.

**Suggested action**: Add a note to the breaking change section or the authoring docs: "If you add a second assessmentRef to a step, all submitted assessment artifacts must include an explicit assessmentId field."

---

### F2 - No multi-ref test coverage in assessment-validation.test.ts (Minor)

**Location**: `tests/unit/mcp/assessment-validation.test.ts`

All 5 test cases in this file use a single-ref step fixture. The new `isSingleRef=false` code path in `validateSingleAssessment` (artifact matching by `assessmentId`, the "missing artifact" error for multi-ref steps when no artifact has a matching `assessmentId`) is not directly unit-tested here.

Multi-ref coverage exists at other layers:
- `assessment-consequences.test.ts`: consequence fire/no-fire
- `assessment-definition-validation.test.ts`: compiler-level validation

But the runtime artifact-validation layer for multi-ref steps has no targeted unit tests.

**Suggested action**: Add 2-3 test cases to `assessment-validation.test.ts` covering: (a) multi-ref step with both artifacts correctly identified by `assessmentId`; (b) multi-ref step missing one artifact (no matching `assessmentId`); (c) multi-ref step with no `assessmentId` on artifact (should fail).

---

### F3 - getLatestAssessmentForNode dead code (Trivial)

**Location**: `src/v2/projections/assessments.ts`, lines 52-58

`getLatestAssessmentForNode` is still exported but the import was removed from `replay.ts`. It is no longer used anywhere.

**Suggested action**: Remove the export (or leave it if it is part of a public API surface -- check if any external consumers use it).

---

### F4 - workflow-for-workflows.json bundled with unrelated feature (Minor)

**Location**: `workflows/workflow-for-workflows.json`

The workflow-for-workflows.json changed from v0.1.0 to v2.4.0 (448 deletions, 558 additions) in this PR. This is a substantial structural refactor entirely unrelated to the multi-assessmentRefs feature. Bundling it makes the PR harder to review, rollback, and bisect.

**Suggested action**: This is worth noting but is not a blocker. Consider splitting into a separate PR next time for easier review and revert granularity.

---

## What Was Verified

- **Positional alignment**: `recordedAssessments[i]` and `acceptedArtifacts[i]` in `outcome-blocked.ts` and `outcome-success.ts` are guaranteed to be positionally aligned. Both arrays are built in the same iteration loop, only when `allValid=true`. Each `validateSingleAssessment` call either returns both non-null (valid) or both null (invalid). The invariant holds.

- **Backward compatibility**: Single-ref steps are unaffected. The `isSingleRef` mode accepts the first `wr.assessment` artifact regardless of `assessmentId`, matching prior behavior.

- **Consequence gate correctness**: `evaluateAssessmentConsequences` receives an empty array when validation fails (invalid artifact), preventing consequence fires on invalid submissions. The gate cannot be bypassed.

- **Compiler validation completeness**: The compiler at lines 287-301 validates ALL `assessmentRefs` against declared assessments before the trigger-level check. No silent mis-validation path.

- **Adversarial attack vectors tested**: (1) consequence fire on invalid artifact -- blocked; (2) wrong-assessment artifact match in multi-ref -- blocked by `assessmentId` matching; (3) two refs accidentally matching same artifact -- blocked by all-or-nothing validation.

---

## Coverage Ledger

| Domain | Status | Notes |
|---|---|---|
| correctness_logic | Checked | Positional alignment, backward compat, consequence evaluation all verified |
| contracts_invariants | Checked | Breaking change documented, isSingleRef boundary minor concern |
| patterns_architecture | Checked | Consistent relaxation across all engine layers |
| runtime_production_risk | Checked | Apparent critical concern in outcome-blocked.ts resolved as false positive |
| tests_docs_rollout | Checked | Minor gap in assessment-validation.test.ts acknowledged |
| security_performance | Not applicable | |

---

## Confidence Assessment

| Dimension | Rating | Rationale |
|---|---|---|
| boundaryConfidence | High | Clean PR against main, merge base confirmed |
| intentConfidence | High | PR description is detailed and accurate |
| evidenceConfidence | High | Full diff reviewed, all key code paths traced and verified |
| coverageConfidence | Low | Multi-ref path in validateSingleAssessment lacks direct unit tests; isSingleRef boundary undocumented |
| consensusConfidence | High | All reviewer families converged on approve_with_minor_comments |

**Final confidence: Low** (coverageConfidence drives result per derivation rules)

---

## Ready-to-Post Comments

**Comment 1** (on `assessment-validation.ts` lines 148-155):
> The `isSingleRef` boundary isn't mentioned in the breaking change section. When a step has 1 ref, the first artifact is accepted regardless of `assessmentId` (backward compat). When a step has 2+ refs, artifacts must match by `assessmentId`. Worth documenting: if you add a second `assessmentRef` to an existing step, agents submitting artifacts without an explicit `assessmentId` will start getting a "Missing assessment artifact" error.

**Comment 2** (on `tests/unit/mcp/assessment-validation.test.ts`):
> This file now has no multi-ref test coverage. The new `isSingleRef=false` logic (artifact matching by `assessmentId`, missing-artifact error for identified multi-ref) is tested indirectly via E2E/integration tests but not with targeted unit cases here. Would be good to add 2-3 cases covering the new path.

**Comment 3** (on `src/v2/projections/assessments.ts` line 52):
> `getLatestAssessmentForNode` appears to be dead code now that `replay.ts` no longer imports it. Safe to remove unless it's part of an intentional public API.

---

## Review Environment

- **Review target**: PR #305, GitHub `EtienneBBeaulac/workrail`
- **Context sources used**: PR body, full diff (2658 lines), CI check results, source files read directly
- **Missing sources**: No ticket/issue referenced; no external migration guide
- **Boundary confidence**: High (clean branch, confirmed merge base `b95cda231d`)
- **Context confidence**: High (self-contained PR with thorough description)
- **Limitations**: None material to this review

---

## CI Status

All 13 checks pass: Build & Test, Contract Tests, E2E Tests, Type Check, Security Audit, Validate Workflows, Verify Generated Artifacts, semantic-release dry-run.

---

## Blocking Behavior Observed

During the final validation step, the engine's three-dimension assessment gate (`evidence-quality-gate`, `coverage-completeness-gate`, `contradiction-resolution-gate`) blocked three times when a dimension was rated `low`:

1. Blocked on `coverage_completeness: low` -- required investigation of uncovered domains
2. Blocked on `evidence_quality: low` -- required anchoring all findings to specific file locations
3. Blocked on `contradiction_resolution: low` -- required resolving stated contradictions

This confirmed that the multi-assessmentRef consequence mechanism (the feature under review) works correctly end-to-end: `anyEqualsLevel: low` fires on the first low dimension found across all three referenced assessments, in `assessmentRefs` order, and blocks until the follow-up requirement is addressed.
