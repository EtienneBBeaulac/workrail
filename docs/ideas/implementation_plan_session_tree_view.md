# Implementation Plan: Session Tree View in Console

*Created: 2026-04-18*

---

## Problem Statement

WorkRail creates a separate session for every workflow run. When spawn_agent is used, a coordinator session creates multiple child sessions. Today, all sessions appear as a flat list in the console -- there is no visual grouping that shows coordinator-child relationships. The `parentSessionId` field exists in the `session_created` event schema and is written by `makeSpawnAgentTool`, but it is not surfaced in `ConsoleSessionSummary` or rendered in the console UI.

---

## Acceptance Criteria

1. `ConsoleSessionSummary` includes a `parentSessionId: string | null` field. Root sessions have `null`; child sessions have the parent's session ID.
2. `/api/v2/sessions` response includes `parentSessionId` on each session summary.
3. The console SessionList includes a tree view mode toggle.
4. When tree view is active: coordinator sessions (sessions that have children) display their child sessions indented below them, separated by a `TreeLine` connector.
5. When tree view is active: filter controls are disabled with a clear UI indicator.
6. When tree view is active: sessions with no children display identically to the flat view.
7. Orphaned children (parent session not in the loaded 500-session set) display as root sessions in tree view.
8. `buildSessionTree()` handles the case where `parentSessionId === sessionId` (self-parent) by treating the session as a root.
9. TypeScript build passes with no new errors.

---

## Non-Goals

- No new HTTP endpoints (flat `/api/v2/sessions` is unchanged except for the new field).
- No multi-level (depth > 2) tree rendering for MVP.
- No filter+tree interaction for MVP (tree mode and filter mode are mutually exclusive).
- No pagination changes.
- No persistence of tree view toggle state.
- No automatic activation of tree mode.

---

## Philosophy-Driven Constraints

- **Immutability by default**: all new interfaces use `readonly`.
- **Pure functions in use-cases**: `buildSessionTree()` is a pure function with no side effects, in `session-list-use-cases.ts`. No business logic in React components.
- **Make illegal states unrepresentable**: coordinator session appears exactly once (as a root card). Cycle guard prevents self-parenting.
- **Explicit domain types**: `SessionTree` and `SessionTreeNode` are named interfaces, not anonymous objects.
- **YAGNI**: 2-level tree, mutually exclusive filter/tree modes, no new endpoints.
- **Errors as data**: `buildSessionTree()` returns an `orphanChildIds` set; never throws on missing parents.

---

## Invariants

1. `parentSessionId` is `null` for root sessions, a non-empty string for child sessions.
2. `buildSessionTree()` is a pure function: same input always produces the same output.
3. A session with `parentSessionId === sessionId` is treated as a root (cycle guard).
4. An orphaned child (parent not in the input sessions array) is included in `orphanChildIds` and rendered as a root.
5. The flat `/api/v2/sessions` endpoint response is backward-compatible: `parentSessionId` is a new additive field.
6. `console/src/api/types.ts` mirrors `src/v2/usecases/console-types.ts` for `ConsoleSessionSummary` -- both must be updated together.

---

## Selected Approach

**Candidate B: `buildSessionTree()` pure function + `SessionTreeView` presenter**

See `design-candidates-session-tree-view.md` for full analysis. Summary: add `parentSessionId` to the type chain (server + client mirror), extract it at the projection boundary in `console-service.ts`, build the tree client-side in a pure function, and render it in a new presenter component using the existing `TreeLine` connector component.

**Runner-up:** Candidate C (server-side tree endpoint) -- loses because the flat list already contains all data needed; a new endpoint adds API surface with no benefit.

---

## Vertical Slices

### Slice 1: Add `parentSessionId` to server-side types and projection

**Files changed:**
- `src/v2/usecases/console-types.ts` -- add `readonly parentSessionId: string | null` to `ConsoleSessionSummary`
- `src/v2/usecases/console-service.ts` -- add `extractParentSessionId(events)` function, include field in `projectSessionSummary()` return value

**Acceptance criterion:** `GET /api/v2/sessions` response includes `parentSessionId: null` on all existing sessions. TypeScript build passes.

**Pattern to follow:** `extractGitBranch(events)` / `extractRepoRoot(events)` in `console-service.ts` -- scan events for `session_created`, return `data.parentSessionId ?? null`.

**Risk:** Low. Additive field, backward-compatible.

---

### Slice 2: Update client-side type mirror

**Files changed:**
- `console/src/api/types.ts` -- add `readonly parentSessionId: string | null` to `ConsoleSessionSummary`

**Acceptance criterion:** TypeScript build of the console package passes. The new field is accessible in all React components that receive `ConsoleSessionSummary`.

**Risk:** None. Compile-time only.

---

### Slice 3: Add `buildSessionTree()` to session-list-use-cases

**Files changed:**
- `console/src/views/session-list-use-cases.ts` -- add `SessionTreeNode`, `SessionTree` interfaces and `buildSessionTree()` function

**Implementation:**
```typescript
export interface SessionTreeNode {
  readonly session: ConsoleSessionSummary;
  readonly children: readonly ConsoleSessionSummary[];
}

export interface SessionTree {
  readonly roots: readonly SessionTreeNode[];
  readonly orphanChildIds: ReadonlySet<string>;
}

export const TREE_MAX_DEPTH = 2; // aligns with engine's default maxSubagentDepth

export function buildSessionTree(sessions: readonly ConsoleSessionSummary[]): SessionTree {
  // Build parent -> children index
  // Cycle guard: skip if parentSessionId === sessionId
  // Orphan detection: if parent not in session set, add to orphanChildIds
  // Return roots (sessions with no parent, plus orphaned children as roots) with children attached
}
```

**Acceptance criterion:** Unit test in `console/src/views/session-list-use-cases.test.ts` (create if not exists) covers: empty input, all roots, parent-child pairs, cycle detection, orphaned children.

**Risk:** Low. Pure function, no I/O.

---

### Slice 4: Add tree view mode to SessionList state and reducer

**Files changed:**
- `console/src/views/session-list-reducer.ts` -- add `viewMode: 'flat' | 'tree'` to state; add `view_mode_changed` action; when `view_mode_changed` to `tree`, clear filters
- `console/src/hooks/useSessionListViewModel.ts` (or equivalent) -- expose `viewMode` and `dispatch` for tree toggle

**Acceptance criterion:** Toggling to tree mode clears active status filter and search. State transitions are deterministic. TypeScript build passes.

**Risk:** Low. Reducer is pure, state change is straightforward.

---

### Slice 5: Add `SessionTreeView` component and tree toggle UI

**Files changed:**
- `console/src/views/SessionList.tsx` -- add tree/flat mode toggle button; when `viewMode === 'tree'`, render `SessionTreeView` instead of the flat list; show "Filters disabled in tree view" when tree mode active and filters would normally show
- New component `SessionTreeView` (inline in `SessionList.tsx` or in a new file) -- renders `SessionTreeNode[]` with `TreeLine` wrappers for indented children

**Acceptance criterion:**
- Toggle button visible in toolbar
- Clicking toggle switches between tree and flat mode
- In tree mode: coordinator sessions show children indented below using `TreeLine`
- In tree mode: filter controls show a disabled state or a note
- In tree mode with no coordinator sessions: renders identically to flat mode (no indentation)
- `TreeLine` amber connector lines appear between coordinator card and child cards

**Risk:** Medium. No real coordinator sessions exist for manual testing. Must use mock data or construct a test scenario.

---

## Test Design

### Unit tests (`console/src/views/session-list-use-cases.test.ts`)

Add a new `describe('buildSessionTree')` block:
1. Empty input -> `{ roots: [], orphanChildIds: Set() }`
2. All root sessions (no parentSessionId) -> all in roots, no orphans
3. One coordinator with two children -> coordinator root with two children attached
4. Orphaned child (parent not in input) -> child in roots, parentId in orphanChildIds
5. Cycle detection (parentSessionId === sessionId) -> treated as root
6. Multiple coordinators with overlapping children (edge case -- shouldn't occur but test graceful handling)

### Build verification

- `npm run build` (or equivalent) in both workrail root and console package must pass with no new TypeScript errors.

### Manual verification

- Create a test session data fixture (mock two sessions with parent-child relationship) and verify tree rendering visually.
- Or: run a `spawn_agent` workflow in the daemon and observe the console.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cycle in parentSessionId causes infinite loop | Low | High | Cycle guard in buildSessionTree() (Slice 3) |
| Client mirror not updated with server type | Low | Low | TypeScript build fails immediately |
| No real coordinator sessions to test against | High | Medium | Unit tests cover the logic; manual test with mock data |
| Phase 2 UX design requires depth-3 trees | Low | Medium | Change `children: readonly ConsoleSessionSummary[]` to `readonly SessionTreeNode[]`; contained change |
| Tree mode breaks existing GROUP_AXES grouping | None | N/A | Tree mode is a separate view mode; GROUP_AXES unchanged |

---

## PR Packaging Strategy

**Single PR: `feat/console-session-tree`**

All 5 slices in one PR. Rationale:
- Slices 1-2 (type changes) are tiny and safe but useless without the rendering
- Slices 3-4 (logic) are testable independently but nothing to show
- Slice 5 (UI) depends on all prior slices
- The entire change is low-risk and additive -- no breaking changes
- A single PR is easier to review as a coherent feature

---

## Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| 1 (server type + extraction) | Validate at boundaries | Satisfied -- extraction at service boundary |
| 1 | Compose with small pure functions | Satisfied -- extractParentSessionId follows extractRepoRoot pattern |
| 1 | Immutability | Satisfied -- readonly field |
| 2 (client mirror) | Make illegal states unrepresentable | Tension -- manual sync; TypeScript catches divergence at build time |
| 3 (buildSessionTree) | Pure function composition | Satisfied |
| 3 | Errors as data | Satisfied -- orphanChildIds, no throws |
| 3 | Make illegal states unrepresentable | Satisfied -- cycle guard prevents self-parenting |
| 4 (reducer) | Determinism over cleverness | Satisfied -- pure reducer |
| 4 | Functional/declarative | Satisfied |
| 5 (UI) | Compose with small pure functions | Satisfied -- SessionTreeView is a pure presenter |
| 5 | YAGNI | Satisfied -- 2-level only, no filter+tree |

---

## Follow-Up Tickets

- **Visual indicator on orphaned child sessions** (Y1): Add a small 'child session' badge to sessions in `orphanChildIds`. Low priority.
- **Persist tree toggle state** (Y2): Save to sessionStorage or URL param. Low priority.
- **Auto-suggest tree mode when coordinator sessions exist** (Y3): Detect `parentSessionId != null` in session list; show a subtle prompt. Low priority.
- **Filter+tree interaction** (design exists): Add `parentIdIndex` to `filterSessions()` so tree mode and filter mode are compatible. Design is documented in `design-candidates-session-tree-view.md`.

---

## Plan Confidence

- `unresolvedUnknownCount`: 1 (no real coordinator sessions to validate tree rendering end-to-end -- mitigated by unit tests)
- `planConfidenceBand`: High
