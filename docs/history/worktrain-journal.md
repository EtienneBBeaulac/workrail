# WorkTrain Development Journal

Historical narrative, sprint summaries, status updates, and architectural decision records.
Not a backlog -- use `docs/ideas/backlog.md` and `docs/roadmap/` for actionable items.

---

## WorkTrain / WorkRail session: Apr 29, 2026 (continued) -- daemon Phase 3 refactor

### What shipped (PRs #835, #837)

**PR #835: Turn_end subscriber extraction + tool param validation**

Extracted the 126-line inline turn_end subscriber from `runWorkflow()` into `buildTurnEndSubscriber(ctx: TurnEndSubscriberContext)`. The mutable `lastFlushedMessageCount` counter became `lastFlushedRef: { count: number }` -- a plain object shared by reference between the subscriber and the `finally`-block final flush. `runWorkflow()` body reduced from ~426 to ~539 lines... wait, wrong direction. From 539 → 426 lines.

Also added required-field validation at the top of 8 tool `execute()` functions (Bash, Read, Write, Glob, Grep, Edit, spawn_agent, report_issue, signal_coordinator). `complete_step` already validated; `continue_workflow` delegates to the engine. Each validation throws `Error` with a clear message -- `AgentLoop._executeTools()` catches all throws and converts to `isError` tool_results so the LLM can self-correct. 22 new unit tests in `workflow-runner-tool-validation.test.ts`.

**PR #837: buildAgentCallbacks + buildSessionResult extractions + test flakiness fix**

Extracted the 40-line inline `agentCallbacks` object into `buildAgentCallbacks(sessionId, state, modelId, emitter, stuckRepeatThreshold): AgentLoopCallbacks`. The `onToolCallStarted` callback still mutates `state.lastNToolCalls` -- that's intentional and documented.

Extracted the 82-line result-building block into `buildSessionResult(state, stopReason, errorMessage, trigger, sessionId, sessionWorktreePath): WorkflowRunResult` -- a pure function. `runWorkflow()` calls it and then delegates all I/O to the existing `finalizeSession()`. `runWorkflow()` body: 426 → 308 lines.

13 new unit tests covering all 4 result paths (stuck/timeout/error/success), the stuck-over-timeout priority invariant, issueSummaries threading, wall_clock vs max_turns messages, worktree path threading, and botIdentity threading.

Also fixed a pre-existing test flakiness issue: `writeExecutionStats()` is fire-and-forget, and under load with 4 parallel vitest workers its async write chain sometimes didn't complete before tests read the stats file. Fix: added `settleFireAndForget()` before `readStatsFile()` in the stats contract tests (waits for `stats-summary.json` which is written last in the chain), and added `retry: 2` to the vitest config for all test projects.

### runWorkflow() line count progression

| After PR | Lines |
|---|---|
| Pre-refactor (original) | ~880 (body only, in 4900-line file) |
| PR #818 (Phase 1) | ~700 |
| PR #830 (Phase 2: buildPreAgentSession, constructTools) | ~539 |
| PR #835 (Phase 3a: buildTurnEndSubscriber) | ~426 |
| PR #837 (Phase 3b: buildAgentCallbacks, buildSessionResult) | ~308 |

### What's still open

- `CriticalEffect<T>` / `ObservabilityEffect` type distinction -- deferred (requires changing all fire-and-forget call sites)
- `StateRef` mutation wrapper -- deferred as YAGNI
- `ContextBundle` with layer provenance -- deferred as YAGNI (no consumer)
- Zod tool param validation (replacing manual `typeof` checks) -- deferred (requires zodToJsonSchema or accepting two sources of truth)
- `wr.refactoring` workflow -- captured in backlog

---

## WorkTrain / WorkRail session: Apr 28-29, 2026 -- architecture, engine bug fix, workflow improvements

### What shipped (PR #830)

**Daemon architecture refactors (2 commits):**

The session started with a thorough analysis of `workflow-runner.ts` against the project's coding philosophy, which surfaced concrete violations. Two incremental refactors landed:

1. `refactor(engine): extract sidecardLifecycleFor, fix TDZ in abort registry` -- extracted `sidecardLifecycleFor(tag, branchStrategy): SidecarLifecycle` as a pure function with `assertNever` exhaustiveness; replaced scattered `isWorktreeSuccess` conditionals in `finalizeSession`. Fixed the TDZ hazard where `abortRegistry.set(() => { agent.abort() })` was registered before `const agent = new AgentLoop(...)` was initialized -- moved registration after agent construction, removed the two dead `abortRegistry.delete()` calls that had existed only as workarounds. Also updated `worktrain-daemon-invariants.md` sections 2.2 and 3.4.

2. `refactor(engine): full runWorkflow architecture -- PreAgentSession, constructTools, Result type` -- full functional core / imperative shell split for `runWorkflow()`. Added `PreAgentSession` interface and `PreAgentSessionResult` discriminated union making all early-exit paths type-enforced rather than convention-enforced. Added `buildPreAgentSession()` which handles all pre-agent I/O (model validation, start_workflow, token decode, persistTokens, worktree creation, registry setup) and returns `{ kind: 'ready' | 'complete' }`. Added `constructTools()` as an explicitly impure named function with `state` as an explicit parameter documenting the intentional closure impurity. Changed `persistTokens()` to return `Promise<Result<void, PersistTokensError>>` using `src/runtime/result.ts` -- tool factory call sites log-and-continue on err (invariant 4.3 preserved), setup call sites abort on err. FM1 invariant: steer+daemon registries now registered after all potentially-failing I/O in `buildPreAgentSession`, so error paths have nothing to clean up.

**Engine bug fix (2 commits):**

The `wr.bug-investigation` workflow was run against a bug we observed directly: Phase 7 of `wr.coding-task` was silently skipped for Large tasks. Investigation (done independently from scratch, not trusting a prior subagent's diagnosis):

Root cause: `collectArtifactsForEvaluation()` in `v2-context-budget.ts` passed ALL session-history `NODE_OUTPUT_APPENDED` artifacts to `interpreter.next()`. For sequential `artifact_contract` while loops, this caused the second loop to find the first loop's stale `{ decision: stop }` artifact via `findLoopControlArtifact()` and exit immediately on iteration 0. A false comment in `loop-control.ts` stated "nested loops are not supported, so there is at most one active loop" -- true for nested, false for sequential.

Fix: `outcome-success.ts` now passes only `inputOutput?.artifacts ?? []` (the current step's submitted artifacts) to `interpreter.next()`. Historical session artifacts are never the correct source for a loop-control decision -- the exit-decision body step's artifact is always in the current call's `inputArtifacts`. Removed `collectArtifactsForEvaluation()` entirely (dead code after the fix), deleted its unit test file, rewrote the integration test to test the correct single-source contract, corrected the false comment.

**Workflow improvements (2 commits):**

`wr.coding-task` v1.3.0:
- Phase 0 architecture alignment check: agent must scan candidate files and name philosophy violations explicitly (specific function names, line-level violations) -- not assert absence. Captures `architectureViolations` and `architectureStartsFromScratch`.
- Phase 1c conditional fragment: when `architectureStartsFromScratch = true`, injected constraint blocks adapting existing philosophy violations as valid design candidates.
- Phase 8 post-implementation retrospective: runs for all tasks (no complexity gate). Four practical questions: what would you do differently, what adjacent problems were revealed, what follow-up is now visible, what surprised you. Requires 2-4 concrete observations with explicit disposition (filed/accepted/fixed). No philosophy vocabulary -- works for any user.

Also fixed the CI lockfile issue: npm 11 (local) omits `@emnapi/core` and `@emnapi/runtime` package entries that npm 10 (CI, Node 22.14.0) requires. Added the two missing entries manually.

### Key architectural decision: proper fix vs patch for the loop bug

The first instinct was to pass only `inputArtifacts` as a workaround. The correct framing: this IS the proper fix, because it restores the correct abstraction boundary. `interpreter.next()` is a pure function -- it should receive only what's relevant to the current decision. The caller (`outcome-success.ts`) was the architectural error by mixing session history into a current-decision evaluation. Fixing the caller, not adding complexity to the interpreter to compensate.

### Key architectural decision: why the daemon wasn't architected properly from the start

`workflow-runner.ts` grew incrementally -- each feature PR (worktrees, spawn_agent, crash recovery, stuck detection, signal_coordinator) added 50-100 lines to the function. The `wr.coding-task` workflow guides agents to think about architecture but doesn't enforce it against existing code. Phase 0 finds the philosophy document but never asks: does the existing code violate it? The architecture enforcement addition to Phase 0 and the retrospective in Phase 8 are the workflow's response to this observed failure mode.

### What's still deferred

- `CriticalEffect<T>` for `persistTokens` callers (requires changing return type + all call sites -- separate PR)
- `StateRef` mutation wrapper (deferred as YAGNI)
- Zod tool param validation at LLM boundary (separate PR)
- `wr.refactoring` workflow (captured in backlog)

---

## WorkTrain sprint: Apr 17-18, 2026 -- shipped and current state

### What shipped (Apr 17-18)

**Daemon stabilization:**
- `report_issue` tool -- agents call this instead of dying silently; structured JSON written to `~/.workrail/issues/<sessionId>.jsonl`, event emitted to daemon stream, WORKTRAIN_STUCK marker in `WorkflowRunResult`
- Richer `BASE_SYSTEM_PROMPT` -- baked-in behavioral principles (oracle hierarchy, self-directed reasoning, workflow-as-contract, silent failure policy) rather than relying on soul file alone
- `/bin/bash` for Bash tool -- process substitution `<(...)` and other bash-specific syntax now works
- `DaemonEventEmitter` -- structured event stream at `~/.workrail/events/daemon/YYYY-MM-DD.jsonl`
- Self-configuration -- `triggers.yml`, upgraded `daemon-soul.md` (WorkRail-specific rules + coding philosophy), `AGENTS.md` WorkTrain section

**Workflow library:**
- mr-review v2.6 -- `philosophy_alignment` reviewer family; scoped philosophy extraction in fact packet; 7th coverage domain; "is this the right design?" framing
- wfw v2.5 -- phases 2 and 3 split into dedicated prep-step design steps (2a/2b, 3a/3b); principle: assessments need dedicated prep steps, not on-the-fly evidence gathering
- Clean workflow display names across library (removed `v2 •`, `Lean •`, etc.)
- `philosophy.mdc` created at `~/.firebender/commands/philosophy.mdc` -- MR review subagents now evaluate findings against coding philosophy

**Integrations and infrastructure:**
- GitLab polling triggers fully merged (#404) -- zero-webhook MR polling
- TS6 forward-compat tsconfig fixes (#401) -- unblocks TypeScript 6 dep bumps
- Standalone console spec -- `worktrain console` as independent file-reading binary, zero coupling to daemon or MCP server

---

### Current state (Apr 18, 2026)

**What works:**
- Daemon runs autonomously on webhook triggers
- Sessions advance through full workflow steps
- Console at `:3456` when daemon starts before MCP server
- Daemon event stream logging every tool call
- GitLab + GitHub polling (no webhooks needed)
- Philosophy-aligned MR reviews
- `report_issue` tool available to agents

**Known issues / active bugs:**

1. **Daemon killed by MCP server reconnects** (CRITICAL) -- the daemon and MCP server share process infrastructure via the bridge mechanism. When Claude Code reconnects and a new MCP server process starts, it displaces the running daemon. The daemon must be run from a separate terminal or as a `launchd` service to survive MCP reconnects. Root fix: decouple daemon from the MCP server process tree entirely.

2. **Console unstable** -- the console port (3456) is contested between daemon and MCP server. Whoever starts first wins. When the MCP server reconnects, it takes the port and the daemon console goes down. Root fix: standalone `worktrain console` binary (spec in backlog).

3. **`workflow_not_found` on first test** -- trigger used `coding-task-workflow-agentic.lean.v2` (filename) instead of `coding-task-workflow-agentic` (workflow ID). Fixed in triggers.yml. Symptom of workflow ID vs filename confusion -- worth a validator that catches this at `worktrain daemon` startup.

4. **Session advances 0 when daemon crashes** -- if daemon dies mid-Phase-0 (before any `continue_workflow` call), the session is orphaned at `observation_recorded(8)` with 0 advances and no output. No automatic recovery. Crash recovery reads the daemon-session token file but can't resume a session that never advanced. No fix yet.

---

### Next priorities (groomed Apr 18)

**Tier 1 -- Must fix for reliable autonomous operation:**
1. **Daemon as a launchd service** -- run daemon outside Claude Code's process tree so MCP reconnects can't kill it. `worktrain daemon --install` creates a launchd plist and starts it.
2. **Standalone `worktrain console`** -- file-watching binary independent of daemon/MCP. Zero coupling. Spec in backlog.
3. **Workflow ID validation at startup** -- `workrail daemon` should validate that all `workflowId` values in triggers.yml resolve to real workflows before starting, not fail silently at dispatch time.

**Tier 2 -- Workflow quality:**
4. **mr-review prep steps** -- the audit identified missing dedicated prep steps for philosophy extraction, pattern baseline, and design decision reconstruction. These are described in the backlog but not yet in the workflow JSON. wfw v2.5 guides new workflows to add them; the mr-review workflow itself still needs a v2.7 pass to implement them.
5. **Autonomous workflow variants** -- audit `requireConfirmation` gates across all workflows; confirm daemon's `autonomy: full` setting correctly bypasses the right ones.

**Tier 3 -- Features:**
6. **`worktrain spawn` / `worktrain await`** -- already merged, needs real-world test
7. **Auto-commit from handoff artifact** -- merged but untested end-to-end
8. **Session knowledge log** -- continuous context accumulation for subagent packaging
9. **TypeScript 6 dep bump** -- tsconfig fixes are in (#401), unblocks #244 and #231

**Open PRs (only dep bumps remain):**
- #330, #287, #288 -- vitest 4 + vite 8 (major version, needs testing)
- #244, #231 -- TypeScript 6.0.2 (now unblocked by #401)

---

### Duplicate task detection: prevent agents from doing the same work twice (Apr 18, 2026)

**The problem:** with multiple agents running concurrently and a persistent work queue, it's easy to accidentally start two agents on the same task -- especially when the queue drains items from external sources (GitHub issues, Jira) that may be added again after a sync. Today, two agents can independently pick up the same issue, do the same investigation, and open duplicate PRs.

**Detection sources:**
1. **Open PRs**: before starting any coding task, check `gh pr list --state open` -- if a PR already exists that addresses the same issue/goal, skip it
2. **Active sessions**: the session store knows which workflows are currently running and what their goals are; a new dispatch can check for semantic overlap before starting
3. **Queue deduplication**: the work queue should deduplicate by external item ID (GitHub issue number, Jira ticket key) so the same item can't be enqueued twice
4. **Session history**: before starting an investigation, check recent session notes for the same workflowId + goal combination -- if it was completed in the last 24 hours with a successful result, skip or ask the user

**Implementation approach:**
- Queue-level dedup is the simplest and most reliable: each queue item from an external source carries its `sourceId` (e.g. `github:EtienneBBeaulac/workrail:issues:123`). On enqueue, check if `sourceId` already exists in the queue (pending or active) -- if so, skip with a log.
- PR-level dedup: before `worktrain spawn` dispatches a coding task, run `gh pr list --search "<issue title keywords>"` and check for matches. If found, add to outbox ("task already in progress as PR #X") and skip.
- Session-level dedup: the coordinator script checks active session goals before spawning a new one with the same goal text.

**The classify-task-workflow role:** when a task is classified, it can also output a `deduplicationKey` (e.g. `fix:trigger-store:error-kind-consistency`) that is stored with the queue item. Queue items with the same key are considered duplicates.

**What makes this hard:** semantic dedup (two tasks described differently but solving the same problem) requires embedding-based similarity, not exact match. For MVP, exact `sourceId` match + approximate PR title search is sufficient. Semantic dedup is a post-knowledge-graph feature.

---

### Agent actions as first-class events in the session event log (Apr 18, 2026)

**The vision:** the console should be able to reconstruct exactly what an agent did in a session -- every tool call, every argument, every result, every decision -- by reading the event log alone. No log files, no stdout parsing, no separate monitoring infrastructure. The session event store IS the audit trail.

**What's already in the event log:**
- `session_created`, `run_started`, `run_completed`
- `node_created`, `edge_created`, `advance_recorded`
- `node_output_appended` (step notes)
- `preferences_changed`, `context_set`, `observation_recorded`

**What's missing -- agent-level actions:**
- `tool_call_started` -- which tool was called, with what arguments, at what timestamp
- `tool_call_completed` -- result (truncated), duration, success/error
- `llm_turn_started` -- model, token count estimate, step context
- `llm_turn_completed` -- stop reason, output tokens, whether steer() was injected
- `steer_injected` -- what context was injected and why (session recap, workspace context)
- `report_issue_recorded` -- the structured issue from the `report_issue` tool
- `worktrain_stuck` -- when WORKTRAIN_STUCK marker is emitted

**Why this matters:**
Today the `DaemonEventEmitter` writes to `~/.workrail/events/daemon/YYYY-MM-DD.jsonl` separately from the session store. That's two places to look -- and they're not correlated to specific sessions. Putting agent actions into the session event log means:
- Console can show a session timeline: "Phase 0: called `bash` 3 times (12ms, 8ms, 45ms) → called `read` 2 times → advanced to Phase 1"
- The proof record (verification chain spec) can link specific tool calls to assessment gate evidence
- Crash recovery knows exactly where in the agent's execution it died
- The knowledge graph can be updated from session events without re-reading step notes

**The event schema (additions to the existing event store format):**

```typescript
// Tool call lifecycle
{ kind: 'tool_call_started', tool: 'bash', args: { command: 'git status' }, nodeId, ts }
{ kind: 'tool_call_completed', tool: 'bash', durationMs: 45, exitCode: 0, resultSummary: '...', nodeId, ts }
{ kind: 'tool_call_failed', tool: 'bash', durationMs: 45, error: 'ENOENT', nodeId, ts }

// LLM turn lifecycle  
{ kind: 'llm_turn_started', model: 'claude-sonnet-4-6', inputTokens: 12000, nodeId, ts }
{ kind: 'llm_turn_completed', stopReason: 'tool_use', outputTokens: 450, toolsRequested: ['bash'], nodeId, ts }

// Steer injection
{ kind: 'steer_injected', reason: 'session_recap', contentLength: 800, nodeId, ts }

// Agent self-reporting
{ kind: 'report_issue_recorded', severity: 'warning', summary: '...', sessionId, ts }
```

**Where to emit them:**
- In `src/daemon/agent-loop.ts` -- before and after each `tool.execute()` call, before and after each LLM call
- In `src/daemon/workflow-runner.ts` -- for steer injection and report_issue recording
- Use the existing `V2ToolContext` session store to append events (same mechanism as `continue_workflow` and `start_workflow`)

**Console rendering:**
Each session detail view gets a "Timeline" tab alongside "Steps" and "Notes":
```
Phase 0: Understand & Classify         [2m 14s]
  ├── llm_turn              450 tokens → 3 tool calls
  ├── bash: git status                    45ms ✓
  ├── bash: gh pr list                   180ms ✓  
  ├── read: AGENTS.md                      8ms ✓
  └── llm_turn              280 tokens → advance
Phase 1a: State Hypothesis              [0m 38s]
  ├── llm_turn              310 tokens → advance
  ...
```

**Relationship to DaemonEventEmitter:**
The existing `DaemonEventEmitter` (written in #498) writes to a separate daily log file. Once agent actions are first-class session events, the daemon event emitter can be simplified or removed -- the session event log is the canonical record. The console reads session events, not daemon event files.

**Build order:**
1. Add `tool_call_started`/`tool_call_completed` events to `agent-loop.ts` -- smallest change, highest value
2. Add `llm_turn_started`/`llm_turn_completed` events
3. Console Timeline tab reads and renders the new event kinds
4. Wire `report_issue_recorded` and `steer_injected` events
5. Deprecate `DaemonEventEmitter` once console reads from session events

---

### FatalToolError: distinguish recoverable from non-recoverable tool failures (follow-up from PR #523)
The blanket try/catch in AgentLoop._executeTools() converts ALL tool throws to isError tool_results. This is correct for Bash/Read/Write (LLM can see and retry), but potentially wrong for continue_workflow failures (LLM retrying with a broken token loops). The discovery agent proposed a FatalToolError subclass: tools throw FatalToolError for non-recoverable errors (session corruption, bad tokens), plain Error for recoverable failures. _executeTools catches plain Error and returns isError; FatalToolError propagates and kills the session. Combined with the DEFAULT_MAX_TURNS cap (PR followup), this provides defense-in-depth.

---

### Worktree lifecycle management: automatic cleanup and inventory (Apr 18, 2026)

**The problem:** every WorkTrain agent that uses `--isolation worktree` leaves a worktree on disk after completion. With 10 concurrent agents running all day, this accumulated to 69 worktrees in `.claude/worktrees/`, triggering hundreds of simultaneous `git status` processes that saturated the CPU.

**What's needed:**

1. **Automatic cleanup on session end** -- when a WorkTrain session completes (success or failure), the daemon automatically runs `git worktree remove <path> --force` for the session's worktree. If the branch is already merged to main, also delete the local branch ref.

2. **Startup pruning** -- `workrail daemon` startup runs `git worktree prune` in each configured workspace before starting the trigger listener.

3. **`worktrain worktree list`** -- shows all WorkTrain-managed worktrees: path, branch, session ID, age, whether the branch is merged.

4. **`worktrain worktree clean`** -- removes all worktrees whose branches are merged to main, or older than N days. Dry-run mode by default.

5. **`worktrain worktree status`** -- summary: how many worktrees, total disk usage, any stale ones.

6. **Never use main as a worktree** (already in backlog) -- enforced at worktree creation time, not just as a rule.

**Root cause of the CPU spike:** 69 worktrees × repeated `git status --short` from tools/IDE plugins = hundreds of concurrent git processes. Each `git status` on a large repo with many untracked files is CPU-intensive.

**Mitigation already in place:** `--isolation worktree` creates branches named `worktree-agent-<id>` -- these are identifiable and bulk-deletable. The daemon's `runStartupRecovery()` could also prune them.

**Build order:** startup pruning (trivial, high value) → automatic cleanup on session end → `worktrain worktree` CLI commands.

---

### Simplify MCP server: remove primary election, bridge, and HTTP serving (architectural cleanup)

**The core insight:** the bridge/primary-election system exists solely to solve "only one process should serve the console UI on port 3456." Now that `worktrain console` is a standalone file-watching binary (PR #512), that problem is already solved. The entire bridge/election system can be removed.

**What "allow multiple MCP processes" means in practice:**
- Each Claude Code window gets its own MCP server -- no port contention, no primary election, no bridge reconnect cycles
- MCP server becomes pure stdio: starts, handles tools, exits. Nothing async needs to write after the pipe closes -- EPIPE is irrelevant.
- Session store is append-only JSONL per-session -- multiple processes writing different sessions cannot corrupt each other
- `worktrain console` aggregates all sessions from the file store regardless of how many MCP servers ran

**What to remove:**
- `DashboardLock` / `tryBecomePrimary()` / `bindWithPortFallback()` -- the entire primary election system
- `bridge-entry.ts` -- the bridge, spawn storm, and reconnect drama are gone
- `HttpServer` starting as part of the MCP server -- console owns HTTP, not MCP

**What remains for the MCP server:** pure stdio MCP protocol + session engine. No HTTP, no port binding, no lock files. Starts instantly, exits cleanly.

**Why this is safe:**
- Tokens are session-scoped UUIDs -- two servers cannot share a session
- Append-only JSONL has no exclusive file locks
- ~50MB per process × 3 Claude Code windows = 150MB -- acceptable

**The bridge complexity was always a band-aid.** It was the right solution when the MCP server also owned the console UI. With the standalone console, the band-aid can come off and the system becomes dramatically simpler and more reliable.

**Build order:** extract `worktrain console` fully (done) → remove HttpServer from MCP startup → remove bridge → remove DashboardLock/primary election → MCP server is pure stdio.

---

### Agent-engine communication: first principles design (Apr 18, 2026)

**The setup for this conversation:**

Three discovery agents investigated whether the daemon should continue using MCP-style tool calls for workflow control (`continue_workflow`). Their findings:

- **Discovery 1**: Tool calls are fine; enrich `continue_workflow` with `artifacts` now, explore structured output hybrid later pending Bedrock verification. ~225 tokens/request saved with hybrid.
- **Discovery 2**: `complete_step` tool -- daemon owns transitions, continueToken hidden from LLM, notes required at type level. Cleaner DX without paradigm shift.
- **Discovery 3**: The field has converged on tool calls. OpenAI Agents SDK, LangGraph, Temporal, Vercel AI SDK all use tool calls for workflow control. WorkRail's `continue_workflow` with HMAC tokens is already field-standard or better.

**User's response to "the field has converged on tool calls":**

> "Right, but do we want industry standards? Aren't we trying to build something special? What if there is better?"

This is the right question. "Field convergence" is a description of where everyone ended up starting from the MCP/function-calling paradigm -- not proof that it's optimal. Every system surveyed treats the workflow engine as external infrastructure the agent calls into. WorkRail is different: **the daemon IS the workflow engine**. The agent loop and the step sequencer run in the same process, sharing the same DI container. Tool calls are a network-origin concept -- they exist because there's an LLM over there and an executor over here. WorkRail doesn't have that constraint.

---

#### First-principles alternatives (unexplored territory)

These were not in any of the discovery agents' outputs -- they emerge from the insight that WorkRail owns both sides of the conversation:

**1. Structured response parsing (no tool call for workflow control)**
The agent outputs a structured response at the end of each turn. The daemon parses it. The LLM never "calls a tool" to advance -- it produces a well-structured output and the daemon acts on it. The continueToken and workflow machinery are completely invisible to the LLM. Example: agent outputs `{"step_complete": true, "notes": "...", "artifacts": [...]}` as its final text, daemon detects this and advances.

**2. Implicit advancement (criteria-based)**
The daemon watches what the agent produces (file writes, bash outcomes, notes) and decides when to advance -- the agent never explicitly signals "I'm done." The workflow step has completion criteria, and the daemon evaluates them against the agent's cumulative output. More like a CI pipeline (tests pass = done) than an API call. The agent just works; the daemon decides when the step is complete.

**3. Declarative intent + daemon execution**
The agent outputs what it *wants* to happen: "I want to commit these files with this message and advance to the next step." The daemon executes. Same as the scripts-over-agent principle applied to the agent's own workflow control -- the agent declares intent, scripts execute. No tool call for the mechanical parts.

**4. Streaming judgment**
The daemon reads the agent's streaming response in real-time, extracts notes and artifacts as they appear, and makes the advance decision before the agent "finishes." No explicit signal from the agent. The daemon monitors and decides.

**5. Separation of concerns: tools for world, declaration for workflow**
Keep tool calls for external actions (Bash, Read, Write) -- these genuinely need interleaved execution and result reasoning. But workflow control (advance, submit artifacts, set context) uses a different mechanism entirely: structured response, implicit detection, or a single lightweight declaration. The protocol distinction: tools are for I/O, declarations are for state.

---

#### What makes this hard

These alternatives trade off in important ways:
- **Structured response parsing**: requires reliable structured output from the LLM, which can fail without explicit enforcement
- **Implicit advancement**: requires the daemon to correctly evaluate completion criteria -- complex for open-ended steps
- **Declarative intent**: still needs some kind of output format; essentially moves the "tool call" into the response text
- **Streaming judgment**: hardest to implement correctly; requires the daemon to parse partial responses reliably

The current tool-call approach works precisely because it's explicit: the agent signals intent exactly once, the daemon acts on it. The alternatives are more elegant but less reliable.

---

#### What to actually investigate

Before committing to any alternative, these questions need answers:

1. **Does Bedrock support `response_format + tools` simultaneously?** A 10-line test call resolves this. If yes, hybrid structured output is immediately viable for workflow control.
2. **What does implicit advancement actually look like for a coding task?** Write out the completion criteria for `coding-task-workflow-agentic` phase-0 (classify). Can a daemon reliably detect "Phase 0 is done" without an explicit signal?
3. **What is the actual failure mode of structured response parsing?** How often does Claude 4.6 Sonnet fail to produce valid JSON when asked to end its turn with a structured summary? Under what conditions?
4. **What did nexus-core do?** The backlog notes nexus-core as a more advanced system -- how does it handle agent-step transitions?

These are prototype questions, not design questions. Build the smallest possible test for each before committing to any direction.

---

### Bundled trigger templates: zero-config workflow automation via worktrain init (Apr 18, 2026)

**Problem:** Every user has to write their own triggers.yml manually. Wrong workflow IDs, missing required fields, wrong workspace paths -- all common mistakes (we hit all three today). There's no "just works" path to workflow automation.

**Solution:** Ship common trigger templates bundled with WorkTrain. `worktrain init` presents a menu and generates a pre-filled triggers.yml.

**Bundled templates to ship:**

```yaml
# Template: mr-review
- id: mr-review
  workflowId: mr-review-workflow-agentic
  goal: "Review the PR specified in the webhook payload goal field"
  concurrencyMode: parallel
  autoCommit: false
  agentConfig: { maxSessionMinutes: 30 }

# Template: coding-task  
- id: coding-task
  workflowId: coding-task-workflow-agentic
  concurrencyMode: parallel
  autoCommit: false
  agentConfig: { maxSessionMinutes: 60 }

# Template: discovery-task
- id: discovery-task
  workflowId: wr.discovery
  concurrencyMode: parallel
  autoCommit: false
  agentConfig: { maxSessionMinutes: 60 }

# Template: bug-investigation
- id: bug-investigation
  workflowId: bug-investigation.agentic.v2
  agentConfig: { maxSessionMinutes: 45 }

# Template: weekly-health-scan (cron, when native cron trigger ships)
# - id: weekly-health-scan
#   type: cron
#   schedule: "0 9 * * 0"
#   workflowId: architecture-scalability-audit
```

**`worktrain init` flow:**
1. "Which workflows do you want to run automatically?" (checkbox menu)
2. For each selected: set `workspacePath` to current directory (overridable)
3. Generate `triggers.yml` in the workspace root
4. Validate workflow IDs exist before writing (use the startup validator)
5. Tell the user how to fire each trigger: `curl -X POST http://localhost:3200/webhook/<id> ...`

**Why this matters:** The difference between WorkTrain being usable by anyone vs only by engineers who read the source code. A new user should be able to go from `worktrain init` to their first automated workflow in under 5 minutes.

**Also needed:** `worktrain trigger add <template-name>` to add a single trigger to an existing triggers.yml without re-running init.

---

### Coordinator context injection standard: agents start informed, not discovering (Apr 18, 2026)

**The problem:** subagents spawned by a coordinator are completely blind. They know nothing of prior conversations, existing docs, the pipeline, or what's already been tried. The workflows compensate by spending 3-5 turns on "Phase 0: context gathering" every session -- expensive in tokens, time, and LLM turns -- just to get oriented before work starts.

**The root cause:** the coordinator spawns agents with task descriptions but not context. "Fix the Windows CI failures" is a task. "The Windows CI failures are in `workflow-runner-bash-tool.test.ts` because `node -e` isn't in PATH on Windows -- the fix is to use `process.execPath` instead of `node`, which is the established pattern in this codebase" is context. The difference is 0 discovery turns vs 5.

**The standard to establish:**

Every coordinator-spawned agent gets a pre-packaged context bundle. The coordinator assembles it before calling `worktrain spawn`. The bundle includes:

1. **Prior session findings** -- what relevant sessions discovered (from session store query)
2. **Established patterns** -- the specific invariants and patterns the agent needs (from knowledge graph or AGENTS.md)
3. **What NOT to discover** -- explicit list of things already known so the agent doesn't waste turns
4. **Failure history** -- what's been tried and didn't work (prevents re-exploring dead ends)

**Format:** ~2000 tokens max, injected as a `<context>` block before the task description. Structured so the agent can skip Phase 0 context gathering entirely when the bundle is complete.

**Build order:**
1. Write the standard as a prompt template for coordinator scripts (`worktrain spawn` calls)
2. The knowledge graph provides the infrastructure for querying relevant context automatically
3. Eventually: `worktrain spawn` reads the context bundle from the graph + session store automatically, coordinator doesn't have to assemble it manually

**Why this is high priority:** every agent spawned today without proper context is burning tokens on discovery that should have been provided upfront. At 10 concurrent agents, that's 10x the waste. With proper context injection, Phase 0 becomes 1 turn instead of 5, and output quality improves because the agent starts with the right mental model.

---

### Context budget per spawned agent: capped, structured, queryable (Apr 18, 2026)

**The companion spec to context injection:**

Rather than hoping agents discover the right context, the coordinator guarantees a minimum context budget: a pre-packaged bundle of ~2000 tokens that every agent starts with. The knowledge graph is what makes this scalable -- without it, the coordinator has to manually assemble context from files, which is itself expensive.

**Bundle contents (structured):**
- `<relevant_files>` -- paths + key excerpts from files the agent will likely touch (from KG query)
- `<prior_sessions>` -- summaries of the last 3 sessions that touched related code (from session store)
- `<established_patterns>` -- specific patterns the agent must follow (e.g. "use `tmpPath()` not `/tmp/`")
- `<known_facts>` -- things already proven true (e.g. "semantic-release runs automatically after CI, not before")
- `<do_not_explore>` -- explicit list of dead ends and already-tried approaches

**How the knowledge graph enables this:**
- `relevant_files`: KG query "what files are related to the goal?" returns the structural subgraph
- `prior_sessions`: session store query "what sessions touched these files in the last 7 days?"
- `established_patterns`: AGENTS.md + KG pattern nodes
- `known_facts` and `do_not_explore`: built by the coordinator from prior session outputs

**Without the KG (today):** the coordinator manually includes key context in the prompt. Better than nothing, but requires the coordinator to know what's relevant.
**With the KG (future):** `worktrain spawn --workflow X --goal "..."` automatically queries the KG and assembles the context bundle. Coordinator just provides the goal.

---

### Decouple goal from trigger definition -- late-bound goals for daemon sessions (Apr 18, 2026)

**The problem:** `goal` is currently required at trigger-definition time (in triggers.yml). For triggers like `mr-review`, the goal is inherently dynamic -- it's the PR title and description, known only when the webhook fires, not when the trigger is configured.

The current workaround: `goalTemplate: "{{$.goal}}"` with the caller passing `{"goal": "Review PR #123..."}` in the webhook payload. This works but is awkward -- the caller must know the payload field convention, and it's not obvious from the trigger definition.

**The right model:** separate "which workflow" (trigger definition) from "what to do" (dispatch-time goal).

```yaml
# Trigger definition -- no goal required
triggers:
  - id: mr-review
    workflowId: mr-review-workflow-agentic
    workspacePath: ~/git/myproject
    # No goal here -- goal comes from dispatch context
```

```bash
# Dispatch with goal at call time
curl -X POST http://localhost:3200/webhook/mr-review \
  -d '{"goal": "Review PR #123: fix authentication bug"}'

# Or via worktrain spawn
worktrain spawn --trigger mr-review --goal "Review PR #123: fix authentication bug"
```

**Implementation options:**

1. **goalTemplate with `$.goal` as the default** -- if no `goal` is set in the trigger and no `goalTemplate` is set, default to `goalTemplate: "{{$.goal}}"`. The webhook payload's `goal` field becomes the canonical way to pass a dynamic goal. Zero breaking changes.

2. **Late-bound goal field on WorkflowTrigger** -- `executeStartWorkflow` accepts `goal` as a separate parameter. The trigger provides everything except the goal; the dispatcher (TriggerRouter) resolves the goal from the webhook payload or a default. This makes the separation explicit at the type level.

3. **Prompt injection** -- the workflow's first step can read `context.goal` which is injected from the webhook payload. The trigger has a static placeholder; the real goal comes through as a context variable. This is how it currently half-works but without the clean API.

**Preferred: Option 1 (default goalTemplate)** -- minimal change, backward compatible, works immediately. If `goal` is absent from the trigger and the webhook payload contains `{"goal": "..."}`, use it. Document this as the standard pattern for dynamic-goal triggers.

**Also needed:** the `worktrain spawn` CLI command should accept `--goal` as a first-class flag (already partially implemented) so coordinator scripts can pass goals without knowing the webhook payload format.

**Why this matters for WorkTrain being production-ready:** most real-world triggers (PR review, issue investigation, incident response) have dynamic goals that depend on what just happened. Static goals in triggers.yml only work for scheduled/cron tasks. Late-bound goals make the whole trigger system composable with external events.

---

### Session identity: a unit of work is one session, not many (Apr 18, 2026)

**The problem:** WorkTrain creates a separate WorkRail session for every workflow run. A task that involves discovery + design + implementation + review + re-review appears as 5 unrelated sessions in the console. There's no way to know they belong together without reading the goals. The user sees 50 flat sessions instead of 10 units of work.

**The correct model:** a session is a unit of work, not a workflow run. "Review PR #559" is one session. It might internally run 3 workflow sessions (context gathering, review, re-review) but the user sees one thing with one identity.

**What's needed:**

**1. Parent-child session relationships**
`session_created` in the session store gets an optional `parentSessionId` field. When a coordinator spawns a child via `worktrain spawn`, the child carries the parent's ID. The session store becomes a tree.

```typescript
// session_created event
{
  kind: 'session_created',
  sessionId: 'sess_abc123',
  parentSessionId: 'sess_root456',  // NEW -- absent for root sessions
  workflowId: 'wr.discovery',
  goal: '...'
}
```

**2. Root session as the identity**
The root session is what the user sees. It represents the unit of work ("Review PR #559", "Implement GitHub polling adapter"). Child sessions are implementation details -- they may be visible on drill-down but not in the top-level list.

**3. Console session DAG view**
The console shows root sessions, each expandable to show the tree of child sessions:
```
● Review PR #559                    [3 sessions, 22 min]
  ├── wr.discovery (context)        [completed, 8 min]
  ├── mr-review-workflow-agentic    [completed, 11 min]  
  └── coding-task (fix findings)    [running, 3 min...]
```

**4. Session identity propagated through coordinator**
`worktrain spawn` accepts `--parent-session <id>` to link child sessions. The coordinator script passes this when spawning each phase of a pipeline. When spawning via the daemon trigger, the trigger's initial session becomes the root.

**Relationship to coordinator sessions spec:**
The coordinator sessions spec (`spawn_session` + `await_sessions` tools) handles the orchestration. This spec handles the identity and visibility. They're complementary: coordinator scripts drive the work, session identity makes the work visible as a coherent unit.

**Why this matters:**
- Today: user sees "what are all these sessions?" -- has to read goals to understand grouping
- With this: user sees "here are my 5 units of work today" -- each one tells a coherent story
- The console becomes a work log, not a session log

**Build order:**
1. Add `parentSessionId` to `session_created` event schema (small, additive)
2. `worktrain spawn --parent-session <id>` flag (wires through TriggerRouter dispatch)
3. Console aggregates sessions by root and shows tree on expand
4. Dashboard "work sessions" view replaces flat session list as default

---

### Trigger-derived tool availability and knowledge configuration (Apr 18, 2026, to investigate)

**Observation:** the trigger already declares what external system matters. A `gitlab_poll` trigger means the agent will be working on GitLab content. A `jira_poll` trigger means Jira. WorkTrain should use this declaration to automatically configure what tools and knowledge sources the agent gets -- no manual per-trigger MCP configuration.

**Idea 1: Implicit tool availability from trigger source**
If `provider: gitlab_poll` → agent automatically gets GitLab MCP tools.
If `provider: github_poll` → agent gets GitHub tools.
If `provider: jira_poll` → agent gets Jira tools.
The trigger source is a declaration of intent -- WorkTrain infers the tool environment from it. No extra config needed for the common case.

**Idea 2: Trigger as knowledge configuration**
The trigger could declare where the agent gets different kinds of knowledge:

```yaml
- id: jira-bug-fix
  provider: jira_poll
  knowledge:
    general:   [glean, confluence]         # background org knowledge
    codebase:  [github, local-kg]           # structural code knowledge  
    task:      [jira-ticket, related-prs]   # what this specific task is about
    style:     [team-conventions, agents-md] # how to do the work
```

The daemon assembles a pre-packaged context bundle from these sources before the agent starts. The agent skips Phase 0 discovery entirely for the declared knowledge domains.

**Why this is interesting:**
- Closes the loop between "what triggers the work" and "what context the agent needs"
- The trigger author knows better than anyone what knowledge sources are relevant
- Eliminates redundant context gathering across sessions for the same trigger type
- Natural fit with workspace-scoped MCP config and the knowledge graph

**What needs investigating:**
- Is the trigger → tool mapping always 1:1 (gitlab_poll → gitlab MCP) or does it need explicit override?
- What are the right "knowledge categories"? (general, codebase, task, style seem like a reasonable starting set)
- How does this interact with the knowledge graph? (local-kg is already planned as a knowledge source)
- Can this be inferred automatically or does it always need explicit declaration?
- How do you handle a trigger that spans multiple systems (e.g. a Jira ticket about a GitHub PR)?

**This is a design-first item** -- the ideas are promising but the right shape isn't obvious. Needs a discovery pass before any implementation.

---

### Rethinking the subagent loop from first principles (Apr 18, 2026)

**Step back from all assumptions.** The current design assumes subagent spawning works like Claude Code's `mcp__nested-subagent__Task` -- the LLM decides when to spawn, what to give it, and handles the result. That's not the only model, and it might not be the best one for WorkTrain.

---

#### The current assumption (inherited from Claude Code)

```
Agent decides → calls spawn_agent tool → subagent runs → agent gets result → agent continues
```

The LLM is the orchestrator. It decides when parallelism is needed, what context to pass, how to handle results.

**Problems with this:**
- LLMs are bad at orchestration decisions -- they sometimes delegate when they shouldn't, sometimes don't when they should
- Context passing is lossy -- the LLM decides what to include, which is usually insufficient
- Subagent output competes with everything else in the parent's context window
- The LLM has to reason about the subagent's output before continuing -- burns context and turns
- No enforcement -- the LLM can skip delegation entirely and just do the work itself (often wrong)

---

#### Alternative model: workflow-declared parallelism, daemon-enforced

**The workflow spec is the orchestration. The daemon is the orchestrator. The LLM is the executor.**

```yaml
# Workflow step definition
- id: parallel-review
  type: parallel
  agents:
    - workflow: routine-correctness-review
      contextFrom: [phase-3-output, candidateFiles]
    - workflow: routine-philosophy-alignment  
      contextFrom: [phase-0-output, philosophySources]
    - workflow: routine-hypothesis-challenge
      contextFrom: [phase-2-output, selectedApproach]
  synthesisStep: synthesize-parallel-review
```

The daemon sees this step definition and:
1. Automatically spawns 3 child sessions with specified workflows
2. Injects the declared context bundles (from prior step outputs) into each child
3. Waits for all 3 to complete
4. Passes all 3 results to a synthesis step
5. Injects the synthesis into the parent agent's next turn

**The parent LLM never decides to spawn anything.** It just does its part. The workflow declares the orchestration pattern. The daemon enforces it.

---

#### What this changes about the agent's job

Today: "Do this work, and decide when to delegate parts of it to subagents."

New model: "Do this bounded cognitive task. The daemon handles everything else."

The agent's job becomes strictly about the cognitive work -- reasoning, writing, deciding within a defined scope. Orchestration, parallelism, context packaging, result synthesis -- all daemon responsibilities defined by the workflow spec.

---

#### The agent gives context to the daemon, not to subagents directly

Instead of the LLM calling `spawn_agent({ goal: "...", context: {...} })`, the workflow step has:

```yaml
- id: context-gathering
  output:
    contextFor:
      - step: parallel-review
        keys: [candidateFiles, invariants, philosophySources]
```

The agent writes outputs as structured artifacts. The daemon routes those artifacts to the right child agents at the right time. The LLM never packages context for a subagent -- it just produces outputs, and the workflow spec declares where those outputs go.

**This is the shift:** from "agent as orchestrator" to "workflow as orchestrator, daemon as executor, agent as cognitive unit."

---

#### What the subagent loop might look like

```
Parent workflow step completes
  ↓ Daemon reads step output artifacts
  ↓ Daemon checks workflow spec for parallel/sequential children
  ↓ Daemon spawns child sessions with structured context bundles
  ↓ Children run their bounded tasks
  ↓ Daemon collects child outputs
  ↓ Daemon passes synthesized context to parent's next step
  ↓ Parent continues with full context
```

No LLM orchestration. No token-burning context packaging decisions. No "did I remember to delegate this?" uncertainty.

---

#### What needs to be designed (don't implement yet)

1. **Workflow step schema for parallelism** -- how does the workflow spec declare parallel agents, sequential chains, fan-out/fan-in patterns?
2. **Context routing spec** -- how does a step's output get routed to specific child agents? What's the schema for `contextFor`?
3. **Synthesis patterns** -- how do multiple child outputs get combined? (concatenate? LLM synthesis step? structured merge?)
4. **Failure handling** -- if one child fails, what happens? (fail-fast? continue with partial results? retry?)
5. **Depth limits** -- same constraints as native agent spawning, but enforced at the workflow level not tool level
6. **Backward compatibility** -- workflows that currently use `mcp__nested-subagent__Task` can be migrated incrementally

**This is a design-first item.** Run a discovery session to explore the design space before any implementation. The current assumptions about subagent loops may be entirely wrong.

---

### Workflow runtime adapter: one spec, two runtimes (Apr 18, 2026)

**The core insight:** as workflows evolve (potentially morphing significantly once the subagent loop is rethought), the workflow JSON becomes the canonical spec for *what work needs to happen*. How that spec gets executed depends on the runtime. A single adapter layer translates the canonical spec to runtime-specific execution plans.

**Two runtimes, one spec:**

```
workflows/mr-review-workflow-agentic.json  ← canonical spec (unchanged)
         ↓
WorkflowAdapter.forRuntime('mcp')          ← MCP runtime interpretation
WorkflowAdapter.forRuntime('daemon')       ← Daemon runtime interpretation
```

**What each adapter does:**

MCP adapter (human-in-the-loop):
- Preserves `requireConfirmation` gates
- Presents `continue_workflow` tool call interface
- LLM drives subagent spawning manually via `mcp__nested-subagent__Task`
- Maintains backward compat with all existing Claude Code usage

Daemon adapter (fully autonomous):
- Removes or auto-bypasses `requireConfirmation` gates
- Replaces `continue_workflow` with `complete_step` (daemon manages tokens)
- Converts workflow-declared parallelism into automatic child session spawning
- Routes step outputs to child agents per workflow spec
- Enforces output contracts at step boundaries

**Why this matters as workflows evolve:**

Once the subagent loop is rethought (workflow-as-orchestrator model), workflow steps will likely declare parallelism, context routing, and synthesis patterns explicitly. These declarations make no sense to the MCP runtime (a human is already deciding this in real-time). The adapter translates them:

```yaml
# Workflow spec (future shape)
- id: parallel-review
  type: parallel
  agents: [correctness, philosophy, hypothesis-challenge]
  contextFrom: [phase-3-output]
```

MCP adapter sees this → renders as: "You should spawn 3 reviewer subagents now. Here's a template..."
Daemon adapter sees this → actually spawns 3 child sessions automatically

The workflow spec describes the intent. The adapter knows how each runtime fulfills it.

**Key guarantee:** workflow improvements automatically benefit both runtimes. Improving `mr-review-workflow-agentic`'s philosophy alignment step shows up whether a human runs it through Claude Code or WorkTrain runs it autonomously. No dual maintenance.

**Also eliminates "autonomous workflow variants":** the backlog had a separate item for autonomous variants of workflows. With the adapter, the canonical workflow spec is the only version -- the daemon adapter handles what "autonomy: full" means in practice. No parallel workflow files.

**Build order:**
1. Define the canonical workflow spec surface (what can be declared)
2. MCP adapter (largely a no-op -- existing behavior, but formally defined)
3. Daemon adapter (the interesting one -- translates declarations to daemon execution)
4. Converter for upgrading existing workflow JSONs to the new canonical spec if the schema evolves

**Dependencies:** requires the subagent loop rethinking to be resolved first -- the adapter can't be designed until we know what the workflow spec will declare.

---

### User notifications when daemon starts and finishes work (Apr 18, 2026)

**The problem:** the daemon silently starts and finishes sessions. Unless you're watching the console or tailing the log, you have no idea work happened or completed. For autonomous sessions that run over minutes or hours, this is a significant UX gap.

**What users need to know:**
- Session started: "WorkTrain started reviewing PR #566" (with a link)
- Session completed: "WorkTrain finished reviewing PR #566 -- APPROVED, no findings" (with session link)
- Session failed/stuck: "WorkTrain got stuck on PR #566 after 15 turns -- needs attention" (with details)

**Notification channels -- anything the user wants:**

The notification system should be open-ended. Any channel that accepts a webhook or has an API should be configurable. The architecture is: `DaemonEventEmitter` → `NotificationRouter` → one or more configured channels.

Short-term (easiest to ship):
- **Outbox.jsonl** -- already spec'd. `worktrain inbox` reads it, mobile client polls it. Works everywhere, zero config.
- **Generic webhook** -- HTTP POST to any URL. Covers Slack, Discord, Teams, PagerDuty, Zapier, IFTTT, and anything else that accepts webhooks. One implementation, infinite integrations.
- **macOS notification** -- `osascript` on Mac. Useful for local dev awareness.
- **Linux/Windows notification** -- `notify-send` on Linux, Windows Toast via PowerShell.

Medium-term (first-class integrations):
- **Slack** (direct API, not just webhook -- enables threading, reactions, rich formatting)
- **Discord** (webhook, then bot for richer interactions)
- **Microsoft Teams** (Adaptive Cards)
- **Telegram** (popular for personal automation)
- **Email** (SMTP for async, digest mode)

Long-term (when mobile exists):
- **Mobile push notifications** -- the mobile app (spec'd in backlog) receives push notifications directly. When the app exists, this becomes the primary channel -- native push is better than any polling-based alternative.
- **Desktop app** -- if WorkTrain ever has a desktop app, native notifications from there.

**The outbox is the universal foundation.** Every notification goes through `~/.workrail/outbox.jsonl` first. Channel-specific delivery (webhook, Slack, push) is a fan-out from the outbox. This means: a mobile app polling the outbox gets ALL notifications regardless of which other channels are configured.

**Config:**
```json
// ~/.workrail/config.json
{
  "notifications": {
    "onSessionComplete": true,
    "onSessionFailed": true,
    "onStuck": true,
    "onSessionStart": false,
    "channels": [
      { "type": "webhook", "url": "$SLACK_WEBHOOK_URL" },
      { "type": "webhook", "url": "$DISCORD_WEBHOOK_URL" },
      { "type": "macos" },
      { "type": "outbox" }
    ]
  }
}
```

**Build order:** outbox.jsonl integration (foundation, works everywhere) → generic webhook (covers Slack/Discord/Teams/anything) → platform notifications (macOS/Linux/Windows) → mobile app push (when mobile exists).

---


---

## 🎉 WorkTrain first confirmed end-to-end autonomous session (Apr 18, 2026)

**Timestamp:** 2026-04-18T15:09:49Z  
**Commit:** `473f4bd0` (main)  
**npm version:** v3.34.1 (published, installable by anyone)  
**What happened:** A real MR review workflow (`mr-review-workflow-agentic`) ran completely autonomously via webhook trigger, advanced through all phases (context gathering, review, synthesis, validation, handoff), self-validated, and produced a structured finding set. 8 step advances, `outcome: success`.

**Trigger:** `POST /webhook/mr-review {"goal": "Review PR #566: fix two minor bugs..."}`  
**Session:** `sess_3bmjuzf7l2vrqynjtleg5iskm4`  
**Result:** APPROVE with High confidence. 3 Minor findings, 1 Informational. Correctly decided not to delegate since no Critical/Major issues.

---

### What works at this commit

- Daemon accepts webhooks, starts sessions, runs workflows end-to-end
- Sessions advance through all workflow phases autonomously
- `mr-review-workflow-agentic` v2.6 runs fully -- context gathering, review phases, synthesis loop, validation, handoff
- `wr.discovery` v3.2.0 runs fully -- with new phase-0-reframe (goal reframing before research)
- Console shows live sessions via event log (no daemon connection required)
- MCP server is stable (bridge removed, EPIPE fixed, v3.34.1 published)
- GitHub + GitLab polling triggers (no webhooks needed)
- `worktrain init`, `tell`, `inbox`, `spawn`, `await` CLI commands
- Stuck detection + visibility (`worktrain status`, `worktrain logs --follow`)
- `complete_step` tool -- daemon manages continueToken, LLM never handles it
- Assessment gate circuit breaker (stops at 3 blocked attempts, shows artifact format)
- `worktrain daemon --install` creates launchd service (daemon survives MCP reconnects)
- Self-configuration (`triggers.yml`, `daemon-soul.md`, `AGENTS.md` for workrail repo)

### Current limitations at this commit

**Blocking reliable complex workflows:**
1. **`complete_step` not yet tested in production** -- just merged, daemon still using `continue_workflow` in running sessions. Needs daemon restart to take effect.
2. **Assessment gates still unreliable** -- `complete_step` fixes the token issue; the `artifacts` field (#557) fixes the submission issue. But `coding-task-workflow-agentic` phases with quality gates haven't been tested end-to-end yet.
3. **Native `spawn_agent` not yet merged** -- implementation in progress. Until it lands, all subagent delegation is via `mcp__nested-subagent__Task` (invisible black box).
4. **No session identity (parentSessionId)** -- multi-phase work appears as unrelated flat sessions in the console.

**Architecture not yet realized:**
5. **Coordinator scripts don't exist** -- `worktrain spawn/await` is there but no templates.
6. **Subagent loop not rethought** -- LLM still decides when to delegate; workflow-as-orchestrator model is spec'd but not built.
7. **Workflow runtime adapter not built** -- workflows run in daemon mode as-is; no MCP vs daemon adaptation layer.
8. **Knowledge graph not built** -- context gathering still sweeps files on every session.
9. **MCP simplification PR-B not done** -- HttpServer still starts with MCP server.

**Missing for production autonomy:**
10. **No notifications** -- daemon completes work silently. Users have no awareness unless watching console/logs.
11. **No auto-commit from handoff artifact** -- merged but untested end-to-end.
12. **Late-bound goals not implemented** -- triggers require static goals; dynamic goals (like PR reviews) need `goalTemplate: "{{$.goal}}"` as default.
13. **No coordinator script template** -- the multi-phase autonomous pipeline exists as primitives but not as a usable script.

---

### Artifacts as first-class citizens: explorable, accessible, out of the repo (Apr 18, 2026)

**The current mess:** every autonomous session dumps `design-candidates.md`, `implementation_plan.md`, `design-review-findings.md`, `mr-review.md` etc. as files in the repo root or worktrees. They are:
- Not indexed or searchable
- Not visible in the console
- Not accessible to other sessions (agent B can't read agent A's handoff without knowing the exact file path)
- Polluting the repo with ephemeral working documents
- Lost when worktrees are cleaned up
- Scattered across the filesystem with no structure

**The right model:** artifacts are WorkTrain data, not filesystem files.

---

#### What an artifact is

Any structured output from a session that has value beyond the session itself:
- **Handoff docs** -- what one session produces for the next to consume
- **Design candidates** -- research output with tradeoffs and recommendation
- **Implementation plans** -- what to build, how, in what order
- **Review findings** -- MR review output with findings, severity, recommendation
- **Spec files** -- behavioral specs, acceptance criteria, API contracts
- **Investigation summaries** -- bug investigation root cause and reproduction
- **Context bundles** -- pre-packaged knowledge for subagent consumption

**NOT artifacts:** step notes (stay in WorkRail session store), event logs (stay in daemon events), source code (stays in repo).

---

#### Where artifacts live

`~/.workrail/artifacts/<sessionId>/<artifact-type>-<timestamp>.json`

Structured JSON, not markdown. The display layer (console, `worktrain artifacts`) renders them as human-readable. Other agents query them as structured data.

**Why JSON not markdown:**
- Queryable by other agents (what are the findings with severity=critical?)
- Renderable by the console with proper formatting, filtering, search
- Versionable and diffable in the artifact store
- Accessible via the knowledge graph (artifacts become nodes with typed edges)

---

#### Console integration

The console session detail view gets an "Artifacts" tab alongside "Steps" and "Notes":

```
Session: sess_3bmj...  [MR Review: PR #566]
├── Steps (8)
├── Notes
└── Artifacts (3)
    ├── 📋 review-findings.json    "APPROVE -- 3 Minor, 1 Info"
    ├── 📄 context-bundle.json     "12 files read, 4 patterns identified"  
    └── 🔍 investigation-notes.json "Signal 3 dead code in max_turns path"
```

Click an artifact → full rendered view in the console.

---

#### Accessibility to other agents

Agents can query artifacts from prior sessions via a new tool:

```
read_artifact({ sessionId: 'sess_3bmj...', type: 'review-findings' })
→ { verdict: 'APPROVE', findings: [...], recommendation: '...' }

search_artifacts({ type: 'implementation-plan', workflowId: 'coding-task-workflow-agentic', since: '7d' })
→ [{ sessionId, summary, createdAt }, ...]
```

This replaces the current pattern where agents `cat design-candidates.md` from a known path -- fragile, path-dependent, breaks across worktrees.

---

#### Workflow integration

Workflow steps declare their artifact output type:

```json
{
  "id": "phase-1c-challenge-and-select",
  "output": {
    "artifact": "design-candidates",
    "schema": "wr.artifacts.design-candidates.v1"
  }
}
```

**Both the daemon AND the MCP server** store step artifacts automatically. The artifact store is a WorkRail data layer feature, not daemon-specific. A human using Claude Code with the MCP produces the same artifacts in the same store as an autonomous daemon session. The console shows them for both. Other sessions (human-driven or autonomous) can query them either way.

In MCP mode, the human can explicitly commit an artifact to the repo if desired (e.g. a final spec becomes `docs/specs/feature-x.md`). But the default is the artifact store -- repo is opt-in. The `NEVER COMMIT MARKDOWN FILES` rule in workflow metaGuidance exists because the artifact store doesn't exist yet. Once it does, that rule becomes unnecessary for all runtimes.

---

#### What stays in the repo

Almost nothing from WorkTrain sessions. The only things that belong in the repo:
- Source code changes (committed via auto-commit or human review)
- Long-lived spec files that are part of the product (e.g. `docs/ideas/backlog.md`)
- Workflow definitions (`workflows/*.json`)

Everything else -- design docs, review findings, investigation notes, implementation plans -- lives in `~/.workrail/artifacts/`. If you want a design doc in the repo, you explicitly commit it. The default is: it lives in WorkTrain's data layer.

---

#### Build order

1. **Artifact store** -- `~/.workrail/artifacts/<sessionId>/` directory structure, JSON schema for common types
2. **Daemon writes artifacts** -- workflow steps with `output.artifact` declaration write to the artifact store automatically
3. **`worktrain artifacts` CLI** -- list, read, search artifacts by session, type, date
4. **Console artifacts tab** -- render artifacts in session detail view
5. **`read_artifact` / `search_artifacts` tools** -- agents can query the artifact store
6. **Knowledge graph integration** -- artifacts become nodes, sessions link to their artifacts

**The `NEVER COMMIT MARKDOWN FILES` rule in metaGuidance is a symptom of this missing feature.** The rule exists because agents keep dumping files in the wrong place. With a proper artifact store, the rule becomes unnecessary -- artifacts have nowhere to go except the artifact store.

---

### "Add to repo" button in console for artifacts (Apr 18, 2026)

Instead of workflow steps declaring upfront whether an artifact goes to the repo, the human makes that decision after seeing the content -- via a button in the console.

**The flow:**
1. Agent produces artifact → stored automatically in `~/.workrail/artifacts/`
2. Human opens it in the console Artifacts tab
3. Sees action buttons: **📁 Add to repo** | **📋 Copy** | **🔗 Share link**
4. Clicks "Add to repo" → console prompts: "Save as: `docs/design/design-candidates-<name>.md`" (editable path with sensible default)
5. Console commits the artifact as markdown to the repo at that path, with a commit message like `docs: add design candidates for <workflow-goal>`

**Why this is better than workflow-level declaration:**
- Agent doesn't need to know at step time whether output will be repo-worthy
- Human decides after seeing actual content quality
- Ephemeral working artifacts stay ephemeral; only promoted ones go to the repo
- No "NEVER COMMIT MARKDOWN FILES" rule needed -- agents just produce artifacts, humans decide what's repo-worthy

**Button options:**
- **📁 Add to repo** -- renders artifact as markdown, commits to repo at specified path
- **📋 Copy** -- copies rendered markdown to clipboard
- **🔗 Share link** -- generates a URL that opens the artifact in the console. ⚠️ Local-only: only works on the same machine or with shared filesystem access. Requires cloud hosting for true team sharing (see cloud hosting spec in backlog)
- **📤 Export** -- save to arbitrary filesystem path outside the repo

**The commit WorkTrain creates:**
```
docs(design): add design candidates for MCP simplification

Source: WorkTrain session sess_3bmj... (mr-review-workflow-agentic)
Artifact: design-candidates-stdio-simplification-2026-04-18.md
```

**Also useful for:** implementation plans the team wants to track, spec files that belong in the repo permanently, investigation summaries that become part of incident post-mortems.

---

## Current state update (Apr 18, 2026 -- later)

**npm version: v3.35.1** (auto-released after spawn_agent merged)

### What additionally shipped since the milestone (commit 473f4bd0)

- **`complete_step` tool** (#569) -- daemon manages continueToken internally, LLM never handles it. Notes required (min 50 chars). `continue_workflow` deprecated.
- **`spawn_agent` tool** (#573) -- native in-process child session spawning. parentSessionId in session_created event. Depth enforcement. Semaphore bypass. All 4 WorkflowRunResult variants handled.
- **`complete_step` description fix** (#575) -- removed token-seeking language from deprecated continue_workflow description that would have triggered the LLM to seek a token.
- **Discovery ran before both implementations** -- wr.discovery validated complete_step approach (found 1 merge blocker fixed), designed spawn_agent architecture (found semaphore deadlock risk avoided).

### Updated limitations

**Still open from previous list:**
1. ~~complete_step just merged, untested~~ → ✅ merged, description fixed, discovery validated
2. ~~spawn_agent not merged~~ → ✅ merged as #573
3. **No session identity in console UI** -- parentSessionId is NOW in the event store (schema extended in #573) but console doesn't show the tree yet. Data is there; visualization is not.
4. **No coordinator scripts** -- spawn_agent exists, coordinator templates don't.
5. **Subagent loop still LLM-driven** -- workflow-as-orchestrator model spec'd but not built.
6. **Workflow runtime adapter not built** -- one spec, two runtimes model spec'd but not built.
7. **Knowledge graph not built** -- context still sweeps files every session.
8. **Artifacts not first-class** -- agents still dump markdown files in repo. Artifact store spec'd but not built.
9. **No notifications** -- daemon completes silently.
10. **MCP simplification PR-B** -- HttpServer still starts with MCP server.

### What's now possible that wasn't before

With `complete_step` + `spawn_agent`:
- Agents can advance workflows without ever touching a token (removes the #1 session failure cause)
- Workflows can declare delegation and the daemon spawns proper child sessions (all visible in event log)
- Multi-phase work has a path to becoming a coherent work unit (parentSessionId in data, UI visualization next)

### Next priorities

1. **Console session tree view** -- parentSessionId data is in the store. Build the UI to show it.
2. **First coordinator script template** -- `coordinator-mr-review.sh` that spawns: discovery → review → (conditional) fix → re-review. Proves the spawn/await loop works end-to-end.
3. **Notifications** -- macOS notification + generic webhook. ~30 min implementation.
4. **Late-bound goals** -- default `goalTemplate: "{{$.goal}}"` when no static goal. 10-line fix in trigger-store.ts.
5. **Artifacts store foundation** -- `~/.workrail/artifacts/` directory structure. Step 1 of the first-class artifacts vision.

---

## What WorkTrain is currently capable of (as of v3.36.0, Apr 18, 2026)

Tested empirically today. This is what actually works, not what's specced.

---

### Autonomous workflow execution

**Confirmed working:**
- Accepts webhook triggers and dispatches workflow sessions autonomously
- `mr-review-workflow-agentic` v2.6 runs end-to-end: context gathering, parallel reviewer phases, synthesis loop, validation, structured handoff. **Confirmed today** (sess_3bmj..., APPROVE verdict).
- `coding-task-workflow-agentic` (lean v2) runs end-to-end for Small tasks. **Confirmed today** (evidenceFrom field implementation, completed successfully).
- `wr.discovery` v3.2.0 runs with goal reframing. **Confirmed today** (spawn_agent architecture discovery).
- Sessions advance through 8+ workflow steps autonomously (36 step advances today across 6 sessions).
- 402 LLM turns + 660 tool calls executed autonomously today.

**Known reliability issues:**
- `wr.discovery` hit timeout once today -- multi-step discovery workflows can run long and hit the 60-min limit
- One coding task failed (error) -- assessment gate or tool issue, still being investigated
- One MR review timed out -- complex PRs need more time than the configured limit

---

### Trigger system

**Confirmed working:**
- Generic webhook trigger (fire-and-forget via `POST /webhook/<id>`)
- GitHub Issues polling (no webhook registration needed)
- GitLab MR polling (no webhook registration needed)
- Multiple triggers in one triggers.yml
- WorkflowId validation at startup (wrong IDs caught before traffic arrives)
- `goalTemplate` interpolation from webhook payload

**Not yet working:**
- Native cron trigger (requires OS crontab workaround)
- Late-bound goals (static goal required in triggers.yml, dynamic goal via payload requires `goalTemplate`)

---

### Agent capabilities inside sessions

**Confirmed working:**
- Bash (read files, run commands, git, gh CLI)
- Read (read files)
- Write (write files -- used by coding tasks)
- `complete_step` (daemon-managed token, LLM never handles continueToken)
- `continue_workflow` (deprecated but functional for backward compat)
- `report_issue` (agents call this when stuck, logged to `~/.workrail/issues/`)
- `spawn_agent` (spawns child WorkRail sessions in-process, v3.35.1+)
- Assessment artifact submission (`artifacts` field in complete_step)

**Not yet working in production:**
- `spawn_agent` just shipped (v3.35.1) -- untested in real workflows yet
- `complete_step` just shipped (v3.34.1) -- daemon now using it but not yet validated end-to-end through full assessment-gate workflow

---

### Observability

**Confirmed working:**
- Daemon event log (`~/.workrail/events/daemon/YYYY-MM-DD.jsonl`) -- every LLM turn, tool call, session lifecycle event
- `worktrain logs --follow` -- real-time event stream
- `worktrain status <sessionId>` -- session health summary with stuck detection
- Console (`http://localhost:3456/console`) -- live sessions, step notes, repoRoot grouping, `isLive` from event log
- Stuck detection -- `agent_stuck` events emitted for repeated tool calls, no-progress, timeout imminent
- `issue_reported` events when agents hit walls

**Known gaps:**
- Console shows flat session list, not work-unit tree (parentSessionId data exists, visualization not built)
- `isLive` only covers today's event log (cross-midnight limitation)
- No push notifications when daemon completes work

---

### Infrastructure

**Confirmed working:**
- MCP server stable (v3.36.0, bridge removed, EPIPE fixed)
- `worktrain daemon --install` creates launchd service (daemon survives MCP reconnects)
- `worktrain console` standalone (independent of daemon and MCP server)
- `worktrain init` guided onboarding
- `worktrain tell` / `worktrain inbox` message queue
- `worktrain spawn` / `worktrain await` CLI (primitives exist, no coordinator templates yet)
- Crash recovery (orphaned sessions detected and cleared on startup)
- Workspace context injection (CLAUDE.md, AGENTS.md, daemon-soul.md)
- maxConcurrentSessions semaphore (default 3)
- Per-trigger timeout + max-turn limits

---

### What WorkTrain cannot do yet (key gaps for autonomous production use)

1. **Multi-phase work is invisible** -- sessions are flat in console. A 5-session MR review pipeline looks like 5 unrelated sessions.
2. **No coordinator scripts** -- spawn_agent and spawn/await exist but there's no coordinator template to run a full pipeline.
3. **No auto-commit** -- agents write code but don't commit or open PRs autonomously (merge workflow exists in spec, not in production use).
4. **No notifications** -- daemon completes work silently.
5. **Assessment gates unreliable** -- complete_step fixes the token issue but full assessment-gate workflows not yet validated end-to-end.
6. **Subagent delegation invisible** -- spawn_agent creates proper child sessions, but workflows still use mcp__nested-subagent__Task for most delegation (invisible black box).
7. **No artifact store** -- agents dump markdown in the repo as a workaround.
8. **Context poverty** -- each session starts from scratch, no persistent knowledge graph.

---

### WorkTrain benchmarking: prove it's better, publish the results (Apr 18, 2026)

**The opportunity:** if WorkTrain can demonstrably outperform one-shot LLM calls and human-in-the-loop for specific task types, with reproducible benchmarks published in GitHub and visible in the console, that's the killer adoption argument. Not "trust us, it's better" -- actual numbers.

**What to benchmark:**

| Dimension | WorkTrain | One-shot | Human-in-loop |
|-----------|-----------|----------|---------------|
| MR review finding rate (Critical/Major caught) | ? | ? | ? |
| False positive rate (findings that were wrong) | ? | ? | ? |
| Coding task correctness (builds + tests pass) | ? | ? | ? |
| Coding task completeness (wiring, exports, tests) | ? | ? | ? |
| Bug investigation accuracy (correct root cause) | ? | ? | ? |
| Time to complete | ? | ? | ? |
| Token cost per task | ? | ? | ? |

**Model comparison within WorkTrain:**
- Haiku (fast, cheap) vs Sonnet (balanced) vs Opus (best) for each task type
- Other providers: GPT-4o, Gemini 1.5 Pro, Llama 3 (via Ollama) -- can WorkTrain run on any model?
- Does the workflow structure make Haiku competitive with Sonnet one-shot? (hypothesis: yes, for structured tasks)

**The benchmark suite:**

1. **MR review benchmark** -- 50 PRs with known ground truth (bugs that were later filed, correct implementations that had no bugs). Score: recall (caught real issues) + precision (didn't flag non-issues).
2. **Coding task benchmark** -- 50 tasks with objective completion criteria (build passes, tests pass, correct wiring). Score: % completing correctly on first autonomous run.
3. **Bug investigation benchmark** -- 30 real bugs with known root causes. Score: % identifying correct root cause.
4. **Discovery quality benchmark** -- 20 design questions with expert-evaluated answers. Score: coverage of key tradeoffs, identification of non-obvious alternatives.

**How to publish:**

- `docs/benchmarks/` directory in the repo -- YAML results files, one per benchmark run
- GitHub Actions CI job that runs the benchmark suite on each release and commits results
- Console "Benchmarks" tab showing historical performance by model and workflow version
- Public benchmark page (once cloud hosting exists) showing WorkTrain vs alternatives
- Badge in README: "MR review recall: 87% (Sonnet 4.6, v3.36.0)"

**Why this matters for adoption:**
- Developers are skeptical of autonomous agents -- "it probably makes stuff up"
- Hard numbers cut through skepticism instantly
- Showing WorkTrain with Haiku beating one-shot Opus on structured tasks is a compelling cost argument
- Showing improvement over workflow versions gives teams confidence the system is getting better
- The benchmark suite is also a regression test -- if a workflow change degrades performance, CI catches it

**What makes this hard:**
- Ground truth is expensive to establish (need expert-labeled evaluation sets)
- Some tasks are inherently subjective (discovery quality)
- Benchmarks can be gamed (optimize for the benchmark, not real performance)
- Need enough volume to be statistically meaningful

**Starting point:** the mr-review workflow is the easiest to benchmark objectively. Start with 20 PRs where bugs were later discovered and 20 PRs that shipped cleanly. Run each through `mr-review-workflow-agentic` on several model tiers. Measure recall and precision. That's a publishable result with one weekend of work.

---

### Autonomous feature development: scope → breakdown → parallel execution → merge (Apr 18, 2026)

**The vision:** give WorkTrain a feature scope -- from a vague idea to a fully groomed ticket -- and it figures out the rest. Discovery if needed, design if needed, breakdown into parallel slices, execution across worktrees, context management across agents, bringing it all back together.

**The four pillars the user cares about:**
1. **Autonomy** -- WorkTrain takes a scope and figures out the work breakdown without hand-holding
2. **Quality** -- comes FROM autonomy + workflow enforcement + coordination. Each slice goes through the right phases.
3. **Throughput** -- parallel slices across worktrees simultaneously. N agents working while you focus elsewhere.
4. **Visibility** -- one coherent work unit you can track at a glance, not N unrelated sessions in a flat list.

**The pipeline for a scope:**

```
Input: "add GitHub polling support" (any level of definition -- idea to full spec)
  │
  ├── [if vague] ideation + spec authoring → output: BRD / acceptance criteria
  ├── classify-task → taskComplexity, hasUI, touchesArchitecture, taskMaturity
  ├── [if Medium/Large] discovery → context bundle, invariants, candidate files
  ├── [if touchesArchitecture] design → candidates, review, selected approach
  ├── breakdown → parallel slices with dependency graph
  │     ├── Slice 1: types + schema         (worktree A)
  │     ├── Slice 2: polling adapter        (worktree B, depends: 1)
  │     ├── Slice 3: scheduler integration  (worktree C, depends: 2)
  │     └── Slice 4: tests                 (worktree D, depends: 1-3)
  ├── [parallel execution] each slice: implement → review → (fix if needed) → approved
  ├── [serial integration] merge slices in dependency order, verify after each
  └── [final] integration test → PR created → notification to user
```

**Context management across agents:**
- Coordinator maintains a "work unit manifest": current phase, slice status, shared invariants, decisions made in design phase
- Each spawned agent receives a context bundle: relevant portion of the manifest + files it needs + decisions from upstream phases
- Agents don't rediscover what the coordinator already knows
- After each agent completes, its findings update the manifest (new invariants found, scope changes, follow-up tickets)

**Worktree coordination:**
- Each slice gets its own worktree (already done via `--isolation worktree`)
- Coordinator tracks which files each slice touches -- detects conflicts before they happen
- Independent slices run in parallel; dependent slices queue automatically
- Merge order follows the dependency graph, not wall-clock completion time

**Knowing when to spawn a new main agent:**
- When a slice is too large or discovers unexpected scope, it requests a breakdown from the coordinator
- When a review finds a Critical finding, the coordinator spawns a dedicated fix agent with the finding + relevant context
- When integration reveals a regression, coordinator spawns an investigation agent before retrying the merge

**The coordinator's job (what stays in scripts, not LLM):**
- Maintain the manifest (JSON file, append-only)
- Compute the dependency graph
- Decide parallelism vs serialization
- Route: clean → merge, minor findings → fix agent, critical → escalate
- Track worktrees, detect conflicts
- Sequence the merge order

**What requires LLM cognition:**
- Discovery (what are the invariants, which files matter)
- Design (which approach, what tradeoffs)
- Implementation (write the code)
- Review (is this correct and complete)
- Breakdown (what are the right slice boundaries)

**The minimum viable version:**
A coordinator that handles a Medium/Small scoped task (already classified, no need for ideation or design). Takes 2-4 parallel slices, runs them, reviews each, merges when clean. No escalation handling in v1 -- if anything fails, notify the user.

This is the thing that makes WorkTrain feel like a senior engineer taking ownership of a task, not a tool you have to supervise step by step.

---

### Coordinator design decision: MVP-first, generalize after (Apr 18, 2026)

**Decision:** Build the first coordinator as a PR review-specific script. Generalize to a reusable coordinator framework after proving it works end-to-end.

**Rationale:** Three discovery runs all converged on the architecture (TypeScript script, `CoordinatorDeps` interface, 2-call HTTP for notes). The risk is over-engineering for hypothetical pipelines before validating the real one. PR review is the highest-value first use case with a clear success criterion.

**The generic coordinator architecture is already designed** (see `docs/discovery/coordinator-script-design.md`). The `CoordinatorDeps` interface and `AgentResult` bridge type make migration to a generic coordinator trivial -- the PR review script uses these types, so generalizing is additive, not a rewrite.

**Migration path:** once PR review coordinator is proven in production, extract the routing logic (`parseFindings`, `routeByFindings`) and `CoordinatorDeps` interface into `src/coordinators/base.ts`. The PR review coordinator becomes one implementation of the base pattern.

---

### Architecture decisions from Apr 17-18 sessions (to record before files are cleaned up)

**Decision 1: Structured output + tool calls can coexist (Apr 18)**
Validated empirically via integration test. The beta API (`client.beta.messages.create()`) supports both JSON schema enforcement AND tool calls in the same request. Schema enforcement applies at `end_turn` only. Bedrock is more consistent than direct Anthropic API for system-prompt fallback behavior. This opens a future path for replacing `complete_step` with structured output, but `complete_step` remains the chosen primitive for now.

**Decision 2: `complete_step` is the preferred daemon workflow-control primitive (Apr 18)**
PR #569 merged. The daemon holds the continueToken in a closure; LLM calls `complete_step(notes)` and never handles the token directly. Structured output (`beta.messages.create` with JSON schema) was evaluated as an alternative and deferred -- it's a viable migration path for a future version but adds API complexity today. Follow-up: track a structured output migration as a future improvement, not a current priority.

**Decision 3: AgentLoop error handling contract -- FatalToolError (Apr 16)**
`FatalToolError` subclass selected for distinguishing recoverable from non-recoverable tool failures in the AgentLoop. The contract: user-facing tools (Bash, Read, Write) catch failures and return `isError: true` in the tool_result (loop continues, LLM can retry). Coordination tools with unrecoverable failures (session store corruption, token decode failure) throw `FatalToolError` -- `_executeTools` instanceof-checks this and kills the session rather than surfacing a confusing error to the LLM. This contract is part of the AgentLoop architecture and must be followed by any new tool implementations.

**Decision 4: Use `wr.discovery` for discovery-only tasks, not `coding-task-workflow-agentic` (Apr 17)**
Discovered from a broken session: `coding-task-workflow-agentic` dispatched with "do discovery only, no code" ran 11 step advances then stopped without `run_completed`. The workflow's implementation phases fired even with explicit instructions not to code. Lesson: when a trigger or coordinator wants pure discovery/research, use `wr.discovery` as the workflowId. `coding-task-workflow-agentic` should only be dispatched when implementation is the actual goal.

**Decision 5: Bug -- MCP server EPIPE crash (Apr 18)**
Root cause confirmed with 15 production crash log entries: `process.stderr` is missing an `'error'` event handler in `registerFatalHandlers()`. When an MCP client disconnects, Node.js emits `EPIPE` on stderr which crashes the process with an unhandled error. `process.stdout` already has equivalent protection via `wireStdoutShutdown()`. Fix: mirror the stdout protection for stderr. One-line fix being implemented in PR `fix/mcp-stderr-epipe-crash`.

---

### worktrain status → console integration (Apr 18, 2026)

The `worktrain status` CLI command is Phase 1. Phase 2: the same data and rendering lives inside the console as the default landing view when you open it -- not the sessions list, the overview. Same `StatusDataPacket` type, two surfaces. The console overview replaces the need to run a CLI command; it auto-refreshes and stays live.

---

### WorkTrain as a native macOS app (Apr 18, 2026)

Long-term vision: WorkTrain becomes a full native Mac app -- not just a CLI + web console, but a proper macOS application with a menubar icon, system notifications, windows, and native UX.

**What this unlocks:**
- Always-on menubar presence showing daemon status at a glance
- Native macOS notifications (already built via osascript -- the app version uses UserNotifications framework directly)
- The `worktrain status` overview as a native window, not a browser tab
- Message queue and inbox as a native interface (type a message from anywhere on your Mac, not just the terminal)
- Background daemon management -- start/stop/restart from the menubar without terminal
- Deep system integration: file system events, calendar, Contacts, native share sheet

**Tech stack options:**
- Swift/SwiftUI: full native, best macOS integration, steeper learning curve from TypeScript
- Electron + existing console UI: fastest path, same TypeScript codebase, but heavy
- Tauri: Rust core + existing web frontend, lighter than Electron, good macOS support
- React Native macOS: reuses React knowledge, not quite native feel

**Recommended path:** Tauri wrapping the existing console UI. The console is already a React/Vite app. Tauri gives native menubar, notifications, and system APIs without rewriting the frontend. The WorkTrain daemon stays as a separate process managed by the app.

**This is a post-v1 platform decision** -- not a near-term priority, but worth designing toward. Don't make architectural decisions that would make the Tauri wrapper hard later.

---

### Long-running sessions: stay open across agent handoffs (Apr 18, 2026)

**The problem:** today when an MR review session completes, it writes its findings and exits. If the findings require fixes, a new fix agent starts from scratch with no shared context. When the fix is done, a new re-review agent also starts from scratch. Three sessions that are logically one unit of work are isolated from each other.

**The vision:** a session can stay open and wait -- dormant but alive -- while another agent does work. When that work completes, the waiting session resumes with full context continuity.

**The MR review example:**

```
[MR review session]  finds: 2 critical, 3 minor
  → stays open, waiting for fixes
  
  [Fix agent session]  addresses all 5 findings
    → completes, signals "fixes ready"
  
[MR review session resumes]  re-reads the diff, re-evaluates
  → all 5 verified fixed, 0 new findings
  → completes with APPROVE verdict
```

The same session that found the issues verifies the fixes. No context reconstruction. No risk of re-review missing something the original reviewer knew.

**Other use cases for waiting sessions:**

- **Architecture review waiting for approval:** architect session identifies a design gap, waits for the human to decide on direction, resumes when the decision is recorded
- **Discovery session waiting for data:** a research session identifies that it needs a specific file or API response, signals "blocked on: fetch X", waits for a retrieval agent to deliver it, resumes with the data injected
- **Coordinator waiting on child completion:** instead of a coordinator script polling `worktrain await`, the coordinator session can yield and be resumed by the daemon when child sessions complete -- same session, same context, no polling overhead
- **Spec authoring waiting for stakeholder input:** a spec session writes a draft, flags "needs: human review of acceptance criteria", waits, resumes when the human adds a comment
- **Integration test waiting for deployment:** a test coordination session waits for a deploy to complete before running integration tests

**The key insight: the LLM doesn't experience waiting.**

LLMs have no concept of time. Between one turn and the next, zero time passes from the agent's perspective. This means "waiting" is not a thing that happens to the agent -- it just doesn't receive its next turn until the coordinator has something to give it.

The session is paused at the engine level (DAG holds at a node, no new turns issued). The agent submitted its output and simply hasn't received a response yet. When the coordinator is ready -- fix agent completed, human reviewed, deployment finished -- it advances the session with a turn that contains the new context. From the agent's perspective: it submitted findings and immediately received "here are the fixes, verify them."

**No `wait_for` primitive needed at the workflow level.** The coordinator is the timing mechanism. This is the coordinator's job: know when each session is ready for its next input, and deliver that input at the right time.

```
Coordinator logic:

1. Advance review session to "findings complete" node
2. Read findings from session output
3. Spawn fix agent with those findings
4. Wait for fix agent to complete (worktrain await)
5. Inject fix summary into review session's next turn
6. Advance review session: "Here are the fixes. Verify them."
   → LLM receives this as the natural next step, no time gap perceived
```

**Why this is more powerful than re-running a fresh session:**

- **Context continuity:** the reviewer remembers what it found, why it flagged it, what invariants it was checking. A fresh session has to re-discover all of that.
- **Relational memory:** "does this fix address the root cause I identified, or just the symptom?" -- only the original session knows the root cause reasoning.
- **Efficiency:** no redundant context gathering. The resumed session picks up exactly where it left off.
- **The agent doesn't know it's coordinating:** from the agent's view, it's a continuous workflow. The coordinator manages the timing externally.

**Implementation path:**

- Phase 1: coordinator scripts withhold `complete_step` advancement until the condition is met. This already works today -- the coordinator just doesn't advance the session until the fix agent is done.
- Phase 2: the coordinator passes structured context when advancing: `complete_step(session, { injectedContext: fixSummary })`. The session receives it as part of the next step's prompt.
- Phase 3: declarative pipelines -- workflow JSON declares that step N waits for an external condition before proceeding. The coordinator reads this and manages the timing automatically. No hand-coded coordinator script needed for common patterns.

---

### Coordinatable workflow steps: confirmation points the coordinator can satisfy (needs discovery, Apr 18, 2026)

⚠️ **Needs discovery before implementation. The questions below are open, not answered.**

**The insight:** workflows already have `requireConfirmation: true` on certain steps -- these are natural coordination points. Right now they pause for a human. The idea is to make them also pausable-for-a-coordinator, so a coordinator (or another agent) can be the one that responds instead of a human.

**The vision:**
A workflow reaches a `requireConfirmation` step. In MCP mode (human-driven), it behaves exactly as today -- pauses and waits. In daemon/coordinator mode, instead of blocking forever, the coordinator can:
- Inject a synthesized answer based on external work it just did ("architecture review found X, proceed with approach A")
- Spawn another agent to generate the answer and inject its output
- Ask a discovery agent to weigh in and forward the result
- Simply forward a human's message from the message queue

The original session never knows whether a human or a coordinator satisfied the confirmation. It just receives the next turn with context.

**Why this is powerful:**
Today the coordinator is external to the workflow -- it orchestrates sessions from outside. This makes the workflow itself coordinatable from within, so multi-agent collaboration can be declared in the workflow spec rather than bolted on in coordinator scripts.

**What's unknown and needs discovery:**
1. **Mechanism:** is this an enriched `requireConfirmation` (add a `coordinatable: true` flag?), a new step type (`requireCoordinatorInput`?), or something at the engine level? Tradeoffs between each.
2. **What gets injected:** always a structured decision ("proceed/revise/abort + findings"), or also data injection ("here are the file contents", "here's what the API returned")? How does the step receive it -- as a new tool call result, as a steer, as part of the step prompt?
3. **Coordinator discovery:** how does the coordinator know a step is waiting for it vs waiting for a human? Does it poll the session state? Does the session emit a `coordinator_gate_pending` event? (This connects to the `waitForCoordinator` spec in this backlog.)
4. **Timeout/fallback:** if the coordinator never responds, what happens? Fall back to human? Error? Configurable?
5. **MCP invariant:** must behave identically to today in MCP/human-driven mode. The coordinator path is additive, not a behavior change for existing users.

**Relationship to other specs:**
- "Long-running sessions: stay open across agent handoffs" -- the session pauses at the confirmation point, coordinator acts, session resumes
- "POST /api/v2/sessions/:id/steer" -- this might be the injection mechanism
- `signal_coordinator` tool -- the session might signal the coordinator instead of blocking
- `waitForCoordinator` step flag (already in this backlog) -- same underlying need, different framing
- "Coordinator review mode: self-healing vs comment-and-wait" -- confirmation points are where that routing decision gets expressed

---


---

## Architecture Decision: Three-Workflow Pipeline (Apr 18, 2026)

### Decision

The canonical WorkRail workflow pipeline for new features is:

```
wr.discovery (optional) → wr.shaping (optional) → coding-task-workflow-agentic
```

Each workflow is independently useful. The pipeline is an optional chain, not a required sequence.

### Rationale

**wr.discovery** produces a direction -- what problem is worth solving. Output: structured discovery notes at `.workrail/discovery/`.

**wr.shaping** produces a bounded pitch -- what specifically to build and explicitly NOT build, at a product level. Output: `.workrail/current-pitch.md`. Faithful Shape Up methodology. Tech-agnostic. No code-level content.

**coding-task-workflow-agentic** produces running code -- engineering approach, sliced implementation, verification. When pitch.md exists (Phase 0.5), it skips design ideation and translates the pitch directly into an engineering approach. The pitch's no-gos and appetite are binding constraints.

### No TechSpec workflow needed

The coding workflow already does everything a TechSpec workflow would do: Phase 1b generates design candidates, Phase 1c selects and challenges the approach, Phase 3 writes the spec and implementation plan. Adding a separate TechSpec workflow would duplicate this and create a question of which is canonical. The coding workflow is the engineering planning layer.

**The split that matters is product vs engineering:**
- Product decisions (what to build, for whom, within what time) → wr.shaping
- Engineering decisions (how to build it, which interfaces, which tests) → coding workflow

### When to skip shaping

- Task is small, concrete, and clearly scoped → go straight to coding workflow
- Discovery already produced a bounded, implementable direction
- You have a pre-written ticket or spec that already defines what to build

### Faithful Shape Up constraint

wr.shaping is tech-agnostic. A pitch for a Kotlin Android app and a pitch for a Python API service look structurally identical. No file paths, no function signatures, no implementation details. This makes pitches usable by human engineering teams at companies using Shape Up, not just WorkRail's coding workflow.

### Phase 0.5 mechanics

When `coding-task-workflow-agentic` finds `.workrail/current-pitch.md`:
1. Reads all five pitch sections (Problem, Appetite, Solution/Elements, Rabbit Holes, No-Gos)
2. Sets `shapedInputDetected=true`
3. Skips phases 1a-1c (hypothesis, design generation, challenge-and-select)
4. Phase 1d translates pitch elements/invariants/no-gos into an engineering approach
5. Plan audit (Phase 4) checks for drift against the pitch
6. Appetite is a hard ceiling -- oversized engineering work becomes follow-up tickets


---


---

## Completed (Apr 19, 2026)

### wr.shaping -- Faithful Shape Up shaping workflow

Created `workflows/wr.shaping.json`. Faithful Shape Up methodology, tech-agnostic, produces `.workrail/current-pitch.md` only. Nine steps: ingest → frame gate → diverge (6 shapes, Verbalized Sampling) → converge → breadboard + elements → rabbit holes + no-gos → draft/critique loop → approval gate → write pitch.md. Two human gates with autonomous fallback. Appetite is calendar-time only (xs/s/m/l/xl). No code-level content -- a pitch for a Kotlin app and a pitch for a Python service look structurally identical.

### coding-task-workflow-agentic -- Upstream context Phase 0.5

Added Phase 0.5 "Locate Upstream Context" to `coding-task-workflow-agentic.json`. Format-agnostic: the agent uses whatever tools are available (repo search, WebFetch, Confluence/Notion/Glean MCPs, etc.) to find any upstream document -- pitch, PRD, BRD, RFC, design doc, user story, Jira epic, etc. Sets `upstreamSpecDetected` + `solutionFixed` flags. When `solutionFixed=true`, design ideation phases (1a-1c) are skipped and Phase 1d translates upstream constraints directly into an engineering approach. Plan audit (Phase 4) checks for drift against `upstreamBoundaries` whenever an upstream document was found.

Also consolidated from three workflow variants to one canonical file.


---

## Current state update (Apr 19, 2026)

**npm version: v3.40.0**

### What shipped since v3.36.0 (Apr 18 -- Apr 19)

- **`wr.shaping`** -- faithful Shape Up shaping workflow (9 steps, two human gates with autonomous fallback)
- **`coding-task-workflow-agentic` Phase 0.5** -- upstream context detection; skips design phases when solution is pre-specified. Three-workflow pipeline: shaping → discovery → coding.
- **Coding workflow consolidated** -- from three variants (lean, full, lean.v2) to one canonical file.
- **HttpServer removed from MCP server** (#601) -- pure stdio. MCP server can no longer accidentally start an HTTP server.
- **Late-bound goals** (#604) -- `goalTemplate: "{{$.goal}}"` defaults for webhook-driven sessions. Goals can come from the payload, not just the static trigger definition.
- **Coordinator message queue drain** (#606) -- `pr-review` coordinator reads `~/.workrail/message-queue.jsonl` before each spawn cycle. `worktrain tell stop`, `skip-pr <n>`, `add-pr <n>` work.
- **Notifications shipped** -- `NotificationService` implemented, wired into `TriggerRouter` via `trigger-listener.ts`. `WORKTRAIN_NOTIFY_MACOS=true` and `WORKTRAIN_NOTIFY_WEBHOOK=<url>` in `~/.workrail/config.json`.
- **`worktrain run pr-review`** -- fully wired coordinator command. `spawnSession` → `awaitSessions` → `getAgentResult` (session-wide artifact aggregation) → `parseFindingsFromNotes` → route by severity.
- **`wr.review_verdict` artifact path** -- end-to-end wired: `mr-review-workflow.agentic.v2.json` phase-6 emits it, `artifact-contract-validator.ts` validates it at `continue_workflow` time, coordinator reads it with keyword-scan fallback.
- **`worktrain logs` / `worktrain health`** -- structured daemon log tailing and per-session health summary. `worktrain status <id>` deprecated in favor of `worktrain health <id>`.
- **`signal_coordinator` tool** -- agent can emit structured mid-session signals (`progress`, `finding`, `data_needed`, `approval_needed`, `blocked`) without advancing the step.
- **`ChildWorkflowRunResult` + `assertNever`** -- spawn_agent delivery_failed bug fixed. `delivery_failed` impossible state is compile-time excluded.
- **`lastStepArtifacts` on `WorkflowRunSuccess`** -- `onComplete` callback forwards artifacts alongside notes. Coordinator can read typed artifacts from result without a separate HTTP call.
- **`steerRegistry` + POST `/sessions/:id/steer`** -- coordinator injection endpoint wired in daemon console. Running sessions register a steer callback; coordinators can inject mid-session messages via HTTP.
- **GitHub polling adapters** -- `github_issues_poll` and `github_prs_poll` providers fully implemented alongside existing `gitlab_poll`.
- **Knowledge graph spike** -- `src/knowledge-graph/` module: DuckDB in-memory + ts-morph indexer + two validation queries. NOT yet wired to an MCP tool (ts-morph in devDependencies).
- **`worktrain daemon --install`** -- launchd plist creation, load, verify. Daemon survives MCP server reconnects.
- **Performance sweep** -- April 2026 sweep identified 10 highest-leverage fixes, filed as issues #248-257. Not yet merged.

### Accurate limitations (as of v3.40.0)

1. **Console session tree UI not built** -- `parentSessionId` is stored in the `session_created` event and in `WorkflowRunSuccess`. Console `RunLineageDag` shows the per-session step DAG only. Cross-session parent-child tree is data-only. PRs #607 (tree view) and #608 (steer endpoint) are OPEN.
2. **Daemon tool set is minimal** -- agent has: `complete_step`, `continue_workflow` (deprecated), `Bash`, `Read`, `Write`, `report_issue`, `spawn_agent`, `signal_coordinator`. No `Glob`, `Grep`, or `Edit`. Read/Write are thin wrappers.
3. **`worktrain tell` messages only drained by coordinator** -- `drainMessageQueue` is called by `runPrReviewCoordinator`, not by the daemon loop. A running autonomous session cannot receive mid-run injections from `worktrain tell`. The `steerRegistry` HTTP endpoint is the mid-session channel.
4. **Knowledge graph not wired** -- module exists, ts-morph must move to dependencies before an MCP tool can be built.
5. **`spawn_agent` return missing `artifacts`** -- returns `{ childSessionId, outcome, notes }` only. Typed artifacts from child session are not surfaced to the parent agent. `lastStepArtifacts` on `WorkflowRunSuccess` exists but spawn_agent doesn't return it.
6. **`worktrain inbox --watch` stub** -- `--watch` flag prints "not yet implemented" and exits.
7. **Artifact store not built** -- agents still dump markdown/files directly into the repo. `~/.workrail/artifacts/` directory structure not created.
8. **Performance issues not fixed** -- issues #248-257 filed from April sweep. `continue_workflow` triggers 6+ event log scans, full session rebuild per `/api/v2/sessions` request, N+1 workflow fetches, no caching.
9. **No auto-commit** -- agents can write code but do not commit, push, or open PRs autonomously.
10. **Assessment gates not battle-tested** -- end-to-end flow with `outputContract: required: true` not validated in production use.

### Open PRs to merge

- **#607** `feat(console): add session tree view for coordinator sessions` -- cross-session parent-child hierarchy in console. Blocked on: `parentSessionId` data is in store but console routes need to surface it.
- **#608** `feat(console): add POST /api/v2/sessions/:sessionId/steer for coordinator injection` -- NOTE: this endpoint is already implemented in `daemon-console.ts` via `steerRegistry`. PR #608 may be adding this to the MCP server console separately. Check before merging.
- **#610** `feat(workflows): add wr.shaping` -- the shaping workflow. Ready to merge.
- **#587** `fix(mcp): add assertNever exhaustiveness guard to TriggerRouter` -- likely already applied in codebase (ChildWorkflowRunResult assertNever is live). May be a duplicate or different scope. Check.

### Next priorities (groomed Apr 19)

1. **Merge #610 (wr.shaping)** -- ready. Workflow is implemented and in the branch.
2. **Merge #587 (TriggerRouter assertNever)** -- quick fix, check if still relevant.
3. **Review and merge #607 + #608** -- console tree view and steer endpoint. Verify #608 doesn't duplicate what's already live in daemon-console.ts.
4. **Performance fixes** -- issues #248-257. Pick highest-leverage first: SessionIndex (#248) and console projection cache (#249) eliminate most of the repeated scans.
5. **Daemon tool set: add Glob + Grep** -- agents routinely need to search files. `Read` + `Bash` grep is slow and lossy. Native `Glob` and `Grep` tools would make coding sessions more reliable.
6. **`spawn_agent` artifacts gap** -- add `artifacts?: readonly unknown[]` to the return value. `lastStepArtifacts` is already on `WorkflowRunSuccess`; wiring it through is ~30 LOC.
7. **Knowledge graph wiring** -- move `ts-morph` and `@duckdb/node-api` to dependencies, add `query_knowledge_graph` MCP tool.
8. **Artifact store foundation** -- `~/.workrail/artifacts/` directory, write path in `complete_step`.

---

### wr.shaping workflow: shape messy problems into implementation-ready specs (needs authoring, Apr 18, 2026)

**Status:** Design complete. Ready to author as a WorkRail workflow JSON.

**Design docs:**
- `docs/design/shaping-workflow-discovery.md` -- WorkRail-internal discovery findings
- `docs/design/shaping-workflow-external-research.md` -- External research synthesis (Shape Up, LLM failure modes, artifact schema)

**The gap this fills:** WorkRail has `wr.discovery` (divergent) and `coding-task-workflow-agentic` (convergent). Shaping is the missing middle -- converting messy discovery output into a bounded, implementation-ready spec without mid-implementation rabbit holes.

**The 11-step skeleton (see design doc for full detail):**
1. ingest_and_extract -- extract problem frames, forces, open questions
2. **frame_gate** -- MANDATORY HUMAN GATE: confirm problem + appetite
3. diverge_solution_shapes -- 4 parallel rough shapes with varied framings
4. converge_pick -- SEPARATE JUDGE (different model/prompt): pick best shape
5. breadboard_and_elements -- fat-marker breadboard + Interface/Invariant/Exclusion classification
6. rabbit_holes_nogos -- adversarial: risks, mitigations, no-gos, assumptions
7. context_pack_build -- file globs, reuse_utilities, conventions, do-not-touch boundaries
8. example_map_and_gherkin -- Given/When/Then acceptance criteria + verification commands
9. draft_pitch -- self-refine ×2, SEPARATE CRITIC (obfuscated authorship)
10. **approval_gate** -- MANDATORY HUMAN GATE: approve, edit, or restart
11. finalize_and_handoff -- schema validation, emit shape.json + pitch.md

**The single most important design decision:** generator and critic run on structurally different prompts (ideally different model families). CoT and self-reflection alone do NOT mitigate anchoring or self-preference bias (Lou & Sun 2025; Panickssery et al. 2024).

**Output artifact:** `shape.json` -- contains problem story, appetite (multi-dimensional: calendar + tokens + turns + files), breadboard, elements, context_pack (file boundaries + reuse_utilities), Gherkin acceptance criteria, rabbit holes, no-gos, decomposition with walking skeleton, assumptions_log, build_readiness_score.

**Key insight for AI implementers:** LLMs need MORE explicit specs than humans on interfaces/invariants/file boundaries (no tacit knowledge, no scope-shame), but LESS explicit than junior humans on standard patterns. The dominant failure mode is confident architectural divergence -- working code that reinvents an existing utility. Context Pack (Step 7) directly prevents this.

**Next action:** author `wr.shaping` as a WorkRail workflow JSON using workflow-for-workflows, then update `coding-task-workflow-agentic` Phase 0 to detect and consume `shape.json` when present.

---


---

## Current state update (Apr 20, 2026)

**npm version: v3.45.0**

### What shipped in this session (Apr 19-20, 2026)

All five top-priority autonomous pipeline items shipped:

- **#1 -- Worktree isolation + auto-commit** (PR #630) -- Each WorkTrain coding session now runs in an isolated git worktree (`~/.workrail/worktrees/<sessionId>`). `trigger.workspacePath` is never mutated; all tool factories receive `sessionWorkspacePath`. Crash recovery sidecar persists `worktreePath` for orphan cleanup. `delivery-action.ts` asserts HEAD branch before push. `test-task` trigger: `branchStrategy: worktree`, `autoCommit: true`, `autoOpenPR: true`.

- **#2 -- Stuck detection escalation** (PR #636) -- New `WorkflowRunResult._tag: 'stuck'` discriminant. When `repeated_tool_call` heuristic fires and `stuckAbortPolicy !== 'notify_only'` (default: `'abort'`), daemon aborts the session immediately instead of burning the 30-min wall clock. Writes structured entry to `~/.workrail/outbox.jsonl`. `stuckAbortPolicy` and `noProgressAbortEnabled` configurable per trigger in `agentConfig`. `ChildWorkflowRunResult` updated atomically.

- **#3 -- Adaptive pipeline coordinator** (PR #639) -- `worktrain run pipeline --issue N --workspace path` routes tasks to the right pipeline via pure static routing:
  - dep-bump + PR number → QUICK_REVIEW (delegates to `runPrReviewCoordinator`)
  - PR/MR number → REVIEW_ONLY
  - `current-pitch.md` exists → IMPLEMENT (coding + PR + review + merge)
  - Default → FULL (discovery → shaping → coding → PR → review → merge)
  - Fix loop cap: 2 iterations max. Escalating audit chain for Critical findings. UX gate for UI-touching tasks. 6 hardcoded timeout constants. Pitch archived after IMPLEMENT/FULL completes.

- **#4 -- GitHub issue queue poll trigger** (PR #637) -- New `github_queue_poll` trigger provider. Polls GitHub issues matching `GitHubQueueConfig` (assignee-based MVP, `label`/`mention`/`query` typed but `not_implemented`). Maturity inference from 3 deterministic heuristics. Idempotency check (conservative: parse errors = active). JSONL decision log at `~/.workrail/queue-poll.jsonl`. `maxTotalConcurrentSessions` cap. Bot identity config (`botName`, `botEmail`).

- **#5 -- Context assembly layer** (PR #624, shipped earlier) -- `ContextAssembler` injects git diff summary + prior session notes before turn 1. Feeds into coordinator pre-dispatch.

- **Performance sweep** (all 10 issues #248-257 -- already confirmed complete)
- **Console session tree** (PR #607 -- parentSessionId rendered in UI)
- **Daemon file-nav tools** (PR #619) -- Glob, Grep, Edit + upgraded Read/Write with staleness guard
- **`spawn_agent` artifacts** (PR #613) -- `lastStepArtifacts` surfaced through spawn_agent return
- **`wr.shaping` workflow** (PR #610) -- faithful Shape Up shaping, 9 steps
- **Coding workflow Phase 0.5** (PR #610) -- upstream context detection, three-workflow pipeline

### WorkTrain current capabilities (v3.45.0)

**Autonomous workflow execution -- confirmed working:**
- `worktrain run pipeline --issue N` routes to the right pipeline and runs it end-to-end
- `worktrain run pr-review` autonomous PR review with structured verdicts and auto-merge
- Coding sessions run in isolated worktrees, auto-commit, auto-open PR
- Sessions abort when stuck (instead of burning 30-min wall clock)
- GitHub issue queue polling: assign issue to `worktrain-etienneb` → daemon picks it up automatically
- All sessions start with git diff + prior session notes injected (ContextAssembler)
- Daemon file-nav tools: Glob, Grep, Edit, Read (paginated), Write (staleness guard)
- Escalating audit chain: Critical findings → prod audit → re-review → escalate if still Critical
- Fix loop: minor findings → max 2 fix iterations before escalation

**WorkTrain agent tool set (v3.45.0):**
`complete_step`, `continue_workflow` (deprecated), `Bash`, `Read`, `Write`, `Glob`, `Grep`, `Edit`, `report_issue`, `spawn_agent`, `signal_coordinator`

**Trigger system:**
- Generic webhook, GitLab MR polling, GitHub Issues polling, GitHub PR polling
- **NEW: `github_queue_poll`** -- assignee-based issue queue with maturity inference
- `branchStrategy: worktree` -- isolated worktree per session
- `autoCommit: true` / `autoOpenPR: true` -- full delivery pipeline
- `stuckAbortPolicy: 'abort' | 'notify_only'`
- `goalTemplate`, `referenceUrls`, `contextMapping`, `agentConfig`

### Accurate limitations (v3.45.0)

1. **`dispatchAdaptivePipeline()` not yet connected** -- `TriggerRouter.dispatchAdaptivePipeline()` exists but `polling-scheduler.ts` still calls `router.dispatch()`. Queue poll sessions run as generic sessions, not routed through the adaptive coordinator. Cross-PR gap documented with TODO.

2. **`findingCategory` not on review-verdict** -- Audit chain always dispatches `production-readiness-audit` for Critical findings regardless of finding type. `findingCategory` field on `findings[]` items needs to be added to `wr.review_verdict` schema as a follow-up so architecture findings can route to `architecture-scalability-audit` correctly.

3. **Bot account setup required before first queue run** -- `worktrain-etienneb` GitHub account must be created, PAT generated with `repo:read` scope, stored as `WORKTRAIN_BOT_TOKEN`, and added as repo collaborator. Commit identity: `worktrain-etienneb@users.noreply.github.com`. Without this, `github_queue_poll` trigger has no bot identity.

4. **No auto-merge setting in `worktrain init`** -- Auto-merge policy is hardcoded in the coordinator. Should be a `~/.workrail/config.json` setting exposed during `worktrain init`.

5. **Grooming loop not built** -- Three open design decisions must be settled before building (human-ack boundary, compute budget, priority signal source). Deferred until Level 1 usage data exists.

6. **Knowledge graph not wired** -- `src/knowledge-graph/` module exists (DuckDB + ts-morph), `ts-morph` in devDependencies. No daemon tool yet. Architecture decision: belongs in context assembly layer, not as a daemon tool.

7. **`worktrain inbox --watch` stub** -- Prints "not yet implemented." The outbox mechanism exists; just needs a polling loop.

8. **Artifact store not built** -- Agents dump markdown in the repo. `~/.workrail/artifacts/` not created.

### Next priorities (groomed Apr 20)

1. **Connect `dispatchAdaptivePipeline()`** -- Wire `polling-scheduler.ts` to call `TriggerRouter.dispatchAdaptivePipeline()` when `context.taskCandidate` is present. Small change, unlocks the full autonomous queue → pipeline connection.

2. **`findingCategory` on review-verdict schema** -- Add `findingCategory: 'correctness' | 'security' | 'architecture' | 'ux' | 'performance' | 'testing'` to `findings[]` in `ReviewVerdictArtifactV1Schema`. Update `mr-review-workflow-agentic` final step to emit it. Unlocks correct audit routing.

3. **Bot account setup + `worktrain init` overhaul** -- Create `worktrain-etienneb`, add `worktrain daemon --check` command (API key + git fetch dry run), expose auto-merge policy in `worktrain init`.

4. **Level 1 usage: run WorkTrain on its own backlog** -- Create `worktrain:ready` issues for the top 10 ready tasks, assign to `worktrain-etienneb`, observe one full queue → pipeline run. Collect data on misclassifications and weak PRs before designing the grooming loop.

5. **`worktrain inbox --watch`** -- Close the notification loop. Outbox exists, just needs the polling implementation.

---


---

## Current state update (Apr 21, 2026)

**npm version: v3.59.6** | Daemon PID: 54113 | Status: Running, pipeline active

### What shipped in this session (Apr 19-21, 2026)

**All five autonomous pipeline items (previously recorded) plus:**

- **Discovery loop fix** (#748) -- three coupled fixes: thread `maxSessionMinutes` through `spawnSession` (sessions now get 55/35/65 min instead of 30 min default), inspect `PipelineOutcome` in polling-scheduler and apply `worktrain:in-progress` label on escalation, write issue-ownership sidecar for cross-restart idempotency
- **In-process `awaitSessions` and `getAgentResult`** (#741) -- replaced HTTP calls to the daemon's own console with direct `ConsoleService` access
- **Try/catch on all coordinator I/O** (#740) -- `getAgentResult`, `pollForPR`, `postToOutbox` all wrapped; coordinator no longer crashes on I/O failure
- **Dispatch dedup prealloc bypass** (#744) -- `dispatch()` now bypasses dedup for pre-allocated sessions, fixing the zombie session bug that prevented discovery from starting
- **Promise.race crash fix** (#733) -- worktrees scan timeout no longer crashes the daemon via unhandled rejection
- **Trigger validator** (#690) -- `worktrain trigger validate` command, `validateTriggerStrict()` pure function
- **`worktrain trigger poll`** (#697) -- force immediate poll cycle on any queue trigger
- **`worktrain trigger test`** (#656) -- dry-run showing what would dispatch
- **Auto-load ~/.workrail/.env** (#673) -- daemon reads secrets from .env automatically
- **Daemon lifecycle events** (#674) -- `session_aborted` on SIGTERM, `daemon_heartbeat` every 30s
- **Attribution signals** (#658) -- `[WT]` PR title prefix, `Co-authored-by: WorkTrain` commit trailers, `worktrain:generated` label
- **Secret scan before push** (#660) -- pattern-based scan blocks commits with leaked credentials
- **Unified logs stream** (#680) -- `worktrain logs` now merges daemon events, queue-poll.jsonl, and filtered stderr
- **Stale lock file handling** (#705) -- validates lock file PID before trusting port discovery
- **5 architectural audits** (docs/design/) -- coordinator access, error handling, testability, type bloat, memory management
- **Stale user workflow cleanup** -- removed old copies from `~/.workrail/workflows/` that were causing ValidationError noise

### Current pipeline state (live)

Discovery session `ecf359d7` running: 77 turns, 11 step advances (active, making real progress on issue #393). Session `b7df0c8b` also running (just started). First clean run after all pipeline fixes landed.

### Accurate limitations (v3.59.6)

1. **Ghost sessions in event log** -- sessions killed by daemon crashes don't get `session_aborted` events from old daemon instances. New daemons emit it on shutdown, but historical sessions show as RUNNING.
2. **Worktree orphan leak** -- if `maybeRunDelivery()` worktree removal fails after sidecar deletion, orphan is invisible to `runStartupRecovery`. See backlog.
3. **`queue-poll.jsonl` never rotated** -- disk exhaustion risk on long-running daemons. See backlog.
4. **`ReviewSeverity` missing `assertNever`** -- future variants silently fall through. See backlog.
5. **`process.stderr.write` in `readVerdictArtifact`** -- bypasses injected dep, invisible to test fakes. See backlog.
6. **WorkRail MCP stale state** -- `workrail cleanup` command doesn't exist yet. Manual cleanup needed for dead managed sources, old session accumulation.
7. **Trigger validation static/runtime gap** -- some runtime checks not in static validator. See trigger-validation-gap-audit.md.
8. **WorkflowTrigger type bloat** -- mixes trigger config, session runtime state, delivery config. See workflow-trigger-lifecycle-audit.md.
9. **Conversation history not persisted** -- LLM conversation history is in-memory only. On crash, context is lost. See backlog.

### Next priorities (groomed Apr 21)

1. **Watch the current pipeline run** -- discovery `ecf359d7` is active at 77 turns/11 steps. If it completes, shaping and coding should fire automatically. First end-to-end validation.
2. **Execution time tracking** -- add session timing to `execution-stats.jsonl` for timeout calibration. Small change in `runWorkflow()` finally block.
3. **Three audit findings from above** -- worktree orphan leak, queue-poll rotation, assertNever fixes. All small, targeted.
4. **`workrail cleanup` command** -- removes dead managed sources, rotates old session files, clears stale git caches. Stops ValidationError noise in MCP server logs.
5. **Conversation history persistence** -- `conversation.jsonl` per session, append-only. Prerequisite for true crash recovery.
6. **Autonomous crash recovery and interrupted-session resume** -- see full entry below (Apr 21).

---


---

## Current state update (Apr 23, 2026)

**npm version: v3.66.0** | Daemon: stopped (intentionally, undergoing MCP reconnect) | MCP: reconnecting to updated binary

---

### What shipped in this session (Apr 22-23, 2026)

This was a major session covering daemon/console separation, metrics infrastructure, and workflow stability fixes.

**Architecture -- daemon/console/MCP separation:**
- **Delete daemon-console.ts** (#753) -- daemon no longer bundles an embedded console; `worktrain console` is now the sole console entry point
- **Remove dead steer/poll endpoints** (#755) -- deleted `worktrain trigger poll` CLI and the steer/poll HTTP endpoints that were only used by the deleted daemon-console
- **Wire workflow catalog into standalone console** (#783, open) -- `worktrain console` Workflows tab now works without the MCP server running; `EnhancedMultiSourceWorkflowStorage` constructed directly in `standalone-console.ts`

**Metrics infrastructure (6-step sequence, all merged):**
- **timestampMs on events** (#768, #772) -- `DomainEventEnvelopeV1Schema` now has required `timestampMs`; backfill script at `scripts/backfill-timestamps.ts`
- **`run_completed` event** (#773) -- emitted on successful session completion with `startGitSha`, `endGitSha`, `agentCommitShas`, `captureConfidence`, `durationMs`
- **Authoring docs: metrics_* keys** (#767) -- `metricsProfile` field and SHA accumulation convention documented in `docs/authoring-v2.md`
- **`projectSessionMetricsV2` projection** (#771) -- pure projection reading `run_completed` + `context_set metrics_*` keys, wired into `ConsoleSessionSummary`
- **Console metrics display** (#777) -- `SessionMetricsSection` in session detail view; `GET /api/v2/sessions/:id/diff-summary` endpoint
- **`stats-summary.json` writer** (#769) -- `~/.workrail/data/stats-summary.json` aggregated from `execution-stats.jsonl`, written post-session and every 30s heartbeat

**Engine improvements:**
- **Execution time tracking** (#756) -- `execution-stats.jsonl` per session in finally block
- **Worktree orphan leak fix** (#756) -- sidecar deletion deferred to `maybeRunDelivery()` for worktree sessions
- **assertNever for ReviewSeverity** (#756)
- **Crash recovery phase A** (#759) -- `clearQueueIssueSidecars()` fixes 56-min re-dispatch block; sidecar preservation for sessions with progress
- **Conversation history persistence** (#762) -- `<sessionId>-conversation.jsonl` per daemon session, append-only delta flush at each turn
- **queue-poll.jsonl rotation** (#761) -- 10 MB size cap with `.1` backup
- **Remove WorkTrain-owned label writes** (#765) -- `worktrain:in-progress`, `worktrain:generated` labels removed; deduplication now purely internal (sidecar + dispatchingIssues + session scan)
- **metricsProfile footer injection** (#779) -- engine injects `metrics_*` accumulation footers based on `metricsProfile` workflow field; all 35 bundled workflows assigned profiles

**Workflow namespace:**
- **Rename all bundled workflows to `wr.*`** (#782, open) -- `coding-task-workflow-agentic` → `wr.coding-task`, `mr-review-workflow-agentic` → `wr.mr-review`, etc. Prevents local project source from shadowing bundled workflows on version mismatch.

---

### Open PRs (waiting for WorkRail MCP review before merge)

| PR | Title | Status |
|---|---|---|
| #782 | Rename all bundled workflows to `wr.*` namespace | CI passing, needs `wr.mr-review` |
| #783 | Wire workflow catalog into standalone console | CI pending, needs `wr.mr-review` |

**Do not merge #782 or #783 without running `wr.mr-review` on each.** The MCP needs to reconnect to the updated 3.66.0 binary first.

---

### Active bugs (investigated, not yet fixed)

1. **`additionalProperties: false` not enforced in Ajv** -- `src/application/validation.ts` uses `strict: false`, making schema's `additionalProperties` advisory only. A workflow with an unknown field passes `validate:registry`. Discovery+shaping in progress (agent running). **High priority -- fix before next release.**

2. **`wr.mr-review` NOT_FOUND from MCP** -- `list_workflows` finds it but `start_workflow` returns NOT_FOUND. Root cause: MCP process is still running old 3.60.0 binary (global npm was stale). Fixed by `npm update -g @exaudeus/workrail` (done). Requires MCP reconnect to take effect.

3. **User's `wr.discovery` VALIDATION_ERROR** -- stale `npx` cache pre-3.11.2. Fix: `npm cache clean --force && npx @exaudeus/workrail`. No code change needed.

---

### Known gaps (not yet started)

- **Phase B crash recovery** -- actual agent loop restart after crash (not just sidecar preservation). Blocked on conversation history being tested end-to-end. See "Autonomous crash recovery" entry above.
- **`workrail cleanup` command** -- removes dead managed sources, old sessions. Still needed.
- **console-routes.ts dispatch coupling** -- `POST /api/v2/auto/dispatch` still imports `runWorkflow` from `src/daemon/`. See backlog entry.
- **`wr.*` list/get inconsistency** -- user-source `wr.*` copies appear in list but execution uses bundled. Low priority.

---

### Current system state (Apr 23, 2026 -- end of session)

**npm version: v3.68.1** | Daemon: stopped | MCP: connected on 3.68.1

**What shipped this session (Apr 23):**
- **`wr.*` workflow namespace rename** (#782) -- all 31 bundled workflows renamed; `legacy_project` source can no longer shadow bundled ones
- **`triggers.yml` updated** (#785) -- `wr.coding-task`, `wr.mr-review`
- **Standalone console Workflows tab** (#783) -- works without MCP server
- **Validation regression test** (#784) -- `additionalProperties: false` confirmed enforced
- **Session metrics refactor** (#786) -- defensive cast removed, types clean
- **Validation warnings in `list_workflows`** (#787) -- users now see why their workflow disappeared
- **`loadSessionNotes` export fix** (#790) -- 14 pre-existing test failures now pass
- **`metrics_outcome` validation** (#793) -- agents get `VALIDATION_ERROR` immediately if they pass invalid values; tested and confirmed working

**Active bugs / gaps:**
- GitHub admin bypass removed from ruleset -- `gh pr merge --admin` will fail
- `metrics_pr_numbers` still 0% (review workflows not picking up footer) -- expected, no sessions have completed `wr.mr-review` with new IDs yet
- Only 20% of sessions have `run_completed` -- most daemon sessions don't complete due to crashes/timeouts; normal

**Known gaps (not yet started):**
- **Phase B crash recovery** -- actual agent loop restart after crash
- **`workrail cleanup` command** -- dead managed sources, old sessions
- **Versioned workflow schema validation** -- see backlog entry above
- **console-routes.ts dispatch coupling** -- `POST /api/v2/auto/dispatch` imports from `src/daemon/`
- **Daemon agent loop stall detection** -- 120s liveness check for frozen loops

**System state:**
- **WorkRail MCP server:** Connected at 3.68.1 (global npm `npx -y @exaudeus/workrail`). All `wr.*` IDs working.
- **WorkTrain daemon:** Stopped. Start: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.worktrain.daemon.plist`. Points at local dist (`/Users/etienneb/git/personal/workrail/dist/cli-worktrain.js`).
- **WorkRail console:** Not running. Start: `worktrain console`. Reads session files directly, no daemon required.
- **Global npm:** 3.68.1 (`npm update -g @exaudeus/workrail` done)
- **Local build:** Built from main at 3.68.1 (`npm run build` done)

**Next up:**
1. Restart daemon and watch first pipeline run with `wr.*` IDs
2. Versioned schema validation (design ready in backlog, audit confirmed v1 = current schema)
3. Daemon agent loop stall detection (medium priority)

---


---

## Consider rewriting WorkRail engine in Kotlin (Apr 23, 2026)

### The argument

WorkRail's coding philosophy demands "make illegal states unrepresentable" and "type safety as the first line of defense." TypeScript is structurally at odds with this: the compiler is advisory, not enforcing. `as unknown as`, `any`, and type assertion casts are always one line away. In a codebase where autonomous agents write and merge code without deep human review, the compiler is the reviewer -- and TypeScript's escape hatches make it too easy for an agent to paper over a real design problem with a cast.

Evidence from today's work: the `RunCompletedDataExpected` intermediate interface and the `as unknown as` cast in `session-metrics.ts` both existed for weeks. TypeScript didn't prevent them. A stricter compiler -- one where bypass requires genuine effort -- raises the bar the agent has to clear before code is valid.

### What Kotlin actually buys

- **Sealed classes** -- exhaustive `when` is a compile error, not a runtime `assertNever` pattern that convention must enforce
- **No easy escape hatch** -- `as` in Kotlin throws at runtime on type mismatch; there's no equivalent of `as unknown as` that silently lies to the compiler
- **Null safety by default** -- `String` vs `String?` is a language distinction, not a `strict: true` compiler flag that can be turned off
- **Value classes and data classes** -- less boilerplate for domain types, stronger invariants

### What TypeScript + current tooling already covers

- Zod at boundaries provides runtime validation that Kotlin's type system would provide at compile time -- this gap is smaller than it looks
- `neverthrow` gives Result types
- Discriminated unions + `assertNever` give exhaustiveness -- but enforced by convention, not the compiler

### Real costs

- JVM startup latency for an MCP server that starts/stops frequently -- mitigable with GraalVM native image, but adds build complexity
- Full rewrite of `src/` -- months of work, not weeks
- Console stays TypeScript/React regardless
- The Kotlin MCP SDK exists but the ecosystem tooling (npm, Node.js file I/O patterns) needs reimplementation

### The honest tradeoff

Convention drift is a recurring tax. Migration is a one-time cost. In a codebase driven heavily by autonomous agents, the compiler is the last line of defense against accumulated drift. TypeScript's permissiveness means that defense has holes.

This is not urgent -- the current codebase is working well. But if autonomous agent usage grows and human review per-PR decreases further, the compiler enforcement gap becomes more important, not less.

**Priority:** Low / long-term. Worth revisiting when the agent is writing the majority of new code. Requires a concrete spike: rewrite one module (e.g. `src/v2/durable-core/domain/`) in Kotlin and measure the real friction before committing to a full migration.

---
