# UI/UX Workflow Design Candidates

## Problem Understanding

**Core claim**: AI agents fail at UI/UX design not because they lack knowledge but because they skip the process that converts knowledge into good design. They anchor on solutions before understanding users, produce single outputs instead of alternatives, violate UX laws they can accurately recite, and ignore edge cases, accessibility, and content entirely.

**The 6 failure categories:**
1. **Process failures** — skips empathy, jumps to single solution, happy-path only, no iteration
2. **UX law violations** — knows Hick/Miller/Jakob/Fitts/Peak-End/Tesler but doesn't apply them
3. **Content/communication failures** — designs layout, ignores microcopy, no error states, no onboarding
4. **Accessibility failures** — color contrast, keyboard nav, touch targets, screen readers ignored
5. **Context blindness** — no design system, platform conventions, brand, user research knowledge
6. **Inherent limitations** — can't see/render designs, can't test with users

**Core tension**: Agents CAN recite all UX principles. The failure is enforcement and process, not knowledge.

**What makes this hard**: A checklist prompt doesn't work — an agent can "check" each item while still fundamentally designing the wrong thing. The forcing function must be structural: impossible to advance past Problem Framing without user goals explicitly stated and confirmed.

## Philosophy Constraints

- **Make illegal states unrepresentable**: Solution proposals before user framing are an illegal state
- **Validate at boundaries**: User goals/problem definition is the boundary; validate before design begins
- **Structured freedom**: Constrain outcomes (user framing required, alternatives required), not cognition steps
- **Anti-lazy wording**: 'design a UI for X' is insufficient input; workflow must force specificity
- **YAGNI**: Don't add phases that don't address a real failure mode

## Candidates

### A: Minimal — Problem-First Gate

**Summary**: 3-phase workflow enforcing exactly one invariant: no solution proposals until user goals and constraints are explicitly stated and confirmed (requireConfirmation).

- **Tensions resolved**: premature convergence
- **Tensions accepted**: UX law violations, edge cases, accessibility all left to agent judgment
- **Failure mode**: agent states user goals then proposes a single solution anyway
- **Repo pattern**: similar to bug-investigation hypothesis-first gate
- **Gains**: minimal ceremony, fast, blocks root cause
- **Losses**: only addresses 1 of 6 failure categories
- **Scope**: too narrow
- **Philosophy**: honors validate-at-boundaries; conflicts with make-illegal-states-unrepresentable

---

### B: Process Enforcement — Adapted Production Readiness Audit (RECOMMENDED for creation)

**Summary**: 6-phase creation workflow with hypothesis-first, neutral context packet, parallel reviewer families per failure category, synthesis loop, and design spec handoff.

**Phase structure:**
- Phase 0: Problem framing + user goals + constraints (requireConfirmation always)
- Phase 1: State design hypothesis — what does the agent currently believe is the right direction?
- Phase 2: Freeze context packet + declare reviewer families based on declared concerns
- Phase 3: Parallel reviewer bundle (IA reviewer, UX laws reviewer, accessibility reviewer, edge-cases reviewer, content/microcopy reviewer)
- Phase 4: Synthesis + contradiction loop
- Phase 5: Design spec handoff with per-dimension findings

**Complexity branching**: Simple (single-screen, minor change) → skip Phase 1-3, go direct. Standard/Complex → full pipeline.

- **Tensions resolved**: all 6 failure categories; forces alternatives at hypothesis stage; evidence-based per-dimension findings
- **Tensions accepted**: inherent visual limitations; spec not mockup
- **Failure mode**: reviewer families produce generic UX advice not tied to actual design context
- **Repo pattern**: directly adapts `production-readiness-audit.json` structure; auditComplexity branching from `adaptive-ticket-creation.json`
- **Gains**: comprehensive, structured freedom, all failure categories covered
- **Losses**: heavier than minimal for simple tasks (mitigated by Simple fast path)
- **Scope**: best-fit for feature-level and screen-level design work
- **Philosophy**: all principles satisfied

---

### C: Alternatives-First — Double Diamond

**Summary**: Forces divergence (3 fundamentally different design directions with explicit IA sketches) before any convergence, with adversarial challenge before the agent recommends one.

- **Tensions resolved**: single-solution anchoring; forces genuine exploration
- **Tensions accepted**: UX laws/accessibility not explicitly enforced
- **Failure mode**: 3 directions are superficially different (same IA, different metaphors)
- **Repo pattern**: adapts `architecture-scalability-audit.json` dimension-declaration
- **Gains**: best for exploring solution space; documents tradeoffs
- **Losses**: lighter on UX law enforcement; accessibility second-class
- **Scope**: best as a mechanism within B rather than a standalone workflow
- **Philosophy**: honors structured freedom; YAGNI tension (adds divergence without enforcing quality)

---

### D: UX Audit — Review Against Principles (RECOMMENDED as companion)

**Summary**: Review workflow for existing designs. User provides a design description/spec; agent audits it against explicit UX dimensions with per-dimension verdicts and evidence.

**Dimensions**: information architecture, Hick/Miller/Jakob laws, Fitts + touch targets, Peak-End + emotional journey, accessibility (WCAG checklist), edge cases (empty/error/loading/first-use), content + microcopy.

- **Tensions resolved**: turns agent UX knowledge into structured application; fully evidence-based
- **Tensions accepted**: doesn't help with design-from-scratch; requires existing design as input
- **Failure mode**: agent audits what's in the spec but misses implicit design assumptions not stated
- **Repo pattern**: directly adapts `architecture-scalability-audit.json`
- **Gains**: actionable per-dimension findings with references; complements B
- **Losses**: review only, not creation
- **Scope**: best-fit as standalone for design review; or used after B to audit the output
- **Philosophy**: all principles satisfied; mirrors architecture-scalability-audit exactly

## Comparison and Recommendation

**Recommendation: Build B and D as two separate workflows that naturally compose.**

B (creation) and D (audit) serve different moments: B for designing from scratch, D for auditing before implementation. Together they cover the full design process. Neither alone is sufficient.

C's divergence mechanism (3 design directions) should be incorporated as a step within B's hypothesis phase, not as a separate workflow.

A is too narrow — prevents the worst failure but leaves 5 of 6 failure categories entirely to agent judgment.

## Self-Critique

**Strongest counter-argument**: B is too heavy for everyday use. Adding a button to a screen shouldn't require 6 phases and reviewer families. Counter: the Simple fast path (auditComplexity branching) addresses this — simple changes skip everything except problem framing and spec.

**Pivot condition**: If agents produce hollow reviewer findings (generic advice not tied to the actual design context), the reviewer-family approach needs replacement with a simpler rubric where the agent self-scores against explicit criteria rather than running independent reviewers.

## Open Questions for Main Agent

1. Should D be a standalone workflow or a phase within B? (Standalone seems cleaner — used at a different moment in the process.)
2. What's the right output format for B? Markdown design spec? JSON with structured fields? Decision records?
3. Should B include a visual vocabulary section — letting the agent describe layout in structured prose (grid, card, list, etc.) as a partial substitute for visual mockups?
4. Is there a third workflow worth building: a **Design System Audit** that checks whether a proposed design is consistent with an existing component library?
