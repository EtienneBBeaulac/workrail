# Now / Next / Later

Lightweight cross-cutting roadmap. **This is the single entry point** -- check here first before digging into tickets or plan docs.

*Last updated: 2026-04-14*

---

## Now

*(nothing actively in progress -- work is in a clean state)*

---

## Next

*(groomed, roughly ordered by value -- ready to execute)*

1. **Execution trace Layer 3** -- edge cause diamonds on DAG edges, loop bracket in gutter, `[ CAUSE ]` expandable footer on `blocked_attempt` nodes. No backend changes needed. One data dependency for ghost nodes (skipped steps) -- needs backend confirmation before that sub-feature. See `docs/design/console-execution-trace-discovery.md`.

2. **`fix-multi-instance-gaps` PR** -- branch `fix/etienneb/multi-instance-gaps` has 1 committed, pushed, unpushed-to-PR change: `fix(mcp): resolve three multi-instance safety gaps` (HttpServer.ts, http-entry.ts, tests). Needs a PR opened and merged.

3. **Legacy workflow modernization** -- `exploration-workflow.json` is the highest-priority candidate. `mr-review-workflow.json` and `bug-investigation.json` are next. See `docs/roadmap/open-work-inventory.md` for the full prioritized list and what "modernization" means.

---

## Later

*(not yet groomed; rough priority order)*

- **Console engine-trace UX -- Layer 3b (ghost nodes)** -- skipped steps shown at 0.25 opacity with `[ SKIPPED ]` badge; requires backend to emit skipped step IDs in trace refs
- **Dashboard artifacts** -- replace file-based docs with session-scoped structured outputs rendered in the console; design exists in `workflow-execution-contract.md`
- **Evict stale repo roots** -- `remembered-roots-store` accumulates forever; stale repos inflate worktree counts. Add TTL eviction. See #241.
- **Typed SSE events + server-side `.git/` watchers** -- true live worktree updates without polling. See #242.
- **Authorable response supplements** -- workflow schema surface, validation rules, authoring guidance; design needed first
- **Declarative composition engine** -- spec-driven workflow assembly from pre-validated routines
- **Parallel `forEach` execution** -- concurrent loop iterations with result collection
- **Subagent composition chains** -- chained delegated outputs (researcher → challenger → analyzer)
- **Enforceable verification contracts** -- structured evidence artifacts replacing prose-only verification criteria
- **Assessment-gate tiers beyond v1** -- Tier 2: structured redo recipes; Tier 3: assessment-triggered subflows
- **Workflow rewind / re-scope** -- go back to an earlier checkpoint when scope understanding changes mid-run
- **Remote references** -- `resolveFrom: "url"` for workflow refs pointing at Confluence, GDocs, etc.
- **Workflow categories / category-first discovery** -- flat `list_workflows` is growing noisy; category-first browsing with counts and representative titles
- **Platform evolution** -- discovery, sharing, portable references, MCP resources/prompts (see `docs/plans/workrail-platform-vision.md`)
- **Multi-tenancy and running-workflow upgrades**
- **Console cyberpunk polish** -- scanlines, bracket notation for status badges, letter-spacing 0.30em, `//` separators (see `docs/design/console-cyberpunk-ui-discovery.md` for ranked list)
- **Workflows inventory screen redesign** -- split-pane layout, keyboard-nav item list + persistent detail panel; design-first (see `docs/design/console-ui-backlog.md`)
- **Equip / unequip workflows from the console** -- `[ EQUIPPED ]` badge, backend toggle endpoint
- **Forever backward compatibility** -- `workrailVersion` field in workflows, engine version adapters; see `docs/ideas/backlog.md` (high importance, not yet properly designed)

---

## Recently shipped

*(moved here to keep Now/Next clean)*

- ~~**GitHub branch protection + pre-push hook**~~ -- server-side rule blocks direct pushes; `.git-hooks/pre-push` added (was missing despite `core.hooksPath` local override); Claude hook updated to catch `:main` refspec syntax (#344)
- ~~**Console execution trace explainability -- Layers 1 + 2**~~ -- `[ TRACE ]` tab on each RunCard renders chronological decision log; NodeDetailSection routing sections show `[ WHY SELECTED ]`, `[ CONDITIONS EVALUATED ]` with `[ PASS ]`/`[ SKIP ]` badges; contextFacts chip strip in DAG header (#340)
- ~~**Top-level runCondition tracing**~~ -- `nextTopLevel()` now emits `evaluated_condition` trace entries for each step, explaining why sparse DAGs jump from phase 0 to phase 6; `formatConditionTrace()` produces `SKIP: taskComplexity (equals)` / `PASS: taskComplexity=Medium (not_equals: Small)`
- ~~**Filter chips cross-contamination fix**~~ -- selecting a source no longer hides/changes tag pill counts; `sourceFilteredWorkflows` / `tagFilteredWorkflows` added to ViewModel state
- ~~**Windows CI fix**~~ -- duplicate `createFakeStdout` declaration in shutdown-hooks.test.ts resolved; unblocked release pipeline
- ~~**Trial the quality gate and readiness audit**~~ -- `workflow-for-workflows.v2.json` and `production-readiness-audit.json` exercised extensively on the MVI refactor and MCP stability work; STANDARD/THOROUGH depth validated
- ~~**Assessment-gate adoption in mr-review-workflow**~~ -- `mr-review-workflow.agentic.v2.json` already has assessmentRefs/assessmentConsequences alongside `bug-investigation`, `coding-task-workflow-agentic.lean.v2`, and `workflow-for-workflows.v2`
- ~~**Console CPU spiral**~~ -- all three fixes shipped: `change` SSE events no longer invalidate worktrees, enrichWorktree semaphore MAX=8, fs.watch filtered to `.jsonl` writes
- ~~**Console MVI architecture**~~ -- all 6 views refactored to Repository → UseCases → Reducer → ViewModel → pure presenter; 290+ new tests; `console/CLAUDE.md` documents the pattern (#332)
- ~~**MCP server stability**~~ -- `wireStdoutShutdown` (EPIPE crash), `clearIfStaleLock` (stale lock after crash), `HttpServer.stop()` idempotency, port exhaustion graceful degradation (#332, #335)
- ~~**HTTP MCP dev environment**~~ -- nodemon + HTTP transport for local dev; `npm run dev:mcp:watch` (#334)
- ~~**Worktree scan parallelization**~~ -- parallel filter, lazy workspace dir, reduced subprocess timeout (#325)
- ~~**Workflow-source setup phase 1**~~ -- rooted team sharing, remembered roots, grouped source visibility (#160–#164)
- ~~**MCP Roots Protocol**~~ -- per-request workspace anchor resolution, `RootsReader`/`RootsWriter` capability split (#75/#78/#147)
- ~~**v2 production readiness**~~ -- v2 default-on, feature flag gate removed
- ~~**Retrieval budget and recovery surface**~~ -- 24 KB recovery budget, 2 KB resume preview, deterministic tiering
