# Plan Analysis: WorkflowsView for WorkRail Console

## Scope of Analysis

Frontend-only feature addition (4 slices) to an existing React/Vite SPA. Backend APIs are already implemented and live. Analysis covers:
- S1: Type definitions and query hooks
- S2: CSS variable additions
- S3: WorkflowsView + WorkflowDetail components
- S4: App.tsx navigation refactor (useUrlNav hook + tab bar)

## Checks to Run

### Completeness
- [ ] Do the frontend types in S1 exactly match what the backend actually emits?
- [ ] Are all backend fields surfaced in the frontend types (no silent drops)?
- [ ] Does S4 account for the existing `selectedSessionId` state and SessionDetail navigation?
- [ ] Is there a back-end type definition file (`console-types.ts`) that also needs updating?
- [ ] Does the plan handle the `workflowService` optional guard (API may return 404)?

### Pattern Consistency
- [ ] Does `useWorkflowList()` follow the same query options pattern as `useSessionList()` / `useWorktreeList()`?
- [ ] Does `useWorkflowDetail(id)` follow the `enabled: !!id` pattern like `useNodeDetail()`?
- [ ] Does the CSS-hidden mount pattern for WorkflowsView follow WorkspaceView's `hidden` prop contract?
- [ ] Is the `role=tablist` tab bar consistent with how WorkspaceView currently handles header navigation?

### Regression Risks
- [ ] Does adding a tab bar to App.tsx break the existing SessionDetail back-navigation flow?
- [ ] Does `useUrlNav()` conflict with the existing `useState` navigation (selectedSessionId)?
- [ ] Does `WorkspaceView` still receive and handle `hidden` correctly after App.tsx restructure?
- [ ] Does the CSS change to `--text-muted` affect any existing components that rely on `#666666`?

### Slice Boundary Quality
- [ ] Can S2 (CSS) be done independently or does it block S3?
- [ ] Does S1 need to be complete before S3 can start (type dependencies)?
- [ ] Does S4 have any circular dependency with S3 (WorkflowsView imported before defined)?

## Key Questions

1. **Type drift**: The backend `console-routes.ts` emits `{ id, name, description, version, tags, source, about?, examples? }` from `/api/v2/workflows` and adds `stepCount`, `preconditions?` from `/api/v2/workflows/:id`. Do S1's `ConsoleWorkflowSummary` and `ConsoleWorkflowDetail` match these shapes exactly?

2. **Tag pill count**: Plan says "All + 8 category pills, routines excluded". `workflow-tags.json` has 9 non-hidden tags: coding, review_audit, investigation, design, documentation, tickets, learning, routines, authoring. Excluding routines = 8. But is `authoring` included? It has only 1 workflow (`workflow-for-workflows`). Plan should specify which 8.

3. **URL nav without router**: `useUrlNav()` reading `?tab=workflows&wf=id&tag=coding` -- how does this interact with the existing `selectedSessionId` state? SessionDetail is currently reached via `onClick`, not URL. Does `?tab=` coexist with session-detail navigation, or does S4 propose replacing all navigation with URL state?

4. **Backend console-types.ts**: The frontend `types.ts` is described as "Mirror of console-types.ts from the backend". If S1 adds workflow types to `console/src/api/types.ts`, should `src/v2/usecases/console-types.ts` (backend) also be updated for parity? Plan doesn't mention this.

5. **Polling strategy for workflow list**: Workflows are static (no session-driven changes). Should `useWorkflowList()` poll at all? `useSessionList()` polls every 30s because sessions change frequently. Workflow definitions don't change -- `staleTime: Infinity` or no `refetchInterval` is more appropriate.

6. **WorkflowDetail "optimistic partial render"**: The backend already returns the full detail in one call. What does "optimistic partial render" mean in this context? Is the plan referring to showing list-level data while the detail fetch is in-flight, or something else?

## Pattern Reference List

- `console/src/api/hooks.ts` -- query options patterns for reference
- `console/src/api/types.ts` -- existing type mirror pattern
- `src/v2/usecases/console-types.ts` -- backend source of truth for types
- `src/v2/usecases/console-routes.ts` -- actual backend API response shapes
- `spec/workflow-tags.json` -- canonical tag list (9 tags total, 3 hidden workflows)
- `console/src/views/WorkspaceView.tsx` -- CSS-hidden mount pattern, `hidden` prop
- `console/src/App.tsx` -- current navigation state model (useState only)
- `console/src/index.css` -- current CSS variables

## Risk Focus Areas

1. **S4 regression risk (HIGH)**: App.tsx restructure touches ALL existing navigation. Any mistake breaks SessionDetail.
2. **S1 type completeness (MEDIUM)**: Missing fields silently render as undefined in the UI.
3. **URL state without router (MEDIUM)**: No TanStack Router (explicitly a non-goal) -- manual URL manipulation is error-prone.
4. **Tag pill "8" assumption (LOW)**: Count discrepancy if authoring is misclassified.
5. **Polling for static data (LOW)**: Unnecessary network traffic if workflow hooks copy session poll intervals.

---

## Findings Report

### Executive Summary

The plan is structurally sound for S1-S3 and can ship as written. **S4 has an underspecified interaction gap** that will block correct implementation. One finding (F2) reveals `--bg-tertiary` is already broken in production -- S2 is fixing a live bug, not just adding a new variable. Overall verdict: **Revise S4 spec before implementation; S1-S3 are ready to start in parallel.**

---

### F1 -- Orange: S4 navigation contract is underspecified -- interaction between `useUrlNav()` and `selectedSessionId` undefined

**Severity:** Orange

**Location:** S4 -- `useUrlNav()` hook, App.tsx render tree description

**Problem:**
The current App.tsx uses `selectedSessionId: string | null` (React state) as the sole navigation signal. SessionDetail is rendered when this is non-null. The plan introduces `useUrlNav()` reading `?tab=`, `?wf=`, and `?tag=` from the URL, but does not specify:
1. Whether `selectedSessionId` is replaced by URL state or kept alongside it
2. What the header looks like when `selectedSessionId !== null` (back-button row) AND `?tab=workflows` is active
3. Whether clicking a session row (which currently calls `setSelectedSessionId`) also writes to `?tab=workspace&session=id` in the URL, or leaves URL unchanged

Without this contract, an implementer will make incompatible assumptions. The most likely failure: the tab bar renders while SessionDetail is active (because `?tab=` is in the URL), causing two navigation paradigms to collide in the header.

**Recommendation:**
Add to S4 spec: explicit statement of which navigation state owns what. Simplest correct option: `selectedSessionId` stays as React state (not in URL); `useUrlNav` manages only `?tab=`, `?wf=`, and `?tag=`; the header shows back-button when `selectedSessionId !== null` (overrides tab bar), tab bar otherwise.

---

### F2 -- Orange: `--bg-tertiary` is already referenced in production code but undefined in `index.css` -- S2 fixes a live bug

**Severity:** Orange

**Location:** `console/src/index.css` (S2 target), `console/src/views/WorkspaceView.tsx` lines 769 and 797, `console/src/views/WorktreeList.tsx` line 300

**Problem:**
Three existing components already use `var(--bg-tertiary)`. The variable is not defined in `index.css`. As a result:
- `WorkspaceView` scope toggle active-state button has no background (invisible active indicator)
- `WorkspaceView` skeleton loading badge has no background
- `WorktreeList` inline code element has no background

The plan describes S2 as "add `--bg-tertiary`" as if it's a new variable, but it is actually fixing a silent visual defect already shipping. This means S2 should be treated as a **bug fix** with higher urgency than the plan implies -- the scope toggle active state has been broken since `--bg-tertiary` was first referenced.

**Recommendation:**
Prioritize S2 (CSS) as a standalone bug fix, independent of the WorkflowsView feature. Consider landing it on its own commit before S3 work begins. The plan's value `#222222` for `--bg-tertiary` is reasonable for the dark theme.

---

### F3 -- Orange: S1 frontend types do not specify the `source` field shape -- type safety lost for source-based display

**Severity:** Orange

**Location:** S1 -- `ConsoleWorkflowSummary`, `ConsoleWorkflowDetail` in `console/src/api/types.ts`

**Problem:**
The backend workflow endpoints emit `source: WorkflowSourceInfo` where `WorkflowSourceInfo = { kind: 'bundled' | 'user' | 'project' | 'custom' | 'git' | 'remote' | 'plugin', displayName: string }`. The plan names the types to add but does not specify the `source` field's shape. If an implementer types it as `object` or `Record<string, string>`, WorkflowDetail and card components cannot use `source.kind` as a discriminant to show "Bundled" vs "User" vs "Custom" source badges without a cast.

This violates the codebase principle "make illegal states unrepresentable" -- the `kind` discriminant should be typed as a string union, not as a plain `string`.

**Recommendation:**
Add to S1: `ConsoleWorkflowSourceInfo` as `{ readonly kind: 'bundled' | 'user' | 'project' | 'custom' | 'git' | 'remote' | 'plugin'; readonly displayName: string }` (mirroring `WorkflowSourceInfo` from `src/types/workflow.ts`). Reference the backend type in a comment as the canonical source. Also add this to `src/v2/usecases/console-types.ts` for parity with the existing mirror pattern.

---

### F4 -- Yellow: `useWorkflowList()` polling strategy unspecified -- risk of inheriting 30s session poll interval

**Severity:** Yellow

**Location:** S1 -- `useWorkflowList()` in `console/src/api/hooks.ts`

**Problem:**
All existing list hooks (`useSessionList`, `useWorktreeList`) set `refetchInterval: 30_000` because sessions and worktrees change frequently during a workflow run. Workflow definitions are static at server startup -- they don't change while the server is running. The plan does not specify `refetchInterval` or `staleTime` for `useWorkflowList()`. An implementer using an existing hook as a template will copy the 30s poll, causing unnecessary network traffic that never returns new data.

**Recommendation:**
Add to S1: `useWorkflowList()` should set `staleTime: Infinity` (or at minimum 10 minutes) and no `refetchInterval`. A single cache-hit query per session is sufficient. Add a comment explaining why: "Workflow definitions are static -- no polling needed."

---

### F5 -- Yellow: "Optimistic partial render" in S3/WorkflowDetail is ambiguous given the backend returns full data in one call

**Severity:** Yellow

**Location:** S3 -- WorkflowDetail component description, "optimistic partial render"

**Problem:**
The plan says WorkflowDetail should do "optimistic partial render." The backend `/api/v2/workflows/:workflowId` already returns the complete detail payload (id, name, description, tags, source, stepCount, about, examples, preconditions) in a single response. There is no partial/incremental delivery. The phrase "optimistic partial render" suggests showing list-level data (from `useWorkflowList` cache) while the detail fetch is in-flight -- but this is not stated explicitly.

If the implementer interprets this as needing a streaming or skeleton-first approach that doesn't match the backend contract, they'll over-engineer the loading state.

**Recommendation:**
Clarify in S3: WorkflowDetail shows data from `useWorkflowList` cache (id, name, description, tags) as an immediate render while `useWorkflowDetail(id)` fetches (for stepCount, full about, examples, preconditions). This is the correct "optimistic" interpretation. The list hook result for the matching id should be passed as an initial prop to WorkflowDetail.

---

### F6 -- Yellow: Backend `console-types.ts` not updated -- breaks the "mirror" documentation convention

**Severity:** Yellow

**Location:** S1 -- `src/v2/usecases/console-types.ts` (omitted from plan scope)

**Problem:**
The frontend `console/src/api/types.ts` header reads: "Mirror of console-types.ts from the backend (Console DTOs)." Adding `ConsoleWorkflowSummary`, `ConsoleWorkflowListResponse`, and `ConsoleWorkflowDetail` only to the frontend file breaks this mirror convention. The backend `console-types.ts` is the canonical source; the frontend file is supposed to be kept in sync.

This is a documentation/maintenance issue rather than a functional bug (the backend types are defined implicitly in `console-routes.ts`), but it will confuse future contributors who look at `console-types.ts` and expect to see all Console DTOs.

**Recommendation:**
Add to S1: also add the three new workflow types to `src/v2/usecases/console-types.ts`. This keeps the mirror promise intact. The types belong there structurally -- they are DTOs returned by the Console API.

---

### Verdict: Revise

S1, S2, and S3 are ready to start. S4 requires a spec revision before implementation to define the navigation state ownership contract between `useUrlNav()` and the existing `selectedSessionId` state. F2 (the `--bg-tertiary` bug) should be treated as an urgent independent fix.
