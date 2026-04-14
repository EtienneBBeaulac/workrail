# Now / Next / Later

Lightweight cross-cutting roadmap. **This is the single entry point** -- check here first before digging into tickets or plan docs.

*Last updated: 2026-04-14*

---

## Now

*(nothing actively in progress -- work is in a clean state)*

---

## Next

*(groomed, roughly ordered by value -- ready to execute)*

1. **Assessment-gate adoption in mr-review-workflow** -- The assessment-gate engine feature is real and piloted in `bug-investigation.agentic.v2.json`. The next highest-value target is `mr-review-workflow.agentic.v2.json`. This is about rollout and workflow fit, not engine work. See `docs/plans/mr-review-workflow-redesign.md` and `open-work-inventory.md`.

2. **Trial the quality gate and readiness audit on real diverse tasks** -- `workflow-for-workflows.v2.json` and `production-readiness-audit.json` have been tuned through authoring reasoning, not evidence from varied real runs. Run both on multiple tasks spanning different archetypes. Tune `STANDARD` vs `THOROUGH` depth from what is observed. See `docs/tickets/next-up.md` Ticket 6.

3. **Progress notifications** -- Long workflows block with no agent visibility. Design is mostly done; three open issues remain before implementation: (a) `progressToken` threading through `ToolContext`, (b) `NotificationSender` port to give `advance.ts` access to `sendNotification`, (c) step-node counting (filter `step` nodes only, exclude `blocked_attempt`/`checkpoint`). See `docs/plans/v2-followup-enhancements.md` P2.

4. **Console execution-trace explainability** -- The DAG shows only `node_created`/`edge_created`. Engine decisions (fast paths, skipped phases, condition evaluation, loop entry/exit) are invisible, making legitimate runs look broken. This needs a **design phase first** before any implementation -- see `docs/tickets/next-up.md` Ticket 5 and `docs/ideas/backlog.md`.

5. **Legacy workflow modernization** -- `exploration-workflow.json` is the highest-priority candidate. `mr-review-workflow.json` and `bug-investigation.json` are next. See `docs/roadmap/open-work-inventory.md` for the full prioritized list and what "modernization" means.

---

## Later

*(not yet groomed; rough priority order)*

- **Console engine-trace UX** -- after the design from #4 above is complete and agreed
- **Dashboard artifacts** -- replace file-based docs with session-scoped structured outputs rendered in the console; design exists in `workflow-execution-contract.md`, blocked on a richer console UI substrate
- **Evict stale repo roots** -- `remembered-roots-store` accumulates forever; stale repos inflate worktree counts and slow scanning. Add TTL eviction. See #241.
- **Typed SSE events + server-side `.git/` watchers** -- true live worktree updates without polling; replaces the interval-based worktrees refetch. See #242.
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
- **Equip / unequip workflows from the console** -- `[ EQUIPPED ]` badge, equipped/unequipped visual state, backend toggle endpoint

---

## Recently shipped

*(moved here to keep Now/Next clean)*

- ~~**Console CPU spiral**~~ -- all three fixes shipped: `change` SSE events no longer invalidate worktrees (governed by refetchInterval only), enrichWorktree semaphore at MAX=8, fs.watch filtered to `.jsonl` writes
- ~~**Console MVI architecture**~~ -- all 6 views refactored to Repository → UseCases → Reducer → ViewModel → pure presenter; 290+ new tests; `console/CLAUDE.md` documents the pattern (#332)
- ~~**MCP server stability**~~ -- `wireStdoutShutdown` (EPIPE crash), `clearIfStaleLock` (stale lock after crash), `HttpServer.stop()` idempotency (double SIGTERM), port exhaustion graceful degradation, `openDashboard` degraded-mode guard (#332, #335)
- ~~**HTTP MCP dev environment**~~ -- nodemon + HTTP transport for local dev; `npm run dev:mcp:watch` (#334)
- ~~**Worktree scan parallelization**~~ -- parallel filter, lazy workspace dir, reduced subprocess timeout (#325)
- ~~**Workflow-source setup phase 1**~~ -- rooted team sharing, remembered roots, grouped source visibility (#160–#164)
- ~~**MCP Roots Protocol**~~ -- per-request workspace anchor resolution, `RootsReader`/`RootsWriter` capability split (#75/#78/#147)
- ~~**Content coherence and linked references**~~ -- `StepContentEnvelope`, `WorkflowReference`, parallel resolution, discriminated union types
- ~~**v2 production readiness**~~ -- v2 default-on, feature flag gate removed
- ~~**Retrieval budget and recovery surface**~~ -- 24 KB recovery budget, 2 KB resume preview, deterministic tiering
