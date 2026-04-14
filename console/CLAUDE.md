# Console Architecture Guide

The WorkRail Console uses a strict MVI (Model-View-Intent) architecture adapted for React/TypeScript. Every view follows this layering. Do not introduce new views without following it.

---

## Layer Stack (bottom to top)

```
API hooks (React Query)
    ↓
Repository hook          useXxxRepository.ts       console/src/hooks/
    ↓
Use cases                xxx-use-cases.ts           console/src/views/
    ↓
Reducer                  xxx-reducer.ts             console/src/views/
    ↓
ViewModel hook           useXxxViewModel.ts         console/src/hooks/
    ↓
View (pure presenter)    XxxView.tsx                console/src/views/
```

---

## Layer Rules

### Repository hook (`useXxxRepository.ts`)
- Wraps React Query hooks. Returns a clean domain interface -- no React Query types leak out.
- Use `query.isLoading` (not `isFetching`) to avoid SSE-triggered loading flicker.
- Maps API errors to typed domain errors at this boundary.
- Filters data at the boundary (e.g. strip `routines` from workflow list here, not in the view).

### Use cases (`xxx-use-cases.ts`)
- Pure functions only. Zero React imports. No side effects.
- Contains: filtering, sorting, grouping, aggregation, derived calculations.
- **Add this file when** logic is complex enough to test independently (more than one line).
- **Skip this file when** all derivations are trivial (one-line `find`, `filter`, `map`).

### Reducer (`xxx-reducer.ts`)
- Pure function: `reducer(state, event) -> state`. Zero React imports.
- State and events are TypeScript discriminated unions (`readonly` everywhere).
- Always end the `switch` with `default: return assertNever(event)` for exhaustiveness.
- **Add this file when** there are 2+ interdependent state fields with non-trivial transition rules.
- **Skip this file when** there is only one state field (use `useState` in the ViewModel instead).
- Key invariant examples: scope change resets focusedIndex; tag/source change clears selectedWorkflowId; any filter change resets page to 0.

### ViewModel hook (`useXxxViewModel.ts`)
- The only place that calls React hooks AND mixes data concerns.
- Calls the repository, wires `useReducer` (or `useState` for simple cases), calls use cases in `useMemo`.
- Owns all side effects: keyboard listeners, focus management, scroll lock, body scroll.
- Returns a `XxxViewState` **discriminated union**: `loading | error | ready` (and other states as needed).
- Never returns `{ data: X | null; isLoading: boolean }` -- use a discriminated union instead.
- Destructure individual stable values from the repository before using them as `useMemo` deps (the repository object itself is a new literal every render).
- **Multi-repository ViewModels are valid**: a ViewModel may call multiple repositories when it needs to join data from two sources. Reference: `useWorkflowDetailViewModel` calls both `useWorkflowDetailRepository` (current workflow) and `useWorkflowsRepository` (adjacent workflow list for prev/next navigation).
- **ViewModel hooks are not unit tested** under the current strategy -- only pure functions (reducers, use cases) have tests. ViewModel behavior is covered indirectly through integration. A future investment would be `@testing-library/react` `renderHook` tests for state transitions.

### View (`XxxView.tsx`)
- Pure presenter. Receives `{ viewModel: UseXxxViewModelResult }` as its only data prop.
- Zero API hooks. Zero `useQuery`/`useMutation`. Zero business logic.
- May call animation hooks (`useModalTransition`, `useAutoAnimate`) -- these are pure visual effects, not data.
- May hold DOM refs (scroll container, panel ref for focus target) -- these are UI concerns.
- Renders based on `viewModel.state.kind` discriminated union. Every `kind` must be handled.
- **Inline sub-panel exception**: when a view renders a named sub-panel that is not a separate route (e.g. the archive panel in `WorkspaceView`, the workflow detail modal in `WorkflowsView`), the sub-panel's ViewModel may be called inside the parent view rather than AppShell. The parent view is the correct scoping boundary because the ViewModel lifetime should match the sub-panel's visibility. This is NOT a violation of the pure-presenter rule -- it is a documented exception for co-located sub-panels.

---

## Decision Criteria

| Question | Answer → Action |
|----------|----------------|
| Does the view fetch data? | Yes → add repository hook |
| Is there filtering/sorting/grouping logic? | Yes and non-trivial → add use cases file |
| Are there 2+ state fields with rules between them? | Yes → add reducer |
| Is there only one state field (a toggle or nullable)? | Yes → use `useState` in ViewModel, skip reducer |
| Are there pure functions (use cases or reducer)? | Yes → add tests in `tests/unit/console-*.test.ts` |

---

## Reference Implementations

When building a new view, read these first:

| Layer | Reference file |
|-------|---------------|
| Repository | `console/src/hooks/useWorkspaceRepository.ts` |
| Use cases | `console/src/views/workspace-types.ts` |
| Reducer | `console/src/views/workspace-reducer.ts` |
| ViewModel (complex) | `console/src/hooks/useWorkspaceViewModel.ts` |
| ViewModel (simple, no reducer) | `console/src/hooks/useSessionDetailViewModel.ts` |
| View | `console/src/views/WorkspaceView.tsx` |
| Tests | `tests/unit/console-workspace-reducer.test.ts` |

---

## File Naming

| Layer | Pattern | Location |
|-------|---------|----------|
| Repository | `use{Name}Repository.ts` | `console/src/hooks/` |
| Use cases | `{name}-use-cases.ts` | `console/src/views/` |
| Reducer | `{name}-reducer.ts` | `console/src/views/` |
| ViewModel | `use{Name}ViewModel.ts` | `console/src/hooks/` |
| Pure function tests | `console-{name}-reducer.test.ts` / `console-{name}-use-cases.test.ts` | `tests/unit/` |
| ViewModel hook tests | `use{Name}ViewModel.test.tsx` | `console/src/hooks/__tests__/` |

**Two test locations:**
- **Pure function tests** (reducers, use cases) -- no React, run in the root `tests/unit/` directory via `npm run test:unit` from the repo root.
- **ViewModel hook tests** -- require jsdom + React, live in `console/src/hooks/__tests__/`, run via `cd console && npx vitest run`. Uses `@testing-library/react` `renderHook` with `vi.mock` for repository boundaries.

---

## Common Mistakes to Avoid

- **Calling API hooks in views** -- all data flows through the ViewModel.
- **`data: X | null` + `isLoading: boolean`** -- use a discriminated union instead.
- **`repo` object as `useMemo` dep** -- the repository returns a new object literal every render. Destructure the individual fields you need as deps.
- **Side effects in reducers** -- reducers are pure. Navigation, fetch calls, focus management go in the ViewModel.
- **`refetch_requested` as a reducer event** -- side effects are not events. Call the side effect directly (e.g. `onRefetch()`) instead of routing through the reducer.
- **Tests co-located with source** -- all tests go in `tests/unit/console-*.test.ts`.
- **Reducer for a single boolean/nullable** -- `useState` is correct for one field.
