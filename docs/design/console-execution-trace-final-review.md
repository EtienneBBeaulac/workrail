# Design Review: WorkRail Console Three-Layer Execution Trace

## Purpose
This document records the design review of the proposed three-layer execution trace feature
for the WorkRail Console. It is a human-readable companion to the WorkRail workflow execution
notes. Execution truth lives in the workflow notes and context variables, not here.

## Context / Ask
Review the proposed three-layer execution trace design holistically before implementation.
Determine whether the combined interaction model is coherent or needs restructuring.

## Path Recommendation
`full_spectrum` -- the design is already proposed; risk is coherence of the combined model,
not ignorance of options. Both landscape grounding (codebase constraints) and reframing
pressure (do the layers conflict?) are required.

## Constraints / Anti-goals
See workflow context variables for the full list.

---

## Landscape Packet
*(filled during landscape phase)*

## Problem Frame Packet
*(filled during problem framing phase)*

## Candidate Directions

### Generation expectations (for synthesis quality check)
- `full_spectrum` path: candidates must reflect both landscape constraints and reframing pressure
- Must include at least one direction that extends the existing NodeDetailSection rather than adding a new surface (tests the riskiest assumption)
- Must include at least one direction that preserves the proposed floating overlay with precise conflict resolutions
- Must include a bidirectional linking direction as an alternative to Layer 2 overlay
- THOROUGH: if the first set feels clustered, push for divergence on the ambient data duplication issue

*(filled during candidate generation step)*

## Challenge Notes
*(filled during adversarial challenge phase)*

## Resolution Notes
*(filled during resolution phase)*

## Decision Log
*(key decisions recorded here)*

## Final Summary

### Verdict: The three-layer concept is coherent. Layer 2 needs restructuring before implementation.

**Confidence band:** HIGH

### Selected direction: Hybrid B+C

**Layer 1 (TRACE tab):** Implement exactly as proposed. Zero backend cost, tab CSS infrastructure already exists in `index.css`. No changes needed.

**Layer 2 (routing context for selected node):** Replace the floating overlay with two new entries prepended to the `SECTION_REGISTRY` array in `NodeDetailSection.tsx`:
- `routing` section (first entry): filters `executionTraceSummary.items` by `refs.some(r => r.kind === 'node_id' && r.value === nodeId)`, renders `[ WHY SELECTED ]` / `[ CONDITIONS EVALUATED ]` / `[ LOOP ]` / `[ DIVERGENCE ]` groupings with the proposed badge vocabulary
- `run_routing` section (second entry, collapsed by default): shows ambient items with no node_id ref
- contextFact chip strip in `RunLineageDag` DAG header (below SummaryChips row), conditional on `run.executionTraceSummary?.contextFacts.length > 0`
- `routingEventCount` badge on DAG tab header when node is selected (label: `[ N routing decisions ]`, not just a count)
- TRACE tab label counter for live runs (visible in DAG mode when new ambient items arrive)

**Layer 3 (DAG annotations):** Implement edge cause diamonds, loop brackets, CAUSE button on blocked_attempt nodes. Ghost nodes explicitly gated on backend confirmation of `skipped_step` kind in `ConsoleExecutionTraceItemKind`.

### Runner-up: Proposed floating overlay (Candidate A)
Revisit if user research validates: (a) spatial anchoring reduces debugging time on complex DAGs, or (b) users are confused about which node the right panel refers to.

### Residual risks
1. **SECTION_REGISTRY ordering fragility:** A code comment must mark the routing section as "must remain first" to survive future contributions.
2. **Post-run vs live debugging use case:** If live debugging is the primary use case, ambient routing context in DAG mode may need a stronger signal than the TRACE tab label counter.

### Decision log
- Floating overlay rejected because: (a) single click opens two simultaneous surfaces (overlay + right panel); (b) overlay-in-TRACE is an illegal state with no structural prevention; (c) overlay positioning in scroll-container coordinates is non-trivial with ambiguous value.
- NodeDetailSection SECTION_REGISTRY chosen because: one-entry addition at the explicit extension point, zero new surface logic, satisfies all five acceptance criteria, honors all philosophy principles.
- contextFact chip strip borrowed from proposed Layer 2 to preserve ambient DAG-mode context visibility.
