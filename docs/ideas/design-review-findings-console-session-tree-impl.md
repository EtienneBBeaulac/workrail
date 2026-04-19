# Design Review Findings: Console Session Tree Implementation (Phase 3)

*2026-04-18 -- Covering Slice 5: SessionTreeView component*

---

## Tradeoff Review

| Tradeoff | Acceptable? | Condition for Failure | Notes |
|---|---|---|---|
| Transient expand state (resets on navigation) | Yes | Never -- no acceptance criterion requires persistence | Acceptable for MVP |
| Auto-expand only on initial render | Yes | User expects newly-in_progress coordinators to auto-expand during the page session | Known limitation, acceptable |
| Expand toggle outside ConsoleCard | Yes | Layout mismatch -- toggle disconnected from card visually | WorkspaceView.tsx proves the flex-row pattern works |

---

## Failure Mode Review

| Failure Mode | Handled? | Mitigation | Risk |
|---|---|---|---|
| Expand toggle triggers card navigation | Yes | Toggle is separate DOM button outside ConsoleCard | None |
| Coordinator with no children shows toggle | Yes | Hide toggle when children.length === 0 | None |
| cycle in parentSessionId | Yes | buildSessionTree() cycle guard | None |
| Newly in_progress coordinator won't auto-expand after initial render | Partial | Accepted for MVP; useState init only covers initial render | Low |
| TypeScript type errors | None expected | All types already defined in Slices 1-4 | None |

---

## Runner-Up / Simpler Alternative Review

**Simpler variant adopted:** Skip auto-expand entirely, or keep auto-expand for initial render only. Decision: keep auto-expand on initial render (simple useState initializer), accept that mid-session state changes won't auto-expand. Avoids useEffect/useMemo complexity.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Pure functions in use-cases | Satisfied -- buildSessionTree() is pure |
| Immutability | Satisfied -- readonly types throughout |
| Compose with small functions | Satisfied -- SessionTreeView is a named function |
| YAGNI | Satisfied -- auto-expand is minimal |
| Functional/declarative | Acceptable tension -- useState Map is mutable but correct for React UI state |

---

## Findings

### Red (must fix before implementation)

None.

### Orange (should address)

**O1: Expand toggle placement requires specific layout**
The expand toggle must be in a flex row with the coordinator card, but the coordinator card itself must not be a parent of the toggle (avoids nested interactive elements). The pattern from WorkspaceView.tsx is `<div className="flex items-start gap-2">` containing `[toggle button]` then `[coordinator card button]`.

### Yellow (advisory)

**Y1: Auto-expand fires only on initial render**
If a coordinator transitions to in_progress after the component first renders, it will not auto-expand. This is acceptable for MVP.

---

## Recommended Revisions

1. Use `flex items-start gap-2` wrapper row for [expand-toggle, coordinator-card] to avoid nested interactive elements.
2. Initialize expand state with `useState(() => new Map(roots.filter(...).map(n => [n.session.sessionId, true])))` -- function initializer to avoid re-running on re-renders.

---

## Residual Concerns

- Visual quality of the amber left border + [COORD] badge combination requires human visual review -- cannot be verified by TypeScript check.
- No real coordinator sessions exist locally, so end-to-end visual testing requires either manual mock data or running a spawn_agent workflow.
