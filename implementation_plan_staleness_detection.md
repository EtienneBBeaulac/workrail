# Implementation Plan: Workflow Staleness Detection

## Problem Statement

Workflows can drift out of sync with the authoring spec they were written against. There is currently no signal to tell users or agents that a workflow may need review. Add a `staleness` field to `list_workflows` and `inspect_workflow` MCP output, driven by an optional `validatedAgainstSpecVersion` stamp in the workflow JSON.

## Acceptance Criteria

- `list_workflows` and `inspect_workflow` responses include a `staleness` field for each workflow
- Three-tier signal: `none` (stamped and current), `likely` (stamped but outdated), `possible` (unstamped)
- `staleness` includes a human-readable `reason` string and optional `specVersionAtLastReview`
- Running `workflow-for-workflows` stamps the current spec version into the workflow JSON at Phase 7
- Existing workflows work without modification (field is optional everywhere)
- `authoring-spec.json` has an explicit version bump trigger and changelog array
- Unit tests cover the pure staleness computation function

## Non-Goals

- Console UI changes (deferred to follow-up)
- Blocking workflow execution on staleness signal
- Auto-fixing stale workflows
- Tracking routine dependency changes (v1 out of scope)

## Applied Philosophy

- **Make illegal states unrepresentable** → typed `{ level, reason, specVersionAtLastReview? }` object, not boolean
- **Errors are data** → unreadable spec file returns `undefined` staleness (absent field), not an error
- **Determinism** → same stamp + same spec version always produces identical output
- **Validate at boundaries** → computed at the MCP output boundary; core engine trusts it
- **YAGNI** → optional field, no migration needed, no existing workflow breaks

## Invariants

- `validatedAgainstSpecVersion` is optional in JSON schema and TypeScript type
- Staleness computation is a pure function with no side effects
- Spec version read once at module load, not per request
- If spec version is unreadable, `staleness` field is absent from output (graceful degradation, not error)

## Selected Approach

Module-load singleton + pure function. Read `spec/authoring-spec.json` once at import time. Compute staleness via `computeWorkflowStaleness(stamp, currentVersion)`. Add optional `staleness` field to both output schemas.

**Runner-up**: Inject via ToolContext — more testable but costs an interface change. Not worth it for a spec version number.

## Slices

### Slice 1: Types and schema
- `src/types/workflow-definition.ts`: add `readonly validatedAgainstSpecVersion?: number` to `WorkflowDefinition`
- `spec/workflow.schema.json`: add optional `validatedAgainstSpecVersion` property (integer, minimum 1)
- `src/mcp/output-schemas.ts`: define `StalenessSummarySchema` and add optional `staleness` to `V2WorkflowListItemSchema` and `V2WorkflowInspectOutputSchema`

### Slice 2: Computation function
- `src/mcp/handlers/v2-workflow.ts`: add module-level `CURRENT_SPEC_VERSION` constant (reads `spec/authoring-spec.json` via `fileURLToPath(import.meta.url)`)
- Add pure function `computeWorkflowStaleness(stamp, currentVersion)`:
  - `stamp === currentVersion` → `{ level: 'none', reason: 'Workflow validated against current authoring spec (v{N}).', specVersionAtLastReview: N }`
  - `stamp < currentVersion` → `{ level: 'likely', reason: 'Authoring spec updated from v{stamp} to v{currentVersion} since last review.', specVersionAtLastReview: stamp }`
  - `stamp === undefined` → `{ level: 'possible', reason: 'Workflow has not been validated against the authoring spec.' }`
  - `currentVersion === null` → `undefined` (spec unreadable, degrade silently)

### Slice 3: Wire into handlers
- `buildV2WorkflowListItem`: add `staleness: computeWorkflowStaleness(workflow.definition.validatedAgainstSpecVersion, CURRENT_SPEC_VERSION)` to the returned object
- `handleV2InspectWorkflow`: same, spread into the `V2WorkflowInspectOutputSchema.parse(...)` payload

### Slice 4: workflow-for-workflows stamp
- `workflows/workflow-for-workflows.v2.json` Phase 7 procedure: add step to write `validatedAgainstSpecVersion` to the workflow file using the current spec version (read from `spec/authoring-spec.json`)
- Note in handoff: "The `validatedAgainstSpecVersion` stamp must be committed to take effect."

### Slice 5: Authoring spec companion changes
- `spec/authoring-spec.json` `changeProtocol`: add "Increment `version` when any required-level rule is added, removed, or materially changed."
- `spec/authoring-spec.json`: add `changelog: [{ version: 3, date: "2026-03-21", summary: "Baseline version at staleness feature introduction." }]`

## Test Design

**Unit tests** (`tests/unit/mcp/workflow-staleness.test.ts`):
```
computeWorkflowStaleness(3, 3)    → { level: 'none', ... }
computeWorkflowStaleness(2, 3)    → { level: 'likely', ..., specVersionAtLastReview: 2 }
computeWorkflowStaleness(undefined, 3) → { level: 'possible', ... }
computeWorkflowStaleness(undefined, null) → undefined
computeWorkflowStaleness(3, null) → undefined
```

**Integration**: existing `list_workflows` tests unaffected (staleness is optional).

**Schema**: `npm run validate:registry` confirms `validatedAgainstSpecVersion` field is accepted in workflow JSON.

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Spec file path fails in some environments | Low | Use `fileURLToPath(import.meta.url)` + `path.resolve`; return null on any error |
| Output schema change breaks callers | Low | Field is optional; `.parse()` accepts new optional fields |
| Spec version never bumped | Medium | `changeProtocol` addition makes the trigger explicit |

## PR Strategy

SinglePR — all changes are coupled. Ship together.

## Philosophy Alignment

| Principle | Status | Note |
|---|---|---|
| Make illegal states unrepresentable | Satisfied | Typed enum level, not boolean |
| Errors are data | Satisfied | Unreadable spec → undefined, not throw |
| Determinism | Satisfied | Pure function + module constant |
| Validate at boundaries | Satisfied | MCP output boundary only |
| YAGNI | Satisfied | Optional field, no migration |
| Explicit domain types | Satisfied | StalenessSummary, not raw string |
