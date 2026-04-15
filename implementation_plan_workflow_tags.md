# Implementation Plan: Workflow Tag-First Discovery

## Problem Statement

The workflow catalog (~36 items) returns too many tokens in a flat `list_workflows` call (~4K tokens). Tags (closed-set multi-labels from a 9-value canonical enum) replace single-label categories, resolving multi-fit workflows and enabling a compact first call (~500 tokens).

## Acceptance Criteria

- `list_workflows` without `tags` filter returns `{ workflows: [], tagSummary: [{id, displayName, count, when, examples}] }` (~500 tokens)
- `list_workflows` with `tags=["coding"]` returns full list of workflows tagged coding
- Each workflow has 1-3 tags from the closed enum
- `validate:registry` errors on non-hidden workflows with no tags
- Backwards compatible — existing callers see empty `workflows` array and can browse `tagSummary`

## Non-Goals

- MCP resource for tags (no resource infrastructure in server — deferred)
- Free-form user tags
- Console UI
- Per-workspace custom tag vocabularies

## Applied Philosophy

- Determinism: tags explicitly authored, not inferred
- Make illegal states unrepresentable: untagged = validation error
- YAGNI: no MCP resource until server infrastructure exists

## Invariants

- Tag vocabulary is closed: coding, review_audit, investigation, design, documentation, tickets, learning, routines, authoring
- Tags live in spec/workflow-tags.json overlay (not workflow JSON) — workflowHash unaffected
- Each workflow: 1-3 tags

## Selected Approach

Module-load singleton: read `spec/workflow-tags.json` once at `v2-workflow.ts` module load. Branch in `handleV2ListWorkflows` on `tags` filter presence.

## Slices

### Slice 1: spec/workflow-tags.json
```json
{
  "tags": [
    { "id": "coding", "displayName": "Coding & Development",
      "when": ["implementing a feature", "refactoring code", "converting code between platforms"],
      "examples": ["coding-task-workflow-agentic"] },
    ...
  ],
  "workflows": {
    "mr-review-workflow-agentic": { "tags": ["review_audit"] },
    "intelligent-test-case-generation": { "tags": ["tickets", "coding"] },
    "wr.discovery": { "tags": ["design", "investigation"] },
    "test-session-persistence": { "tags": ["testing"], "hidden": true }
  }
}
```

### Slice 2: Schema + handler changes
- `V2ListWorkflowsInput`: add `tags?: string[]`
- `V2WorkflowListOutputSchema`: add `tagSummary?: { id, displayName, count, when, examples }[]`
- `handleV2ListWorkflows`: branching logic

### Slice 3: validate:registry
Error (not warning) on non-hidden workflows missing from workflow-tags.json

### Slice 4: Description rewrites
Rewrite all 25 workflow `description` fields as intent phrases: "Use this to [verb] [object] [context]"

## Test Design

- Unit: `buildTagSummary(tags, workflows)` pure function covering multi-tag workflows
- Unit: filter logic when `tags=["coding"]` vs `tags=["coding","review_audit"]`
- Schema: validate spec/workflow-tags.json against expected shape
- Integration: existing list_workflows tests still pass (empty workflows array)

## Risk Register

| Risk | Mitigation |
|---|---|
| spec/workflow-tags.json path resolution | Use path.resolve(__dirname, '../../../spec/workflow-tags.json') |
| Existing callers break on empty workflows | workflows: [] is additive, not replacing |

## PR Strategy: SinglePR

## Philosophy Alignment

| Principle | Status |
|---|---|
| Determinism | Satisfied — explicitly authored |
| Make illegal states unrepresentable | Satisfied — validation error on missing tags |
| YAGNI | Satisfied — no MCP resource until infra exists |
| Immutability | Satisfied — overlay read-only at runtime |
