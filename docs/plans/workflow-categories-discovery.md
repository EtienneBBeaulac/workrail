# Workflow Categories & Category-First Discovery

## Context / Ask

The workflow catalog has grown to ~36 items (25 JSON files + routines + bundled). A flat `list_workflows` call returns all of them with full descriptions, consuming 3-5K tokens. Agents often don't know the exact workflow ID — they know the task family. Design category-first discovery: categories as metadata, `list_workflows` returns a summary when called without a category filter.

## Path Recommendation

`landscape_first` — the problem and desired outcome are clear. The key unknowns are implementation shape (where categories live, how the contract changes) and what the natural category taxonomy looks like for the current catalog. Understanding these grounds the design decision.

## Constraints / Anti-goals

- Must not break existing `list_workflows` callers (additive, not breaking)
- Categories must not require maintaining a parallel structure that drifts
- `list_workflows` contract change must be backwards-compatible

## Landscape Packet

*(to be populated)*

## Problem Frame Packet

*(to be populated)*

## Candidate Directions

*(to be populated)*

## Challenge Notes

*(to be populated)*

## Resolution Notes

*(to be populated)*

## Decision Log

*(to be populated)*

## Final Summary

*(to be populated)*

## Final Summary

### Selected Direction: Candidate A — spec overlay + category filter

**Confidence: High.** Three candidates evaluated, challenged, reviewed. No direction changes required.

### Implementation shape

**1. `spec/workflow-categories.json`** (new file)
```json
{
  "categories": [
    { "id": "coding", "displayName": "Coding & Development" },
    { "id": "review_audit", "displayName": "Review & Audit" },
    { "id": "investigation", "displayName": "Investigation & Debugging" },
    { "id": "design", "displayName": "Design & Discovery" },
    { "id": "documentation", "displayName": "Documentation" },
    { "id": "tickets", "displayName": "Tickets & Planning" },
    { "id": "learning", "displayName": "Learning & Personal" },
    { "id": "routines", "displayName": "Routines (Internal)" },
    { "id": "authoring", "displayName": "Workflow Authoring" },
    { "id": "testing", "displayName": "Testing & Diagnostics" }
  ],
  "workflows": {
    "mr-review-workflow-agentic": { "category": "review_audit" },
    "bug-investigation-agentic": { "category": "investigation" },
    "coding-task-workflow-agentic": { "category": "coding" },
    "test-session-persistence": { "category": "testing", "hidden": true },
    ...
  }
}
```

**2. `V2ListWorkflowsInput`**: add `category?: string`

**3. `V2WorkflowListOutputSchema`**: add `categorySummary?: { id, displayName, count, representatives }[]`

**4. Response contract:**
- No `category` passed → `{ workflows: [], categorySummary: [...10 categories with counts...] }` (~500 tokens)
- `category=coding` → `{ workflows: [...full list for coding...], categorySummary: undefined }` (~800 tokens)

**5. `validate:registry`**: error (not warning) on uncategorized non-hidden workflows

**6. `list_workflows` tool description**: update to explain category browsing

### Decision Log

- A (spec overlay) selected: hash stable, backwards compatible, CI-checkable, follows includeSources pattern
- B (convention inference) rejected: only covers ~30% of catalog reliably  
- C (embedded with hash isolation) rejected: compiler complexity for no gain over A
- Challenge: two-call adoption risk — resolved, summary is DEFAULT not opt-in
- Orange finding: response contract clarified (`workflows: []` + `categorySummary` when no category passed)

### Residual risks

1. Per-workspace custom categories deferred to v2
2. Routines visibility (show in summary or hide?) — open question, recommend show with "Routines (Internal)" label
3. validate:registry must not be removable without replacing the uncategorized-workflow check

### 5 open questions to resolve before building

1. Should `testing` workflows be `hidden: true` or shown in summary?
2. Should routines appear in summary or be hidden?  
3. Should `categorySummary` include a short description per category?
4. What display name for `review_audit`?
5. Should workflow-for-workflows Phase 7 prompt for category?
