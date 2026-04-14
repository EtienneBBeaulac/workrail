# Next Up

Groomed near-term tickets. Check `docs/roadmap/now-next-later.md` first for the current priority ordering.

---

## Ticket 1: Open PR for fix-multi-instance-gaps

Branch `fix/etienneb/multi-instance-gaps` has a committed + pushed fix: `fix(mcp): resolve three multi-instance safety gaps` (HttpServer.ts, http-entry.ts, tests). Needs a PR opened and merged.

---

## Ticket 2: Execution trace Layer 3a (no backend)

### What to build

Three independent DAG annotations, all using existing trace data:

- **Edge cause diamonds** -- 10×10px rotated square at each edge midpoint, character code (C/F/D/>) + color indicating trace item kind. Hover shows the trace item summary.
- **Loop bracket in gutter** -- amber vertical line spanning looped nodes, `[ LOOP ]` top cap + `[ // Nx ]` bottom cap. Suppressed for single-iteration loops.
- **`[ CAUSE ]` footer on blocked_attempt nodes** -- expandable footer showing the blocker summary from the trace.

### Files

- `console/src/components/RunLineageDag.tsx`
- `console/src/components/NodeDetailSection.tsx` (CAUSE footer section)

### Notes

- `run.executionTraceSummary` is already available in `RunLineageDag` (used for contextFacts chips). No new props needed.
- Layer 3b (ghost nodes for skipped steps) requires backend confirmation that skipped step IDs are emitted in trace refs -- keep separate.
- See `docs/design/console-execution-trace-discovery.md` for the full design.

---

## Ticket 3: Legacy workflow modernization -- exploration-workflow.json

### Goal

Modernize `workflows/exploration-workflow.json` to current v2/lean authoring patterns. This is the highest-priority candidate among the unmodernized workflows.

### What modernization means

- Current v2/lean structure where appropriate
- `metaGuidance` and `recommendedPreferences`
- `references` for authoritative companion material
- `templateCall` / routine injection instead of repeating large prompt blocks
- Tighter loop-control wording and evidence-oriented review structure

### Related

- `docs/roadmap/open-work-inventory.md` (full prioritized modernization list)
- `docs/authoring.md` (modern baseline)

---

## Ticket 4: Design console execution-trace explainability (Layer 3b -- ghost nodes)

### Status

Blocked on backend confirmation. `ConsoleDagNode` has no `stepId` field. The backend needs to either emit a step_id-to-position mapping or emit synthetic `skipped_step` DAG nodes before this can be built.

### What needs backend work

- Confirm whether `selected_next_step` trace refs include skipped step IDs
- Add `stepId` field to `ConsoleDagNode` DTO or a new `skipped_step` event kind

---

## Recently completed

- ~~**Ticket: Console execution trace Layer 1 + 2**~~ (done -- `[ TRACE ]` tab, NodeDetailSection routing sections, condition tracing, #340)
- ~~**Ticket: Top-level runCondition tracing**~~ (done -- `formatConditionTrace`, `traceStepRunConditionSkipped/Passed`, `nextTopLevel` emits evaluated_condition entries)
- ~~**Ticket: Filter chips cross-contamination**~~ (done -- `sourceFilteredWorkflows`/`tagFilteredWorkflows` in ViewModel)
- ~~**Ticket: Windows CI fix**~~ (done -- duplicate createFakeStdout resolved)
- ~~**Ticket: GitHub branch protection + pre-push hook**~~ (done -- server-side rule + .git-hooks/pre-push, #344)
- ~~**Ticket: Assessment-gate mr-review adoption**~~ (done -- already had assessmentRefs)
- ~~**Ticket: Console CPU spiral**~~ (done -- all three fixes shipped)
- ~~**Ticket: Console MVI architecture**~~ (done -- all 6 views, #332)
- ~~**Ticket: MCP server stability**~~ (done -- EPIPE, stale lock, double SIGTERM, #332 #335)
- ~~**Ticket: v2 sign-off and cleanup**~~ (done)
- ~~**Ticket: Retrieval budget strengthening**~~ (done)
- ~~**Ticket: Workflow-source setup phase 1**~~ (done, #160–#164)
