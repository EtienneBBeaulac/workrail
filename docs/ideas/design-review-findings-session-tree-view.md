# Design Review Findings: Session Tree View in Console

*Discovery session: 2026-04-18*

---

## Tradeoff Review

| Tradeoff | Violates Acceptance Criteria? | Conditions for Failure | Verdict |
|---|---|---|---|
| Manual type mirror sync | No -- TypeScript catches at build time | Developer forgets to update client mirror | Acceptable -- compiler enforces |
| Incomplete tree when parent outside 500-session window | No -- degrades to orphan-as-root | Coordinator runs many children over days | Acceptable for MVP |
| 2-level tree max | No -- engine depth limit aligns (maxSubagentDepth=2) | If maxSubagentDepth raised in config | Acceptable -- contained change to fix |
| Tree mode opt-in (not default) | No -- flat view is current default | Users never discover toggle | Acceptable -- can add auto-suggest later |

---

## Failure Mode Review

| Failure Mode | Handled? | Missing Mitigation | Risk |
|---|---|---|---|
| Cyclic parentSessionId (self-parent) | Partial | Explicit cycle guard in buildSessionTree(): `if (parentId === session.sessionId) treat as root` | Low -- easy to add, must add |
| Orphaned child (parent outside window) | Yes | Optional: 'child session' badge. Low priority. | Low |
| Filter shows no results in tree mode | Yes -- existing empty-state UI handles it | None needed | Low |
| Tree toggle state lost on navigation | Not handled | Persist in sessionStorage or URL param. Low priority. | Low |
| Client mirror type not updated | Yes -- TypeScript build fails | None needed | None at runtime |

---

## Runner-Up / Simpler Alternative Review

**Runner-up (C, server-side tree):** No elements worth borrowing. Client already has all 500 sessions; server-side computation adds API surface with no benefit.

**Simpler variant adopted:** Tree mode and filter mode are mutually exclusive for MVP. When tree mode is active, status/search filters are disabled (or auto-cleared). This eliminates the filter+tree parentIdIndex complexity from filterSessions() entirely. The more complex filter-aware tree can be added later when coordinator sessions are common enough to justify it.

---

## Philosophy Alignment

**Satisfied:** Immutability, make illegal states unrepresentable, compose with small pure functions, validate at boundaries, errors as data, YAGNI.

**Under tension (acceptable):**
- Functional/declarative: buildSessionTree() is imperative-style but pure. Same-input/same-output invariant holds.
- Type mirror sync: two copies of ConsoleSessionSummary can diverge, but TypeScript build catches this before runtime.

**No risky philosophy tensions.**

---

## Findings

### Red (must fix before implementation)

None.

### Orange (should fix before implementation)

**O1: Cycle guard missing in design**
buildSessionTree() must guard against `parentSessionId === session.sessionId`. Without this, a session appears both as a root and as its own child. Add explicitly to implementation.

### Yellow (low priority, note for future)

**Y1: Orphaned child has no visual indicator**
Children with a dangling parentSessionId (parent outside 500-session window) show as roots with no indication they're children. A small 'child session' badge would improve UX for multi-day coordinator runs. Not needed for MVP.

**Y2: Tree toggle state not persisted**
Navigating to session detail and back resets tree/flat mode. Could be persisted in sessionStorage or URL param. Not needed for MVP.

**Y3: Tree mode not auto-suggested when coordinator sessions exist**
Users may not discover the tree mode toggle. When any session has `parentSessionId != null`, show a subtle prompt or auto-activate tree mode. Not needed for MVP.

---

## Recommended Revisions

1. **Add cycle guard to buildSessionTree():** Before adding a session to a parent's children array, check `parentSessionId !== session.sessionId`. Treat self-parenting sessions as roots.

2. **Make filter mode and tree mode mutually exclusive:** When tree mode is activated, clear active filters (or disable the filter controls). When a filter is applied, tree mode is disabled. Show a clear UI state for this (e.g., "Filters disabled in tree view").

3. **Document 2-level max as explicit constant:** Define `TREE_MAX_DEPTH = 2` in session-list-use-cases.ts with a comment explaining the engine's maxSubagentDepth alignment.

---

## Residual Concerns

1. **Untestable in real UI until coordinator sessions are run.** Zero sessions have parentSessionId today. The implementation can be verified only via manual testing with artificially constructed session data or by running an actual spawn_agent workflow. Recommendation: add a simple unit test for buildSessionTree() with mock ConsoleSessionSummary objects in session-list-use-cases.test.ts (if the test file exists -- check before implementing).

2. **Filter+tree interaction deferred, not designed.** The current design explicitly excludes filtering while in tree mode. If a future sprint adds filter+tree, the parentIdIndex approach was analyzed and is the right path -- but it must be designed and tested carefully to avoid surprising UX (parent shown in 'complete' filter even though it's in_progress).
