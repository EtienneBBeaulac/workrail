# Agent Handoff: May 12, 2026

**Repo:** /Users/etienneb/git/personal/workrail  
**Branch:** main (clean, synced with origin)  
**Last commit:** 0e6141da feat(engine): coordinator-owned delivery for full autonomous pipeline (#1003)

---

## What was accomplished this session

### Shipped

**PR #994 -- parallel spawn_agent + discovery timeout fixes**
- `spawn_agent` now accepts `{ agents: [{workflowId, goal, workspacePath}] }` for concurrent child sessions via `Promise.all`
- `DEFAULT_SESSION_TIMEOUT_MINUTES`: 30 → 60; `DISCOVERY_TIMEOUT_MS`: 55 → 60
- `parseParams()` boundary parser, `SpawnContext` DI bundle, `spawnOne()` extracted helper
- `kind: 'single' | 'parallel'` discriminant on results, `maxItems: 10` schema cap
- 25 tests (13 existing + 12 new)

**PR #1003 -- coordinator-owned delivery (the big one)**
- Full autonomous pipeline now produces commits, PRs, and merges
- `runCoordinatorDelivery(deps, recapMarkdown, branchName, workspace)` -- reads `HandoffArtifact` from recapMarkdown, calls `runDelivery()` from delivery-action.ts
- `spawnSession('wr.coding-task')` gets `branchStrategy: 'worktree'` (isolated branch per coding session)
- `CodingHandoffArtifactV1.branchName` used for `pollForPR()` -- fixes sess_* handle vs branch name mismatch
- `deps.mergePR()` called on clean and post-audit-clean verdicts (was hollow)
- Missing `branchName` escalates immediately (no more silent 5-min poll timeout)
- `runCoordinatorDelivery` returns `Result<string|null,string>` with PR URL -- callers use it directly, `pollForPR()` is fallback only
- `execDelivery` dep added to `AdaptiveCoordinatorDeps` for testable DI
- 390 test files / 6054 tests / 0 failures

**Also shipped today (PRs #995-#997):**
- Removed stale root-level design artifacts
- Committed live design specs (session-budget-cooperative-completion, implementation_plan_session_event_context), research (openclaw), scripts (session-analysis.py)
- AGENTS.md: removed prohibition on committing .md files, added docs/plans/ as canonical home for live design specs

---

## Current state of the codebase

### What works
- Full pipeline technically runs end-to-end: discover → shape → code → deliver (commit + PR) → review → merge
- `spawn_agent` runs N child sessions in parallel
- `worktrain diagnose` for session observability
- `worktrain daemon --start/--stop/--install`
- Crash recovery (sidecar + startup resume)
- Adaptive coordinator pipeline (QUICK_REVIEW, REVIEW_ONLY, IMPLEMENT, FULL modes)

### What is still broken / MVP blockers

**#1 (Score 15): Shared pipeline worktree** -- CRITICAL, filed today
The pipeline creates a worktree for the coding session only. Discovery writes design docs to the main workspace; shaping writes the pitch file. The coding worktree forks from `main` before those files are committed, so the coding agent can't see the pitch or design doc. Cross-phase file handoffs are silently broken.

**Fix needed:** Coordinator creates one worktree at the start of the full pipeline run. All phases share the same workspace path. See `docs/ideas/backlog.md` "Shared pipeline worktree" entry (score 15, MVP critical).

**#2 (Score 13): Intent gap**
Agent builds what it understood, not what was meant. The pipeline runs but often solves the wrong problem. Needs interpretation checkpoint before coding starts. See backlog items: "Intent gap", "Intent resolution", "Scope rationalization".

**#3: `implementation_plan_session_event_context.md`** (in docs/plans/)
`SessionEventContext` + provider/modelId on DaemonEvent is designed but not built. All 29 emit call sites use scattered positional params. Low risk, medium effort. Plan is at `docs/plans/implementation_plan_session_event_context.md`.

**#4: `session-budget-cooperative-completion.md`** (in docs/plans/)
Cooperative session completion (no hard kill) -- sessions that are close to completing a step when the timeout fires should get a grace window. Designed, not built. `docs/plans/session-budget-cooperative-completion.md`.

---

## Key architectural context

### Three systems -- do NOT conflate
1. **WorkRail MCP server** (`workrail start`) -- stdio MCP for Claude Code, DO NOT touch for daemon work
2. **WorkTrain daemon** (`worktrain daemon`) -- autonomous agent runner, calls engine directly
3. **WorkTrain console** (`worktrain console`) -- read-only HTTP session viewer

### Coordinator architecture
- Entry: `src/trigger/trigger-listener.ts` (github_queue_poll triggers) → `TriggerRouter.dispatchAdaptivePipeline()`
- Routing: `src/coordinators/routing/route-task.ts` (pure, synchronous) → QUICK_REVIEW / REVIEW_ONLY / IMPLEMENT / FULL
- Pipeline executors: `src/coordinators/modes/`
- Coordinator deps: `src/trigger/coordinator-deps.ts` -- ALL I/O injected, all testable

### Delivery architecture (just shipped, PR #1003)
- `src/coordinators/coordinator-delivery.ts` -- `extractPrNumberFromUrl()` + `runCoordinatorDelivery()`
- `runCoordinatorDelivery()` reads `HandoffArtifact` from `recapMarkdown` (the handoff JSON block in step notes), calls `runDelivery()` from `src/trigger/delivery-action.ts`
- `CodingHandoffArtifactV1` (`branchName`, `keyDecisions`) ≠ `HandoffArtifact` (`commitType`, `prTitle`, `prBody`) -- different types serving different purposes
- `runDeliveryPipeline()` from `src/trigger/delivery-pipeline.ts` is daemon-coupled (imports WorkflowRunSuccess) -- NEVER call it from coordinator

### Worktree naming (after PR #1003)
- Trigger-dispatched: branch = `${branchPrefix}${runId}` where runId = process-local UUID
- Coordinator-spawned: branch = `CodingHandoffArtifactV1.branchName` (agent-reported, interim until shared pipeline worktree)

---

## Top priorities for next agent

1. **Implement shared pipeline worktree** (score 15, MVP critical)
   - Coordinator creates one worktree before first session spawn
   - All phases (discovery, shaping, coding, review) use the same workspace path
   - Coordinator names the branch (deterministic, known before any session)
   - `pollForPR()` and `runCoordinatorDelivery()` use the coordinator-known branch name
   - Cleanup in `runFullPipeline()` finally block
   - See `docs/ideas/backlog.md` "Shared pipeline worktree" for design questions

2. **Parallel tool execution in AgentLoop** (score 13)
   - Add `isConcurrencySafe(): boolean` and `isReadOnly(): boolean` to `AgentTool` interface
   - `partitionToolCalls()` batching in `AgentLoop._executeTools()`
   - `runToolsConcurrently(cap=10)` via bounded `Promise.all`
   - See `docs/ideas/backlog.md` "Parallel tool execution" + `research/wr-research-ccloop-001/brief.md` for Claude Code implementation details

---

## Files to read before starting any new work

1. `AGENTS.md` -- full architectural rules and working principles
2. `docs/vision.md` -- north star
3. `docs/ideas/backlog.md` (run `npm run backlog -- --min-score 12 --unblocked-only`)
4. `docs/design/full-pipeline-delivery-design.md` -- coordinator delivery architecture
5. `research/wr-research-ccloop-001/brief.md` -- Claude Code agent loop patterns

## Dev loop

```bash
npm run watch          # auto-recompile on save
npm run dev:mcp:watch  # auto-restart MCP server
npx vitest run         # run all tests (390 files, ~36s)
npm run backlog -- --min-score 12 --unblocked-only  # top work items
```
