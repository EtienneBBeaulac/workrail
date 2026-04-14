# Next Up

Groomed near-term tickets. Check `docs/roadmap/now-next-later.md` first for the current priority ordering.

---

## Ticket 1: Fix console CPU spiral (worktrees invalidation on SSE events)

### Problem

When a session write fires `fs.watch`, the SSE handler calls `invalidateQueries(['worktrees'])`, which bypasses `staleTime` and spawns up to 606 concurrent git subprocesses (measured at 12.5s). That git fan-out writes another session event on return, closing the loop.

### Goal

Break the feedback loop and cap git concurrency.

### Acceptance criteria

- `useWorkspaceEvents()` in `console/src/api/hooks.ts` no longer calls `invalidateQueries(['worktrees'])` -- worktrees governed solely by `refetchInterval`
- `enrichWorktree` in `src/v2/usecases/worktree-service.ts` is bounded by a concurrency semaphore (max 8)
- `fs.watch` callback in console routes fires only on `.jsonl` writes, not all file changes

### Files

- `console/src/api/hooks.ts` (remove invalidateQueries from useWorkspaceEvents)
- `src/v2/usecases/worktree-service.ts` (semaphore -- may already be partially done)
- Console routes fs.watch handler

### Related

- `docs/design/console-performance-discovery.md`
- `docs/roadmap/open-work-inventory.md` #0

---

## Ticket 2: Assessment-gate adoption in mr-review-workflow

### Problem

The assessment-gate engine feature exists and is piloted in `bug-investigation.agentic.v2.json`, but adoption is intentionally narrow. The next highest-value workflow to adopt it is `mr-review-workflow.agentic.v2.json`.

### Goal

Add workflow-level assessment declarations and step-level assessment refs + consequence declarations to `mr-review-workflow.agentic.v2.json`. Calibrate follow-up wording and consequence visibility from observed behavior.

### Acceptance criteria

- `workflows/mr-review-workflow.agentic.v2.json` uses assessment refs on at least its core review steps
- Follow-up consequence behavior matches the pattern piloted in `bug-investigation.agentic.v2.json`
- `npm run validate:registry` passes
- Planning docs updated to reflect the expanded rollout

### Files

- `workflows/mr-review-workflow.agentic.v2.json`
- `docs/plans/mr-review-workflow-redesign.md`
- `docs/roadmap/open-work-inventory.md`

---

## Ticket 3: Trial quality gate and readiness audit on real tasks

### Problem

`workflow-for-workflows.v2.json` and `production-readiness-audit.json` have been tuned through authoring reasoning, not evidence from varied real use. The remaining risk is ceremony vs usefulness at `STANDARD` vs `THOROUGH` depth.

### Goal

Run both workflows on multiple distinct tasks spanning at least two archetypes each. Tune from what is observed. Record findings in planning docs.

### Acceptance criteria

- `workflow-for-workflows.v2.json` exercised on 2+ distinct authoring tasks spanning different archetypes
- `production-readiness-audit.json` exercised on 2+ realistic audit targets with different scope/risk shapes
- Observed weaknesses classified into authoring-integrity, outcome-effectiveness, or ceremony/depth tuning buckets
- Any resulting workflow edits revalidated with `npm run validate:registry`
- Planning docs capture the tuned follow-up state

### Files

- `workflows/workflow-for-workflows.v2.json`
- `workflows/production-readiness-audit.json`

---

## Ticket 4: Progress notifications design resolution + implementation

### Problem

Long workflows block the agent with no visibility into progress. The design is mostly done but three issues block implementation.

### Goal

Resolve the three open design issues, then implement `notifications/progress` in `advance.ts`.

### Open design issues (must resolve before coding)

1. **`progressToken` plumbing** -- `request._meta?.progressToken` is available at the `CallToolRequestSchema` handler but not in `advance.ts`. Thread it through `ToolContext` or a dedicated `RequestMeta` field.
2. **`NotificationSender` port** -- `advance.ts` has no access to the MCP `Server` instance. Pass it via a `NotificationSender` port (interface segregation -- expose only `sendNotification`, not the full server).
3. **Step-node counting** -- Count only `nodeKind === 'step'` nodes for progress total; exclude `blocked_attempt` and `checkpoint` nodes (post-ADR 008 these are in the same DAG).

### Acceptance criteria

- `continue_workflow` sends `notifications/progress` when `progressToken` is provided
- `progress` count uses `step` nodes only
- opt-in only -- no behavior change for clients that do not provide `progressToken`
- Tests cover the notification send path and the node counting filter

### Files

- `src/mcp/handlers/v2-execution/advance.ts`
- `src/mcp/types.ts` (V2Dependencies)
- `src/mcp/handler-factory.ts` (ToolContext)

### Related

- `docs/plans/v2-followup-enhancements.md` P2

---

## Ticket 5: Design console execution-trace explainability

### Problem

The console DAG shows only `node_created`/`edge_created`. Engine decisions -- fast paths, skipped phases, condition evaluation, loop entry/exit, `taskComplexity` -- are invisible. Legitimate runs look broken when the DAG is sparse.

### Goal

Produce a concrete design (DTO shape + UX direction) so the console can explain *why* the engine took a path, not just *which* nodes were created. This is a design ticket -- no implementation.

### Acceptance criteria

- Concrete console design exists for showing engine decisions alongside the DAG
- Design distinguishes authoring phases from actual execution nodes
- Proposed DTO shape identifies which engine events and run-context fields must be projected
- Design includes at least one clear UX treatment for fast paths / skipped phases that currently look like broken graphs

### Non-goals

- Implementing the full console redesign
- Exposing every raw engine event directly in the UI

### Files / related

- `docs/reference/workflow-execution-contract.md`
- `src/v2/usecases/console-service.ts`
- `console/src/api/types.ts`
- `docs/ideas/backlog.md` (Console engine-trace visibility)

---

## Recently completed

- ~~**Ticket: v2 sign-off and cleanup**~~ (done -- v2 is default-on, stale docs cleaned up)
- ~~**Ticket: Retrieval budget strengthening**~~ (done -- 24 KB recovery budget, deterministic tiering, #144161e)
- ~~**Ticket: Expand lifecycle validation coverage**~~ (done -- auto-walk smoke test covers all bundled workflows)
- ~~**Ticket: Workflow-source setup phase 1**~~ (done -- rooted team sharing, remembered roots, grouped source visibility, #160–#164)
- ~~**Ticket: Finish prompt/supplement boundary alignment**~~ (done -- documented in authoring.md, workflow-execution-contract.md)
- ~~**Ticket: Console MVI architecture**~~ (done -- all 6 views refactored, 290+ tests, console/CLAUDE.md, #332)
- ~~**Ticket: MCP server stability**~~ (done -- EPIPE crash, stale lock, double SIGTERM, port exhaustion, #332 #335)
