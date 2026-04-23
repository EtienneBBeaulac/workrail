# UI/UX Design Workflow Discovery

## Context / Ask

Map the specific ways AI agents fail at UI/UX design work and identify which failures are addressable through workflow structure. Goal: inform the design of a WorkRail workflow for UI/UX design.

## Path Recommendation

`full_spectrum` — need both landscape (catalog of AI failure modes with evidence from UX principles) and reframing (which failures a workflow can actually address vs. which are inherent AI limitations).

## Constraints / Anti-goals

- Not building a visual design tool — agents can't render or see designs
- Not replacing the human designer — augmenting and structuring agent-assisted design
- Must produce something an agent can actually execute, not just describe

## Landscape Packet

*(populated in Phase 1)*

## Problem Frame Packet

*(populated in Phase 1d)*

## Candidate Directions

*(populated in Phase 3)*

## Challenge Notes

*(populated in Phase 4)*

## Resolution Notes

*(populated in Phase 5)*

## Decision Log

*(populated as decisions are made)*

## Final Summary

*(populated at end)*

## Candidate Directions

See `docs/plans/ui-ux-workflow-design-candidates.md` for full candidate analysis.

**Recommendation: Two composing workflows**

### Workflow B: UI/UX Design Creation Workflow
For designing UI/UX from scratch. Adapted from `wr.production-readiness-audit.json`.

**Phase structure:**
- Phase 0: Problem framing, user goals, constraints, existing design context (requireConfirmation always)
- Phase 1: State 2-3 design directions with IA sketches (requireConfirmation — forces alternatives before convergence)
- Phase 2: Freeze context packet + select reviewer families based on declared concerns
- Phase 3: Parallel reviewer bundle (IA, UX laws, accessibility, edge cases, content/microcopy)
- Phase 4: Synthesis + contradiction loop
- Phase 5: Design spec handoff

**Complexity branching**: Simple (single component, no new flows) skips Phases 1-3.

### Workflow D: UI/UX Design Audit Workflow
For reviewing an existing design description/spec before implementation. Adapted from `wr.architecture-scalability-audit.json`.

User provides design description; agent audits against declared dimensions: information architecture, Hick/Miller/Jakob/Fitts laws, accessibility (WCAG), edge cases (empty/error/loading/first-use), content/microcopy, visual hierarchy.

**Composability**: Run B to create the design spec, then D to audit it before handing to implementation.

## Decision Log

- A (Minimal gate) rejected: only addresses 1 of 6 failure categories
- C (Alternatives-first) incorporated as required step in B Phase 1, not standalone
- B + D selected: B for creation, D for audit, different moments in design process
- Challenge: reviewer generic findings — mitigated by context packet constraint
- Challenge: too heavy — mitigated by Simple fast path

## Final Summary

**The core insight**: AI agents don't fail at UI/UX because they lack knowledge — they fail because nothing forces them through the process that converts knowledge into good design. The workflow's job is to make the right process structurally unavoidable.

**What agents are bad at (6 categories):**
1. Process — premature convergence on single solution, happy-path only
2. UX law application — knows Hick/Miller/Jakob/Peak-End but skips them
3. Content — designs layout, ignores microcopy and error states
4. Accessibility — all 17 WCAG categories routinely missed
5. Context — doesn't know design system, platform, brand
6. Inherent — can't see/render, can't test with users

**What a workflow can fix (categories 1-4):**
Structural enforcement through phases, reviewer families, and requireConfirmation gates.

**What requires human input (categories 5-6):**
Design system, platform conventions, brand personality, real user research, visual review.

**Residual risks:**
- Reviewer families may produce generic findings without context packet constraint
- Simple path may be overused — needs explicit criteria
- Output is a spec, not a mockup — acceptable for developer-AI teams
