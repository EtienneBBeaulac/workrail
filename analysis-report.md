# Analysis Report: anyEqualsLevel Trigger Simplification

**Verdict: REVISE -- 10 tests currently failing; migration is incomplete**

---

## Executive Summary

The `anyEqualsLevel` trigger simplification is architecturally correct and well-implemented in the source code, schema, docs, and the 7 new unit tests. However, the migration is **incomplete**: 5 test/fixture files still use the old `{ dimensionId, equalsLevel }` trigger form, causing **10 test failures** in the full test suite. CI is broken.

The root cause: the old trigger form is now fully rejected by the schema (`additionalProperties: false`, `required: ["anyEqualsLevel"]`), so any workflow definition using `{ dimensionId, equalsLevel }` fails at schema validation before tests can exercise their intended behavior.

---

## Findings by Concern

### Concern 1: integration test assessment-followup-retry-flow.test.ts

**BROKEN.** `tests/integration/v2/assessment-followup-retry-flow.test.ts:137`

```
when: { dimensionId: 'confidence', equalsLevel: 'low' },
```

- Test failure: `expected 'error' to be 'success'` at line 150 -- workflow fails schema validation at start
- The test asserts `blockRes.data.kind === 'blocked'` which can never be reached
- **Fix**: Replace with `when: { anyEqualsLevel: 'low' }`

---

### Concern 2: Other integration tests

**BROKEN.** `tests/integration/v2/assessment-step-context.test.ts:118`

The `BASE_WORKFLOW` constant at line 118 uses the old form. It drives 3 of 4 tests in the file; all 3 fail with `expected 'error' to be 'success'`.

```
when: { dimensionId: 'confidence', equalsLevel: 'low' },
```

- **Fix**: Replace with `when: { anyEqualsLevel: 'low' }` in `BASE_WORKFLOW`

---

### Concern 3: authoring-spec.json assessment-v1-constraints check/antiPattern text

**OK -- intentional reference.** `spec/authoring-spec.json:1010`

```json
"antiPatterns": [
  "Using dimensionId trigger on a multi-dimension gate -- the other dimensions will never block automatically",
  ...
]
```

This is in the `antiPatterns` array -- it is correctly teaching what NOT to do. The `checks` array at line 1007 says `"Multi-dimension gates use anyEqualsLevel rather than a single dimensionId trigger."` which is correct positive guidance. No change needed.

---

### Concern 4: lastReviewed date in authoring-spec.json

**STALE.** `spec/authoring-spec.json:6`

```json
"lastReviewed": "2026-03-21"
```

New rules were added to the `assessment-gates` group (the `assessment-v1-constraints` rule and others). The date was not updated. Today is 2026-04-04 -- 14 days stale.

- **Fix**: Update to `"2026-04-04"` (or date of the actual content change)

---

### Concern 5: Other test files with old trigger form

**Additional broken files not in the original concern list:**

**`tests/unit/compiler/assessment-definition-validation.test.ts`** -- 3 failures:

| Line | Test Name | Failure |
|---|---|---|
| 155 | `'accepts a valid step-level follow-up consequence'` | Expects `valid === true` but validation engine now rejects old form with `anyEqualsLevel 'undefined' is not declared in any dimension` |
| 184 | `'rejects a consequence that references an unknown assessment dimension'` | Expects error `references unknown dimension 'scope'` but gets `anyEqualsLevel 'undefined' is not declared` |
| 306 | `'fails fast on invalid assessment consequence level at compile time'` | Expects error `unsupported level 'medium'` but gets `anyEqualsLevel 'undefined' is not declared` |

Fix for each:
- Line 155: Replace `{ dimensionId: 'confidence', equalsLevel: 'low' }` with `{ anyEqualsLevel: 'low' }`
- Line 184: Replace `{ dimensionId: 'scope', equalsLevel: 'low' }` with `{ anyEqualsLevel: 'low' }` -- the test was checking an unknown `dimensionId`, which is no longer the validation mechanism; with the new form, the equivalent test should use `anyEqualsLevel: 'unknown_level'` to get the "not declared in any dimension" error
- Line 306: Replace `{ dimensionId: 'confidence', equalsLevel: 'medium' }` with `{ anyEqualsLevel: 'medium' }` -- the test was checking an unsupported level; with the new form `{ anyEqualsLevel: 'medium' }` should still trigger the right error (level not declared)

**`tests/lifecycle/fixtures/test-artifact-loop-control.fixture.ts:87`** -- drives 3 lifecycle failures:

```typescript
when: {
  dimensionId: 'confidence',
  equalsLevel: 'low',
},
```

- Causes `bundled-workflow-smoke.test.ts:262` to fail with compilation error
- Causes 2 tests in `test-artifact-loop-control.lifecycle.test.ts` to fail
- **Fix**: Replace with `when: { anyEqualsLevel: 'low' }`

---

## Pattern Compliance Summary

| Area | Status |
|---|---|
| Source types (`workflow-definition.ts`) | Correct -- only `anyEqualsLevel` |
| Runtime (`assessment-consequences.ts`) | Correct -- reads `anyEqualsLevel` |
| Compiler (`workflow-compiler.ts`) | Correct -- validates `anyEqualsLevel` |
| Validation engine | Correct -- validates `anyEqualsLevel` |
| JSON schema (`workflow.schema.json`) | Correct -- `required: ["anyEqualsLevel"]`, `additionalProperties: false` |
| 7 new unit tests | Correct -- all use `anyEqualsLevel` |
| Documentation (`docs/authoring-v2.md`) | Correct -- no old form references |
| Spec authoring rules | Correct -- antiPattern reference is intentional |
| **4 test/fixture files** | **BROKEN -- still use old form** |

---

## Complete Fix Checklist

**Required to unbreak CI (10 test failures):**

- [ ] `tests/integration/v2/assessment-followup-retry-flow.test.ts:137` -- replace `{ dimensionId: 'confidence', equalsLevel: 'low' }` with `{ anyEqualsLevel: 'low' }`
- [ ] `tests/integration/v2/assessment-step-context.test.ts:118` -- same replacement in `BASE_WORKFLOW`
- [ ] `tests/unit/compiler/assessment-definition-validation.test.ts:155` -- replace with `{ anyEqualsLevel: 'low' }`
- [ ] `tests/unit/compiler/assessment-definition-validation.test.ts:184` -- replace with `{ anyEqualsLevel: 'unknown_level' }` (to keep testing "level not declared in dimension")
- [ ] `tests/unit/compiler/assessment-definition-validation.test.ts:306` -- replace with `{ anyEqualsLevel: 'medium' }`
- [ ] `tests/lifecycle/fixtures/test-artifact-loop-control.fixture.ts:87` -- replace `{ dimensionId: 'confidence', equalsLevel: 'low' }` with `{ anyEqualsLevel: 'low' }`

**Nice-to-have:**

- [ ] `spec/authoring-spec.json:6` -- update `lastReviewed` from `"2026-03-21"` to `"2026-04-04"`

---

## Final Verdict

**REVISE**

The source code, schema, runtime, new unit tests, and documentation are all correct and consistent. The migration is solid architecturally. What's missing is completing the test migration -- 5 files were not updated and are now causing 10 test failures. The fixes are all mechanical (search-and-replace on `when` trigger objects) and low-risk. No logic changes are needed.
