# Workflow Discovery Model: Alternatives to Categories

## Context / Ask

Hierarchical categories break down when items fit multiple buckets or none. Exploring whether a superior organization model exists for WorkRail's ~36 workflow catalog, specifically for token-efficient agent discovery.

## Path Recommendation

`full_spectrum` — problem framing matters here. The wrong model will feel natural to build but create friction in practice. Need both landscape (what models exist) and reframing (what do agents actually need when discovering workflows).

## Constraints / Anti-goals

- Must keep first `list_workflows` call compact (~500 tokens)
- Must be maintainable — no model that requires constant curation to stay accurate
- Must work for agents (text-based, probabilistic matching) not just humans (visual scanning)

## Landscape Packet

*(to be populated)*

## Problem Frame Packet

*(to be populated)*

## Candidate Directions

*(to be populated)*

## Challenge Notes / Resolution Notes / Decision Log / Final Summary

*(to be populated)*

## Final Summary

### Selected Direction: B + A — Categories with `when` phrases + intent-oriented descriptions

**Confidence: High.**

### The enriched `categorySummary` response

Each category entry in the first `list_workflows` call contains:
- `id`: stable identifier
- `displayName`: human-readable name  
- `count`: number of workflows
- `when: string[]`: 3-5 intent phrases agents match against ("reviewing a merge request before merging", "auditing a service before deployment")
- `examples: string[]`: 1-2 representative workflow IDs for agents that recognize names

**First call (~500 tokens)** → agent reads `when` phrases, picks category  
**Second call with `category=`** → agent reads intent-oriented `description` per workflow, picks specific workflow

### Workflow descriptions (A component)

All 36 workflow descriptions rewritten as intent phrases: "Use this to [verb] [object] [context]". Ships in same PR as the category changes.

### What changed from original Candidate A (prior session)

The original spec overlay + category filter design is unchanged structurally. The key additions:
1. Each category gains a `when: string[]` array in `spec/workflow-categories.json`
2. Each category gains an `examples: string[]` array (1-2 workflow IDs)
3. All workflow `description` fields rewritten as intent phrases
4. `workrail://categories` MCP resource exposes `when` phrases so agents can read them independently
5. Authoring guidelines added as comments in `spec/workflow-categories.json`

### Decision Log

- A alone (better descriptions) rejected: doesn't solve 500-token first call
- C (per-workflow triggers) rejected for now: unnecessary maintenance burden; it's the pivot condition if B proves insufficient
- D (tags) rejected: YAGNI
- B selected: categories + `when` phrases at category level. Low maintenance (9 entries), high signal density, both human and agent discovery served

### Residual risks

1. `when` phrase quality is load-bearing — content quality problem, not structural. Authoring guidelines mitigate.
2. Per-workflow triggers (C evolved) remains the right escalation if `when` phrases prove too coarse after real usage.
