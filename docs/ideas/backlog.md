# Ideas Backlog

Workflow and feature ideas worth capturing but not yet planned or designed.
For historical narrative and sprint journals, see `docs/history/worktrain-journal.md`.

---

## P0 / Critical (blocks WorkTrain from working correctly)

### Agent is doing coordinator work

**Status: bug** | Priority: P0

The agent ran `cd /path/to/main-checkout && git log`, `gh issue view`, read roadmap docs, checked open PRs -- coordinator work. The agent should never do this. It is a worker: receive scoped task, produce output, call `complete_step`. All environment setup, context gathering, git operations, worktree management, PR creation, and orchestration is coordinator responsibility.

The coordinator should: create the worktree before the agent starts, pass a clean context packet (issue body, relevant code, what to produce), handle all git operations after the agent finishes, spawn specialized sub-agents for subtasks.

**Near-term mitigation:** Inject `sessionWorkspacePath` (the worktree) into the system prompt instead of `trigger.workspacePath` (main checkout), and explicitly tell the agent "do not run git commands, do not read roadmap docs -- that is coordinator work." Partial fix held pending full redesign.

**Full fix:** Coordinator-heavy pipeline redesign (see below).

---

### Wrong directory: agent worked in main checkout instead of worktree

**Status: bug** | Priority: P0

All bash commands used `cd /main-checkout` instead of the worktree. Code changes went nowhere. Delivery found nothing to commit and silently skipped. Root cause: system prompt names `trigger.workspacePath`, not `sessionWorkspacePath`.

---

### Agent faked commit SHAs in handoff block

**Status: bug** | Priority: high

Handoff block `agentCommitShas` contained existing main-branch SHAs from `git log`, not new commits. Fix: coordinator records commit SHAs itself (before/after diff) rather than trusting the agent.

---

### `taskComplexity=Small` misclassification

**Status: bug** | Priority: medium

Issue #241 (TTL eviction across multiple files + new tests) was classified as Small, skipping design review, planning audit, and verification loops. Consider requiring human confirmation on Small classification before bypassing phases.

---

### Daemon binary stale after rebuild, no indication to user

**Status: ux gap** | Priority: medium

After `npm run build`, `worktrain daemon --start` launches the old binary. No warning. Fix: compare binary mtime to running process's binary and warn if stale.

---

### `worktrain daemon --start` reports success even when daemon crashes immediately

**Status: bug** | Priority: medium

Health check waits 1 second then checks `launchctl list`. If daemon crashes in < 1s, check sees a PID and reports success. Fix: poll for up to 5 seconds, verify daemon is still running at end of window.

---

### Handoff block not surfaced to operator

**Status: ux gap** | Priority: medium

Agent writes a complete handoff block (commitType, prTitle, prBody, filesChanged) to the session store. Invisible to operator without digging through event logs. Fix: `worktrain status <sessionId>` should show it; console session detail should surface it prominently.

---

## WorkTrain Daemon

The autonomous workflow runner (`worktrain daemon`). Completely separate from the MCP server -- calls the engine directly in-process.


### `wr.refactoring` workflow (Apr 28, 2026)

**Status: idea** | Priority: medium

A dedicated `wr.refactoring` workflow for structural refactors that don't change behavior. Distinct from `wr.coding-task` because refactors have a different shape: no new features, no bug fixes, just architecture alignment. The workflow should enforce:
- **Discovery phase**: understand current state, identify violations, classify scope
- **Test-first phase**: write tests for any extracted pure functions BEFORE extracting them (TDD red)
- **Extraction phase**: one slice at a time, tests green after each
- **Verification phase**: full suite green, build clean, no behavior changes
- **Doc update phase**: update any reference docs that describe the changed invariants

The `wr.coding-task` workflow has too much overhead for pure refactors (design review, risk assessment gating, PR strategy) and not enough refactor-specific discipline (test-first enforcement, behavior-unchanged verification).

---

### API key baked into launchd plist at install time (Apr 24, 2026)

**Status: idea** | Priority: medium

`worktrain daemon --install` captures `ANTHROPIC_API_KEY` from the current shell environment and bakes it into `~/Library/LaunchAgents/io.worktrain.daemon.plist` (mode 600). The key persists in the plist file indefinitely and is visible to anyone who can read the file or takes a backup of `~/Library/LaunchAgents/`.

**Better approach:** Read `ANTHROPIC_API_KEY` from `~/.workrail/.env` at daemon startup rather than baking it into the plist. The plist would only contain the non-secret env vars (AWS_PROFILE, WORKRAIL_TRIGGERS_ENABLED, PATH). Secrets live in `~/.workrail/.env` which is already the designated secrets file and is already loaded by `loadDaemonEnv()` at startup.

**Implementation:** In `captureEnvVars()` in `src/cli/commands/worktrain-daemon.ts`, exclude `ANTHROPIC_API_KEY` (and any other `*_API_KEY` vars) from the captured set. The daemon already calls `loadDaemonEnv()` which reads `~/.workrail/.env` -- operators just need to put the key there instead of in their shell env.

**Migration:** Existing installs have the key in the plist. `worktrain daemon --install` should detect an existing plist with an API key and print a migration note.

---

### runWorkflow() functional core refactor -- Phase 2 (Apr 24, 2026)

**Status: idea** | Priority: medium

Phase 1 landed in PR #818: extracted `tagToStatsOutcome`, `buildAgentClient`, `evaluateStuckSignals`, `SessionState`, and `finalizeSession`. `runWorkflow()` is still ~880 lines with I/O and pure logic interleaved in the setup phase.

**What remains:**

**Extract `buildSessionConfig(trigger, loadedCtx) -> SessionConfig`** -- a pure function that takes already-loaded context (soul content, workspace context string, session notes array -- all loaded by I/O before the call) and returns everything the agent loop needs: system prompt, tool list, session limits, model/client config. Currently this logic is scattered through the setup phase alongside the I/O calls that load the data.

```typescript
interface SessionContext {
  readonly systemPrompt: string;
  readonly tools: readonly AgentTool[];
  readonly sessionTimeoutMs: number;
  readonly maxTurns: number;
  readonly initialPrompt: string;
  readonly agentCallbacks: AgentLoopCallbacks;
}

function buildSessionContext(
  trigger: WorkflowTrigger,
  agentClient: AgentClientInterface,
  modelId: string,
  soulContent: string,           // already loaded by loadDaemonSoul()
  workspaceContext: string | null, // already loaded by loadWorkspaceContext()
  sessionNotes: readonly string[], // already loaded by loadSessionNotes()
  state: SessionState,
  // ... tool factories, schemas, etc.
): SessionContext
```

The shell then does:
1. All I/O in sequence: `loadDaemonSoul`, `loadWorkspaceContext`, `loadSessionNotes`, `git worktree add`, `executeStartWorkflow`, `parseContinueTokenOrFail`, `persistTokens`
2. One pure call: `buildSessionContext(trigger, client, modelId, soul, ctx, notes, state, ...)`
3. Run the agent loop with the returned config

**Why this matters:** `buildSessionContext` would be unit-testable without any filesystem, LLM, or session store. The system prompt assembly, tool list construction, and session limit calculation are currently untestable in isolation. This is the biggest remaining testability gap.

**Prerequisite:** Phase 1 (PR #818) -- done. `SessionState` already exists and can be passed in.

**Scope:** Single file (`src/daemon/workflow-runner.ts`). New exports: `buildSessionContext`, `SessionContext`. No public API changes.

---

## Shared / Engine

The durable session store, v2 engine, and workflow authoring features shared by all three systems.


### Improve commit SHA gathering consistency in wr.coding-task

**Status: idea** | Priority: high

After fixing the primary cause (SHA footer referenced `continue_workflow` by name while daemon agents use `complete_step`), two structural gaps remain that prevent consistent SHA recording:

**Gap 1: SHA footer appears on every non-final step, including planning/design steps with no commits.** Agents correctly skip it on those steps, but the repetition trains them to suppress it reflexively -- including on implementation steps where it matters. Options to explore: inject only inside loop bodies tagged as implementation, add an opt-out flag to steps, or move the SHA reminder into the implementation step prompts directly in the workflow JSON.

**Gap 2: `phase-5-small-task-fast-path` has no correctly-wired final metrics step for Small tasks.** `isLastStep` resolves to `phase-7b-fix-and-summarize`, which has a `runCondition` that skips it for Small tasks. Small-task sessions never see the final metrics footer. Needs either: the final footer added directly to `phase-5`'s authored prompt, or `isLastStep` detection made context-aware (complex).

**Gap 3: No validation for `metrics_commit_shas`.** `checkContextBudget` validates `metrics_outcome` but not SHAs. Missing or partial arrays fail silently. A warning-level soft validation at the final step would at least surface the gap in logs.

The right fix is probably a combination of moving the SHA instruction into the implementation step prompts directly (removing it from the ambient footer entirely) and adding Gap 2's final footer to `phase-5`. That avoids any new engine machinery.

---

### `jumpIf`: conditional step jumps with per-target jump counter

**Status: idea** | Priority: medium

**Problem:** Workflows with investigation or iterative refinement patterns (bug-investigation, mr-review) can exhaust their hypothesis set and reach an `inconclusive_but_narrowed` state with no structural way to restart an earlier phase. A `jumpIf` primitive would let any step conditionally restart execution from an earlier step when a context condition is met.

**Proposed design:**

```json
{
  "id": "phase-4b-loop-decision",
  "jumpIf": {
    "condition": { "var": "diagnosisType", "equals": "inconclusive_but_narrowed" },
    "target": "phase-2-hypothesis-generation-and-shortlist",
    "maxJumps": 2
  }
}
```

**Engine behavior:**
- When a step completes and its `jumpIf.condition` is met, the engine checks the per-session jump counter for `target`
- Counter is derived from the event log: count `jump_recorded` events where `toStepId === target` -- fully append-only and replayable
- If `counter < maxJumps`: append `jump_recorded` event, create fresh nodeIds for `target` and all subsequent steps, mint a new continueToken pointing at the fresh target node
- If `counter >= maxJumps`: jump is blocked, execution falls through to the next step (safety cap, not an error)

**Why this is safe:**
- `maxJumps` is a required field -- no unbounded loops possible
- Counter is derivable from the append-only event log -- no mutable state
- Fall-through on limit reached is predictable and operator-visible

**Open design questions:**
- `maxJumps` default if omitted -- probably require it explicitly (same as `maxIterations` on loops)
- DAG console rendering -- backward jumps create "re-entry" edges. Needs a distinct visual treatment
- Interaction with `runCondition` -- if a jumped-to step has a `runCondition` that evaluates false at re-entry time, does the engine skip it and advance?

**Scope when ready to implement:**
- `spec/workflow.schema.json`: add `jumpIf` to `standardStep`
- `spec/authoring-spec.json`: add authoring rule
- Compiler: validate `target` resolves to a reachable earlier step, `maxJumps >= 1`
- Engine (`src/v2/durable-core/`): new `jump_recorded` event kind, counter derivation, fresh nodeId creation on jump
- Console DAG: render jump edges distinctly

**Motivation workflow:** `wr.bug-investigation` -- when all hypotheses are eliminated and `diagnosisType === 'inconclusive_but_narrowed'`, jump back to phase 2 (hypothesis generation) with the eliminated theories in context, up to 2 times before falling through to validation/handoff.

---

### Versioned workflow schema validation

**Status: idea** | Priority: medium-high

**Problem:** WorkRail validates workflow files against the schema bundled in the currently-running MCP binary. Binary too new rejects old workflows; binary too old rejects new workflows. Both cause silent disappearance from `list_workflows` with no explanation.

**The right fix:** Each workflow declares `"schemaVersion": 1` (integer). The binary ships validator copies for every schema version it supports. When loading a workflow, pick the validator matching the declared version.

**Load-time logic:**
1. Read `schemaVersion` (default 1 if absent -- legacy workflows)
2. If `schemaVersion === current`: validate against current schema directly
3. If `schemaVersion < current` (binary newer): validate against the declared schema version
4. If `schemaVersion > current` (binary too old): load leniently with warnings -- `additionalProperties: false` does not apply

**Decision (from Apr 23 audit):** v1 = current schema. The one historical breaking change (`assessmentConsequenceTrigger`, Apr 5) was fully contained within the bundled workflow corpus. No historical reconstruction needed.

**Files to change:** `spec/workflow.schema.json`, `spec/workflow.schema.v1.json` (snapshot), `src/application/validation.ts`, `src/types/workflow-definition.ts`, `workflow-for-workflows.json` (stamp `schemaVersion`), all bundled workflows.

---

### Task re-dispatch loop protection

**Status: idea** | Priority: high

**Problem:** When a pipeline session fails (stuck, crash, timeout), the idempotency sidecar expires after its TTL and the queue re-selects the same issue on the next poll cycle. There is no memory of how many times an issue has been attempted. A task that consistently fails gets retried indefinitely, burning API credits with no forward progress.

**Concrete incident:** Issue #393 was dispatched in a loop -- discovery + shaping + coding sessions repeatedly started, failed stuck, and were re-dispatched.

**Design:** Extend `queue-issue-<N>.json` to include `attemptCount`. On each new dispatch for the same issue, increment. When `attemptCount >= maxAttempts` (default 3), skip dispatch, emit outbox notification, apply a `worktrain:needs-human` label, and post a comment on the issue.

**Human reset:** Closing/reopening the issue, removing the `worktrain:stuck` label, or `worktrain retry <issueNumber>`.

**Files:** `src/trigger/adapters/github-queue-poller.ts`, `src/trigger/polling-scheduler.ts`, daemon sidecar schema.

---

### Daemon agent loop stall detection

**Status: idea** | Priority: medium

**Problem:** A daemon session that stops making LLM API calls (hung tool, network issue with no timeout, silent deadlock) spins until the wall-clock timeout fires -- up to 55-65 minutes. No indication to the operator, no early abort, no event emitted.

**Design:** In `src/daemon/agent-loop.ts`, add a per-turn heartbeat timer that resets each time an LLM call starts. If the timer fires (120s with no new turn), call `agent.abort()` and emit `agent_stuck` with `reason: 'no_llm_turn'`. Configurable via `agentConfig.stallTimeoutSeconds`.

**Where to look:** `src/daemon/agent-loop.ts` `_runLoop()`, `src/daemon/workflow-runner.ts` stuck detection, `src/daemon/daemon-events.ts` `AgentStuckEvent`.

---

### `queue-poll.jsonl` never rotated

**Status: idea** | Priority: medium

**Bug:** `~/.workrail/queue-poll.jsonl` grows indefinitely -- `appendFile`-only, no rotation. At 5-minute poll intervals: ~8-87 MB/month depending on activity. Disk exhaustion risk on long-running daemons.

**Fix:** Add a size check before appending in `appendQueuePollLog()`. If file exceeds 10 MB, rotate: rename to `queue-poll.jsonl.1`, start fresh. Keep at most 2 rotated files.

**File:** `src/trigger/polling-scheduler.ts`, `appendQueuePollLog()`.

---

### ReviewSeverity: stderr bypassing injected dep

**Status: idea** | Priority: medium

**Bug 1 (DONE):** `assertNever` on `ReviewSeverity` was added at `pr-review.ts:1407`. ✓

**Bug 2 (still open):** `src/coordinators/pr-review.ts:447` -- `process.stderr.write(...)` called directly instead of using injected `deps.stderr`. Tests that inject a fake dep miss this log.

**File:** `src/coordinators/pr-review.ts`.

---

### Session continuation / "just keep talking"

**Status: idea** | Priority: medium

A completed session is not dead -- the conversation is still in the event log. The only thing blocking continuation is the engine rejecting messages to sessions in `complete` state.

**The change:** Remove that gate. `worktrain session continue <sessionId> "<message>"` sends a message to a completed session. New events appended to the same log. Same session ID. The agent has full context of everything it ever did.

Context window overflow (very long sessions) is a separate optimization problem -- truncate oldest turns while keeping step notes. Don't solve it now.

---

### Session as a living record: post-completion phases

**Status: idea** | Priority: medium

A `session_completed` event means the original workflow is done -- not that the session can never receive new events. The event log is append-only: just keep appending. A post-completion interaction adds a `session_resumed` event, then new turns, then a new `session_completed`.

This is already how mid-run resume works. The same mechanism extends naturally to post-completion: rehydrate the completed state, append a new lightweight phase, run it, complete again.

**Richer automatic checkpoints:** Many session events should trigger a checkpoint automatically:
- `step_advanced` (already essentially a checkpoint)
- `signal_coordinator` fired (agent surfaced meaningful mid-step state)
- Worktree commit pushed (code state durable on remote)
- Coordinator steers the session (notable injection)
- `spawn_agent` child completes (parent has new information)

---

### Rules preprocessing: normalize workspace rules before injection

**Status: idea** | Priority: medium

**Problem:** WorkTrain injects all rules files raw into every agent's system prompt. A workspace with `.cursorrules`, `CLAUDE.md`, `.windsurf/rules/*.md`, and `AGENTS.md` might inject 10KB of rules into a discovery session that only needs 2KB.

**Design:** A `worktrain rules build` command that reads all IDE rules files from the workspace, deduplicates overlapping rules, categorizes by phase, and writes to `.worktrain/rules/`:
- `implementation.md`, `review.md`, `delivery.md`, `discovery.md`, `all.md`
- `manifest.json` -- which files exist, when generated, source files used

At session time: WorkTrain injects only the phase-relevant file.

---

### True session status (live agent state in console)

**Status: idea** | Priority: medium-high

**Problem:** The console currently infers session status from last event timestamp. WorkTrain has direct access to `DaemonRegistry`, `DaemonEventEmitter`, and turn-level events -- it should show true status.

**True session status taxonomy:**
- `active:thinking` -- LLM API call in progress
- `active:tool` -- tool executing (name visible)
- `active:idle` -- between turns, session in DaemonRegistry
- `stuck` -- stuck heuristic fired
- `completed:success/timeout/stuck/max_turns`
- `aborted` -- daemon killed mid-run
- `daemon:down` -- no recent heartbeat

Surface in: `worktrain status`, `worktrain health <sessionId>`, console session rows.

---

## WorkTrain Daemon -- Coordinator patterns

Coordinator design patterns for WorkTrain's autonomous pipeline.


### Event-driven agent coordination (coordinator as event bus)

**Status: idea** | Priority: high

**Problem:** Agents managing an MR should not poll for review comments or CI status -- that wastes turns and burns tokens. Instead, the coordinator should register for events and steer the agent when something relevant happens.

The infrastructure already exists: `steerRegistry` + `POST /sessions/:id/steer`, `signal_coordinator` tool, `DaemonEventEmitter`.

**What's missing:** Coordinator-side event sources (GitHub webhooks or polling fallback) and an event-to-steer bridge that maps `MREvent` to structured steer messages.

**How it works:** MR management agent session is parked (no pending turns). Coordinator registers for GitHub events. When review comment/CI failure/approval arrives, coordinator steers the running session. Agent responds. No polling from the agent side.

**Agent session prompt:** "Do not poll for PR status. Wait for the coordinator to deliver events via injected messages."

---

### MR lifecycle manager

**Status: idea** | Priority: high

**Gap:** WorkTrain currently creates a PR and dispatches an MR review session. Everything between "PR created" and "PR merged" is invisible: CI failures, reviewer comments, requested changes, merge conflicts, required approvals. A human has to watch and intervene.

**Vision:** `runMRLifecycleManager()` takes ownership of the MR from creation to merge.

**Responsibilities:**
1. MR creation with correct template, labels, milestone, reviewers, linked tickets
2. CI pipeline monitoring -- parse failures, retry flaky tests, spawn fix sessions
3. Review comment triage -- classify each comment (actionable/question/nit/approval/blocker), reply autonomously or escalate
4. Approval tracking -- when all gates pass, trigger merge
5. Merge conflict resolution -- rebase or escalate complex conflicts
6. Merge execution + downstream ticket/notification updates

**Dependency:** PR template support, phase-scoped rules, `dispatchCondition` webhook filter.

---

### Phase-scoped context files

**Status: idea** | Priority: medium

**Design:** Teams define context files scoped to specific pipeline phases under `.worktrain/rules/`:
- `discovery.md`, `shaping.md`, `implementation.md`, `review.md`, `delivery.md`, `pr-management.md`, `all.md`

Each file is injected only into sessions running the matching pipeline phase. Reduces token waste and rule dilution. `all.md` is equivalent to today's AGENTS.md injection.

**Load order (most specific wins):** `AGENTS.md` / `CLAUDE.md` (base) → `.worktrain/rules/all.md` → phase-specific file.

---

### Coordinator architecture: separation of concerns

**Status: idea** | Priority: medium

**Problem:** `src/coordinators/pr-review.ts` is already ~500 LOC doing session dispatch, result aggregation, finding classification, merge routing, message queue drain, and outbox writes. Adding knowledge graph queries, context bundle assembly, and prior session lookups would create a god class.

**Right layering:**
```
Trigger layer         src/trigger/          receives events, validates, enqueues
Dispatch layer        (TBD)                 decides which workflow + what goal
Context assembly      (TBD)                 gathers and packages context before spawning
Orchestration layer   src/coordinators/     spawns, awaits, routes, retries, escalates
Delivery layer        src/trigger/delivery  posts results back to origin systems
```

**Context assembly** is the missing layer. Before dispatching a coding session, `assembleContext(task, workspace)` runs: knowledge graph query, upstream pitch/PRD fetch, relevant prior session notes, returns a structured context bundle. The orchestration script should call this, not own it.

---

### Scheduled tasks (native cron provider)

**Status: idea** | Priority: medium

**Gap:** No native cron/schedule provider. Workaround is OS crontab calling `curl`.

**Design:**
```yaml
triggers:
  - id: weekly-code-health
    provider: schedule
    cron: "0 9 * * 1"
    workflowId: architecture-scalability-audit
    workspacePath: /path/to/repo
    goal: "Run weekly code health scan"
```

**Key decisions:**
- Standard 5-field cron syntax, configurable timezone
- Missed runs NOT caught up by default (optional `catchUp: true`)
- Overlap prevention: if a run is still active when the next tick fires, skip it
- `worktrain run schedule <trigger-id>` for manual trigger

**Implementation:** `PollingScheduler` already runs time-based loops. Schedule provider would use cron expression matching instead of API polling. State persists to `~/.workrail/schedule-state.json`.

---

### Autonomous grooming loop + workOnAll mode

**Status: idea** | Priority: medium

**Three autonomy levels:**

- **Level 0 (current):** Human applies `worktrain` label to specific issues. WorkTrain works those only.
- **Level 1 -- workOnAll:** Config flag `workOnAll: true`. WorkTrain looks at ALL open issues, infers which are actionable, picks highest-priority. Escape hatch: `worktrain:skip` label.
- **Level 2 -- Fully proactive:** WorkTrain also surfaces work it found itself (failing CI, backlog items with no issue, patterns in git history).

**Grooming loop (scheduled nightly):** Reads backlog, open issues, recent completed work. Closes resolved issues. For ungroomed items: infers maturity (linked spec, acceptance criteria, vague language). For high-value idea-level items: runs `wr.discovery` + `wr.shaping`, creates/updates issue.

**workOnAll config:**
```json
{ "workOnAll": true, "workOnAllExclusions": ["needs-design", "blocked-external"], "maxConcurrentSelf": 2 }
```

---

### Escalating review gates based on finding severity

**Status: idea** | Priority: medium

**Problem:** "Blocking" is binary -- a single Critical finding and a trivially incorrect comment are treated identically.

**Right behavior:** After a fix round, if re-review still returns Critical:
1. Another full MR review -- confirm the Critical is real, not a false positive
2. Production readiness audit -- a Critical finding often implies a runtime risk
3. Architecture audit -- if the Critical is architectural

Routing by `finding.category` from `wr.review_verdict`:
- `correctness` / `security` -> always trigger prod audit
- `architecture` / `design` -> trigger arch audit
- All -> trigger re-review

**Hard rule:** A PR that triggered the escalating audit chain should NEVER auto-merge. Human explicit approval required.

---

### Workflow execution time tracking and prediction

**Status: idea** | Priority: medium

**Problem:** Timeouts are set by intuition. No data on how long workflows actually take.

**What to track:** For every completed session -- workflow ID, total wall-clock duration, turn count, step advances, outcome, task complexity signals. Store in `~/.workrail/data/execution-stats.jsonl`.

**Uses:**
- Calibrate timeouts automatically (p95 * 1.5)
- Predict duration before dispatch
- Step-advance rate as workflow efficiency proxy

**Implementation:** Append to `execution-stats.jsonl` in `runWorkflow()`'s finally block.

---

### WorkRail MCP server self-cleanup

**Status: idea** | Priority: medium

**Sources of stale state:** old workflow copies in `~/.workrail/workflows/`, dead managed sources, stale git repo caches, 500+ sessions accumulating with no TTL, remembered roots for non-existent paths.

**Fix -- two layers:**

1. **Startup auto-cleanup (light):** On MCP server startup, silently remove managed sources where the filesystem path doesn't exist. Log "removed N stale sources."

2. **`workrail cleanup` command:**
   ```
   workrail cleanup [--yes] [--sessions --older-than <age>] [--sources] [--cache] [--roots]
   ```

---

### Subagent context packaging

**Status: idea** | Priority: medium

**Problem:** When a main agent spawns a subagent, the work package is too thin. The main agent has rich context (why this approach was chosen, what was tried, what constraints were discovered) but packages the subagent task as a one-liner.

**Design (Option B -- structured work package):**
```typescript
spawnSession({
  workflowId: 'coding-task-workflow-agentic',
  goal: '...',
  context: {
    whyThisApproach: '...',
    alreadyTried: [...],
    knownConstraints: [...],
    relevantFiles: [...],
    completionCriteria: '...'
  }
})
```

**Context mode:** `context: 'inherit' | 'blank' | 'custom'`. Blank is for adversarial roles (challenger, reviewer) where anchoring to main-agent context is counterproductive.

**Session knowledge log:** As the main agent progresses, it appends to `session-knowledge.jsonl` -- decisions, user pushback, relevant files, constraints, things tried and failed. Auto-included in subagent work packages.

---

### Workflow-scoped system prompts for subagents

**Status: idea** | Priority: medium

**Design:** Workflows (and individual steps) can declare a `systemPrompt` field injected into subagent sessions.

```json
{
  "id": "mr-review-workflow.agentic.v2",
  "systemPrompt": "You are an adversarial code reviewer. Your job is to find problems, not validate the approach.",
  "steps": [...]
}
```

Step-level `systemPrompt` overrides workflow-level for that step.

**Composition layers:**
1. WorkTrain base prompt
2. Workflow-level `systemPrompt`
3. Step-level `systemPrompt`
4. Soul file (operator behavioral rules)
5. AGENTS.md / workspace context
6. Session knowledge log (if `context: 'inherit'`)
7. Step prompt

---

### `context-gather` step type

**Status: idea** | Priority: medium

**Problem:** Phase 0.5 in the coding workflow currently looks for a shaped pitch by checking a local path. This doesn't handle coordinator-injected context, manually written docs (GDoc, Confluence, Notion), Glean-indexed artifacts, or URLs embedded in the task description. The search logic is duplicated if other workflows need the same document.

**Proposed primitive:**
```json
{
  "type": "context-gather",
  "id": "gather-pitch",
  "contextType": "shaped-pitch",
  "outputVar": "shapedInput",
  "optional": true,
  "sources": ["coordinator-injected", "local-paths", "task-url", "glean"]
}
```

**Source resolution order (stops at first hit):**
1. `coordinator-injected` -- coordinator already attached context of this type
2. `local-paths` -- check `.workrail/current-pitch.md`, `pitch.md`, `.workrail/pitches/`
3. `task-url` -- extract any URL from task description and fetch
4. `glean` -- search Glean for recent docs matching task keywords (opt-in only)

**Why engine-level:** Coordinator intercept requires the engine to check "has this type already been provided?" before running any search. A routine can't express that.

---

## WorkRail MCP Server

The stdio/HTTP MCP server that Claude Code (and other MCP clients) connect to. MUST be bulletproof -- crashes kill all in-flight Claude Code sessions.



## Console

### Console interactivity and liveliness

**Status: idea** | Priority: medium

**Key areas:**
- **DAG node hover effects** -- nodes in `RunLineageDag` should have visible hover states: border brightens, subtle glow, cursor changes to pointer. This is the single highest-impact item.
- **Node selection highlight** -- selected node should pulse or glow, not just change border color
- **Live session pulse** -- sessions with `status: in_progress` could have a subtle periodic animation
- **Tooltip polish** -- fade in/out rather than appearing instantly

**Design constraint:** Dark navy, amber accent aesthetic. Additions should reinforce this language.

**Where to start:** `console/src/components/RunLineageDag.tsx`. The tooltip pattern (`handleNodeMouseEnter`/`handleNodeMouseLeave`) already exists; a hover glow is a natural peer addition.

**Related:** `docs/design/console-cyberpunk-ui-discovery.md`, `docs/design/console-ui-backlog.md`

---

### Console engine-trace visibility and phase UX

**Status: idea** | Priority: medium

**Gap:** Users currently see only `node_created`/`edge_created`, which makes legitimate engine behavior look like missing workflow phases. Fast paths, skipped phases, condition evaluation, and loop gates are invisible.

**Recommended direction:**
- Keep phases as authoring/workflow-organization concepts
- Add an engine-trace/decision layer showing: selected next step, evaluated conditions, entered/exited loops, important run context variables (e.g. `taskComplexity`), skipped/bypassed planning paths

**Phase 1:** Extend console service/DTOs with a run-scoped execution-trace summary. Show a compact "engine decisions" strip or timeline above the DAG.

**Phase 2:** Richer explainability timeline with branches, skipped phases, condition results. Toggle between "execution DAG" and "engine trace" views.

---

### Console ghost nodes (Layer 3b)

**Status: idea** | Priority: low

Ghost nodes represent steps that were compiled into the DAG but skipped at runtime due to `runCondition`. Currently the DAG just shows fewer nodes with no indication of what was bypassed. Layer 3b would render skipped nodes as faded/ghost elements with a tooltip explaining the skip condition.

---

## Workflow Library

### General-purpose workflow / intelligent dispatcher

**Status: idea** | Priority: medium

Two related ideas:

**`wr.quick-task`** -- the simplest possible workflow. 2 steps: do the work, call complete_step. No complexity routing, no design review, no phased implementation. For tasks under ~10 minutes. Currently small tasks go through `wr.coding-task`'s Small fast-path which is still heavier than needed.

**`wr.dispatch`** -- an intelligent routing workflow. Given a goal, classify it and route to the right workflow: `wr.quick-task` | `wr.research` | `wr.coding-task` | `wr.mr-review` | `wr.competitive-analysis`. The general-purpose entry point -- not a workflow that does everything, but one that decides which workflow to use. The adaptive pipeline coordinator already does this for the queue-poll trigger; the question is whether to expose it as a named user-facing workflow.

Open questions: does `wr.dispatch` replace `workflowId` in trigger config, or coexist alongside it? How does it handle tasks that don't fit any known workflow?

---

### MR review session count inflation

**Status: idea** | Priority: medium

A single PR review dispatches 6-12 autonomous sessions (one per reviewer family: correctness_invariants, runtime_production_risk, missed_issue_hunter, etc.). This inflates session counts, complicates cost attribution, and makes ROI calculations imprecise. Worth investigating: are all 6 families catching distinct issues, or is there significant overlap? Should families be parallelized into a single session with sub-agents rather than separate top-level sessions?

---

### Session trigger source attribution (daemon vs MCP)

**Status: idea** | Priority: high

No reliable way to determine whether a session was started by the daemon (WorkTrain) or a human via MCP (Claude Code). Every session-level metric and ROI calculation is ambiguous without this.

**Fix:** Add `triggerSource: 'daemon' | 'mcp'` to `run_started` event data. One-line change at each entry point, makes attribution permanent and queryable from the event log.

Files: `src/v2/durable-core/schemas/session/events.ts`, `src/mcp/handlers/v2-execution/start-workflow.ts`, `src/daemon/workflow-runner.ts`.

---

### Standup status generator

**Status: idea** | Priority: low

A workflow that aggregates activity across git history, GitLab/GitHub MRs and reviews, and Jira ticket transitions since the last standup. Outputs a categorized ("what I did / doing today / blockers") human-readable message. Tool-agnostic: detect available integrations and adapt.

---

### Workflow effectiveness assessment and self-improvement proposals

**Status: idea** | Priority: medium

**Idea:** WorkTrain runs workflows hundreds of times. It should use that data to propose improvements.

**Per-run metrics to collect:**
- Steps skipped most often (candidate for removal)
- Steps consuming the most tokens/time
- Steps where the agent calls `continue_workflow` immediately (prompt too vague or redundant)
- Sessions that produced PRs with Critical findings (workflow not thorough enough)
- Sessions that completed vs hit max_turns

**Output:** Structured proposal per workflow:
- Step-level issues with evidence (specific sessions, specific steps)
- Proposed changes with confidence and impact estimate
- Feed directly into `workflow-for-workflows`

**Flow-back:** Low-confidence proposals as GitHub issues. High-confidence, low-risk proposals auto-applied to local copy + PR to community.

---

## Platform Vision (longer-term)

### Knowledge graph for agent context

**Status: idea** | Priority: medium

**Problem:** Every session starts with a full repo sweep. Context gathering subagents re-read the same files, re-trace the same call chains, re-identify the same invariants.

**Design -- two-layer hybrid:**

**Layer 1: Structural graph (hard edges, deterministic)**
Built by `ts-morph` (TypeScript Compiler API) + DuckDB. Captures: `imports`, `calls`, `exports`, `implements`, `extends`, `registers_in`, `tested_by`. Answers precise questions with certainty: "what imports trigger-router.ts?", "what CLI commands are registered?"

**Layer 2: Vector similarity (soft weights, semantic)**
Every node gets an embedding. Answers fuzzy questions: "what is conceptually related to this?", "what past sessions are relevant to this bug?" Built with LanceDB (embedded, TypeScript-native, local-first).

**Technology:**
- Structural: `ts-morph` + DuckDB
- Vector: LanceDB + local embedding model (Ollama or `@xenova/transformers`)
- Unified query: `query_knowledge_graph(intent)` returns merged structural + semantic results

**Build order:** Structural layer spike first (1-day). Vector layer after spike proves the foundation. Incremental update: re-index only files in `filesChanged` after each session.

**Build decision (from Apr 15 research):** ts-morph + DuckDB wins. Cognee: Python-only. GraphRAG/LightRAG: use LLMs to build graph (violates scripts-over-agent). Mem0/Zep: conversational memory, not code graphs. Sourcegraph: enterprise weight, overkill.

---

### Dynamic pipeline composition

**Status: idea** | Priority: medium

**Insight:** Not all tasks are equal in how much work is needed before implementation. A raw idea needs a completely different pipeline than a fully-specced ticket.

**Maturity spectrum:**
- `idea` -> `rough` -> `specced` -> `ready` -> `code-complete`

**Coordinator reads maturity + existing artifacts and prepends the right phases:**
- Nothing -> ideation -> market research -> spec authoring -> ticket creation -> implementation
- BRD + designs -> architecture review -> implementation
- Fully specced -> coding only

**New workflows needed:**
- `classify-task-workflow` -- fast, 1-step, outputs `taskComplexity`/`riskLevel`/`hasUI`/`touchesArchitecture`/`taskMaturity`
- `ideation-workflow`, `spec-authoring-workflow`, `ticket-creation-workflow`, `grooming-workflow`

---

### Per-workspace work queue

**Status: idea** | Priority: medium

**The insight:** Triggers make WorkTrain reactive. A work queue makes it proactive -- it pulls the next item when capacity is available, works it to completion, pulls the next.

**Internal queue:** `~/.workrail/workspaces/<name>/queue.jsonl` -- append-only, one item per line, consumed in priority order then FIFO.

**External pull sources:**
- GitHub issues (label filter)
- GitLab issues (label filter)
- Jira sprint board
- Linear triage queue

**Queue + message queue + talk:**

| Interface | Use case | Latency |
|-----------|----------|---------|
| Work queue | "do this when you have capacity" | When a slot is free |
| Message queue (`worktrain tell`) | "do this now, between current sessions" | End of current batch |
| Talk (`worktrain talk`) | "let's discuss and decide together" | Interactive |

---

### Remote references (URLs, GDocs, Confluence)

**Status: idea** | Priority: medium

**Design:** Extend the workflow `references` system to support remote sources (HTTP URLs, Google Docs, Confluence pages). WorkRail remains a pointer system -- it validates declarations are well-formed, delivers the pointer, and the agent fetches with its own tools. Auth is entirely delegated to the agent.

**Incremental path:**
- Phase 1: public HTTP URLs. `resolveFrom: "url"`. WorkRail delivers the URL; agent fetches. No auth surface in WorkRail.
- Phase 2: workspace-configured bearer tokens in `.workrail/config.json` keyed by domain
- Phase 3: named integrations (GDocs, Confluence, Notion) as first-class configured sources

**Design questions:**
- Should WorkRail attempt a reachability check at start time, or skip entirely for remote refs?
- How should remote refs appear in `workflowHash`? Content can change between runs.
- `kind` field (`local` vs `remote`) or infer from `source` value?

---

### Declarative composition engine

**Status: idea** | Priority: low

**Summary:** Users or agents fill out a declarative spec (dimensions, scope, rigor level) and the WorkRail engine assembles a workflow automatically from a library of pre-validated routines. The agent is a form-filler, not an architect -- the composition logic lives in the engine.

**Why different from agent-generated workflows:** Engine-composed workflows are assembled from pre-reviewed building blocks using deterministic rules. Same spec always produces the same workflow shape.

**Good early use cases:** Audit-style workflows (user picks dimensions, engine assembles auditor steps), review workflows, investigation workflows.

---

### Workflow categories and category-first discovery

**Status: idea** | Priority: low

**Summary:** Improve workflow discovery by organizing bundled workflows into categories. Currently the catalog is large enough that flat discovery is becoming noisy.

**Phase 1 shape:** If no category is passed, return category names + workflow count per category + a few representative titles. If a category is passed, return the full workflows for that category.

**Design questions:**
- Should categories live in workflow JSON, in a registry overlay, or be inferred from directory/naming?
- Should `list_workflows` become polymorphic, or should category discovery be a separate mode?

---

### Forever backward compatibility (workrailVersion)

**Status: idea** | Priority: medium

Every workflow declares `workrailVersion: "1.4.0"`. The engine maintains compatibility adapters for all previous declared versions -- old workflows run forever without author intervention. The engine adapts; authors never migrate.

**The web model:** this is how browsers handle HTML from 1995. A `<marquee>` tag still renders because the browser adapts, not because the author rewrote their page.

**Engineering implication:** permanent commitment. Once a version adapter is shipped, it cannot be removed. The tradeoff is real but the alternative (expecting external authors to track WorkRail releases and migrate) breaks the platform trust model.

**Phase 1:** Add `workrailVersion` field to schema. Default to `"1.0.0"` for existing workflows. Record in run events.
**Phase 2:** Introduce the first adapter when the first schema-breaking change is needed.
**Phase 3:** Build a compatibility test harness in CI.

**Related:** `src/v2/read-only/v1-to-v2-shim.ts` (existing precedent for version adaptation).

---

### Parallel forEach execution

**Status: idea** | Priority: low

Sequential `forEach` (and `for`, `while`, `until`) all work -- implemented in the v1 interpreter and the v2 durable core. The idea here is parallel execution: run all iterations concurrently rather than sequentially. Requires design around: session store concurrent writes, token protocol isolation per iteration, and console DAG rendering for parallel branches.

---

### Assessment-gate tiers beyond v1

**Status: idea** | Priority: low

**Tier 1 (current):** Same-step follow-up retry. Consequence keeps the same step pending; engine returns semantic follow-up guidance.

**Tier 2 (future):** Structured redo recipe on the same step. Engine surfaces a bounded checklist. No new DAG nodes or true subflow.

**Tier 3 (future):** Assessment-triggered redo subflow. Matched consequence routes into an explicit sequence of follow-up steps. Introduces assessment-driven control-flow behavior.

**Design questions:** When does Tier 2 become necessary? What durable model would Tier 3 need for entering, progressing through, and returning from a redo subflow?

---

### Workflow rewind / re-scope support

**Status: idea** | Priority: low

Allow an in-progress session to go back to an earlier point when new information changes scope, invalidates assumptions, or reveals the current path is wrong.

**Phase 1:** Allow rewind to a prior checkpoint with an explicit reason. Record a "why we rewound" note in session history.

**Phase 2:** Scope-change prompts ("our understanding changed", "the task is broader/narrower"). Let workflows declare safe rewind points explicitly.

**Design questions:**
- Should rewind be limited to explicit checkpoints, or support arbitrary node-level rewind?
- How should the system preserve notes from abandoned paths?
- Should some steps be marked non-rewindable once external side effects have happened?

---

### Subagent composition chains

**Status: idea** | Priority: low

Native support for nested subagents -- an agent spawning a subagent, which spawns its own -- up to a configurable depth limit.

```yaml
agentDefaults:
  maxSubagentDepth: 3
  maxTotalAgentsPerTask: 10
```

**Depth semantics:** Coordinator=0, worker=1, subagent=2, sub-subagent=3.

`maxTotalAgentsPerTask` prevents exponential explosion: depth-3 tree with 3 agents per node = 27 concurrent agents without this cap.

---

### Mobile monitoring and remote access

**Status: idea** | Priority: low (post-daemon-MVP)

**Goal:** Control and monitor autonomous WorkRail sessions from a phone.

**What's needed:**
1. Mobile-responsive console with touch-friendly layout and tap to pause/resume/cancel
2. Push notifications (via Slack/Telegram webhook -- no native app required for MVP)
3. Human-in-the-loop approval on mobile -- maps to `POST /api/v2/sessions/:id/resume`
4. Session log view -- linear timeline, not DAG

**Remote access options:**
1. `workrail tunnel` command (Cloudflare Tunnel from the laptop) -- works behind any NAT/VPN
2. Tailscale integration -- zero WorkRail code needed
3. Cloud session sync -- daemon pushes events to S3/R2

**Priority:** Post-daemon-MVP. Design the REST control plane with mobile in mind from the start.

---

### WorkRail Auto: cloud-hosted autonomous platform

**Status: idea** | Priority: long-term

**Goal:** WorkRail Auto runs on a server 24/7, connected to your engineering ecosystem, working autonomously without a laptop open.

**What this enables:** GitLab MR opened -> WorkRail reviews, posts comment. Jira ticket moves to In Progress -> WorkRail starts coding task, pushes branch. PagerDuty fires -> WorkRail runs investigation, posts findings to Slack.

**Architecture implications:**
- Multi-tenancy: isolated session stores, isolated credential vaults per org
- Horizontal scaling: multiple daemon instances consuming from a shared trigger queue
- Rate limiting per org, per integration

**Relationship to self-hosted:** Self-hosted is always free, always open source, always works offline. WorkRail Auto is the natural SaaS layer -- same engine, same workflows, managed infrastructure.

**Priority:** Long-term. Design the local daemon with multi-tenancy seams in mind from the start (don't hardcode single-user assumptions). Don't build the hosted layer until the local daemon is proven.

---

### Multi-project WorkTrain

**Status: idea** | Priority: medium (to investigate)

**Problem:** WorkTrain needs to handle multiple completely unrelated projects simultaneously, but some projects are related and need to share knowledge.

**Proposed model:** Workspace namespacing with explicit cross-workspace links:
```yaml
workspaces:
  workrail:
    path: ~/git/personal/workrail
    knowledgeGraph: ~/.workrail/graphs/workrail.db
    maxConcurrentSessions: 3
    relatedWorkspaces: [storyforge]
  storyforge:
    path: ~/git/personal/storyforge
    knowledgeGraph: ~/.workrail/graphs/storyforge.db
    relatedWorkspaces: [workrail]
```

**Must be workspace-scoped:** knowledge graph, daemon-soul.md, session store, concurrency limits, triggers.

**Can be shared globally:** WorkTrain binary, token usage tracking, message queue, merge audit log.

---

### Message queue: async communication with WorkTrain from anywhere

**Status: idea** | Priority: medium

**Design:** A persistent message queue (`~/.workrail/message-queue.jsonl`) that decouples when you send a message from when WorkTrain acts on it.

```bash
worktrain tell "skip the architecture review for the polling triggers PR, it's low risk"
worktrain tell "add knowledge graph vector layer to next sprint"
```

Each command appends to the queue. The daemon drains between agent completions -- never mid-run, always at a natural break point.

**Outbox (WorkTrain -> user):** WorkTrain appends notifications to `~/.workrail/outbox.jsonl`. A mobile client polls this or an HTTP SSE endpoint wraps it.

**This is the foundation for mobile monitoring.** The mobile app is just a client that reads outbox and writes to message-queue.

---

### Periodic analysis agents

**Status: idea** | Priority: low

Agents on a schedule that proactively identify issues, gaps, improvement opportunities:

- **Weekly: Code health scan** -- `architecture-scalability-audit` on modules not audited in 30 days
- **Weekly: Test coverage scan** -- files modified with zero/low test coverage
- **Weekly: Documentation drift scan** -- recently merged PRs changed behavior described in docs
- **Monthly: Dependency health scan** -- CVEs, active forks, lighter alternatives
- **Monthly: Performance baseline** -- benchmark scenarios vs previous month
- **Continuous: Security scan** -- on every PR merge, OWASP top 10 patterns in changed files
- **Monthly: Ideas generation** -- `wr.discovery` on codebase + backlog + session history, asking "what's the most impactful thing we could build next?"

---

### Monitoring, analytics, and autonomous remediation

**Status: idea** | Priority: low

WorkTrain watches application health metrics (error rate, latency, session success/failure rate, queue depth), identifies anomalies, investigates root causes, and resolves what it can automatically.

**Monitoring loop:** Detect anomaly -> classify severity -> investigate with `bug-investigation.agentic.v2` -> if confidence >= 0.8 and severity <= High, attempt auto-remediation (config/feature-flag fix, code fix) or else escalate with full findings.

**Analytics dashboard:** Per-module PR cycle time, workflow step failure rates, token cost per session type, quality score (weighted composite of review accuracy + coding success rate + investigation accuracy).

---

### Cross-repo execution model

**Status: idea** | Priority: medium (post-MVP for hosted tier)

**Problem:** WorkRail currently assumes a single repo. The autonomous daemon breaks this -- a coding task may touch Android, iOS, and a backend API simultaneously.

**Workspace manifest:** Sessions declare which repos they need:
```json
{
  "context": {
    "repos": [
      { "name": "android", "path": "~/git/my-project/android" },
      { "name": "backend", "path": "~/git/my-project/backend" }
    ]
  }
}
```

**Scoped tools:** `BashInRepo`, `ReadRepo`, `WriteRepo` that route to the correct working directory.

**Dynamic provisioning:** If the repo is already cloned locally, use it. If declared as a remote URL, clone to `~/.workrail/repos/<name>/`.

**This is the feature that makes WorkRail truly freestanding** for multi-repo development teams.

---

### Long-term vision: WorkRail as a general engine, domain packs as configuration

**Status: idea** | Priority: long-term

WorkTrain is not just a coding tool. The underlying engine -- session management, workflow enforcement, daemon, agent loop, knowledge graph, context bundle assembly -- is domain-agnostic.

**Domain packs:** Self-contained configuration bundles that specialize WorkTrain for a specific problem domain: a set of workflows, a knowledge graph schema, context bundle query definitions, trigger definitions, a daemon soul template.

**Examples:** `worktrain-coding` (current default), `worktrain-research`, `worktrain-creative`, `worktrain-ops`, `worktrain-data`.

**When to make it explicit:** The right time is when a second domain is ready to be added. Extract the coding-specific pieces into `worktrain-coding` and establish the domain pack contract.

---

## Done / Shipped

### Autonomous background agent platform (WorkTrain daemon)

**Status: done** | Shipped as `worktrain daemon`

WorkTrain is a persistent background daemon that initiates workflows autonomously, integrates with external systems, and uses the console as a control plane. Key shipped capabilities:
- `runWorkflow()` with `KeyedAsyncQueue` for concurrent session serialization
- `spawn_agent` / multi-agent subagent delegation
- Polling triggers (GitLab MRs, GitHub issues/PRs, GitHub queue poll)
- Webhook triggers via generic provider
- Worktree isolation (`branchStrategy: worktree`)
- Bot identity (`botIdentity`) and acting-as-user support
- Dynamic model selection (`agentConfig.model`)
- macOS notifications
- SteerRegistry + mid-session injection
- AbortRegistry + SIGTERM graceful shutdown
- `maxOutputTokens` per trigger, `maxQueueDepth` with HTTP 429
- Crash recovery Phase B
- `daemon-soul.md` / workspace context injection
- `complete_step` tool
- Execution stats + structured event log
- Stuck detection (`repeated_tool_call`, `no_progress`)
- `signal_coordinator` tool
- `worktrain init` soul setup
- Per-trigger crash safety (`persistTokens`)
- Worktree orphan cleanup on delivery failure

### WorkRail engine / MCP features

**Status: done**

- Assessment gates v1 with consequences
- Loop control -- all four types (`while`, `until`, `for`, `forEach`) implemented
- Subagent guidance feature
- References system (local file refs)
- Routine/templateCall injection
- Workspace source discovery
- Branch safety (never checkout main into worktree) -- enforced via trigger validation rules and worktree isolation in daemon; NOT a compiled `wr.features.*` engine feature
- Console execution trace Layers 1+2+3a
- Console MVI architecture
- `worktrain` CLI (logs, health, status, trigger validate)
- Notification service

### Scripts-over-agent design principle

**Status: done** -- codified in AGENTS.md and daemon-soul.md

The agent is expensive, inconsistent, and slow. Scripts are free, deterministic, and instant. Any operation the daemon can perform with a shell script, git command, or API call should be done that way -- not delegated to the LLM.

### Dynamic model selection

**Status: done** -- shipped in `triggers.yml` `agentConfig.model`

### Multi-agent support (spawn_agent + coordinator sessions)

**Status: done (partial)** -- `spawn_agent` tool and coordinator sessions with `steer` are shipped. Full `spawn_session`/`await_sessions` as first-class workflow primitives is still an idea (see "Native multi-agent orchestration" above).

### WorkTrain onboarding (`worktrain init`)

**Status: done (basic version)** -- initial soul setup ships. The full guided LLM-provider + trigger + smoke-test onboarding flow described in the idea above is not yet built.

### Daemon context customization

**Status: done** -- `~/.workrail/daemon-soul.md`, AGENTS.md auto-inject, direct `start_workflow` call from daemon.

### Workflow complexity routing

**Status: done (partial)** -- `runCondition`/QUICK/STANDARD/THOROUGH rigor modes ship. A dedicated classify-task-workflow and the full dynamic pipeline coordinator are still ideas above.

### `wr.*` namespace rename

**Status: done** -- all bundled workflows renamed to `wr.*` namespace (PR #782).

### Metrics outcome validation

**Status: done** -- `checkContextBudget` validates `metrics_outcome` enum (PR f0a1822a). SHA validation (Gap 3 above) is still open.

---

