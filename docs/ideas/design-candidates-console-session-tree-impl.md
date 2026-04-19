# Design Candidates: Console Session Tree Implementation (Phase 3)

*2026-04-18 -- This document covers only the remaining Slice 5 (SessionTreeView UI component)*
*Phase 1 and Phase 2 artifacts: see design-candidates-session-tree-view.md and design-review-findings-session-tree-view.md*

## Problem Understanding

Slices 1-4 are implemented. The remaining work is Slice 5: add a SessionTreeView rendering path to SessionList.tsx.

**Tensions:**
- Expand toggle vs card navigation: two click targets on the same logical row. Resolved by a flex row with separate button elements.
- Per-coordinator expand state vs pure component: expand state lives in useState (UI state, not business logic -- correct placement).
- Auto-expand for in_progress: requires checking status in state initialization.

**Likely seam:** SessionList.tsx (presenter) + session-list-use-cases.ts (pure function buildSessionTree, already built).

**What makes it hard:** The expand toggle must be keyboard-navigable separately from the card AND must not trigger card navigation on click.

## Philosophy Constraints

- Pure presenter: no business logic in the component
- Immutability: expand state is a ReadonlyMap or regular Map in useState
- Functional/declarative: map SessionTreeNode[] to JSX
- Compose with small functions: SessionTreeView as a named function, separate from SessionList

## Impact Surface

- SessionList.tsx: adding viewMode branch
- session-list-use-cases.ts: already has buildSessionTree exported
- session-list-reducer.ts: already has viewMode + view_mode_changed

## Candidates

### Candidate A: SessionTreeView inline in SessionList.tsx (only candidate)

**Summary:** A `SessionTreeView` function component in SessionList.tsx takes `SessionTreeNode[]`, initializes expand state as `Map<string, boolean>` (auto-expand in_progress), and renders a flex row with [expand-toggle, coordinator-card] and children in a TreeLine wrapper below when expanded.

**Tensions resolved:** Expand/navigate separation (separate button elements). Accepts: expand state resets on navigation (transient UI state is acceptable).

**Boundary:** SessionList.tsx presenter layer.

**Failure mode:** Expand toggle accidentally triggers card navigation. Fixed by: expand toggle button is outside the coordinator ConsoleCard, not nested inside it.

**Repo pattern:** Follows SessionGroup component pattern in SessionList.tsx exactly.

**Gains:** Simple, pure, testable in isolation. **Loses:** Expand state resets when navigating away (transient).

**Scope:** Best-fit.

**Philosophy:** All principles honored.

## Comparison and Recommendation

Single candidate; no comparison needed. Candidate A is the correct approach.

## Self-Critique

Strongest counter-argument: expand state should be in the reducer (durable within page session). Counter-counter: expand state is UI state, not domain state. Reducer is for interaction state that needs to persist across renders (search, filter, sort, pagination). Expand state for individual coordinator rows is more like accordion state -- local useState is correct.

Pivot condition: if user feedback shows expand state loss is disruptive, move to reducer with `expanded_coordinators: ReadonlySet<string>` field.

## Open Questions for the Main Agent

None. Implementation is fully specified in docs/ideas/design-candidates-session-tree-view.md and the Phase 2 design spec.
