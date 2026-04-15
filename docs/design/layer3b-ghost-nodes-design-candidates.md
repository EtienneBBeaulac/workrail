# Layer 3b Ghost Nodes -- Design Candidates

*Investigative material. Not a final decision.*

---

## Problem Understanding

### What Layer 3b Means

The console's session detail view shows a DAG of workflow execution nodes via `RunLineageDag` (xyflow). Currently only nodes that were actually created appear in the DAG. Layer 3b adds "ghost nodes" for steps that were skipped due to `runCondition` evaluating to false at the top level:

- Skipped nodes rendered at 0.25 opacity with a `[ SKIPPED ]` badge
- Makes the DAG show the full workflow shape, not just the executed path
- Helps users understand why a sparse DAG looks sparse (e.g. a small-task fast path jumped from phase 0 to phase 6)

### Core Tensions

1. **Labels vs simplicity**: Step labels (human-readable titles like "Phase 0: Triage and classify") are what make ghost nodes useful. But resolving them requires the compiled workflow, which is a backend I/O operation. Skipping labels is simpler but produces raw step IDs (`routine-context-gathering-depth`) that users can't parse.

2. **Type safety vs ease**: Adding `isGhost: boolean` to `ConsoleDagNode` is one line but violates "make illegal states unrepresentable" -- ghost steps have no `hasRecap`, `hasFailedValidations`, `isTip`, `parentNodeId`, `createdAtEventIndex`, etc. A separate `ConsoleGhostStep` interface is correct but requires touching both mirrored type files.

3. **Positioning accuracy vs scope**: Exact column positioning requires knowing the workflow's step index order, which the frontend doesn't have without an extra API call. Approximate positioning (sort by trace event index, which matches `nextTopLevel`'s evaluation order for top-level steps) is sufficient for MVP.

4. **ReactFlow nodes vs overlays**: ReactFlow nodes participate in the layout graph (edges could connect to them). Absolute-positioned divs (like loop brackets) are simpler and sufficient since ghost nodes have no edges.

### Existing Patterns

Layer 3a (edge cause diamonds, loop brackets, CAUSE footer) set the pattern for this layer:
- New data added as a field on `ConsoleDagRun` (`executionTraceSummary`)
- Frontend extracts overlay positions in separate `useMemo` blocks in `RunLineageDag`
- Overlay components rendered as absolute-positioned divs, NOT as ReactFlow nodes
- Pure logic functions live in `session-detail-use-cases.ts`

Relevant existing code:
- `console/src/components/RunLineageDag.tsx` -- sub-features A/B/C as separate `useMemo` blocks
- `console/src/views/session-detail-use-cases.ts` -- `groupTraceEntries`, `findEdgeCauseItem`, `getNodeRoutingItems`
- `src/v2/usecases/console-service.ts` -- `projectSessionDetail`, `resolveStepLabels`, `extractStepTitlesFromCompiled`
- `src/v2/durable-core/domain/decision-trace-builder.ts` -- `traceStepRunConditionSkipped` emits `evaluated_condition` + `step_id` ref + `SKIP:` summary

### Where Skipped Steps Live

`traceStepRunConditionSkipped()` is called in `workflow-interpreter.ts` `nextTopLevel()` for each top-level step whose `runCondition` returned false. This emits:
```
{ kind: 'evaluated_condition', summary: 'SKIP: taskComplexity (equals)', refs: [{kind: 'step_id', value: 'phase-2-deep-exploration'}] }
```

These appear in `run.executionTraceSummary.items`. The step IDs are recoverable from the frontend without backend changes. Labels are not.

### What Makes This Hard

- Ghost node labels require resolving a compiled workflow by hash -- the backend already does this for real node labels but via snapshot refs. Ghost steps need direct lookup by stepId from the compiled workflow.
- Two mirrored type files (`console-types.ts` + `console/src/api/types.ts`) must be kept in sync manually.
- Ghost nodes must be positioned within the ReactFlow canvas coordinate space -- they are siblings of real nodes in the same scrollable div.
- The `evaluateCondition` trace items also appear for loop conditions (loop body entries) -- those must NOT become ghost nodes. Filter: only top-level step skips have `step_id` refs (not `loop_id` refs).

---

## Philosophy Constraints

From `AGENTS.md` and `console/CLAUDE.md`:

- **Make illegal states unrepresentable**: Ghost steps have fundamentally different shape from real nodes. Separate type required.
- **Immutability by default**: All new interfaces must use `readonly` everywhere.
- **Pure functions at use-case layer**: Ghost step extraction and positioning are pure functions in `session-detail-use-cases.ts`.
- **Validate at boundaries**: Backend is the boundary for label resolution (I/O).
- **YAGNI**: Don't add step-order-exact positioning if approximate is sufficient.
- **Compose with small pure functions**: One function per concern -- extraction, positioning, rendering are separate.

No philosophy conflicts found between stated rules and repo patterns.

---

## Impact Surface

Adding `skippedSteps: readonly ConsoleGhostStep[]` to `ConsoleDagRun` is additive. Consumers:
- `RunLineageDag.tsx` -- reads `run.skippedSteps` (new `useMemo` block)
- `session-detail-use-cases.ts` -- positioning pure function
- Backend `console-service.ts` -- populates the field
- `console-types.ts` + `console/src/api/types.ts` -- both must be updated (manual mirror)
- Existing test assertions on `ConsoleDagRun` shape -- `skippedSteps` is additive; old tests still pass

The `buildLineageDagModel` signature does NOT need to change -- ghost positioning is a separate pure function consuming the layout model output.

---

## Candidates

### Candidate A: Frontend-only ghost nodes (no labels)

**Summary**: Extract skipped step IDs from `evaluated_condition` SKIP trace items on the frontend; render ghost nodes without step labels (show raw step ID).

**Tensions resolved**: Zero backend changes. No mirrored type file sync needed.
**Tensions accepted**: No step labels. Ghost nodes show raw IDs like `routine-context-gathering-depth`.

**Boundary**: `session-detail-use-cases.ts` -- new pure function `getSkippedStepsFromTrace(items: readonly ConsoleExecutionTraceItem[]): readonly string[]` returning step IDs. `RunLineageDag.tsx` -- new sub-feature D `useMemo` computes ghost positions from active lineage model, renders absolute-positioned `GhostNodeOverlay` components.

**Why this boundary**: Consistent with Layer 3a pattern. Pure function in use-case layer, rendering in view.

**Failure mode**: Raw step IDs are unreadable to users. Feature ships but provides poor UX. Silent failure -- no error, just confusing UI.

**Repo pattern**: Directly adapts Layer 3a overlay pattern. No new fields.

**Gain**: Zero backend risk, minimal diff, fast to ship.
**Give up**: Step labels (the primary user-facing value of the feature).

**Scope**: Too narrow -- labels are 80% of the value.

**Philosophy fit**: Honors YAGNI, small pure functions. Conflicts with "prefer explicit domain types" if ghost step is just `string`.

---

### Candidate B: Backend-emitted skippedSteps with labels (recommended)

**Summary**: Add `skippedSteps: readonly ConsoleGhostStep[]` to `ConsoleDagRun`; backend populates it by scanning `executionTraceSummary.items` for SKIP entries and resolving titles from the already-loaded compiled workflow.

**Tensions resolved**: Full step labels. Named `ConsoleGhostStep` interface. Follows exact Layer 3a precedent (`executionTraceSummary` was added the same way). Approximate positioning is sufficient.
**Tensions accepted**: Two mirrored type files must sync. Backend `projectSessionDetail` grows slightly.

**New types**:
```typescript
// In both console-types.ts and console/src/api/types.ts
export interface ConsoleGhostStep {
  readonly stepId: string;
  readonly stepLabel: string | null;
}
// ConsoleDagRun gains:
readonly skippedSteps: readonly ConsoleGhostStep[];
```

**Backend helper** in `console-service.ts`:
```typescript
function resolveSkippedSteps(
  executionTrace: ConsoleExecutionTraceSummary | null,
  workflowHash: string | null,
  titlesByHash: Map<string, ReadonlyMap<string, string>>,
): readonly ConsoleGhostStep[]
```
Filters `items` for `evaluated_condition` with `step_id` ref and `SKIP:` summary prefix; resolves labels from `titlesByHash` (already loaded by `resolveStepLabels`).

**Frontend pure function** in `session-detail-use-cases.ts`:
```typescript
export function positionGhostNodes(
  skippedSteps: readonly ConsoleGhostStep[],
  model: LineageDagModel,
): readonly PositionedGhostNode[]
```
Places ghost nodes at `depth = maxActiveDepth + 1`, evenly spaced in a dedicated ghost lane below the active lineage. `PositionedGhostNode` has `{ stepId, stepLabel, x, y }`.

**Rendering in `RunLineageDag.tsx`**: New sub-feature D `useMemo` + `GhostNodeOverlay` absolute-positioned component. Not ReactFlow nodes. Not clickable (`pointerEvents: 'none'` on the node body, but tooltip on hover to show full step label).

**Why this boundary**: `ConsoleGhostStep` as backend DTO matches how `executionTraceSummary` was added. Label resolution is I/O -- belongs at the backend boundary. Pure positioning function belongs in use-case layer.

**Failure mode**: If `workflowHash` is null (no-workflow run), labels fall back to null, and ghost nodes show step ID. Same graceful degradation as real node labels.

**Repo pattern**: Directly follows how Layer 3a added `executionTraceSummary` to `ConsoleDagRun`. Same file sequence, same pattern.

**Gain**: Full step labels. Named type. Clean architecture. Graceful null fallback.
**Give up**: Two type files must sync. Moderate backend diff.

**Scope**: Best-fit. Satisfies acceptance criteria without extra API endpoints.

**Philosophy fit**: Honors all principles. Explicit domain type, immutability, pure functions, validate at boundaries.

---

### Candidate C: ReactFlow custom node type with exact positioning

**Summary**: Add ghost steps as `Node<GhostNodeData>[]` in the ReactFlow graph with `nodeType: 'ghost'`, positioned at the exact workflow-step-order column using the step's index in the compiled workflow fetched from a new frontend API call.

**Tensions resolved**: Exact column positioning matching workflow step order. Ghost nodes as real ReactFlow nodes (future edge support). Hover/click behavior handled by ReactFlow.
**Tensions accepted**: Extra API call creates loading race. New API endpoint needed. Custom `nodeTypes` map requires memoization in `RunLineageDag`.

**Boundary**: New `useWorkflowStepsRepository` hook fetching `/api/v2/workflows/:hash/steps` (or reuse existing catalog endpoint). Session detail ViewModel joins session data + workflow steps. `buildLineageDagModel` extended to accept ghost steps with exact column indices.

**Why this boundary**: Solves exact positioning by having the frontend know step order. But this is a new data dependency not currently in the session detail view's data model.

**Failure mode**: If workflow steps API call fails, ghost nodes disappear entirely (non-graceful). Loading state race: ghost nodes flicker in when the secondary call resolves. `nodeTypes` must be defined outside render or in `useMemo` (easy to get wrong, causes ReactFlow remount warnings).

**Repo pattern**: Departs significantly. No existing custom node types. No extra API calls in session detail view. Over-engineered for the goal.

**Gain**: Exact positioning. Future edge support.
**Give up**: Extra API call. Loading complexity. New endpoint needed. Significant scope expansion.

**Scope**: Too broad. Not justified by acceptance criteria.

**Philosophy fit**: Conflicts with YAGNI. Honors explicit types and exhaustiveness.

---

## Comparison and Recommendation

| Criterion | A | B | C |
|---|---|---|---|
| Step labels | No | Yes | Yes |
| Backend changes | None | Small additive | New endpoint |
| Type safety | Weak | Strong | Strong |
| Positioning | Approximate | Approximate | Exact |
| Failure mode | Silent bad UX | Graceful null | Hard failure + flicker |
| Repo pattern fit | Direct | Direct | Departs |
| YAGNI | Over-honors | Balanced | Violates |

**Recommendation: Candidate B.**

Labels are not optional -- raw step IDs are meaningless to users. Candidate A saves 30 minutes and ships a feature that doesn't work. Candidate C solves an exact-positioning problem that the acceptance criteria don't require and introduces loading complexity.

Candidate B follows the exact path Layer 3a established (`executionTraceSummary` was added as a backend-assembled field on `ConsoleDagRun`). The backend helper is small and reuses `extractStepTitlesFromCompiled` which already exists.

---

## Self-Critique

**Strongest argument against B**: `projectSessionDetail` is already complex. Every new helper adds cognitive overhead and another I/O fan-out point. A determined advocate for A would argue: "Ship step IDs now, add labels in a follow-up when we have a codegen solution for the mirrored types."

**Why A still loses**: The roadmap already says "requires backend to emit skipped step IDs" -- that's an acknowledgment that backend work is expected. The label resolution is 10 lines of code (reuses existing infra). The UX gap is not cosmetic.

**What would justify C**: A product requirement saying ghost nodes must appear at their workflow-order column (not just after the active lineage). Evidence required: user feedback that approximate positioning is confusing. Not present.

**Invalidating assumption**: If `traceStepRunConditionSkipped` is NOT actually called in the v2 engine (only in the v1 interpreter), then the trace items won't exist and ghost nodes won't appear for v2 sessions. `workflow-interpreter.ts` is the v1 interpreter. Need to verify whether the v2 engine emits equivalent traces. If not, this entire feature is a no-op for v2 sessions and the real work is adding trace emission to the v2 engine first.

---

## Open Questions for the Main Agent

1. **V2 engine trace emission**: Does the v2 durable engine (`src/v2/`) emit `evaluated_condition` trace entries for top-level step `runCondition` evaluations? Or is this only in the v1 interpreter (`workflow-interpreter.ts`)? If v2 doesn't emit these, ghost nodes won't appear for any v2 sessions and the backend/frontend work is pointless without fixing the v2 engine first.

2. **Ghost lane layout**: Should ghost nodes appear in a single horizontal band below the active lineage (all at the same Y, different X)? Or in a vertical column to the right of the active lineage (all at the same X, different Y)? The current layout is horizontal (depth = X axis, lane = Y axis) -- vertical stacking (same depth, different lanes) may be less intuitive.

3. **Deduplication**: If a step is evaluated multiple times across multiple `continue_workflow` calls (e.g., re-entry in a session with multiple runs), the same `step_id` could appear in multiple SKIP trace items. Should ghost nodes be deduplicated by `stepId`? Answer: yes, show each skipped step only once.
