# Design Candidates: Session Tree View in Console

*Discovery session: 2026-04-18*

---

## Problem Understanding

### Core Tensions

1. **Flat API vs tree UI**: `/api/v2/sessions` returns a flat array. The UI wants a tree grouped by parent-child relationships. Options: build tree client-side from parentSessionId index, or change the API. The existing repo pattern (flat projection DTOs, pure use-case functions) favors building the tree client-side.

2. **Orphaned children vs tree integrity**: If a parent session is older than MAX_SESSIONS_TO_LOAD=500, its children have a dangling parentSessionId. Showing orphaned children as roots is the only safe fallback, but the tree is incomplete. Acceptable for MVP.

3. **Filtering with tree structure**: When filtering by status or search, should the parent appear if only a child matches? Naive filtering breaks the tree. Better approach: include parent when any child matches. Adds complexity to filterSessions().

4. **Type mirror sync**: ConsoleSessionSummary is duplicated between `src/v2/usecases/console-types.ts` (server) and `console/src/api/types.ts` (client mirror). Both must be updated in sync. This is an existing technical debt, not new -- adding parentSessionId just adds one more field to keep in sync.

### Likely Seam

The seam is between the flat sessions array and the tree render. The right place is a new pure function `buildSessionTree(sessions)` in `session-list-use-cases.ts`, not a new HTTP endpoint and not a modification to the GROUP_AXES grouping infrastructure.

### What Makes This Hard

The existing GROUP_AXES abstraction in `session-list-use-cases.ts` is flat -- each group has a string label. Tree grouping requires a fundamentally different rendering shape: a clickable coordinator SessionCard as the group header, with indented children below. Shoehorning tree rendering into GROUP_AXES produces an illegal state (coordinator appears as both a plain-text header label AND a card inside the group).

The filter-with-tree interaction is the hardest sub-problem: when tree mode is active, a filter that excludes the parent but matches a child must still show the parent as context.

---

## Philosophy Constraints

From CLAUDE.md and repo patterns:

- **Immutability by default**: all new types use readonly fields
- **Pure functions in use-cases**: business logic in `session-list-use-cases.ts`, not in React components
- **Make illegal states unrepresentable**: coordinator session must not appear twice (as header AND as card)
- **Errors are data**: orphaned children (parent not in loaded set) should degrade gracefully to root-level display, never throw
- **YAGNI**: 2-level tree only for MVP; no recursive structure needed
- **Compose with small pure functions**: `buildSessionTree()` should be pure and independently testable
- **Validate at boundaries**: `extractParentSessionId()` happens in console-service.ts (the projection boundary); frontend trusts the value

**No philosophy conflicts found.** CLAUDE.md principles and repo patterns are consistent for this problem.

---

## Impact Surface

If `ConsoleSessionSummary` gains a `parentSessionId` field:
- `src/v2/usecases/console-types.ts` -- server type definition
- `console/src/api/types.ts` -- client type mirror (must stay in sync manually)
- `projectSessionSummary()` in `console-service.ts` -- new field returned in the projection
- `filterSessions()` in `session-list-use-cases.ts` -- needs parentIndex for tree-mode filtering
- `SessionList.tsx` -- new tree rendering path
- Any future codegen for the type mirror would pick this up automatically

Existing consumers of the flat `/api/v2/sessions` endpoint are unaffected -- the new field is additive and optional for root sessions.

---

## Candidates

### Candidate A -- Minimal: add parentSessionId, reuse GROUP_AXES with a 'tree' option

**Summary:** Add `parentSessionId` to both type files. Add a 'tree' option to GROUP_AXES that groups children under their parent's sessionId as the group key. The existing SessionGroup component shows the parent sessionId as the group label; children are SessionCards inside.

**Tensions resolved:** API stability (flat array unchanged). Type sync (one field added to both).

**Tensions accepted:** GROUP_AXES abstraction is abused. SessionGroup renders a plain-text label (the parent sessionId string), not a clickable coordinator SessionCard.

**Boundary solved at:** Frontend GROUP_AXES layer only.

**Why that boundary:** Minimum viable change -- no new components, no new functions.

**Failure mode:** Coordinator session appears BOTH as the group label text AND as a SessionCard inside the group (it's in the flat list). The group header is a non-navigable string, not a card. This is an illegal state: the coordinator is visible twice in different forms. Fixing this requires adding a custom node-renderer to SessionGroup -- at which point you've rebuilt Candidate B anyway.

**Repo pattern:** Abuses GROUP_AXES -- designed for grouping by string key, not parent-child hierarchies.

**Gains:** Zero new components. Minimal diff.

**Losses:** Visual quality. Coordinator not navigable from group header. No tree connector lines. Duplication bug.

**Scope:** Too narrow -- doesn't deliver the tree view quality described in the backlog.

**Philosophy:** YAGNI honored. Make illegal states unrepresentable violated (coordinator appears twice).

---

### Candidate B -- Best-fit: new buildSessionTree() + dedicated SessionTreeView component

**Summary:** Add `parentSessionId: string | null` to `ConsoleSessionSummary` on server and client. Implement `extractParentSessionId(events)` in `console-service.ts` (O(1), session_created is always eventIndex=0). Add a new pure function to `session-list-use-cases.ts`:

```typescript
interface SessionTreeNode {
  readonly session: ConsoleSessionSummary;
  readonly children: readonly ConsoleSessionSummary[];
}

interface SessionTree {
  readonly roots: readonly SessionTreeNode[];
  readonly orphanChildIds: ReadonlySet<string>;
}

function buildSessionTree(sessions: readonly ConsoleSessionSummary[]): SessionTree
```

Add a view mode toggle (tree/flat) to `SessionListState`. When tree mode is active, render a new `SessionTreeView` component: coordinator cards at root level, children indented 20px with a CSS `border-left` connector line on the wrapper div. Orphans (parent not loaded) appear as roots.

Modify `filterSessions()` to accept an optional `parentIndex: ReadonlyMap<string, string>` parameter. When tree mode is active: if a child matches the filter, include its parent too (parent appears even if it doesn't match the filter text/status).

**Tensions resolved:** API stability. Tree rendering quality (no duplication). Orphan handling (explicit orphanChildIds set). Filter+tree interaction (parent included when child matches).

**Tensions accepted:** Type mirror sync remains manual.

**Boundary solved at:** Frontend use-cases layer (`buildSessionTree()` is pure) + new presenter component.

**Why that boundary:** `buildSessionTree()` is pure and testable without React. The tree is computed once per render cycle, not per-card. Follows the exact same pattern as the existing pure functions in `session-list-use-cases.ts`.

**Failure mode:** Filter-with-tree is the hardest case. The `filterSessions()` modification adds complexity. If the logic is wrong, the parent could be shown when it shouldn't (e.g., filter=complete, parent is in_progress, child is complete -- should the in_progress parent appear?). Decision: include parent when any child matches, regardless of parent's own status. This is the most useful behavior for the tree view use case.

**Repo pattern:** Follows the pure use-cases + presenter pattern exactly. New SessionTreeView component follows the same presenter shape as existing components.

**Gains:** Clean tree rendering with visual connectors. Navigable coordinator cards. No duplication. Pure testable logic. Degrades gracefully for orphaned children.

**Losses:** Slightly more code than Candidate A. Two components for the same view (flat list + tree view).

**Scope:** Best-fit -- delivers the design described in the backlog without overbuilding.

**Philosophy:** All principles honored. Immutability, explicit domain types, pure functions, YAGNI (2-level tree only).

---

### Candidate C -- Server-side tree: new `GET /api/v2/sessions/tree` endpoint

**Summary:** Add a new server endpoint that returns `{ roots: ConsoleSessionSummaryWithChildren[], orphans: ConsoleSessionSummary[] }`. The flat `/api/v2/sessions` endpoint is unchanged. Server builds the tree from the loaded session set, embedding children under their parent in the response.

**Tensions resolved:** Tree structure computed at the source of truth (server, with access to the full 500-session window). Client receives a ready-to-render tree.

**Tensions accepted:** New endpoint means new React Query hook, new cache key, new loading state. Two overlapping endpoints that must be kept consistent.

**Boundary solved at:** Server projection layer (`console-service.ts`).

**Why that boundary:** Server has the full session set in scope; client doesn't need to rebuild the tree from a flat list.

**Failure mode:** API surface grows. The flat endpoint and tree endpoint must stay consistent. Cache invalidation logic must be updated for both. If the tree endpoint is slow (500 sessions), the flat endpoint is still fast -- users may not understand why.

**Repo pattern:** Departs from the existing pattern (all console endpoints return flat projection DTOs). Adds server complexity for a problem that client-side pure functions can solve with zero HTTP overhead.

**Gains:** Tree is always consistent (parent and children computed together). Client rendering is simpler -- just map the tree response.

**Losses:** API surface growth. Additional React Query hook. More complex cache invalidation. Server-side complexity for a problem solvable client-side.

**Scope:** Too broad -- the flat list already contains all the data needed to build the tree client-side.

**Philosophy:** Conflicts with YAGNI (new endpoint not needed). Conflicts with validate-at-boundaries (boundary moved to server when client can handle it).

---

## Comparison and Recommendation

| Tension | A | B | C |
|---|---|---|---|
| API stability | Resolves | Resolves | Adds new endpoint |
| Tree rendering quality | Fails (duplication) | Resolves | Resolves |
| Orphan handling | None | Explicit | Server-side |
| Filter+tree interaction | Broken | Manageable | Handled server-side |
| Repo pattern fit | Abuses GROUP_AXES | Follows pure-function pattern | Departs from flat-DTO pattern |
| Reversibility | Easy | Easy | Medium |
| Philosophy fit | Partial | Full | Partial |

**Recommendation: Candidate B.**

B resolves all real tensions without overbuilding. It follows the existing pure-function/presenter split the repo already practices. `buildSessionTree()` is pure and testable independently of React. The filter-with-tree interaction is manageable with a contained change to `filterSessions()`. The 2-level tree constraint matches the backlog's examples exactly.

---

## Self-Critique

**Strongest argument against B:** What if the Phase 2 UX design requires 3-level trees (coordinator → child coordinator → grandchild)? B explicitly excludes this by using `readonly children: readonly ConsoleSessionSummary[]` instead of `readonly children: readonly SessionTreeNode[]`. Changing to recursive SessionTreeNode later is a contained change, but it would require updating the SessionTreeView component too.

**Pivot conditions:**
- If Phase 2 UX requires >2 levels: change `SessionTreeNode.children` to `readonly SessionTreeNode[]` and make `SessionTreeView` recursive. The `buildSessionTree()` function would need to become recursive as well.
- If filter+tree interaction proves too complex: ship tree view without filter support in tree mode, show a "tree view disabled while filtered" state.
- If the type mirror sync problem grows: introduce codegen for the type mirror (separate from this feature).

**Assumption that would invalidate B:** If the flat `/api/v2/sessions` endpoint doesn't return all sessions needed to build a complete tree (e.g., if sessions are paginated server-side before reaching the client). Currently MAX_SESSIONS_TO_LOAD=500 applies before the response; if a coordinator and its children are all within the 500-session window, the tree will be complete. If the coordinator is old but children are recent, the tree will be incomplete -- but this degrades gracefully (children show as roots).

---

## Open Questions for the Main Agent

1. **Filter behavior in tree mode**: When filtering by status=in_progress and the coordinator is complete but has an in_progress child -- should the coordinator appear? Proposed: yes, include parent when any child matches. Is this the right UX?

2. **Tree mode default or opt-in**: Should the tree view be the default mode, or should users opt in via a toggle? Given that zero sessions have parentSessionId today, defaulting to tree view would show an identical flat list -- tree mode only activates when coordinator sessions exist.

3. **Connector line style**: Simple `border-left` CSS on the indented container, or tree-line SVG connectors like `TreeLine.tsx` (which already exists in `console/src/components/TreeLine.tsx`)? The existing component should be used if it fits.
