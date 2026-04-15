# Layer 3b Ghost Nodes -- Implementation Plan

*Execution-ready plan. Design is locked. Do not re-open design questions during implementation.*

---

## 1. Problem Statement

The console's session detail DAG only shows nodes that were actually executed. When a workflow has `runCondition` on top-level steps, the DAG can look sparse -- jumping from phase 0 to phase 6 with no explanation. Users cannot tell whether the missing steps were skipped intentionally or represent a bug.

Layer 3b adds "ghost nodes" for skipped steps: rendered at 0.25 opacity with a `[ SKIPPED ]` badge, positioned after the active lineage. This makes the full workflow shape visible and explains sparse DAGs.

---

## 2. Acceptance Criteria

- [ ] When a session has `executionTraceSummary` with `evaluated_condition` items whose summaries start with `SKIP:` and have `step_id` refs, the DAG renders ghost nodes for those step IDs
- [ ] Ghost nodes are rendered at 0.25 opacity
- [ ] Ghost nodes show a `[ SKIPPED ]` MonoLabel badge
- [ ] Ghost nodes show the human-readable step label (from compiled workflow) or fall back to the raw stepId
- [ ] Ghost nodes are NOT clickable (no node detail panel opens)
- [ ] Ghost nodes appear ONLY when `run.executionTraceSummary !== null`
- [ ] Ghost nodes do NOT appear in the OverviewRail
- [ ] Duplicate skipped step IDs (same step evaluated multiple times) produce a single ghost node
- [ ] Ghost nodes are positioned within canvas bounds (no visual clipping)
- [ ] Ghost nodes show a hover tooltip with the full step label or SKIP summary
- [ ] All existing tests pass: `npx vitest run` from repo root AND `cd console && npx vitest run`
- [ ] New pure-function tests cover: SKIP item extraction, deduplication, non-SKIP items excluded

---

## 3. Non-Goals

- Ghost nodes for loop body steps skipped inside loops (only top-level `runCondition` skips)
- Ghost nodes clickable / showing node detail panel
- Ghost nodes in the OverviewRail
- Exact workflow-step-order column positioning (approximate ordering by trace event index is sufficient)
- Any new domain events or changes to the session event schema
- Ghost nodes when no `executionTraceSummary` is present (legacy sessions)

---

## 4. Philosophy-Driven Constraints

- `ConsoleGhostStep` must be a named interface with all-`readonly` fields -- not an inline type
- Ghost steps must never appear in `run.nodes` -- they are a separate array `run.skippedSteps`
- Ghost step extraction is a pure function in `session-detail-use-cases.ts` (no logic in view)
- Ghost node rendering is a separate `useMemo` block in `RunLineageDag.tsx` (sub-feature D), not mixed with `flowNodes`/`flowEdges`
- Backend label resolution reuses `extractStepTitlesFromCompiled` -- no new I/O paths
- `run.skippedSteps ?? []` defensive fallback at frontend consumption site

---

## 5. Invariants

- `ConsoleGhostStep` has shape: `{ readonly stepId: string; readonly stepLabel: string | null }`
- `ConsoleDagRun.skippedSteps` is always an array (never undefined) -- initialized to `[]` by backend
- Ghost steps are deduplicated by `stepId` (same step only appears once)
- Ghost node `x` position: `LINEAGE_SCROLL_OVERHANG + LINEAGE_PADDING + ghostDepth * LINEAGE_COLUMN_WIDTH` where `ghostDepth = maxActiveLineageDepth + 1`
- `graphWidth` must accommodate the ghost column: `max(current graphWidth, LINEAGE_SCROLL_OVERHANG * 2 + LINEAGE_PADDING * 2 + ghostDepth * LINEAGE_COLUMN_WIDTH + ACTIVE_NODE_WIDTH)`
- Ghost nodes are never ReactFlow `Node` objects in the `flowNodes` array -- they are absolute-positioned overlays
- Ghost nodes only rendered when `run.executionTraceSummary !== null`

---

## 6. Selected Approach

**Candidate B: Backend-emitted `skippedSteps` with label resolution**

Backend assembles `skippedSteps: readonly ConsoleGhostStep[]` by scanning `executionTraceSummary.items` for `evaluated_condition` items with `SKIP:` summaries and `step_id` refs, then resolves step labels from the already-loaded compiled workflow via `extractStepTitlesFromCompiled`. Frontend renders as absolute-positioned overlays (sub-feature D), following the Layer 3a pattern for edge diamonds and loop brackets.

**Runner-up**: Candidate A (frontend-only, no labels) -- rejected because raw step IDs are unreadable to users.

**Rationale**: Labels are the primary user-facing value. Backend label resolution reuses existing infrastructure. The Layer 3a pattern (separate `useMemo` + absolute overlay) is well-established.

---

## 7. Vertical Slices

### Slice 1: Backend types and DTO assembly
**Scope**: Add `ConsoleGhostStep` interface and `skippedSteps` field to both mirrored type files. Implement `resolveSkippedSteps` helper in `console-service.ts`. Wire it into `projectSessionDetail`.

**Files**:
- `src/v2/usecases/console-types.ts` -- add `ConsoleGhostStep`, add `skippedSteps` to `ConsoleDagRun`
- `console/src/api/types.ts` -- mirror the same changes
- `src/v2/usecases/console-service.ts` -- add `resolveSkippedSteps` helper, call it in `projectSessionDetail`

**Done when**: Backend assembles `skippedSteps` correctly; existing tests still pass.

**Verification**: `npx vitest run` passes. Manual inspection: a session with skipped steps shows populated `skippedSteps` array in the API response.

---

### Slice 2: Frontend use-case helper and tests
**Scope**: Add `getSkippedStepsFromTrace` pure function to `session-detail-use-cases.ts`. Add unit tests.

**Files**:
- `console/src/views/session-detail-use-cases.ts` -- add `getSkippedStepsFromTrace`
- `tests/unit/console-session-detail-use-cases.test.ts` -- add tests

**Done when**: Pure function correctly extracts and deduplicates skipped step IDs from trace items; tests pass.

**Verification**: `npx vitest run` passes. Tests cover: SKIP items extracted, non-SKIP items excluded, dedup by stepId, items with no step_id ref excluded, empty input returns empty array.

---

### Slice 3: Ghost node positioning
**Scope**: Add `positionGhostNodes` pure function (takes `skippedSteps` + `LineageDagModel`, returns `readonly PositionedGhostNode[]`). Define `PositionedGhostNode` interface. Add `graphWidth` extension logic.

**Files**:
- `console/src/lib/lineage-dag-layout.ts` -- add `PositionedGhostNode` interface and `positionGhostNodes` function; or add as a new dedicated file `console/src/lib/ghost-node-layout.ts`
- `tests/unit/console-lineage-dag-layout.test.ts` (new) -- test positioning logic

**Done when**: `positionGhostNodes` places ghost nodes at correct coordinates; canvas width accommodates the ghost column.

**Verification**: Unit tests cover: no skipped steps returns empty array; N skipped steps produces N positioned nodes at `ghostDepth = maxActiveDepth + 1`; Y positions are spaced correctly; `requiredWidth` accounts for ghost column.

---

### Slice 4: Ghost node rendering
**Scope**: Add sub-feature D `useMemo` in `RunLineageDag.tsx`. Add `GhostNodeOverlay` component. Wire hover tooltip.

**Files**:
- `console/src/components/RunLineageDag.tsx` -- sub-feature D useMemo, GhostNodeOverlay component, `?? []` fallback

**Done when**: Ghost nodes render at 0.25 opacity with `[ SKIPPED ]` badge and step label; hover tooltip works; ghost nodes are not clickable; ghost nodes only appear when `executionTraceSummary !== null`.

**Verification**: Visual inspection in browser. No existing tests broken. `cd console && npx vitest run` passes.

---

## 8. Test Design

### New unit tests in `tests/unit/console-session-detail-use-cases.test.ts`

```
getSkippedStepsFromTrace:
- returns [] for empty items
- extracts stepId from evaluated_condition with SKIP: summary and step_id ref
- excludes evaluated_condition without SKIP: prefix (loop conditions, PASS conditions)
- excludes evaluated_condition with no step_id ref
- deduplicates by stepId (same step evaluated twice -> one entry)
- preserves order by recordedAtEventIndex
- excludes items of other kinds (selected_next_step, entered_loop, etc.)
```

### New unit tests in `tests/unit/console-lineage-dag-layout.test.ts`

```
positionGhostNodes:
- returns [] for empty skippedSteps
- returns [] when model has no active lineage nodes
- places ghost nodes at depth = maxActiveLineageDepth + 1
- stacks multiple ghost nodes in separate Y lanes
- requiredWidth >= x + ACTIVE_NODE_WIDTH for rightmost ghost node
```

### No new integration tests needed (ghost nodes are purely visual / read-only)

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Type file sync mismatch | Low | Medium | Update both files in same commit; `?? []` fallback at frontend |
| Ghost nodes clip at right edge | Medium | Medium | FM4: extend graphWidth; unit test covers this |
| Duplicate ghost nodes | Medium | Low | FM3: dedup in backend helper; unit test covers this |
| `WorkflowInterpreter` not emitting SKIP traces for all workflow types | Low | High | Verified: `outcome-success.ts` uses `WorkflowInterpreter.next()` -> `traceStepRunConditionSkipped` |

---

## 10. PR Packaging

Single PR: `feature/etienneb/execution-trace-layer3b`

All 4 slices in one PR. They are tightly coupled (backend type -> use-case helper -> positioning -> rendering). Splitting would create intermediate states where the backend field exists but the frontend doesn't render it, which is confusing.

Commit sequence (each squashed into the PR final commit):
1. Backend types + DTO assembly (Slice 1)
2. Use-case helper + tests (Slice 2)
3. Ghost positioning + tests (Slice 3)
4. Ghost rendering (Slice 4)

Final PR commit message: `feat(console): add ghost nodes for skipped steps in execution trace DAG`

---

## 11. Philosophy Alignment Per Slice

### Slice 1 (Backend types + DTO)
- Immutability by default -> satisfied: all fields `readonly`
- Make illegal states unrepresentable -> satisfied: `ConsoleGhostStep` separate from `ConsoleDagNode`
- Validate at boundaries -> satisfied: label resolution at backend I/O boundary
- Errors are data -> satisfied: `stepLabel: null` not thrown

### Slice 2 (Use-case helper)
- Compose with small pure functions -> satisfied: single-responsibility `getSkippedStepsFromTrace`
- Exhaustiveness everywhere -> N/A: no discriminated union switch needed
- Prefer fakes over mocks -> satisfied: pure function, no mocks needed

### Slice 3 (Positioning)
- Determinism over cleverness -> satisfied: same inputs always produce same layout
- Compose with small pure functions -> satisfied: `positionGhostNodes` is standalone

### Slice 4 (Rendering)
- YAGNI with discipline -> satisfied: no click handling, no rail integration
- Functional/declarative over imperative -> satisfied: useMemo pattern, no mutation

---

## Metadata

- `implementationPlan`: complete
- `slices`: 4
- `estimatedPRCount`: 1
- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
- `followUpTickets`: none identified
