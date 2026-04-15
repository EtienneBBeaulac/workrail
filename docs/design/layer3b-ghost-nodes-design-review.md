# Layer 3b Ghost Nodes -- Design Review Findings

*Design review of the Candidate B approach: backend-emitted `skippedSteps` with label resolution.*

---

## Tradeoff Review

### Approximate positioning (trace event index order)
Safe. `nextTopLevel` iterates `compiled.steps` in array order, so trace event index IS workflow definition order. Hidden assumption (compiler preserves step order) is guaranteed by the workflow compiler. Tradeoff accepted.

### Ghost nodes not clickable
Acceptable. The `[ TRACE ]` tab in session detail already shows all `evaluated_condition` SKIP items. Ghost nodes can surface the SKIP reason via a hover tooltip (using `hoveredLabel` state already in `RunLineageDag`). No dedicated panel needed.

### Two manually-mirrored type files
Acceptable with mitigation. Both files updated in the same PR. Frontend adds `run.skippedSteps ?? []` defensive fallback at consumption site in `RunLineageDag`.

### Labels fall back to null when no workflow hash
Safe. The null fallback is unreachable in practice (no-workflow sessions cannot have `runCondition`). Fallback degrades gracefully to showing raw stepId.

---

## Failure Mode Review

### FM1: Compiled workflow not pinned -> null labels
**Coverage**: Adequate. Graceful degradation to stepId display. Low risk.

### FM2: Frontend receives skippedSteps as undefined
**Coverage**: Needs explicit mitigation. Add `run.skippedSteps ?? []` at the `useMemo` consumption site in `RunLineageDag.tsx`. Medium risk in rollback scenarios.

### FM3: Duplicate SKIP entries for same stepId
**Coverage**: Needs explicit implementation. Backend `resolveSkippedSteps` must deduplicate by stepId using a `Set<string>`. Without this, a step appears as multiple ghost nodes, which is confusing. Medium risk.

### FM4: Ghost nodes clipping at canvas right edge
**Coverage**: Needs explicit implementation. `graphWidth` in `buildLineageDagModel` (or the ghost positioning function) must ensure the canvas is wide enough to include the ghost column (`depth = maxActiveDepth + 1`). Medium risk -- visually obvious if missed.

### FM5: Ghost nodes in OverviewRail
**Coverage**: Handled by construction. Ghost nodes never enter `model.nodes`. No action needed.

---

## Runner-Up / Simpler Alternative Review

Candidate A (frontend-only, no labels) loses on UX value -- raw step IDs are not readable to users. No elements worth borrowing.

No simpler variant exists that preserves label quality without backend involvement. The named `ConsoleGhostStep` interface is the correct type-safe representation; `nodeKind: 'ghost'` on `ConsoleDagNode` would pollute all existing node-handling code.

---

## Philosophy Alignment

All core principles satisfied:
- Make illegal states unrepresentable: ghost steps cannot masquerade as `ConsoleDagNode`
- Immutability: all `readonly`
- Validate at boundaries: label resolution at backend
- Small pure functions: three single-responsibility functions
- YAGNI: no exact positioning, no click handling, no rail integration
- Errors are data: `stepLabel: null` not thrown

One acceptable tension: exhaustiveness enforcement is not needed for `ConsoleGhostStep` (not a discriminated union participant).

---

## Findings

### Yellow: FM2 -- Type mismatch fallback missing
The design does not explicitly specify `run.skippedSteps ?? []` at the consumption site. If `skippedSteps` arrives as `undefined` (old backend, rollback), ghost nodes silently disappear. Not a crash, but invisible feature loss.
**Severity**: Yellow (not a crash, graceful but invisible).

### Yellow: FM3 -- Deduplication not in spec
Backend `resolveSkippedSteps` spec does not explicitly require dedup by stepId. A session with multiple condition evaluations of the same step would produce duplicate ghost nodes.
**Severity**: Yellow (confusing UX, not broken).

### Yellow: FM4 -- graphWidth extension not specified
The `graphWidth` formula in `buildLineageDagModel` does not account for the ghost column. Ghost nodes at `depth = maxActiveDepth + 1` would clip at the right edge of the canvas.
**Severity**: Yellow (visually broken but easy to fix once noticed).

---

## Recommended Revisions

1. **Add `run.skippedSteps ?? []` fallback** in `RunLineageDag.tsx` at the `useMemo` that reads skipped steps.
2. **Specify dedup requirement** in `resolveSkippedSteps`: collect stepIds into a `Set<string>` and skip already-seen stepIds.
3. **Extend graphWidth** in the ghost positioning function or in `buildLineageDagModel` to ensure the ghost column is within canvas bounds: `ghostDepth = maxActiveDepth + 1; canvasWidth = max(current, LINEAGE_SCROLL_OVERHANG * 2 + LINEAGE_PADDING * 2 + ghostDepth * LINEAGE_COLUMN_WIDTH + ACTIVE_NODE_WIDTH)`.
4. **Add hover tooltip** for ghost nodes using the existing `hoveredLabel`/`tooltipPos` state in `RunLineageDag` (shows the step label or SKIP reason on hover). Low-effort, improves usability.

---

## Residual Concerns

None that would block implementation. All three yellow findings are implementation-level details (not architectural) and are addressed by the recommended revisions above.

The design is sound for implementation.
