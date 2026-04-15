# Workflow Discovery Model: Design Candidates

## Problem Understanding

**The real seam**: The `description` field already exists on every workflow. The problem is descriptions are written as marketing copy, not as intent phrases. The category layer is a symptom of descriptions not carrying enough signal for agents to match on.

**Core tensions:**
1. Human browsing vs. agent matching — humans scan groups visually; agents match text probabilistically
2. Compact summary vs. enough signal — 500 tokens only helps if the signal density is right
3. Multi-fit workflows — forcing single assignment loses information
4. Taxonomy maintenance vs. description maintenance — both together is double burden

**Key insight**: categories organize by type ("what kind of thing is this?"), agents need organization by intent ("when would I use this?"). These are different questions.

## Philosophy Constraints

- **Determinism**: `when` phrases must be explicitly authored, not computed or inferred
- **YAGNI**: don't add tags/embeddings before evidence they're needed
- **Explicit domain types**: intent phrases must be first-class authored fields, not derived

## Candidates

### A: Better descriptions only (too narrow)

Rewrite all 36 workflow descriptions as intent phrases. No categories, no overlay.

- **Fixes**: agent matching quality on second call
- **Doesn't fix**: 500-token first call (36 descriptions = ~3K tokens)
- **Scope**: too narrow — prerequisite, not a solution

### B: Categories + `when` phrases in categorySummary ✓ RECOMMENDED

Keep categories as the organizing layer. Enrich `categorySummary` with a `when: [...]` array of 2-4 intent phrases per category.

**Example first call (~500 tokens):**
```json
{
  "categorySummary": [
    {
      "id": "review_audit",
      "displayName": "Review & Audit",
      "count": 3,
      "when": ["reviewing a merge request", "auditing production readiness", "checking architecture scalability"]
    },
    {
      "id": "investigation",
      "displayName": "Investigation & Debugging",
      "count": 2,
      "when": ["diagnosing a bug in code", "diagnosing tool or environment issues"]
    }
  ]
}
```

- **Fixes**: 500-token budget, human browsing (categories), agent intent matching (`when` phrases), multi-fit (multiple `when` phrases can reference overlapping use cases across categories)
- **Maintenance**: per-category (9 entries), not per-workflow (36 entries)
- **Failure mode**: `when` phrases too coarse — agent can't distinguish within a category. Solvable by writing better phrases.
- **Scope**: best-fit
- **Philosophy**: honors determinism (authored explicitly), YAGNI (minimal addition)

### C: Intent clusters without categories (too broad)

Per-workflow `triggers` array, clustered dynamically into groups with computed labels.

- **Fixes**: multi-fit perfectly
- **Breaks**: determinism (computed clusters shift), 36x maintenance burden, YAGNI
- **Scope**: too broad — solves a problem we don't yet have

### D: Tags + categories (too broad)

Primary category for human browsing, multiple tags for multi-fit intent signals.

- **Fixes**: multi-fit
- **Breaks**: YAGNI (tags before evidence needed), governance burden
- **Scope**: too broad

## Comparison and Recommendation

**B + A together.** B handles compactness and both human/agent discovery. A (better descriptions) is B's prerequisite — it improves the second call after agents pick a category.

The `when` array lives at the **category level** (9 entries), not the workflow level (36 entries). This is the key: low maintenance cost, high signal density, no taxonomy proliferation.

## Self-Critique

**Strongest counter-argument**: `when` phrases at category level are too coarse. An agent wanting a "security review" won't find it if `when` only says "reviewing a merge request." Counter: this is a description quality problem in the phrases, not structural — write better phrases.

**Pivot condition**: if agents still mis-select after good `when` phrases, move to per-workflow `triggers` authored as explicit fields (not computed). Candidate C's structure, A's maintenance discipline.

## Open Questions

1. Who maintains the `when` phrases — inline in `spec/workflow-categories.json` alongside the category definitions?
2. How many `when` phrases per category? 3-5 seems right but worth confirming.
3. Should `when` phrases be surfaced in the `workrail://categories` MCP resource so agents can read them before calling `list_workflows`?
4. Does A (better descriptions) ship in the same PR or separately?
