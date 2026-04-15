# Next Up

Groomed near-term tickets. Check `docs/roadmap/now-next-later.md` first for the current priority ordering.

---

## Ticket 1: Execution trace Layer 3b -- ghost nodes (backend required)

### What it is

Skipped steps shown in the DAG at 0.25 opacity with a `[ SKIPPED ]` badge and dashed border, so users immediately see the scale of what was bypassed without any interaction.

### Blocked on

`ConsoleDagNode` has no `stepId` field. The backend needs to either:
- Emit a step_id-to-position mapping in `executionTraceSummary`
- Or emit synthetic `skipped_step` entries as DAG nodes

Confirm whether `selected_next_step` trace refs already include skipped step IDs (check `src/v2/durable-core/domain/decision-trace-builder.ts`).

### Design reference

`docs/design/console-execution-trace-discovery.md` -- section on ghost nodes

---

## Ticket 2: Legacy workflow modernization -- exploration-workflow.json

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

## Ticket 3: Design console execution-trace explainability (Layer 3b -- ghost nodes)

### Status

Blocked on backend confirmation. `ConsoleDagNode` has no `stepId` field. The backend needs to either emit a step_id-to-position mapping or emit synthetic `skipped_step` DAG nodes before this can be built.

### What needs backend work

- Confirm whether `selected_next_step` trace refs include skipped step IDs
- Add `stepId` field to `ConsoleDagNode` DTO or a new `skipped_step` event kind

---

## Recently completed

- ~~**Ticket: Execution trace Layer 3a**~~ (done -- edge cause diamonds, loop bracket, CAUSE footer on blocked_attempt nodes, #347)
- ~~**Ticket: fix-multi-instance-gaps**~~ (done -- three multi-instance HttpServer safety gaps, #346)
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
