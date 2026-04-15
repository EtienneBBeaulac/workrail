# Implementation Plan: anyEqualsLevel Assessment Trigger

## Problem statement

The current `assessmentConsequenceTrigger` fires only when a single named dimension equals a given level. Workflows with multi-dimensional assessments must pick one dimension as the trigger, meaning the other dimensions being low never block the agent automatically. The intent is: agent submits the full matrix, WorkRail derives the outcome -- if ANY dimension is low, block.

## Acceptance criteria

- A consequence with `{ "anyEqualsLevel": "low" }` fires if ANY dimension in the submitted assessment equals `"low"`
- A consequence with `{ "dimensionId": "x", "equalsLevel": "low" }` continues to fire only when dimension `x` = `"low"` (backward compat)
- Schema validation rejects triggers that set both `anyEqualsLevel` and `dimensionId` simultaneously
- TypeScript compiler catches unhandled trigger kinds (exhaustiveness)
- `mr-review-workflow.agentic.v2.json` uses `anyEqualsLevel: "low"` on its readiness gate

## Non-goals

- Multiple consequences per step (still maxItems: 1)
- Changing the durable event schema shape
- Per-dimension separate consequences
- `allEqualsLevel` (all must match) -- not needed now

## Applied userRules

- **Make illegal states unrepresentable**: discriminated union, not optional fields
- **Type safety as first line of defense**: compile-time exhaustiveness check on trigger kinds
- **Immutability by default**: all new types are `readonly`
- **Exhaustiveness everywhere**: `never` assertion in switch/if chain

## Invariants

1. `TriggeredAssessmentConsequenceV1.triggerDimensionId` remains `string` (not optional) -- event builder requires it; use first matched dimension's ID for `anyEqualsLevel` case
2. `triggerLevel` for `anyEqualsLevel` = the `anyEqualsLevel` value (e.g. `"low"`)
3. Existing `{dimensionId, equalsLevel}` triggers are unaffected

## Selected approach

**Discriminated union** via TypeScript type union + JSON Schema `oneOf`.

Runtime narrowing: `'anyEqualsLevel' in trigger`. Compile-time safety: exhaustiveness `never` check.

## Vertical slices

### Slice 1: Schema (`spec/workflow.schema.json`)

Change `assessmentConsequenceTrigger` from a flat object to `oneOf` with two shapes:
- `{ dimensionId: string, equalsLevel: string }` (existing)
- `{ anyEqualsLevel: string }` (new)

Update description to reflect both forms.

### Slice 2: TypeScript types (`src/types/workflow-definition.ts`)

```typescript
export type AssessmentConsequenceTriggerDefinition =
  | { readonly dimensionId: string; readonly equalsLevel: string }
  | { readonly anyEqualsLevel: string };
```

Remove old interface, replace with type alias.

### Slice 3: Evaluation logic (`src/mcp/handlers/v2-advance-core/assessment-consequences.ts`)

Add private helper:
```typescript
function matchTrigger(
  trigger: AssessmentConsequenceTriggerDefinition,
  dimensions: readonly RecordedAssessmentDimensionV1[],
): { dimensionId: string; level: string } | undefined {
  if ('anyEqualsLevel' in trigger) {
    const matched = dimensions.find(d => d.level === trigger.anyEqualsLevel);
    return matched ? { dimensionId: matched.dimensionId, level: trigger.anyEqualsLevel } : undefined;
  }
  if ('dimensionId' in trigger) {
    const matched = dimensions.find(
      d => d.dimensionId === trigger.dimensionId && d.level === trigger.equalsLevel,
    );
    return matched ? { dimensionId: trigger.dimensionId, level: trigger.equalsLevel } : undefined;
  }
  // Exhaustiveness guard
  const _: never = trigger;
  return undefined;
}
```

Update `evaluateAssessmentConsequences` to use this helper.

### Slice 3b: Compiler validation (`src/application/services/workflow-compiler.ts:327-338`)

Narrow with `'anyEqualsLevel' in consequence.when`:
- `anyEqualsLevel` branch: validate the level value exists in at least one dimension of the assessment (not a specific dimension)
- `dimensionId` branch: keep existing validation unchanged

### Slice 3c: Validation engine (`src/application/services/validation-engine.ts:919-941`)

Same narrowing:
- `anyEqualsLevel` branch: validate level value exists in at least one declared dimension level across all dimensions
- `dimensionId` branch: keep existing validation unchanged

### Slice 4: Authoring docs + spec

- `spec/authoring-spec.json`: Update `assessment-v1-constraints` rule to mention `anyEqualsLevel`; update `assessment-dimension-orthogonality` rule to mention that `anyEqualsLevel` is the correct trigger for multi-dimension gates
- `docs/authoring-v2.md`: Update "Assessment-gate authoring (v1)" to document `anyEqualsLevel` as the preferred trigger for multi-dimension assessments

### Slice 5: Workflow update (`workflows/mr-review-workflow.agentic.v2.json`)

Change consequence trigger from `{ "dimensionId": "evidence_quality", "equalsLevel": "low" }` to `{ "anyEqualsLevel": "low" }`.

## Test design

### Unit tests (`tests/unit/mcp/assessment-consequences.test.ts`)

Add to existing `evaluateAssessmentConsequences` describe block:

- `anyEqualsLevel` fires when first dimension matches
- `anyEqualsLevel` fires when second or later dimension matches (not just first)
- `anyEqualsLevel` does not fire when no dimension matches
- `anyEqualsLevel` fires on the first matched dimension when multiple match (returns first)
- Existing `dimensionId + equalsLevel` tests continue to pass (regression)

### Schema validation tests (`tests/architecture/schema-consistency.test.ts`)

Verify `mr-review-workflow.agentic.v2.json` validates after the workflow update (covered by existing snapshot test).

## Risk register

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| TypeScript error in consumers of `consequence.when.dimensionId` | Medium | Use `'anyEqualsLevel' in trigger` narrowing before accessing |
| Schema snapshot test fails due to schema change | Low | Update snapshot in `tests/architecture/v2-tool-schema-snapshot.test.ts` if it captures the workflow.schema.json |
| `mr-review-workflow` validation fails after trigger change | Low | Run `npm run validate:registry` after change |

## PR packaging

Single PR. All changes are cohesive -- schema, types, evaluation, docs, workflow update.

## Philosophy alignment

| Principle | Status | Why |
|-----------|--------|-----|
| Make illegal states unrepresentable | Satisfied | Discriminated union prevents `{}` or mixed fields |
| Type safety as first line | Satisfied | Exhaustiveness check catches new trigger kinds at compile time |
| Immutability by default | Satisfied | All new types are readonly |
| Exhaustiveness everywhere | Satisfied | never guard in matchTrigger |
| YAGNI with discipline | Satisfied | Only adding what's needed; no allEqualsLevel speculation |
| Architectural fixes over patches | Satisfied | Proper type modeling, not a string sentinel |
