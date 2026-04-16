# Implementation Plan: WorkRail Auto Task Input MVP

Generated 2026-04-14.

---

## Problem Statement

WorkRail needs an "Auto" feature that lets users dispatch autonomous workflow runs from the console UI and via triggers. This requires: (1) schema extensions to `TriggerDefinition` for goal templates, reference URLs, model config, and completion hooks; (2) two new API endpoints for dispatching runs and listing triggers; (3) a new AUTO tab in the console with dispatch and queue panes.

---

## Acceptance Criteria

1. `TriggerDefinition` in `types.ts` has `goalTemplate?`, `referenceUrls?`, `agentConfig?`, `onComplete?` fields -- all `readonly`, all optional.
2. YAML parser in `trigger-store.ts` parses `agentConfig.model` (scalar), `referenceUrls` (space-separated scalar), `onComplete.runOn/workflowId/goal` (sub-object). Emits `[TriggerStore] UNSUPPORTED: onComplete.runOn='failure'` warning (and 'always') at load time.
3. `interpolateGoalTemplate(template, payload)` in `trigger-router.ts` replaces `{{$.dot.path}}` tokens with payload values. Falls back to static `goal` if ANY token is missing.
4. `buildSystemPrompt()` in `workflow-runner.ts` appends reference URLs section when `trigger.referenceUrls` is non-empty.
5. Model setup in `workflow-runner.ts` uses `trigger.agentConfig?.model` when set (split `provider/model-id` on first `/`).
6. `POST /api/v2/auto/dispatch` accepts `{ workflowId, goal, workspacePath, context? }`, calls `runWorkflowFn` via TriggerRouter, returns `{ status: 'dispatched', workflowId }` or `{ error: string }`. Returns 503 when trigger system is disabled.
7. `GET /api/v2/triggers` returns `{ triggers: Array<{ id, provider, workflowId, workspacePath, goal, lastFiredAt? }> }`. Returns empty array when trigger system is disabled.
8. Console has an AUTO tab navigating to `/auto` route.
9. `AutoView` has two-column layout: `DispatchPane` (40%) and `QueuePane` (60%) on desktop, stacked on mobile.
10. `DispatchPane`: workflow selector, goal textarea, `[ RUN ]` button calling dispatch endpoint, error display, collapsible `[ TRIGGERS ]` section.
11. `QueuePane`: status band `[N RUNNING] [N BLOCKED] [N COMPLETED]`, list of sessions filtered to `isAutonomous === true`, each row shows goal/title + status badge + `[ LIVE ]` pulse + elapsed time + chevron expand. Expanded shows recapMarkdown + `[ OPEN IN DAG ]` link.
12. All existing tests pass: `npx vitest run tests/unit/`.
13. TypeScript compiles clean.

---

## Non-Goals

- Implementing `onComplete.runOn !== 'success'` execution -- warn only.
- Full JSONPath engine -- only `{{$.dot.path}}` template interpolation.
- Auth on dispatch endpoint.
- Hot-reload of triggers.yml.
- YAML block sequence parsing for `referenceUrls` (use space-separated scalar).
- Returning a real session ID from the dispatch endpoint (fire-and-forget).
- Tests for the new console components.
- Pushing or opening a PR.

---

## Philosophy-Driven Constraints

- All new `TriggerDefinition` and `WorkflowTrigger` fields must be `readonly`.
- `onComplete.runOn` must be a `'success' | 'failure' | 'always'` literal union.
- Dispatch endpoint returns JSON errors, never throws.
- YAML parsing is the validation boundary -- runtime code trusts a valid `WorkflowTrigger`.
- No new npm dependencies.
- Commit on branch `feat/auto-task-input` only.

---

## Invariants

1. `ContextMappingEntry.required` already exists in `types.ts` line 41 -- DO NOT re-add.
2. All existing trigger-store and trigger-router tests must pass unchanged.
3. `mountConsoleRoutes` optional-param pattern: new `triggerRouter?: TriggerRouter` is a 7th optional param, consistent with existing optional params.
4. `TriggerListenerHandle` interface gets a new `readonly router: TriggerRouter` field (additive, non-breaking).
5. The dispatch endpoint fires and forgets -- it does NOT wait for workflow completion.
6. `interpolateGoalTemplate` must fall back to static `goal` if ANY token is missing (no partial interpolation).
7. `onComplete` warning: check `runOn !== 'success'` (covers 'failure' AND 'always').

---

## Selected Approach

**Extend TriggerRouter** with `dispatch()` and `listTriggers()` methods. Expose router in `TriggerListenerHandle`. Pass as optional 7th param to `mountConsoleRoutes()`. Extend `WorkflowTrigger` with optional `referenceUrls?` and `agentConfig?` fields to keep daemon decoupled from trigger system types.

**Runner-up:** Extract `AutoDispatcher` class -- rejected for dependency duplication and index sync risk.

**Rationale:** TriggerRouter already owns all 4 required dependencies (`index`, `runWorkflowFn`, `ctx`, `apiKey`). Adding `dispatch()` is semantically identical to `route()` with a different input source. No new classes, no new files in `src/trigger/`.

---

## Vertical Slices

### Slice 1: Schema changes (types.ts + trigger-store.ts)
**Files:** `src/trigger/types.ts`, `src/trigger/trigger-store.ts`
**Work:** Add 4 optional fields to `TriggerDefinition`. Add `ParsedTriggerRaw` fields. Add YAML sub-object parsers for `agentConfig` and `onComplete`. Parse `referenceUrls` as space-separated scalar. Add `onComplete.runOn !== 'success'` warning. Extend `WorkflowTrigger` in `workflow-runner.ts` with optional `referenceUrls?` and `agentConfig?`.
**Done when:** TypeScript compiles clean, existing trigger-store tests pass.
**Est:** ~70 LOC across 3 files.

### Slice 2: Trigger router enhancements (trigger-router.ts + workflow-runner.ts)
**Files:** `src/trigger/trigger-router.ts`, `src/daemon/workflow-runner.ts`
**Work:** Add `interpolateGoalTemplate()` helper. Use it in `route()` when `trigger.goalTemplate` is set. Add `dispatch()` method. Add `listTriggers()` method. Update `buildSystemPrompt()` for referenceUrls. Update model setup for `agentConfig?.model`.
**Done when:** TypeScript compiles clean, trigger-router tests pass.
**Est:** ~60 LOC across 2 files.

### Slice 3: TriggerListenerHandle + server.ts wiring
**Files:** `src/trigger/trigger-listener.ts`, `src/mcp/server.ts`
**Work:** Add `readonly router: TriggerRouter` to `TriggerListenerHandle`. Store router from listener result in server.ts and pass to `mountConsoleRoutes`.
**Done when:** TypeScript compiles clean. No test changes needed.
**Est:** ~15 LOC across 2 files.

### Slice 4: API endpoints (console-routes.ts + console/src/api/)
**Files:** `src/v2/usecases/console-routes.ts`, `console/src/api/types.ts`, `console/src/api/hooks.ts`
**Work:** Add `POST /api/v2/auto/dispatch` and `GET /api/v2/triggers` to `mountConsoleRoutes`. Update function signature. Update read-only comment. Add `TriggerSummary` and `AutoDispatchResponse` types to console API types. Add `useTriggerList()` hook.
**Done when:** TypeScript compiles clean in both server and console.
**Est:** ~80 LOC across 3 files.

### Slice 5: Console AUTO tab (router + AppShell + views + components)
**Files:** `console/src/router.tsx`, `console/src/AppShell.tsx`, `console/src/views/AutoView.tsx`, `console/src/components/DispatchPane.tsx`, `console/src/components/QueuePane.tsx`
**Work:** Add `/auto` route. Add `auto` to `TAB_ORDER`. Add `autoMatch` and `AutoView` panel in AppShell. Implement `AutoView`, `DispatchPane`, `QueuePane` as pure presenters.
**Done when:** TypeScript compiles clean in console.
**Est:** ~250 LOC across 5 files.

---

## Test Design

- No new tests required (existing tests must pass).
- Verification: `npx vitest run tests/unit/` -- all passing.
- TypeScript: `cd /Users/etienneb/git/personal/workrail && npx tsc --noEmit` (server) and `cd /Users/etienneb/git/personal/workrail/console && npx tsc --noEmit` (console).
- The YAML sub-object parser changes (agentConfig, onComplete, referenceUrls) are covered by the invariant that existing trigger-store tests pass -- they exercise the parser broadly.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| YAML indent-level off-by-one for agentConfig | Medium | Silent parse failure | Copy exact pattern from trigger-store.ts:234-266 |
| express.json() missing on POST route | Low | 400 errors / undefined body | Use inline middleware |
| WorkflowTrigger extension breaks existing callers | Low | Type errors | All new fields optional |
| console TypeScript errors from new components | Medium | Build failure | Write components incrementally, compile-check per slice |
| `listTriggers()` / dispatch called on undefined router | Low | 500 instead of 503 | Explicit null guard in console-routes |

---

## PR Packaging Strategy

Single PR on branch `feat/auto-task-input`. All 5 slices in one commit. Do NOT push or open PR.

Commit message: `feat(console): add AUTO tab with dispatch pane, queue, and trigger API endpoints`

---

## Philosophy Alignment per Slice

| Slice | Principle | Status |
|---|---|---|
| 1 (Schema) | Immutability by default | Satisfied -- all new fields readonly |
| 1 (Schema) | Make illegal states unrepresentable | Satisfied -- onComplete.runOn literal union |
| 1 (Schema) | Validate at boundaries | Satisfied -- YAML boundary checks all new fields |
| 2 (Router) | YAGNI with discipline | Satisfied -- no onComplete execution, simple template interpolation |
| 2 (Router) | Errors are data | Satisfied -- dispatch() returns Result pattern |
| 3 (Wiring) | Dependency injection | Satisfied -- router threaded via optional param |
| 4 (API) | Errors are data | Satisfied -- JSON error envelope |
| 5 (Console) | Functional/declarative | Satisfied -- pure presenters, no imperative mutation |
| 5 (Console) | YAGNI | Accepted tension -- skeleton components with TODOs acceptable per task spec |

---

## Plan Metadata

- `implementationPlan`: Slices 1-5, single PR
- `slices`: 5 vertical slices, ~475 total LOC
- `testDesign`: No new tests; existing test suite + TypeScript compile
- `estimatedPRCount`: 1
- `followUpTickets`: onComplete execution (runOn: 'success' hook), YAML sequence parser for referenceUrls, session ID return from dispatch endpoint
- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
