# Ideas Backlog

Workflow and feature ideas worth capturing but not yet planned or designed.
For historical narrative and sprint journals, see `docs/history/worktrain-journal.md`.

**Before reading this backlog, read the vision:** `docs/vision.md` -- what WorkTrain is, what success looks like, and the principles every decision is held against. Every item in this backlog should serve that vision. If it doesn't, it shouldn't be here.

**To see a sorted priority view, run:**
```bash
npm run backlog                                       # full list, grouped by blocked/unblocked
npm run backlog -- --min-score 11 --unblocked-only   # top items ready to work on
npm run backlog -- --section daemon                  # filter by section
npm run backlog -- --help                            # all options
```

Each item has a score line: `**Score: N** | Cor:N Cap:N Eff:N Lev:N Con:N | Blocked: ...`

**When adding a new backlog item, score it using this rubric.** Five dimensions, each 1-3. Score = sum (max 15).

| Dimension | 3 | 2 | 1 |
|---|---|---|---|
| **Correctness** | Silent wrong output, crash, or skipped safety gate | Degraded behavior, misleading output, test coverage gap | No effect on correctness |
| **Capability** | Meaningfully expands what WorkTrain can do or who can use it | Reduces friction for an *active* use case today | Polish, internal quality, or nothing anyone is actively blocked by right now |
| **Effort** (inverted) | Hours to a day or two | A few days to a week | Weeks or longer, significant design work needed first |
| **Leverage** | Prerequisite for multiple other items | Enables one or two downstream items | Standalone, nothing depends on it |
| **Confidence** | Clear problem, clear direction, just needs implementation | Problem is clear, but has open questions to hash out first | Still needs discovery or design before work can begin |

**Blocked flag:** annotate with *what* the item is blocked by -- "Blocked: needs knowledge graph" vs "Blocked: needs dispatchCondition" carry very different timelines. Blocked items are listed separately regardless of score.

**Scoring notes:**
- Score the first actionable phase, not the full vision. Phase 1 = two days of work should not score Effort 1 just because Phase 3 is months away.
- Tiebreaker at equal score: prefer the item that makes the next item easier to execute.
- Capability 2 = reduces friction for an *active* use case today (not something hypothetical).

---

## P0 / Critical (blocks WorkTrain from working correctly)

### wr.coding-task implementation loop does not exit when slices complete (Apr 30, 2026)

**Status: bug** | Priority: high

**Score: 13** | Cor:3 Cap:1 Eff:2 Lev:2 Con:3 | Blocked: no

The `wr.coding-task` workflow's implementation loop (up to 20 passes) does not exit when a `wr.loop_control` stop artifact is emitted. The loop ran 8 passes before stopping -- not because of the artifact, but because it exhausted its slice array.

**Root cause (confirmed by investigation)**: `phase-6-implement-slices` is a `forEach` loop, not a `while`/`until` loop with `artifact_contract`. The `wr.loop_control` stop artifact mechanism **only works for `while`/`until` loops** that declare `conditionSource.kind = artifact_contract`. For `forEach` loops, `shouldEnterIteration` checks only `iteration < slices.length` -- artifacts passed to `interpreter.next()` are never consulted. Confirmed in `workflow-interpreter.ts:254-273` and verified by a direct test (3-slice forEach with stop artifact on every call ran all 3 iterations to completion).

**Why the loop stopped at pass 8**: the loop exhausted its `slices` array which had exactly 8 elements. `metrics_outcome = success` appearing at pass 8 was a coincidence.

**`currentSlice.name` showing `[unset]`**: secondary issue. `buildLoopRenderContext` in `prompt-renderer.ts:190-197` requires `sessionContext['slices']` to be an array at render time. If the `slices` context had not yet been projected into `sessionContext`, or if the slice objects lacked a `name` property, templates render as `[unset: currentSlice.name]`.

**Three fix directions:**
1. **Authoring fix**: change `phase-6-implement-slices` from `forEach` to a `while` with `artifact_contract` and add an explicit exit-decision step -- agents can then signal completion via `wr.loop_control`
2. **Engine feature**: add early-exit support to `forEach` loops when a `wr.loop_control` stop artifact is emitted
3. **Prompt fix**: if forEach-exhausts-all-slices is the intent, remove the instruction that tells the agent to emit `wr.loop_control` artifacts

**Things to hash out:**
- Which fix direction is correct depends on the intended behavior: should the agent be able to stop the loop early (fix 1 or 2), or should it always run all slices (fix 3)?
- If fix 2 (engine feature), does early-exit from forEach affect the `currentSlice` render context in a way that could cause confusion?
- Does fix 1 require re-authoring the workflow through `wr.workflow-for-workflows`, or is it a targeted JSON edit?

---

### Agent is doing coordinator work

**Status: partial** | Near-term mitigation shipped PR #882 (Apr 30, 2026)

**Score: 9** | Cor:3 Cap:1 Eff:1 Lev:2 Con:2 | Blocked: no

The system prompt now explicitly scopes the agent to its worktree and instructs it not to read planning docs or run git commands against the main checkout. `Read`/`Write`/`Edit` tools enforce the workspace path at the tool layer (PR #892).

**Remaining:** Full coordinator-heavy redesign still needed. The agent sandbox (tool path restriction to worktree) is the architectural fix -- the system prompt is a mitigation. See "Agent sandbox" item below.

---

### Wrong directory: agent worked in main checkout instead of worktree

**Status: done** | Shipped PR #882 (Apr 30, 2026)

`buildSystemPrompt()` now injects the worktree path as the `## Workspace:` heading and adds an explicit scope boundary. Crash-recovered sessions also get the boundary via `AllocatedSession.sessionWorkspacePath`. `Read`, `Write`, and `Edit` tools all enforce the workspace path with proper normalization (dotdot traversal + prefix-sibling attacks fixed, PR #892).

---

### Agent faked commit SHAs in handoff block

**Status: done** | Fixed in `src/mcp/handlers/v2-advance-core/outcome-success.ts`

**Score: 11** | Cor:3 Cap:1 Eff:2 Lev:2 Con:3 | Blocked: no

Agents no longer participate in SHA tracking. `outcome-success.ts` now always emits `agentCommitShas: []` and `captureConfidence: 'none'` in the `run_completed` event. The `startGitSha` and `endGitSha` boundary fields are still recorded reliably -- consumers that need the commit list should derive it from `git log startGitSha..endGitSha --format=%H` at query time. The console SHA display will show empty for new sessions until that query-time derivation is built (tracked under "Console session detail" / "Artifacts as first-class citizens").

---

### `taskComplexity=Small` misclassification

**Status: bug** | Priority: medium

**Score: 9** | Cor:3 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

Issue #241 (TTL eviction across multiple files + new tests) was classified as Small, skipping design review, planning audit, and verification loops. Consider requiring human confirmation on Small classification before bypassing phases.

---

### Daemon binary stale after rebuild, no indication to user

**Status: ux gap** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

After `npm run build`, `worktrain daemon --start` launches the old binary. No warning. Fix: compare binary mtime to running process's binary and warn if stale.

---

### `worktrain daemon --start` reports success even when daemon crashes immediately

**Status: done** | Shipped PR #898 (Apr 30, 2026)

Now polls `GET /health` every 500ms for up to 5 seconds. Only reports success when the endpoint responds 200. `WORKRAIL_TRIGGER_PORT` also added to plist captured vars so port overrides are consistent between shell and daemon process.

---

### Handoff block not surfaced to operator

**Status: ux gap** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

Agent writes a complete handoff block (commitType, prTitle, prBody, filesChanged) to the session store. Invisible to operator without digging through event logs. Fix: `worktrain status <sessionId>` should show it; console session detail should surface it prominently.

---

### Worktree orphan leak on delivery failure (Apr 21, 2026)

**Status: done** | Fixed via delivery pipeline refactor (Track B)

The delivery pipeline was extracted into `delivery-pipeline.ts` with explicit stage ordering: `parseHandoffStage` -> `gitDeliveryStage` -> `cleanupWorktreeStage` -> `deleteSidecarStage`. Sidecar is now deleted after worktree removal, not before.

---

---

## WorkTrain Daemon

### Intent gap: agent builds what it understood, not what the user meant (Apr 30, 2026)

**Status: idea** | Priority: medium

**Score: 13** | Cor:3 Cap:3 Eff:2 Lev:3 Con:2 | Blocked: no

This is one of the most fundamental failure modes for autonomous WorkTrain sessions and a blocker for production viability. An agent receives a task description, forms an interpretation of what's needed, and executes flawlessly against that interpretation -- but the interpretation was wrong. The code is correct for what the agent thought was asked. It is not what the user actually wanted. The user only discovers this after reviewing the PR, sometimes after it has already merged.

This is categorically different from bugs (the agent implemented the right thing incorrectly) and scope creep (the agent did extra things). This is the agent solving the wrong problem well.

**Why it's hard:** the agent's interpretation feels reasonable from the task description. The user's description was ambiguous, underspecified, or relied on context the agent didn't have. Neither party made an obvious mistake -- the gap is structural.

**Known manifestations:**
- Agent fixes the symptom instead of the root cause because the task description named the symptom
- Agent implements feature X when the user wanted feature Y that happens to use X
- Agent interprets "add support for Z" as extending the existing system when the user wanted a new abstraction
- Agent makes a local fix when the user wanted an architectural change
- Agent's implementation is technically correct but violates unstated invariants the user assumed were obvious

**Things to hash out:**
- Where in the workflow should intent validation happen? Before the agent writes any code (Phase 0), the agent should be required to state its interpretation back in plain English. The user (or a validation step) confirms or corrects it before implementation begins. But this requires a human confirmation gate -- does that break the autonomous use case?
- For fully autonomous sessions (no human in the loop), is there a way to detect a likely intent gap before the agent commits? Signals might include: the task description is short or vague, the agent's interpretation involves a significant architectural decision, the agent is about to delete or restructure existing code.
- What is the right escalation path when the agent detects ambiguity itself? Currently `report_issue` handles task obstacles; there is no structured way for the agent to surface "I am not sure I understood this correctly" before acting.
- The `wr.shaping` workflow exists precisely to close this gap for planned features -- the issue is urgent/reactive tasks that skip shaping entirely. How do we get intent validation without requiring a full shaping pass for every small task?
- Can historical session notes help? If previous sessions have established what "X" means in this codebase (design decisions, naming conventions, architectural invariants), injecting that context before Phase 0 reduces the gap. This points toward the knowledge graph and persistent project memory as partial solutions.
- Should WorkTrain have an explicit "confirm interpretation" step as a configurable option per trigger? A `requireIntentConfirmation: true` flag on the trigger that blocks autonomous start until the operator approves the agent's stated interpretation via the console or CLI.

---

### Scope rationalization: agent silently accepts collateral damage (Apr 30, 2026)

**Status: idea** | Priority: medium

**Score: 13** | Cor:3 Cap:3 Eff:2 Lev:3 Con:2 | Blocked: no

When an agent makes a change that breaks or degrades something outside its immediate task scope, it often recognizes the impact but rationalizes it as acceptable because "that's not in scope for this task." The reasoning feels locally valid -- the agent was asked to do X, X is done correctly, the side effect on Y is noted but deprioritized. This produces a PR that is correct for X and silently broken for Y.

This is exactly what happened with the commit SHA change: setting `agentCommitShas` to always empty correctly fixes the faked SHA bug, but degrades the console's SHA display for all sessions going forward. A scoped agent might note "this makes the console show empty SHAs" and proceed anyway because fixing the console display is "a separate ticket."

**Why this is insidious:** the agent's reasoning is locally coherent. It did not make a mistake within its scope. The problem is that autonomous agents operating in isolation cannot always see when a locally correct change has unacceptable global consequences -- and even when they can see it, they lack a good mechanism to stop, escalate, and surface the impact rather than proceeding.

**Known manifestations:**
- Agent correctly fixes a bug but the fix changes a public API contract, breaking callers it didn't check
- Agent refactors a module for clarity but silently changes behavior in an edge case it considered minor
- Agent adds a feature but disables or degrades an existing feature as a side effect, judging the tradeoff acceptable on its own
- Agent's change passes all tests but the tests don't cover the degraded behavior
- Agent notes a downstream impact in session notes but does not block, escalate, or file a follow-up ticket
- **Agent reframes a bug as "a key tradeoff to document."** This is a specific and common failure: the agent detects a real problem it caused, correctly identifies that it's a problem, and instead of filing it as a bug or escalating, reclassifies it as an "accepted design decision" or "known limitation" in documentation. The bug is real. Documenting it is not fixing it. This pattern actively buries bugs.

**Things to hash out:**
- How does an agent distinguish "acceptable tradeoff within scope" from "collateral damage that must be escalated"? The line is fuzzy and context-dependent. A hard rule ("never degrade existing behavior") is too strict for refactors; a soft heuristic ("if it affects other code, escalate") is too broad.
- Should the agent be required to enumerate side effects as part of the verification phase, and should the coordinator review that list before merging? This is the proof record concept applied to impact assessment rather than just correctness.
- What is the right mechanism for the agent to pause and escalate? Currently `report_issue` is for task obstacles; `signal_coordinator` is for coordinator events. There is no structured "I need a decision on whether this tradeoff is acceptable" signal.
- Test coverage is the obvious mitigation -- if Y has tests, the agent's change would fail them. But not everything has tests, and agents can rationalize skipping test runs for "unrelated" paths.
- Is there a way to detect likely collateral damage statically before the agent acts? A pre-commit check that measures what changed beyond the declared `filesChanged` list, for example, could surface unexpected side effects automatically.
- The knowledge graph and architectural invariant rules (pattern and architecture validation) are partial solutions -- they can flag when a change violates a declared constraint. But they only work for constraints that have been explicitly codified.

---

The autonomous workflow runner (`worktrain daemon`). Completely separate from the MCP server -- calls the engine directly in-process.


### Subagent context package: project vision and task goal baked into spawning (Apr 30, 2026)

**Status: idea** | Priority: high

**Score: 12** | Cor:2 Cap:3 Eff:2 Lev:3 Con:3 | Blocked: no

When WorkTrain spawns a subagent today, the operator (or the main agent) must manually write out all context: what the project is, what WorkTrain's vision is, what the task is trying to accomplish, what documents exist, what the end goal is. Subagents know nothing -- no conversation history, no project familiarity, no awareness of the vision. If the context briefing is thin or missing, the subagent works in the dark and produces generic output.

Two things need to be baked into the spawning infrastructure:

1. **Project-level context package**: every spawned subagent automatically receives a synthesized briefing about the WorkTrain project -- what it is, what it is trying to become, the architectural layers (daemon vs MCP server vs console), the coding philosophy, and pointers to key docs (AGENTS.md, backlog.md, relevant design docs). This should not require the spawning agent to manually write it out each time.

2. **Task-level context package**: every spawned subagent automatically receives the vision and end goal of the specific task -- not just the technical instructions, but WHY the task matters, what it enables, and how it fits into the larger picture. A subagent that understands the goal can adapt when it hits unexpected situations; one that only has instructions cannot.

This is related to the "Coordinator context injection standard" and "Context budget per spawned agent" backlog entries, but is broader -- it applies to all subagent spawning, not just coordinator-spawned child sessions.

**Critical design constraint:** WorkTrain may not always have a "main" agent assembling context dynamically. A pure coordinator pipeline is deterministic TypeScript code -- it knows the goal it was given and the results it gets back, but has no ambient understanding of the project vision and cannot synthesize what context a subagent needs at runtime. This means context packages cannot be assembled dynamically by the spawning agent; they must be **pre-built and attached as structured data**, assembled by the daemon from configured sources before the session starts. This is closer to the trigger-derived knowledge configuration idea than to runtime context assembly.

**Things to hash out:**
- Where does the project-level context package live and how is it kept current? A static template in `~/.workrail/daemon-soul.md` covers behavioral rules but not project vision -- these are different concerns.
- In a pure coordinator pipeline (no main agent), who decides what goes in the context package for each session type? Must be declared configuration, not runtime synthesis.
- Should context profiles be declared per workflow, per trigger type, or per session role (coding vs review vs discovery)?
- What is the right size for an auto-injected context package? Too small loses signal; too large crowds out the actual task prompt.
- Should the package be structured (JSON/YAML) for programmatic injection, or prose for human readability?
- How does this interact with the existing workspace context injection (CLAUDE.md, AGENTS.md, daemon-soul.md)?
- Whether a "main" orchestrating agent is needed at all, or whether pure coordinator scripts plus well-configured context packages are sufficient -- this is an open question that requires real pipeline testing to answer.

---

### Agent-assisted backlog and issue enrichment (Apr 28, 2026)

**Status: idea** | Priority: medium

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

When a new idea or task is captured -- in the backlog, as a GitHub issue, or during a session -- there is often a gap between "the thing was written down" and "the thing is ready to be designed." The open questions, the interaction effects, the scope boundaries, and the failure modes are not thought through yet. A human has to do that work manually before the idea can be groomed.

WorkTrain could assist with this: after an idea is captured, an agent reads it and identifies what still needs to be hashed out before the idea is ready for design. Not proposing solutions -- surfacing the questions that need answers.

**Things to hash out:**
- What triggers this enrichment? On every new issue? Only on request? Only when an issue is labeled a certain way?
- How does this interact with the human's own thinking process -- does an agent-generated question list help, or does it anchor thinking prematurely?
- Should the agent's questions appear in the GitHub issue as a comment, be written back to the backlog entry, or live somewhere else entirely?
- Who is responsible for answering the questions -- the human, another agent, or some combination?
- Is this valuable enough to run on every idea, or does it dilute the signal when applied broadly?
- How do you prevent the agent from generating obvious or generic questions that add no real value?

---

### Agent-assisted backlog prioritization (Apr 28, 2026)

**Status: idea** | Priority: medium

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

Some projects have a clear ticket queue with explicit priority set by a human. Others -- like workrail itself -- have an unordered backlog where the agent needs to decide what to work on next based on impact, effort, and dependencies. Without a structured way to reason about priority, agents either pick arbitrarily or ask the human every time.

WorkTrain should be able to apply a scoring rubric to backlog items and surface a prioritized working order. The rubric scores each item on dimensions like impact, effort, leverage over other items, and how well understood the problem is. Items that score high and have no blockers rise to the top. The agent doesn't decide what to work on -- it produces a ranked list for the human to accept or override.

**Tentative rubric (to be validated):**

Five dimensions, each scored 1-3. Score = sum (max 15). Items marked **Blocked** are pushed below all unblocked items regardless of score.

| Dimension | 3 | 2 | 1 |
|---|---|---|---|
| **Correctness** | Silent wrong output, crash, or skipped safety gate | Degraded behavior, misleading output, test coverage gap | No effect on correctness |
| **Capability** | Meaningfully expands what WorkTrain can do or who can use it | Reduces friction for an *active* use case today | Polish, internal quality, or nothing anyone is actively blocked by right now |
| **Effort** (inverted) | Hours to a day or two | A few days to a week | Weeks or longer, significant design work needed first |
| **Leverage** | Prerequisite for multiple other items | Enables one or two downstream items | Standalone, nothing depends on it |
| **Confidence** | Clear problem, clear direction, just needs implementation | Problem is clear, but has open questions to hash out first | Still needs discovery or design before work can begin |

**Blocked flag:** annotate with *what* the item is blocked by, not just yes/no -- "Blocked: needs knowledge graph" vs "Blocked: needs dispatchCondition" carry very different timelines. Blocked items are listed separately regardless of score.

**Scoring multi-phase items:** score the first actionable phase, not the full vision. An item whose Phase 1 is two days of work should not score Effort 1 just because Phase 3 is months away.

**Tiebreaker for items at the same score:** prefer the item that makes the next item easier to execute, even if it is not a formal prerequisite. A high-score easy item that reduces friction for several downstream items is more valuable than its score alone shows.

**Things to hash out:**
- Should the rubric be defined once globally, or per-workspace/per-project? Different projects have different definitions of "impact."
- How does the agent know enough about the project context to score impact accurately? Without domain knowledge, scores will be generic.
- Who owns the scores -- are they written back to the backlog entries, stored separately, or only computed on demand?
- How do you prevent the scoring from becoming a mechanical exercise that produces a ranked list nobody looks at?
- Should the agent re-score as items are completed and the landscape changes, or is one-time scoring sufficient?
- How does this interact with explicit human priority signals -- if the human labels something high-priority, does the agent's score override or defer?

---

### Queue config discriminated union tightening (Apr 20, 2026)

**Status: tech debt** | Priority: low

**Score: 9** | Cor:1 Cap:1 Eff:3 Lev:1 Con:3 | Blocked: no

`GitHubQueueConfig` uses a flat interface with runtime validation. Should be a proper TypeScript discriminated union so `type: 'assignee'` requires `user` at compile time. Tracked per "make illegal states unrepresentable."

---

### `delivery_failed` unreachable in `getChildSessionResult` -- type promises more than code delivers (Apr 30, 2026)

**Status: bug** | Priority: medium

**Score: 10** | Cor:3 Cap:1 Eff:2 Lev:2 Con:2 | Blocked: no

`ChildSessionResult` has `reason: 'delivery_failed'` as a variant of `kind: 'failed'`. However `fetchChildSessionResult` in `coordinator-deps.ts` reads session status through `ConsoleService.getSessionDetail`, which returns statuses like `complete`/`blocked`/`in_progress` -- it never returns a `delivery_failed` status. `delivery_failed` is a `TriggerRouter`-level concept (callbackUrl POST failure) that is not stored as a session status in the event log. Child sessions spawned via `spawnSession`/`spawnAndAwait` have no `callbackUrl` and cannot produce it through this code path.

The result: coordinators using `getChildSessionResult` can never observe `reason: 'delivery_failed'`, even though the type says they might. This violates the "make illegal states unrepresentable" principle -- the type union promises a variant the implementation cannot produce on this path.

**Architectural fix (not a comment):** surface `delivery_failed` through session status. When `TriggerRouter` records a `delivery_failed` outcome, write a corresponding session event or status that `ConsoleService.getSessionDetail` returns. Then `fetchChildSessionResult` can map it correctly. This closes the gap between what the type promises and what the infrastructure delivers.

Alternative: if `spawnSession`/`spawnAndAwait` child sessions genuinely cannot have `delivery_failed` outcomes by design, remove `reason: 'delivery_failed'` from `ChildSessionResult` entirely and document that it only exists in `spawn_agent`'s direct outcome mapping.

**Things to hash out:**
- Should `delivery_failed` be surfaced through ConsoleService (requires touching session status storage), or removed from `ChildSessionResult` since the `spawnSession` path provably cannot produce it?
- If surfaced: what event or field in the session store carries this status, and how does ConsoleService project it?

---

### `spawnAndAwait` duplicates ~90 lines of polling logic from `awaitSessions` (Apr 30, 2026)

**Status: tech debt** | Priority: low

**Score: 8** | Cor:1 Cap:1 Eff:2 Lev:1 Con:3 | Blocked: no

`spawnAndAwait` in `coordinator-deps.ts` contains an inline polling loop (~90 lines) that duplicates the logic in `awaitSessions`. The WHY comment explains a real construction-time constraint: object literals cannot reference sibling methods by name during construction. But this constraint applies to methods on the returned object -- it does not apply to closure-level functions, which are already used for `fetchAgentResult` and `fetchChildSessionResult`.

**Fix:** extract a `pollUntilTerminal(handles: string[], timeoutMs: number): Promise<'completed' | 'timed_out' | 'degraded'>` closure-level function (before the `return {}` block). Have both `awaitSessions` and `spawnAndAwait` call it. This eliminates the duplication without violating the construction-time constraint.

---

### Daemon architecture: remaining migrations (Apr 29, 2026)

**Status: partial** | A9 shipped Apr 29, 2026.

**Score: 8** | Cor:1 Cap:1 Eff:2 Lev:1 Con:3 | Blocked: no

Track A (A1-A9) shipped and the `SessionSource` migration is complete. `WorkflowTrigger._preAllocatedStartResponse` is gone.

**Remaining items:**

- `CriticalEffect<T>` / `ObservabilityEffect` type distinction -- categorize side effects in `runAgentLoop` and finalization as either crash-relevant or observability-only
- `StateRef` mutation wrapper -- replace direct `state.pendingSteerParts.push()` mutations with an explicit mutation API
- Zod tool param validation -- replace manual `typeof` checks in tool factories with Zod schema validation (requires `zodToJsonSchema` or maintaining two sources of truth for param schemas)
- `createCoordinatorDeps` unit tests -- extraction in B3 improved testability; cover `spawnSession`, `awaitSessions`, `getAgentResult` at minimum
- ~~Wire `AllocatedSession.triggerSource` to the `run_started` event for session attribution~~ -- **done**, PR #899 (Apr 30, 2026)

---

### `wr.refactoring` workflow (Apr 28, 2026)

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

A dedicated `wr.refactoring` workflow for structural refactors that don't change behavior. Distinct from `wr.coding-task` because refactors have a different shape: no new features, no bug fixes, just architecture alignment. The workflow should enforce:
- **Discovery phase**: understand current state, identify violations, classify scope
- **Test-first phase**: write tests for any extracted pure functions BEFORE extracting them (TDD red)
- **Extraction phase**: one slice at a time, tests green after each
- **Verification phase**: full suite green, build clean, no behavior changes
- **Doc update phase**: update any reference docs that describe the changed invariants

The `wr.coding-task` workflow has too much overhead for pure refactors (design review, risk assessment gating, PR strategy) and not enough refactor-specific discipline (test-first enforcement, behavior-unchanged verification).

**Things to hash out:**
- What distinguishes a refactor from a behavior-changing fix? Where is the boundary when a refactor reveals a latent bug and fixing it is the right call?
- How does the workflow verify "no behavior change" for code without tests? Does absence of test failures actually prove behavioral equivalence, or is a separate assertion required?
- Should the workflow gate on having tests before extraction begins, or treat test-writing as a step within it?
- Who is the target user -- a human author running it interactively, or an autonomous daemon session? The constraints differ significantly (daemon can't ask clarifying questions mid-run).
- How does this interact with the existing `wr.coding-task` Small fast-path? Should refactors always bypass that path?
- What happens when a refactor spans multiple modules that are each independently shippable? Does the workflow support incremental delivery, or is it a single atomic PR?

---

### API key baked into launchd plist at install time (Apr 24, 2026)

**Status: done** | Fixed in PR #821

`CAPTURED_ENV_VARS` in `src/cli/commands/worktrain-daemon.ts` contains only non-secret vars (`AWS_PROFILE`, `PATH`, `HOME`, `USER`, feature flags). No `*_API_KEY` or token vars are captured into the plist. Secrets go in `~/.workrail/.env`, which is loaded by `loadDaemonEnv()` at daemon startup.

---

### runWorkflow() functional core refactor -- Phases 2-4 (Apr 24-29, 2026)

**Status: done** | Phases 2-3 shipped Apr 29, 2026. Phase 4 (A1-A8) shipped Apr 29, 2026.

Phase 1 (PR #818): `tagToStatsOutcome`, `buildAgentClient`, `evaluateStuckSignals`, `SessionState`, `finalizeSession`.
Phase 2 (PR #830): `PreAgentSession`/`PreAgentSessionResult`, `buildPreAgentSession`, `constructTools`, `persistTokens` Result type, TDZ fix.
Phase 3 (PRs #835, #837): `buildTurnEndSubscriber`, `buildAgentCallbacks`, `buildSessionResult`. runWorkflow() body: 539 → 308 lines.

**Phase 4 (Track A, PRs #839-#861, Apr 29, 2026):**
- A1: `runStartupRecovery` apiKey injected as parameter (removes process.env read)
- A2: Turn-end collaborators extracted to `src/daemon/turn-end/` (`step-injector`, `detect-stuck`, `conversation-flusher`)
- A3: `SessionScope` + `FileStateTracker` -- typed tool-layer contract, raw Map encapsulated (#843)
- A4: All 11 tool factories extracted to `src/daemon/tools/` -- workflow-runner.ts -1,500 lines (#851)
- A5: `ContextLoader` + `ContextBundle` -- two-phase context assembly, parallelized with pre-agent session setup (#855)
- A6: `ActiveSessionSet` + `SessionHandle` -- replaces `SteerRegistry` + `AbortRegistry` dual Maps; closes TDZ hazard (#856)
- A7: `buildAgentReadySession` + `runAgentLoop` extracted -- runWorkflow() body: 302 → 92 lines (#859)
- A8: `SessionSource` discriminated union + `AllocatedSession` -- typed vocabulary for `_preAllocatedStartResponse` migration (#861)
- A9: Full `SessionSource` migration -- `WorkflowTrigger._preAllocatedStartResponse` removed; all 4 call sites construct `SessionSource` directly; `runWorkflow()` accepts `source?: SessionSource` (#869)

**Also shipped (Track B, PRs #846-#848):**
- B1: `DispatchDeduplicator` -- compile-enforced dedup contract, replaces verbal MUST comment
- B2: `DeliveryPipeline` + `DeliveryStage` -- staged delivery, preempts accretion in trigger-router.ts
- B3: `createCoordinatorDeps` + `setDispatch` -- extracted from 900-line trigger-listener.ts; circular dep fixed

**Unit tests added (PRs #863-#865):** `DefaultFileStateTracker` (15), `DefaultContextLoader` (12), `ActiveSessionSet`/`SessionHandle` (11).

**Total workflow-runner.ts reduction: ~4,955 → ~2,800 lines (44%).**

**Follow-on:** `wr.refactoring` workflow (see backlog entry above). Remaining items in "Daemon architecture: remaining migrations" entry below.

---

### WorkTrain identity model: act as the user, not as a bot (Apr 20, 2026)

**Status: idea** | Priority: medium

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

**Design decision:** WorkTrain acts as the configured user, not as a separate bot account.

**Why bot accounts are the wrong default:** Most developers -- especially at companies -- cannot create separate bot GitHub accounts. Jira, GitLab, and other enterprise systems tie authentication to employee identity. Requiring a separate account creates friction that blocks adoption entirely.

WorkTrain's attribution signal is the **work pattern**, not the identity:
- Branch name: `worktrain/<sessionId>` -- immediately recognizable
- PR body footer: "Automated by WorkTrain" + session ID + workflow name
- Commit co-author: `Co-Authored-By: WorkTrain <worktrain@noreply>`

Anyone reviewing a PR knows it was autonomous. The developer's name on the PR is not a lie -- they configured WorkTrain to do this work on their behalf.

**Queue membership without a bot account:** Label-based opt-in works with any setup:
- Apply `worktrain:ready` label to an issue → WorkTrain picks it up
- The queue poll trigger uses `queueType: label` + `queueLabel: "worktrain:ready"`
- No bot account, no special permissions, no friction

`workOnAll: true` (future) processes any open issue -- also requires no bot account.

**Token:** `$GITHUB_TOKEN` (your personal token) or a fine-grained PAT scoped to the target repo. WorkTrain uses it for API calls; the commit identity (`git user.name`, `git user.email`) is set separately in the worktree and can be whatever you want.

**Attribution / signing:**
1. Commits made by WorkTrain include `Co-Authored-By: WorkTrain <worktrain@etienneb.dev>`. The configured `worktrain-bot` identity is consistent across all workspaces.
2. PR/MR description footer: session link, workflow names run. Clearly WorkTrain-authored.
3. Issue/comment attribution: WorkTrain comments include "WorkTrain investigation" with session link.

`actAsUser: true` explicit opt-in, only for commits/PRs (never emails or Slack without additional permission), PR description always notes "Created by WorkTrain," full audit log in `~/.workrail/actions-as-user.jsonl`.

**Things to hash out:**
- What is the opt-in surface for `actAsUser: true`? Is it a per-trigger config flag, a workspace config, or a one-time global consent?
- If a user's employer audits their git history and finds autonomous commits attributed to the user, what is the disclosure expectation? Should WorkTrain disclose this more prominently in onboarding?
- How does the identity model interact with GPG commit signing? A personal signing key cannot be given to the daemon without significant key management risk.
- What is the right behavior when the configured user identity is unavailable (expired token, revoked PAT)? Should WorkTrain fail fast or fall back to a bot identity?
- How should the `actions-as-user.jsonl` audit log be surfaced and retained? Is the user responsible for it, or should WorkTrain manage rotation and visibility?
- Does `actAsUser` ever apply to things beyond commits/PRs -- issue comments, status updates, webhook calls? Where is the ceiling?

---

### Kill switch and commit signing (Apr 20, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:2 Cap:2 Eff:3 Lev:1 Con:2 | Blocked: no

**Kill switch:** `worktrain kill-sessions` -- aborts all running daemon sessions immediately. Useful when WorkTrain is doing something unexpected. Sends abort signal to all active sessions, marks them user-killed in the event log.

**Commit signing:** verify `git commit` honors existing `commit.gpgsign` config, or add explicit opt-out for bot identities that don't have signing keys. Empirically verify before declaring this solved.

**Things to hash out:**
- Should `worktrain kill-sessions` kill all sessions globally, per-workspace, or per-trigger? What granularity does an operator actually need?
- What happens to in-flight worktrees and uncommitted changes when a session is kill-switched? Is the operator responsible for cleanup, or should the kill switch attempt it?
- How is the kill switch surfaced -- CLI only, or also a console button? What is the latency between kill command and actual session termination?
- For commit signing: if `commit.gpgsign = true` in the user's gitconfig and the daemon has no signing key, does every commit silently fail? What is the right fallback behavior?
- Should WorkTrain detect a signing configuration mismatch at `daemon --start` time rather than discovering it mid-session?
- Is per-bot-identity gpg key management in scope, or is the answer always "disable signing for WorkTrain identities"?

---

### triggers.yml hot-reload (Apr 20, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

The daemon reads `triggers.yml` once at startup. Any change requires a full daemon restart. This creates friction during trigger configuration iteration.

**The fix:** watch `triggers.yml` for changes using `fs.watch()` or `chokidar`, re-validate on change, and if valid swap the in-memory trigger index without restarting the daemon. Active sessions in flight are unaffected (they hold their own trigger snapshot). New sessions after the reload use the new config.

**Partial hot-reload is acceptable:** if the new `triggers.yml` fails validation, log a warning and keep the old config. Don't crash the daemon on a syntax error.

**Implementation:** `TriggerRouter` already accepts a `TriggerIndex` at construction. The hot-reload path re-calls `loadTriggerStore()` and swaps the index reference on the router. `PollingScheduler` loops are keyed per trigger -- swapping the index would also require restarting the polling loops cleanly.

**Things to hash out:**
- When a trigger is removed from `triggers.yml` on a hot-reload, what happens to its in-flight sessions? Should they run to completion, be aborted, or be suspended?
- When a trigger is modified (e.g. `maxSessionMinutes` changed), should in-flight sessions using the old config complete under the old limits or pick up the new ones?
- How should validation errors in the new `triggers.yml` be surfaced to the operator? A log line is easy to miss -- is there a better notification path?
- Does hot-reload need to be transactional (all-or-nothing swap) or can partial updates be safe?
- Should file watching be optional (behind a `--watch` flag) to avoid surprising behavior for users who prefer explicit restarts?

---

### GitHub webhook trigger with assignee/event filtering (Apr 20, 2026)

**Status: idea** | Priority: medium-high

**Score: 11** | Cor:1 Cap:3 Eff:2 Lev:2 Con:3 | Blocked: no

The `github_queue_poll` trigger has a 5-minute latency floor. Assigning an issue fires a GitHub webhook immediately -- WorkTrain should start within seconds, not minutes.

**What exists today:** `provider: generic` handles arbitrary POST webhooks with HMAC validation and `goalTemplate: "{{$.issue.title}}"` extracts issue title from payload. You can use this today but without an assignee filter -- any issue event fires the trigger regardless of who it's assigned to.

**What's missing:** a `dispatchCondition` field that gates dispatch on a payload value:

```yaml
- id: self-improvement-hook
  provider: generic
  workflowId: coding-task-workflow-agentic
  goalTemplate: "{{$.issue.title}}"
  hmacSecret: $GITHUB_WEBHOOK_SECRET
  dispatchCondition:
    payloadPath: "$.assignee.login"
    equals: "worktrain-etienneb"
```

**The hook+poll pattern (recommended for production):**
```yaml
# Primary: instant response via webhook
- id: self-improvement-hook
  provider: generic
  goalTemplate: "{{$.issue.title}}"
  hmacSecret: $GITHUB_WEBHOOK_SECRET
  dispatchCondition:
    payloadPath: "$.assignee.login"
    equals: "worktrain-etienneb"

# Fallback: catch anything missed during downtime
- id: self-improvement-poll
  provider: github_queue_poll
  pollIntervalSeconds: 3600
```

**Implementation:** Add `dispatchCondition: { payloadPath, equals }` to `TriggerDefinition` -- parsed in `trigger-store.ts`, checked in `trigger-router.ts` before enqueuing. Single condition is MVP; AND/OR logic is follow-up.

**Things to hash out:**
- The hook+poll pattern requires two separate trigger IDs for the same workflow. How does deduplication work when both fire near-simultaneously (hook fires, poll also picks up the same item before the hook session completes)?
- `dispatchCondition` only checks a static `equals` comparison. What is the right expansion path for more complex conditions (event type filtering, multiple assignees, label presence)?
- GitHub webhooks require a public endpoint to receive events. How does this work for users without a public IP (laptop behind NAT, VPN)? Is a tunneling strategy (Cloudflare Tunnel, ngrok) in scope or out of scope for this feature?
- Should the `hmacSecret` validation happen before or after `dispatchCondition` evaluation? Order affects error handling for malformed requests.

---

### Gate 2 follow-up: per-trigger gh CLI token for delivery (Apr 20, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:2 Eff:3 Lev:1 Con:3 | Blocked: no

`delivery-action.ts` calls `gh pr create` using whatever `gh` CLI auth is configured globally -- it does not pass a per-trigger token. For single-identity setups this is fine. For multi-identity setups (Zillow service account alongside personal trigger), the globally authenticated `gh` user handles all PR creation, silently using the wrong identity.

**Fix when multi-identity is needed:** Pass `GH_TOKEN=<triggerToken>` env override to `execFn` when calling `gh pr create` and `gh pr merge`. Not a blocker for single-identity. Prerequisite for multi-identity support.

**Things to hash out:**
- How many distinct identities is the multi-identity design actually expected to serve? Is the target use case one personal + one work account, or arbitrary N?
- Where does the per-trigger token come from at runtime -- the trigger definition in `triggers.yml`, a secrets store, or an environment variable resolved at dispatch time?
- If a trigger's token is rotated mid-run, does the in-flight session pick up the new token or fail on the old one?
- Is this blocked by anything upstream -- does the `gh` CLI fully support per-call `GH_TOKEN` overrides without side effects on global auth state?

---

### Queue opt-in design: unresolved decisions (Apr 20, 2026)

**Status: idea** | Priority: medium -- DO NOT IMPLEMENT until these questions are answered

**Score: 8** | Cor:1 Cap:2 Eff:3 Lev:1 Con:1 | Blocked: no

The self-improvement queue was partially implemented using label-based opt-in, then later walked back. This section records what's actually unresolved.

**The configurable queue shape (already designed, partially implemented):**
```
{ "queue": { "type": "github_assignee", "user":  "worktrain-etienneb" } }
{ "queue": { "type": "github_label",    "name":  "worktrain:ready" } }
{ "queue": { "type": "github_query",    "search": "is:issue is:open ..." } }
{ "queue": { "type": "jql",             "query": "assignee=currentUser() AND status='Ready for Dev'" } }
{ "queue": { "type": "gitlab_label",    "name":  "worktrain" } }
```

For the workrail repo specifically: either `github_assignee` (accept the conflation between your personal assignments and WorkTrain's queue -- fine for a solo repo) or `github_label` (apply label per issue -- more discipline, more friction). Neither is wrong; pick based on preference.

**Enterprise implications that must be resolved before Zillow work:**

Three questions to verify before designing any Zillow path:

1. **Service account process**: Does Zillow have a ServiceDesk or security review process for requesting service accounts (`worktrain-etienneb@zillow`)? If yes, request through proper channels rather than acting under personal identity.

2. **AUP check**: Does Zillow's Acceptable Use Policy permit automation acting under employee identities without explicit security review? If not, "WorkTrain acts as you" is not viable.

3. **Self-approval rules**: Can you approve your own MRs in Zillow's GitLab? If "no self-approval" is enforced, every WorkTrain MR needs a human reviewer. That changes the pipeline entirely (no auto-merge under personal identity).

**Enterprise identity risk:** "WorkTrain acts as you" is different from "Dependabot acts as you." Dependabot does narrow, predictable operations (dependency bumps). WorkTrain does arbitrary LLM-driven code changes. Every autonomous action is attributed to you in audit logs. Understand this risk before turning on autonomy against company repos.

**Jira return path (missing from current jira_poll design):** The `jira_poll` entry describes pulling tickets from Jira but not writing back -- moving ticket to "In Review" when MR is opened, adding MR URL to the Jira ticket, reacting to Jira transitions mid-work. The full Jira integration is a round-trip, not just a poll. Design the return path before implementing `jira_poll`.

---

### Jira + GitLab integration for WorkTrain (Apr 20, 2026)

**Status: idea** | Priority: medium

**Score: 7** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

Most enterprise developers use Jira for tickets and GitLab for code hosting. WorkTrain should work in this environment without requiring GitHub or a bot account.

**What exists:** `gitlab_poll` trigger already exists -- polls GitLab MR list and dispatches sessions when new/updated MRs appear. WorkTrain can already do autonomous MR review on GitLab.

**What's missing -- `jira_poll` trigger:** Poll a Jira board/sprint/filter for issues in a specific status (e.g. "In Progress", "Ready for Dev") assigned to the configured user, and dispatch WorkTrain sessions for them.

Proposed `jira_poll` config:
```yaml
- id: jira-queue
  provider: jira_poll
  jiraBaseUrl: https://zillow.atlassian.net
  token: $JIRA_API_TOKEN
  project: ACEI
  statusFilter: "Ready for Dev"
  assigneeFilter: "$JIRA_USERNAME"
  workspacePath: /path/to/repo
  branchStrategy: worktree
  autoCommit: true
  autoOpenPR: true
  agentConfig:
    maxSessionMinutes: 90
```

**Also missing:** GitLab issue queue -- same as `github_queue_poll` but for GitLab issues.

**Implementation notes:** `jira_poll` follows the same `PollingSource` discriminated union pattern as `gitlab_poll` and `github_queue_poll`. Jira REST API v3: `GET /rest/api/3/search?jql=project=X+AND+status="Ready for Dev"+AND+assignee=currentUser()`. `jira_poll` should extract issue title + description as the goal, and the Jira issue URL as `upstreamSpecUrl` in `TaskCandidate`.

**Things to hash out:**
- How should the return path work -- when WorkTrain opens a PR, should `jira_poll` automatically transition the Jira ticket to "In Review" and attach the PR URL? Who owns specifying that behavior?
- Jira Cloud vs Jira Server/Data Center have different REST API versions and auth flows. Which variant is in scope first?
- Jira JQL filters can be arbitrarily complex. Should `jira_poll` expose a raw `jql` field, or only structured filters like `statusFilter` + `assigneeFilter`? What are the safety tradeoffs?
- How is deduplication handled? Jira issue IDs must be used as the `sourceId` to prevent re-dispatch when the poll runs again with the issue still in the same status.
- Should GitLab issue queue share the same config schema as `jira_poll`, or be a separate provider? How much should they be unified?

---

### MR/PR template support (Apr 20, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

WorkTrain opens PRs using a generic body format hardcoded in `delivery-action.ts`. Teams maintain `.github/PULL_REQUEST_TEMPLATE.md` (GitHub), `.gitlab/merge_request_templates/` (GitLab), or custom templates -- WorkTrain ignores all of them. PRs opened by WorkTrain look structurally different from human-authored PRs and skip required fields (checklists, reviewer guidelines, linked issue fields).

**What needs to happen:** Before `gh pr create`, `delivery-action.ts` should check for a PR/MR template in standard locations (`.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/*.md`, `.gitlab/merge_request_templates/Default.md`). If a template exists: merge the agent's `HandoffArtifact.prBody` into the template structure.

**Recommended approach:** Pass the template to the agent's final step as additional context. The final step already produces the `HandoffArtifact.prBody` -- inject the template there so the agent fills it out correctly rather than trying to merge post-hoc.

Should land before WorkTrain is used in team repos with strict PR templates.

**Things to hash out:**
- Some repos have multiple PR templates keyed by branch prefix or PR type. How does WorkTrain select the right template when more than one exists?
- Template injection into the final step prompt may push the context window into uncomfortable territory for large templates. Is there a size budget for injected template content?
- Who is responsible for updating the injected template when the repo's template changes? Is this pulled fresh at dispatch time, or cached?
- GitLab MR templates have a different discovery path than GitHub PR templates. Should both providers be handled by the same abstraction, or is each provider responsible for its own template resolution?
- Should WorkTrain ever skip template injection if the agent's own `prBody` output already satisfies the template structure? Or is injection always mandatory?

---

### triggers.yml: composable configuration for multi-workspace support (Apr 20, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Single `triggers.yml` works well for one workspace. Becomes boilerplate-heavy as more repos are added. Each new repo needs a full trigger block repeating shared fields. The file mixes two concerns: **what to watch** (source, provider, repo, token, poll interval) and **what to do** (workflow, branch strategy, delivery, timeouts).

**Proposed direction: two-layer config**

Layer 1 -- trigger templates (global defaults):
```yaml
defaults:
  coding-pipeline:
    branchStrategy: worktree
    baseBranch: main
    branchPrefix: "worktrain/"
    autoCommit: true
    autoOpenPR: true
    agentConfig:
      maxSessionMinutes: 120
      maxTurns: 60
```

Layer 2 -- per-workspace overrides:
```yaml
triggers:
  - id: self-improvement
    extends: coding-pipeline
    provider: github_queue_poll
    workspacePath: /path/to/repo
    source:
      repo: owner/repo
      token: $WORKTRAIN_BOT_TOKEN
```

**Alternative:** per-workspace discovery -- WorkTrain scans each configured `workspaceRoots` entry for `.workrail/triggers.yml`. This is the GitHub Actions model -- one file per workflow per repo. Global `~/.workrail/triggers.yml` defines cross-workspace triggers.

Essential before WorkTrain manages more than 2-3 repos.

**Things to hash out:**
- If a workspace-local `.workrail/triggers.yml` and the global `~/.workrail/triggers.yml` both define a trigger with the same ID, which wins? Is this a conflict or a merge?
- Secrets (tokens, webhook secrets) in workspace-local triggers.yml files would be committed to the repo if the file is checked in. What is the recommended secret injection story for per-workspace config?
- When extending a named default template, what fields can be overridden vs. must be set? Are there fields that are always inherited and cannot be changed per-workspace?
- Is per-workspace discovery opt-in or the default behavior? Changing the default could break existing single-file setups.
- How does the daemon know which workspace paths to scan if it doesn't already have a configured workspace list?

---

### Demo repo feedback loop: WorkTrain improves itself via real task execution (Apr 20, 2026)

**Status: idea** | Priority: high

**Score: 12** | Cor:1 Cap:3 Eff:3 Lev:3 Con:2 | Blocked: no

Run WorkTrain against a real demo repo, observe what breaks, automatically file issues against the workrail repo, and have WorkTrain fix them. A self-improving feedback loop that surfaces real production failures faster than any manual testing.

**The loop:**
```
Demo repo tasks (worktrain:ready issues)
  -> WorkTrain runs full pipeline: discover -> shape -> code -> PR -> review -> merge
  -> Failure classifier watches daemon event log
  -> For each failure: structured issue filed against workrail repo
     (what task, what step, what went wrong, session ID, relevant log lines)
  -> worktrain-etienneb assigned -> WorkTrain fixes itself
  -> WorkTrain re-runs the failed task -> confirms fix
```

**Phase 1:** Pick a demo repo (real TypeScript project, diverse tasks), add 5-10 `worktrain:ready` issues, run WorkTrain on them, manually supervise first runs, collect failure patterns.

**Phase 2:** Failure classifier -- scheduled session that reads `~/.workrail/events/daemon/YYYY-MM-DD.jsonl`, classifies sessions by outcome, for each non-success creates a GitHub issue against the workrail repo with structured failure context. ~100-150 LOC in `src/coordinators/failure-classifier.ts`.

**Phase 3:** Auto-rerun after fix -- when WorkTrain merges a fix for a failure issue, the failure classifier re-queues the original demo task. Confirms the fix actually resolved the failure.

**Relationship to benchmarking:** the same 10 demo tasks run after each WorkTrain release become a regression benchmark. Track: % completing successfully, fix loop iterations needed, LLM turns per task, token cost per task.

**Things to hash out:**
- Who chooses the demo repo and the demo tasks? What makes a task representative vs a toy example?
- How does the failure classifier distinguish a WorkTrain bug from a task that is genuinely ambiguous or underdefined? Misclassification would create noise in the self-improvement loop.
- What is the blast radius if the self-improvement loop files a bad issue against workrail and WorkTrain acts on it autonomously? Who reviews auto-filed issues before they enter the queue?
- How many re-run attempts per task before the loop gives up and escalates to a human?
- Token cost of running 10 demo tasks per release could be significant. Is there a policy for how often the benchmark suite runs?
- How does this interact with branch protection and CI? WorkTrain fixing itself creates PRs -- someone or something must review and merge them.

---

### Autonomous crash recovery and interrupted-session resume (Apr 21, 2026)

**Status: idea** | Priority: high

**Score: 11** | Cor:3 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

**The problem:** A daemon crash loop kills all in-flight sessions. The queue correctly detects the sidecar and skips re-dispatch for the TTL window, but when the sidecar expires the session is re-dispatched from scratch with zero context. An agent that spent 10 min in Phase 0, read codebase files, and formed a plan loses all of that work.

**What we want:** WorkTrain detects orphaned sessions on startup and makes an autonomous decision: resume if meaningful progress was made, discard and re-dispatch from scratch if too early to be worth resuming.

**Resumability decision criteria:**
- Session had >= 1 `continue_workflow` call (at least one step advance): worth resuming
- Session is at step 0 with 0 advances but > 5 LLM turns: borderline -- context accumulated but no checkpoint. Surface to console for human decision.
- Session is at step 0, < 5 turns, < 2 min: discard -- nothing was lost
- Session's worktree is missing or corrupted: discard -- can't resume cleanly
- Session is on a coding workflow and has uncommitted changes in the worktree: pause for human review before discarding

**`session-recovery-policy.ts`** (pure function) already exists -- extend `evaluateRecovery()` to surface the `human_review` case.

**`worktrain session resume <sessionId>` CLI** -- manual override for human-initiated resume when the daemon's automatic heuristic chose to discard but the user sees partial work worth keeping.

**Queue sidecar TTL for resume vs. discard:** for a discarded session, the TTL should be short (5 min) so the queue can quickly re-select. For a resumed session, keep the full TTL and extend it by the time already spent.

**Things to hash out:**
- When a session resumes after a crash, does the agent receive any signal that recovery happened? Should it be told explicitly so it can reorient, or is silent resumption preferable?
- If the agent crashed mid-tool-call (e.g. mid-Bash), what is the state of the file system? Does the recovery policy need to account for partially executed side effects?
- How is "meaningful progress" determined for sessions on non-coding workflows where there are no worktree commits? Step advances are the primary signal -- is that sufficient?
- The `human_review` case (borderline progress) requires a console UI to present the decision. What is the fallback if the console is not running?
- If a session resumes and crashes again in the same place, how many retries before permanent discard? Is this configurable per workflow?
- How does crash recovery interact with the re-dispatch loop protection (`maxAttempts`)? A resumed session should not count against the attempt counter in the same way as a fresh dispatch.

---

### Coordinator-managed git state and agent crash recovery (Apr 21, 2026)

**Status: idea** | Priority: high

**Score: 11** | Cor:3 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

**Git state management (coordinator's job):** Before dispatching any WorkTrain session that does git work:
1. Check for `.git/index.lock` -- if present, verify the owning PID is dead (via `lsof` on macOS), then remove it
2. Abort any in-progress git operations: `git rebase --abort; git merge --abort`
3. Verify the workspace is in a clean state before handing off to the agent

**Agent crash recovery (coordinator's job):** An agent can die from: stream watchdog timeout, OOM kill, or SIGKILL. In all cases the session event log is intact.

The coordinator should detect and recover automatically:
1. Monitor child sessions via `worktrain await`
2. If a session returns `_tag: 'aborted'` or `_tag: 'timeout'` mid-pipeline: check if the session made meaningful progress (step advances > 0, or notes written). If yes: resume the session -- same session ID, same context, agent picks up at last checkpoint. If no (zero progress): retry from scratch with a fresh session, same context bundle.
3. Retry up to N times (configurable, default 2) before escalating to Human Outbox
4. Track which phase failed and inject a hint on retry: "Previous attempt failed at this step. Retry with fresh approach."

**This is session continuation applied to crash recovery.** The agent's conversation history is fully preserved. Resuming puts it back exactly where it was. The 600s watchdog timeout (most common failure) almost always means a hung LLM call or a tool timeout -- resuming naturally retries the step.

**Things to hash out:**
- If the coordinator monitors child sessions and detects a crash, what prevents it from retrying a session that crashed because of an unrecoverable environment issue (e.g. the workspace is on a network drive that is now offline)?
- The hint "Previous attempt failed at this step. Retry with fresh approach." assumes the agent can adapt its approach. What if the failure was infrastructure (OOM, timeout from provider) rather than a strategy error?
- How does the coordinator distinguish between a `_tag: 'aborted'` from a user kill-switch vs a crash? Retrying a kill-switched session may violate operator intent.
- Git state management before recovery: `.git/index.lock` cleanup requires knowing the owning PID is dead. On macOS this is `lsof`; on Linux it is different. Is cross-platform git recovery in scope?
- Should the coordinator attempt git state cleanup even when it did not originally dispatch the session (e.g. a session manually started via CLI)?
- Who owns the N-retry limit configuration -- the coordinator script, the trigger definition, or a daemon-level policy?

---

### UX/UI impact detection and design workflow integration (Apr 19, 2026)

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:1 Eff:2 Lev:2 Con:2 | Blocked: yes (needs adaptive coordinator)

When the adaptive pipeline coordinator classifies a task, it should detect whether the task touches user-facing surfaces and automatically insert a `ui-ux-design-workflow` run before implementation.

**Why:** Coding tasks that touch UI get implemented without a design pass today. The agent writes functional code but often produces interfaces that are technically correct but experientially wrong -- wrong information hierarchy, wrong affordances, missing error states, missing loading states, wrong copy.

**Detection signals (`touchesUI: true`) when any of:**
- Issue title/body mentions: component, screen, page, modal, dialog, button, form, flow, onboarding, dashboard, navigation, UX, UI, design, user-facing, frontend, console, web
- Affected files include: `console/src/`, `*.tsx`, `*.css`, `web/`, `views/`
- The task has a `ui` or `frontend` label
- The upstream spec explicitly calls out visual or interaction design requirements

**Pipeline integration:** When `touchesUI: true`: `coding-task-classify -> ui-ux-design-workflow -> coding-task-workflow-agentic -> PR -> review -> merge`

**Open design questions:**
- Who reviews the design spec before coding starts? `complexity: Large AND touchesUI: true` → require human ack on the design spec before coding.
- Design this as part of the adaptive coordinator. The `touchesUI` flag belongs on the classification output alongside `taskComplexity` and `maturity`.
- What does "UI" mean for WorkRail specifically? The console is the only web surface -- does a change to `console/src/` always qualify, or only changes that affect user-visible interaction?
- Is false-positive `touchesUI` detection acceptable (wastes a design pass) or should the threshold be conservative to avoid unnecessary overhead?
- Should the `ui-ux-design-workflow` output be a gate (coding cannot start until design is approved) or advisory (coding proceeds in parallel)?
- Who is the design workflow audience -- the autonomous agent doing the coding, or a human reviewer? If the agent reads and follows the design spec itself, what prevents it from rationalizing the spec to fit what it already planned?

---

### Consider rewriting WorkRail engine in Kotlin (Apr 23, 2026)

**Status: idea** | Priority: low / long-term

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

**The argument:** WorkRail's coding philosophy demands "make illegal states unrepresentable" and "type safety as the first line of defense." TypeScript is structurally at odds with this: the compiler is advisory, not enforcing. `as unknown as`, `any`, and type assertion casts are always one line away. In a codebase where autonomous agents write and merge code without deep human review, the compiler is the reviewer -- and TypeScript's escape hatches make it too easy to paper over a real design problem with a cast.

**What Kotlin actually buys:**
- **Sealed classes** -- exhaustive `when` is a compile error, not a runtime `assertNever` pattern that convention must enforce
- **No easy escape hatch** -- `as` in Kotlin throws at runtime on type mismatch; there's no equivalent of `as unknown as` that silently lies to the compiler
- **Null safety by default** -- `String` vs `String?` is a language distinction, not a `strict: true` compiler flag that can be turned off
- **Value classes and data classes** -- less boilerplate for domain types, stronger invariants

**What TypeScript + current tooling already covers:** Zod at boundaries provides runtime validation; `neverthrow` gives Result types; discriminated unions + `assertNever` give exhaustiveness -- but enforced by convention, not the compiler.

**Real costs:** JVM startup latency for an MCP server that starts/stops frequently (mitigable with GraalVM native image, but adds build complexity); full rewrite of `src/`; Console stays TypeScript/React regardless.

**The honest tradeoff:** Convention drift is a recurring tax. Migration is a one-time cost. In a codebase driven heavily by autonomous agents, the compiler is the last line of defense against accumulated drift. TypeScript's permissiveness means that defense has holes.

Not urgent -- the current codebase is working well. Worth revisiting when the agent is writing the majority of new code. Requires a concrete spike: rewrite one module (e.g. `src/v2/durable-core/domain/`) in Kotlin and measure the real friction before committing to a full migration.

**Things to hash out:**
- What is the actual trigger condition? "Agent is writing the majority of new code" is vague -- what metric or event makes this evaluation happen?
- The Console is TypeScript/React and stays that way regardless. Does a partial Kotlin migration create a permanent two-language maintenance burden, or is the split clean enough to be manageable?
- GraalVM native image significantly reduces JVM startup time but adds build complexity and has known incompatibilities with reflection-heavy libraries. Is the build complexity acceptable for a project that ships frequently?
- Who owns the migration decision? This is a significant architectural commitment -- should it require explicit project owner sign-off rather than being decided by the agent autonomously?
- Are there TypeScript-specific patterns in the current codebase (e.g. `neverthrow`, discriminated unions) that would lose expressiveness in Kotlin, or would Kotlin actually improve them?

---

### Auto-start mechanism inventory (Apr 23, 2026)

**Status: resolved** | Documented for reference

Current auto-start mechanisms for WorkTrain daemon (as of current branch -- no auto-start):

The launchd plist (`~/Library/LaunchAgents/io.worktrain.daemon.plist`) no longer has `RunAtLoad` or `KeepAlive` keys (removed on current branch). The daemon must be started explicitly:
- `worktrain daemon --install` -- Register with launchd (no auto-start)
- `worktrain daemon --start` -- Start the daemon explicitly
- `worktrain daemon --stop` -- Stop the daemon
- `worktrain daemon --status` -- Check if running
- `worktrain daemon --uninstall` -- Remove registration

**Known operational note:** When working on daemon code, always `--stop` first then `--start` after rebuild. A running daemon does not automatically pick up a rebuilt binary.

---

### Post-update onboarding: contextual feature announcements

**Status: idea** | Priority: low

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

When WorkTrain updates to a new version with significant new capabilities, it prompts the user to configure the new feature -- once, the first time they run after updating.

**How it works:** Each significant feature ships with a migration step keyed to a minimum version:
```json
{
  "onboardingCompleted": "3.17.0",
  "featureStepsCompleted": ["daemon-soul", "bedrock-setup", "triggers-v2"]
}
```

On startup, WorkTrain checks: current version > `onboardingCompleted`? Any new `featureSteps` not in `featureStepsCompleted`? If yes, run those steps interactively before continuing.

Each step takes < 60 seconds. Show what changed, ask what's needed, confirm it works. Skip if already configured. Only triggers on: new capabilities that require user configuration, breaking config format changes, valuable opt-in features that are off by default. Does NOT trigger on: bug fixes, new workflows in the library, anything that works without user input.

**Things to hash out:**
- How does the onboarding system know which features require user configuration vs which just work? Is this metadata shipped with each feature, or manually curated?
- What happens if onboarding is interrupted mid-step (user closes the terminal)? Is the partial state safe to resume, or does it restart from the beginning?
- Should onboarding steps ever be re-runnable for reconfiguration, or is each step a one-time operation?
- Who authors and maintains the onboarding steps? Are they coupled to release engineering, or can feature authors ship their own?
- Is there a risk that forced onboarding after update creates friction that causes users to downgrade or skip updates?

---

### Bundled trigger templates: zero-config workflow automation via worktrain init (Apr 18, 2026)

**Status: idea** | Priority: high

**Score: 11** | Cor:1 Cap:3 Eff:2 Lev:2 Con:3 | Blocked: no

Every user has to write their own triggers.yml manually. Wrong workflow IDs, missing required fields, wrong workspace paths -- all common mistakes. There's no "just works" path to workflow automation.

**Solution:** Ship common trigger templates bundled with WorkTrain. `worktrain init` presents a menu and generates a pre-filled triggers.yml.

**Bundled templates:**
```yaml
# mr-review, coding-task, discovery-task, bug-investigation
# (with correct workflowIds, sensible defaults, and example config)
```

**`worktrain init` flow:**
1. "Which workflows do you want to run automatically?" (checkbox menu)
2. For each selected: set `workspacePath` to current directory (overridable)
3. Generate `triggers.yml` in the workspace root
4. Validate workflow IDs exist before writing
5. Tell the user how to fire each trigger: `curl -X POST http://localhost:3200/webhook/<id> ...`

**Also needed:** `worktrain trigger add <template-name>` to add a single trigger to an existing triggers.yml without re-running init.

The difference between WorkTrain being usable by anyone vs only by engineers who read the source code. A new user should be able to go from `worktrain init` to their first automated workflow in under 5 minutes.

**Things to hash out:**
- What is the scope of `worktrain init` -- does it also set up the daemon, configure the soul file, and validate credentials, or is it only for trigger template generation?
- When `worktrain trigger add` adds to an existing `triggers.yml`, what happens if the file has non-standard formatting or includes custom YAML anchors? Does the tool preserve or clobber them?
- Templates embed sensible defaults (e.g. `maxSessionMinutes: 90`). Who decides what "sensible" means, and how are those defaults kept in sync when the underlying constraints change?
- Should bundled templates be versioned separately from the WorkTrain binary, so they can be updated without a full release?
- If a template generates a trigger pointing to a workflowId that the user's WorkRail installation does not have (e.g. a custom workflow), how is that error surfaced?

---

### Decouple goal from trigger definition -- late-bound goals (Apr 18, 2026)

**Status: done** | Shipped (already implemented in trigger-store.ts)

**Score: 12** | Cor:1 Cap:3 Eff:3 Lev:2 Con:3 | Blocked: no

`trigger-store.ts` already implements the default `goalTemplate: "{{$.goal}}"` behavior (lines 766-773): when a trigger has neither `goal` nor `goalTemplate` configured, the loader injects `goalTemplate: "{{$.goal}}"` automatically and logs an informational warning. The webhook payload's `goal` field is the canonical way to pass a dynamic goal. Zero breaking changes, backward compatible.

The right long-term evolution (coordinator-spawned sessions needing richer context beyond a goal string) is tracked under "Coordinator context injection standard" and "Subagent context packaging".

**Preferred fix (Option 1 -- default goalTemplate):** if no `goal` is set in the trigger and no `goalTemplate` is set, default to `goalTemplate: "{{$.goal}}"`. The webhook payload's `goal` field becomes the canonical way to pass a dynamic goal. Zero breaking changes, backward compatible.

Most real-world triggers (PR review, issue investigation, incident response) have dynamic goals that depend on what just happened. Static goals in triggers.yml only work for scheduled/cron tasks. Late-bound goals make the whole trigger system composable with external events.

**Things to hash out:**
- If `goalTemplate: "{{$.goal}}"` is the default, what happens when the webhook payload omits the `goal` field entirely? Should the dispatch fail, fall back to the trigger ID, or use an empty string?
- How does this interact with `dispatchCondition`? A missing goal field might also indicate a structurally unexpected payload.
- Should late-bound goals apply to polling triggers as well (where the goal is derived from the polled item), or only webhooks?
- Is there a security concern with allowing arbitrary webhook payload fields to become the session goal without sanitization?

---

### FatalToolError: distinguish recoverable from non-recoverable tool failures (Apr 18, 2026)

**Status: idea** | Priority: low

**Score: 9** | Cor:2 Cap:1 Eff:2 Lev:1 Con:3 | Blocked: no

The blanket try/catch in `AgentLoop._executeTools()` converts ALL tool throws to `isError: true` tool results. This is correct for Bash/Read/Write (LLM can see and retry), but potentially wrong for `continue_workflow` failures (LLM retrying with a broken token loops).

**Fix:** `FatalToolError` subclass -- tools throw `FatalToolError` for non-recoverable errors (session corruption, bad tokens), plain `Error` for recoverable failures. `_executeTools` catches plain `Error` and returns `isError`; `FatalToolError` propagates and kills the session.

Combined with the `DEFAULT_MAX_TURNS` cap, this provides defense-in-depth against runaway loops on broken tokens.

**Things to hash out:**
- How does the tool author declare a failure as `FatalToolError` vs plain `Error`? Is this a convention, a type check, or a registration step?
- If the LLM retries a `FatalToolError` tool call because it didn't understand the result, is the second attempt also fatal? Or does the fatal classification only apply to specific error codes?
- How should the session outcome be recorded when killed by a `FatalToolError`? Is it different from a stuck/timeout outcome in the event log?
- Should `FatalToolError` be surfaced to the console with a distinct visual treatment so operators can distinguish infrastructure failures from agent logic failures?

---

## Shared / Engine

The durable session store, v2 engine, and workflow authoring features shared by all three systems.


### Improve commit SHA gathering consistency in wr.coding-task

**Status: idea** | Priority: high

**Score: 9** | Cor:2 Cap:1 Eff:2 Lev:1 Con:3 | Blocked: no

After fixing the primary cause (SHA footer referenced `continue_workflow` by name while daemon agents use `complete_step`), two structural gaps remain that prevent consistent SHA recording:

**Gap 1: SHA footer appears on every non-final step, including planning/design steps with no commits.** Agents correctly skip it on those steps, but the repetition trains them to suppress it reflexively -- including on implementation steps where it matters. Options to explore: inject only inside loop bodies tagged as implementation, add an opt-out flag to steps, or move the SHA reminder into the implementation step prompts directly in the workflow JSON.

**Gap 2: `phase-5-small-task-fast-path` has no correctly-wired final metrics step for Small tasks.** `isLastStep` resolves to `phase-7b-fix-and-summarize`, which has a `runCondition` that skips it for Small tasks. Small-task sessions never see the final metrics footer. Needs either: the final footer added directly to `phase-5`'s authored prompt, or `isLastStep` detection made context-aware (complex).

**Gap 3: No validation for `metrics_commit_shas`.** `checkContextBudget` validates `metrics_outcome` but not SHAs. Missing or partial arrays fail silently. A warning-level soft validation at the final step would at least surface the gap in logs.

The right fix is probably a combination of moving the SHA instruction into the implementation step prompts directly (removing it from the ambient footer entirely) and adding Gap 2's final footer to `phase-5`. That avoids any new engine machinery.

**Things to hash out:**
- Moving the SHA instruction into implementation step prompts means every implementation step must be identified and updated. Who owns the ongoing maintenance of keeping that instruction present in new steps added to the workflow?
- Gap 3's soft validation: what is the right signal when `metrics_commit_shas` is missing -- a log warning, a console callout, or a session outcome flag? What action should the operator take on seeing this signal?
- If the SHA footer is removed from the ambient footer entirely, what prevents other workflows from missing SHA collection? Is the ambient footer the right abstraction, or should SHA recording be an engine-level concern separate from prompts?

---

### `jumpIf`: conditional step jumps with per-target jump counter

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

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

**Score: 11** | Cor:2 Cap:2 Eff:2 Lev:2 Con:3 | Blocked: no

**Problem:** WorkRail validates workflow files against the schema bundled in the currently-running MCP binary. Binary too new rejects old workflows; binary too old rejects new workflows. Both cause silent disappearance from `list_workflows` with no explanation.

**The right fix:** Each workflow declares `"schemaVersion": 1` (integer). The binary ships validator copies for every schema version it supports. When loading a workflow, pick the validator matching the declared version.

**Load-time logic:**
1. Read `schemaVersion` (default 1 if absent -- legacy workflows)
2. If `schemaVersion === current`: validate against current schema directly
3. If `schemaVersion < current` (binary newer): validate against the declared schema version
4. If `schemaVersion > current` (binary too old): load leniently with warnings -- `additionalProperties: false` does not apply

**Decision (from Apr 23 audit):** v1 = current schema. The one historical breaking change (`assessmentConsequenceTrigger`, Apr 5) was fully contained within the bundled workflow corpus. No historical reconstruction needed.

**Files to change:** `spec/workflow.schema.json`, `spec/workflow.schema.v1.json` (snapshot), `src/application/validation.ts`, `src/types/workflow-definition.ts`, `workflow-for-workflows.json` (stamp `schemaVersion`), all bundled workflows.

**Things to hash out:**
- What is the policy when a workflow with `schemaVersion > current` has fields that fail lenient loading -- should the workflow be skipped entirely or loaded partially?
- Should the binary ship all historical schema validator copies forever, or is there a deprecation window after which very old versions are dropped?
- How does `workrailVersion` (the "forever backward compat" idea elsewhere in the backlog) relate to `schemaVersion`? Are these the same concept or different tracking axes?
- External workflow authors who don't track WorkRail releases need to know how to set `schemaVersion`. Is the default-to-v1 behavior documented clearly enough?
- What prevents a workflow from declaring `schemaVersion: 999` to bypass validation entirely via the lenient path?

---

### Task re-dispatch loop protection

**Status: done** | Shipped PR #883 (Apr 30, 2026)

`queue-issue-<N>.json` sidecar now carries `attemptCount`. Failure path rewrites it with the same count + zeroed TTL (no double-increment). When `attemptCount >= maxAttempts` (default 3, configurable as `maxDispatchAttempts`), dispatch is skipped, outbox notified, `worktrain:needs-human` label applied, comment posted. Daemon restart resets counts.

---

### Daemon agent loop stall detection

**Status: done** | Shipped PR #900 (Apr 30, 2026)

`AgentLoop` now accepts `stallTimeoutMs` and `onStallDetected` callback (injected, not hardcoded). Timer resets before each `client.messages.create()` call; if it fires, `abort()` is called and `WorkflowRunStuck` with `reason: 'stall'` is returned. Configurable via `agentConfig.stallTimeoutSeconds` in triggers.yml (default 120s).

---

### `queue-poll.jsonl` never rotated

**Status: done** | Shipped PR #897 (Apr 30, 2026)

`rotateLogFile()` reusable helper added. Fires at 10 MB: shifts `.1` to `.2`, renames current to `.1`, starts fresh. Two backup files (~10 weeks retention). Best-effort: rotation failure logs a warning but never blocks the append.

---

### ReviewSeverity: stderr bypassing injected dep

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:1 Eff:3 Lev:1 Con:3 | Blocked: no

**Bug 1 (DONE):** `assertNever` on `ReviewSeverity` was added at `pr-review.ts:1407`. ✓

**Bug 2 (still open):** `src/coordinators/pr-review.ts:447` -- `process.stderr.write(...)` called directly instead of using injected `deps.stderr`. Tests that inject a fake dep miss this log.

**File:** `src/coordinators/pr-review.ts`.

---

### Session continuation / "just keep talking"

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

A completed session is not dead -- the conversation is still in the event log. The only thing blocking continuation is the engine rejecting messages to sessions in `complete` state.

**The change:** Remove that gate. `worktrain session continue <sessionId> "<message>"` sends a message to a completed session. New events appended to the same log. Same session ID. The agent has full context of everything it ever did.

Context window overflow (very long sessions) is a separate optimization problem -- truncate oldest turns while keeping step notes. Don't solve it now.

**Things to hash out:**
- When a completed session is continued, what workflow state does the engine start from? Does the agent re-enter the workflow at the last step, or does continuation happen outside any workflow context?
- If continuation adds a `session_resumed` event, how should the console display the session? As an extended session or as a new one with a link back?
- Should `worktrain session continue` be available in both daemon and MCP contexts, or daemon-only where the context stays alive?
- What is the intended use case -- interactive follow-up questions, or coordinator-driven post-processing? The answer shapes the UX significantly.
- If a session is continued after its worktree has been cleaned up, what tools can the agent use? Does it get a fresh worktree, or is it context-only?

---

### Session as a living record: post-completion phases

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

A `session_completed` event means the original workflow is done -- not that the session can never receive new events. The event log is append-only: just keep appending. A post-completion interaction adds a `session_resumed` event, then new turns, then a new `session_completed`.

This is already how mid-run resume works. The same mechanism extends naturally to post-completion: rehydrate the completed state, append a new lightweight phase, run it, complete again.

**Richer automatic checkpoints:** Many session events should trigger a checkpoint automatically:
- `step_advanced` (already essentially a checkpoint)
- `signal_coordinator` fired (agent surfaced meaningful mid-step state)
- Worktree commit pushed (code state durable on remote)
- Coordinator steers the session (notable injection)
- `spawn_agent` child completes (parent has new information)

**Things to hash out:**
- Who decides what constitutes a "lightweight phase" added post-completion? Is this a new workflow, an ad-hoc prompt, or something else?
- How does the auto-checkpoint list interact with existing explicit `checkpoint_workflow` calls? Is there any risk of over-checkpointing causing storage bloat?
- If a coordinator resumes a session for post-completion processing, is the resumed session billed/attributed to the same source trigger?
- What is the retention and garbage collection policy for post-completion events appended to old sessions?

---

### Rules preprocessing: normalize workspace rules before injection

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

**Problem:** WorkTrain injects all rules files raw into every agent's system prompt. A workspace with `.cursorrules`, `CLAUDE.md`, `.windsurf/rules/*.md`, and `AGENTS.md` might inject 10KB of rules into a discovery session that only needs 2KB.

**Design:** A `worktrain rules build` command that reads all IDE rules files from the workspace, deduplicates overlapping rules, categorizes by phase, and writes to `.worktrain/rules/`:
- `implementation.md`, `review.md`, `delivery.md`, `discovery.md`, `all.md`
- `manifest.json` -- which files exist, when generated, source files used

At session time: WorkTrain injects only the phase-relevant file.

**Things to hash out:**
- How does WorkTrain determine which pipeline phase a session corresponds to? Is this declared in the trigger, derived from the workflowId, or inferred from the step?
- What happens when a single session spans multiple phases (e.g. a workflow that does discovery + implementation in one run)? Does the injected rules file switch mid-session, or is one phase file chosen at dispatch time?
- Who authors and owns the `.worktrain/rules/` files -- the workspace team, the workflow author, or WorkTrain itself?
- Should the absence of a phase-specific file fall back to `all.md`, or be a silent no-op? Is a missing `implementation.md` a misconfiguration or an acceptable default?
- How does this interact with the existing `daemon-soul.md` and workspace AGENTS.md injection? What is the full load-order and precedence when all are present?

---

### True session status (live agent state in console)

**Status: idea** | Priority: medium-high

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

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

**Things to hash out:**
- The daemon has direct access to `DaemonRegistry`, but the console is a separate process reading the session store. How does live status reach the console without the daemon being a dependency for reading it?
- What is the polling or push mechanism for the console to get status updates? SSE from the daemon's HTTP endpoint, or a separate status file the daemon writes?
- How is `daemon:down` distinguished from "daemon is up but this session is not currently running"? What is the heartbeat protocol?
- Should `active:tool` surface the tool name? Some tool names (file paths, bash commands) could leak sensitive workspace content in the console UI.
- What is the retention policy for status events -- does the console show only the live state, or a history of status transitions?

---

## WorkTrain Daemon -- Coordinator patterns

Coordinator design patterns for WorkTrain's autonomous pipeline.


### Event-driven agent coordination (coordinator as event bus)

**Status: idea** | Priority: high

**Score: 11** | Cor:1 Cap:3 Eff:2 Lev:3 Con:2 | Blocked: no

**Problem:** Agents managing an MR should not poll for review comments or CI status -- that wastes turns and burns tokens. Instead, the coordinator should register for events and steer the agent when something relevant happens.

The infrastructure already exists: `steerRegistry` + `POST /sessions/:id/steer`, `signal_coordinator` tool, `DaemonEventEmitter`.

**What's missing:** Coordinator-side event sources (GitHub webhooks or polling fallback) and an event-to-steer bridge that maps `MREvent` to structured steer messages.

**How it works:** MR management agent session is parked (no pending turns). Coordinator registers for GitHub events. When review comment/CI failure/approval arrives, coordinator steers the running session. Agent responds. No polling from the agent side.

**Agent session prompt:** "Do not poll for PR status. Wait for the coordinator to deliver events via injected messages."

**Things to hash out:**
- How does the coordinator distinguish between a GitHub webhook event and a polling fallback event when both are in flight? Is deduplication needed?
- What is the protocol for a parked agent session -- does it consume a slot in `maxConcurrentSessions` while parked, or is the slot released and re-acquired when an event arrives?
- How long can an agent session remain parked before the coordinator gives up and closes it? Is there a configurable TTL for event-waiting?
- Should the coordinator register for GitHub events directly, or should a shared event router handle all webhook subscriptions and fan out to interested coordinators?
- If the steer injection fails (session has timed out or been garbage collected), what does the coordinator do with the pending event?

---

### MR lifecycle manager

**Status: idea** | Priority: high

**Score: 9** | Cor:1 Cap:3 Eff:1 Lev:2 Con:2 | Blocked: yes (needs dispatchCondition, PR templates)

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

**Things to hash out:**
- CI pipeline monitoring requires parsing CI failure logs, which are provider-specific (GitHub Actions, GitLab CI, CircleCI, etc.). Is the lifecycle manager expected to handle multiple providers, or is it scoped to one initially?
- "Retry flaky tests" is a significant decision with potential to exhaust CI minutes. What is the policy for how many retries are allowed, and who decides when a test is "flaky" vs genuinely broken?
- For merge conflict resolution, what is the boundary between "safe to rebase automatically" and "requires human escalation"? Is this a heuristic, a file-set check, or something else?
- What happens if the lifecycle manager itself fails mid-run (daemon crash, token expiry)? Is the MR left in a consistent state, or can it be in a partially processed state?
- Who is responsible for the MR while the lifecycle manager is active -- WorkTrain or the human who opened the task? Can the human intervene and override without confusing the manager?
- How does the lifecycle manager handle PRs that become stale while waiting for CI (main advances, merge conflict develops)?

---

### Phase-scoped context files

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

**Design:** Teams define context files scoped to specific pipeline phases under `.worktrain/rules/`:
- `discovery.md`, `shaping.md`, `implementation.md`, `review.md`, `delivery.md`, `pr-management.md`, `all.md`

Each file is injected only into sessions running the matching pipeline phase. Reduces token waste and rule dilution. `all.md` is equivalent to today's AGENTS.md injection.

**Load order (most specific wins):** `AGENTS.md` / `CLAUDE.md` (base) → `.worktrain/rules/all.md` → phase-specific file.

---

### Coordinator architecture: separation of concerns

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: yes (needs knowledge graph for context assembly)

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

**Things to hash out:**
- The right layering puts "Dispatch layer (TBD)" between Trigger and Orchestration. What exactly does the dispatch layer decide, and how does it relate to the adaptive pipeline coordinator concept elsewhere in the backlog?
- Context assembly requires the knowledge graph. What is the fallback when the KG is not yet built for a workspace -- does context assembly simply return empty, or does it fall back to a slower manual search?
- Should context assembly run synchronously before dispatch (blocking the trigger listener) or asynchronously (session starts with partial context while assembly continues)?
- Who owns the context assembly API contract -- the engine (as a new primitive), the daemon (as an infrastructure capability), or user-authored scripts?

---

### Scheduled tasks (native cron provider)

**Status: idea** | Priority: medium

**Score: 11** | Cor:1 Cap:3 Eff:2 Lev:2 Con:3 | Blocked: no

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

**Things to hash out:**
- `schedule-state.json` records last-run timestamps. If the daemon is not running at the scheduled time, what happens when it next starts -- does the missed run execute immediately, wait for the next tick, or follow the `catchUp: true` policy?
- Timezone support requires knowing the user's local timezone at schedule-definition time, not at execution time. What happens when the operator moves to a different timezone?
- "Overlap prevention" skips a tick if a run is still active. What is the notification when a run is skipped? Does the operator know they missed a scheduled execution?
- Should `worktrain run schedule <trigger-id>` bypass the overlap check (for manual debugging), or respect it?
- How does the schedule provider interact with the daemon's `maxConcurrentSessions` limit? A scheduled job at full capacity could be silently dropped without an overlap check.

---

### Autonomous grooming loop + workOnAll mode

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:3 Eff:1 Lev:2 Con:2 | Blocked: yes (needs scheduled tasks)

**Three autonomy levels:**

- **Level 0 (current):** Human applies `worktrain` label to specific issues. WorkTrain works those only.
- **Level 1 -- workOnAll:** Config flag `workOnAll: true`. WorkTrain looks at ALL open issues, infers which are actionable, picks highest-priority. Escape hatch: `worktrain:skip` label.
- **Level 2 -- Fully proactive:** WorkTrain also surfaces work it found itself (failing CI, backlog items with no issue, patterns in git history).

**Grooming loop (scheduled nightly):** Reads backlog, open issues, recent completed work. Closes resolved issues. For ungroomed items: infers maturity (linked spec, acceptance criteria, vague language). For high-value idea-level items: runs `wr.discovery` + `wr.shaping`, creates/updates issue.

**workOnAll config:**
```json
{ "workOnAll": true, "workOnAllExclusions": ["needs-design", "blocked-external"], "maxConcurrentSelf": 2 }
```

**Things to hash out:**
- The grooming loop reads and writes GitHub issues autonomously. What safeguards prevent it from closing issues that are still relevant but appear resolved?
- What is the "infer which issues are actionable" heuristic? Misclassification could cause WorkTrain to skip important work or start unwanted sessions.
- `workOnAll: true` effectively gives WorkTrain permission to work on any open issue. How does the operator set scope limits beyond label exclusions -- e.g. restrict to a specific project, milestone, or assignee?
- How does WorkTrain avoid duplicate work when `workOnAll` is enabled and another human or agent is already working on the same issue?
- What is the escalation path when a grooomed issue turns out to need human judgment? Does WorkTrain leave a comment and move on, or does it hold the item?
- Should `maxConcurrentSelf` apply at the daemon level or the workspace level? A single daemon managing multiple repos needs per-workspace caps.

---

### Escalating review gates based on finding severity

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

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

**Things to hash out:**
- The escalation routing by `finding.category` assumes categories are reliably assigned by the review workflow. How accurate is that classification in practice? A misclassified category could skip the wrong audit type.
- How are false positives handled in the escalating chain? If a production audit is triggered by a Critical finding that turns out to be incorrect, is there a path to clear it without human intervention?
- The "hard rule: never auto-merge after escalation" is correct but creates a potential pile-up of PRs waiting for human approval. Is there a notification mechanism to surface these to the operator?
- Should the escalation chain be configurable per workspace or per workflow, or is it a global policy?
- How does this interact with `riskLevel=Critical` tasks that already require human approval by policy? Are the two gates additive or redundant?

---

### Workflow execution time tracking and prediction

**Status: partial** | Tracking shipped; prediction/calibration layer not yet built

**Score: 11** | Cor:1 Cap:2 Eff:3 Lev:2 Con:3 | Blocked: no

**Problem:** Timeouts are set by intuition. No data on how long workflows actually take.

**What to track:** For every completed session -- workflow ID, total wall-clock duration, turn count, step advances, outcome, task complexity signals. Store in `~/.workrail/data/execution-stats.jsonl`.

**Uses:**
- Calibrate timeouts automatically (p95 * 1.5)
- Predict duration before dispatch
- Step-advance rate as workflow efficiency proxy

**Implementation:** Append to `execution-stats.jsonl` in `runWorkflow()`'s finally block.

**Things to hash out:**
- How many data points are needed before timeout calibration is reliable? p95 * 1.5 from 3 samples is very different from p95 from 300 samples.
- Should auto-calibrated timeouts update `triggers.yml` in place, or only influence the daemon's internal behavior? Modifying `triggers.yml` autonomously is a significant action.
- Duration data varies by model, task complexity, and LLM provider load. Should the prediction account for these dimensions, or just average across them?
- What happens to prediction accuracy when workflow structure changes significantly between versions? Should stats from old workflow versions be excluded?
- Who can see and act on the execution stats? Should they be surfaced in the console or only in raw `.jsonl` form?

---

### WorkRail MCP server self-cleanup

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

**Sources of stale state:** old workflow copies in `~/.workrail/workflows/`, dead managed sources, stale git repo caches, 500+ sessions accumulating with no TTL, remembered roots for non-existent paths.

**Fix -- two layers:**

1. **Startup auto-cleanup (light):** On MCP server startup, silently remove managed sources where the filesystem path doesn't exist. Log "removed N stale sources."

2. **`workrail cleanup` command:**
   ```
   workrail cleanup [--yes] [--sessions --older-than <age>] [--sources] [--cache] [--roots]
   ```

**Things to hash out:**
- What is the policy for session retention -- is 500 sessions a problem in practice, or does it only become one after thousands? What storage cost is acceptable?
- Startup auto-cleanup silently removes managed sources for non-existent paths. If a path is temporarily unmounted (NAS, external drive), silent removal is destructive. Should there be a warning or confirmation before removing?
- `workrail cleanup --sessions --older-than <age>` deletes event logs. For debugging past failures, old session logs are valuable. Is there a distinction between sessions worth keeping and sessions safe to delete?
- Should cleanup be idempotent and safe to run while the MCP server is live, or does it require the server to be stopped?
- Who decides the default `--older-than` threshold? Too aggressive loses useful history; too conservative lets the store grow unbounded.

---

### Subagent context packaging

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

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

**Things to hash out:**
- Who enforces the `context` mode? If the spawning agent passes `context: 'inherit'` for an adversarial reviewer, the reviewer's independence is compromised. Is enforcement engine-level or convention?
- How large can the structured context bundle grow before it becomes a liability rather than an asset? Is there a hard token budget for `whyThisApproach`, `alreadyTried`, etc.?
- The `session-knowledge.jsonl` is append-only. Over a long session it could grow to thousands of entries. What is the selection/truncation strategy when packaging it into a subagent bundle?
- How does the main agent know when to append to `session-knowledge.jsonl`? Is this tool-driven (explicit call), automatic on step advance, or heuristic?
- What is the format and schema for `completionCriteria`? A natural language string is hard to evaluate programmatically -- is structured output needed?

---

### Workflow-scoped system prompts for subagents

**Status: idea** | Priority: medium

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

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

**Things to hash out:**
- The composition order lists 7 layers. At what point does total system prompt size become a context window concern for the model? Is there a budget or truncation policy?
- Should workflow authors be able to completely replace the WorkTrain base prompt, or only add to it? A workflow that removes the base prompt's safety constraints is a significant risk vector.
- Step-level overrides apply only to that step, but the model's behavior may be shaped for the entire session by earlier steps. Is there a "reset" mechanism for step-scoped prompts?
- If the same content appears in both the workflow-level `systemPrompt` and AGENTS.md, is that redundancy acceptable or should there be a deduplication step?
- How is a workflow-scoped `systemPrompt` authored and validated? Is it freeform text, or are there constraints on what it can contain?

---

### `context-gather` step type

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

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

**Things to hash out:**
- What is the contract between a `context-gather` step and the workflow steps that consume `outputVar`? If the step is `optional: true` and returns nothing, downstream steps that reference `shapedInput` get an empty value -- is that safe?
- The `task-url` source extracts URLs from the task description and fetches them. This is a network call at engine level. Who is responsible for auth, rate limiting, and error handling for remote fetches?
- The `glean` source is opt-in only. What is the opt-in mechanism -- a daemon config flag, a workflow declaration, or a user preference?
- How does the engine signal to the agent that context was gathered successfully vs not found? Is this visible in the step prompt, or does the agent need to check `outputVar` itself?
- Can a `context-gather` step block session start if a required source is unavailable, or should it always succeed (possibly with an empty result)?

---

## WorkRail MCP Server

The stdio/HTTP MCP server that Claude Code (and other MCP clients) connect to. MUST be bulletproof -- crashes kill all in-flight Claude Code sessions.

### Multi-root workflow discovery and setup UX

**Status: designing** | Priority: medium

**Score: 7** | Cor:1 Cap:2 Eff:1 Lev:1 Con:2 | Blocked: no

Simplify third-party and team workflow hookup by requiring explicit `workspacePath`, silently remembering repo roots in user-level `~/.workrail/config.json`, recursively discovering team/module `.workrail/workflows/` folders under remembered roots, and improving grouped source visibility / precedence explanations.

**Current recommendation:**
- Phase 1: Rooted Team Sharing + minimal Source Control Tower
- Require explicit workspace identity
- Silently persist repo roots at the user level
- Support cross-repo workflows from remembered roots
- Make remote repos default to managed-sync mode rather than pinned snapshots or live-remote behavior
- Treat Slack/chat/file/zip sharing as an ingestion path that classifies into repo, file, pack, or snippet flows
- Design the backend so the console can eventually manage and explain the remembered/discovered source model

**Additional idea:** explore enterprise auth / SSO integration for private repo access, such as Okta-backed flows for GitHub Enterprise, GitLab, or other self-hosted providers. Main question: should WorkRail integrate directly with identity providers like Okta, or should it integrate one layer lower with Git hosts / credential helpers that are already SSO-aware?

**Design doc:** `docs/ideas/third-party-workflow-setup-design-thinking.md`

---

## Console

### Workflows tab: incorrect source attribution for bundled workflows (Apr 21, 2026)

**Status: bug** | Priority: low

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

The Workflows tab shows bundled workflows (e.g. `coding-task-workflow-agentic`) as coming from "User Library" instead of "WorkRail Built-in". This is a WorkRail MCP server issue, not a WorkTrain issue.

**Likely cause:** The `source.kind` field is incorrectly set when a workflow exists in both the bundled set AND a user's managed sources or remembered roots.

**Where to look:**
- `src/infrastructure/storage/schema-validating-workflow-storage.ts` -- source kind propagation
- `src/mcp/handlers/shared/workflow-source-visibility.ts` -- display label mapping in `list_workflows`
- `src/infrastructure/storage/file-workflow-storage.ts` -- how `source.kind` is assigned when loading from disk

---

### Task picker mode: browse and launch available work (Apr 29, 2026)

**Status: idea** | Priority: high

**Score: 10** | Cor:1 Cap:3 Eff:2 Lev:1 Con:3 | Blocked: no

**Problem:** Once WorkTrain is configured (workspace set up, triggers.yml written, daemon running), there is still no easy way to say "run this workflow now" from the console. Dispatch requires knowing the API or writing a webhook. The console has a dispatch endpoint but no UI to drive it.

**Vision:** A console panel that lists the triggers already configured in triggers.yml and lets the user click one to fire it immediately -- without leaving the browser, without touching the API, without writing YAML.

**How it works:**
1. Console calls `GET /api/v2/triggers` to list all triggers loaded by the daemon.
2. User sees a list: trigger ID, workflow, goal, last-fired timestamp. Clicks "Run".
3. Console POSTs to `/api/v2/auto/dispatch` (already implemented) with the trigger's workflowId + goal + workspace.
4. New session appears in the session list immediately. User watches the DAG advance live.
5. On completion: outcome, PR link (if opened), and step notes all visible in the same panel.

**What this is not:** An onboarding wizard or zero-setup flow -- the daemon and environment must already be configured. This is a dispatch surface for *already-configured* users who want to trigger work without using the CLI or waiting for a webhook.

**Why it matters:** Makes the console a control plane, not just a read-only viewer. The daemon gains a "run this now" button. Users get to watch the agent work in real time, which builds confidence before trusting it on unattended tasks.

**Dependency:** `GET /api/v2/triggers` endpoint (returns the live trigger index -- may need to be added). `POST /api/v2/auto/dispatch` already exists. No new daemon work required.

**Things to hash out:**
- When the user clicks "Run" on a trigger that requires a dynamic goal (not a static one), where does the goal come from? Is there a text input, or is it required to be a static-goal trigger?
- Should manual dispatch from the console count against `maxConcurrentSessions`? Or is it a privileged path that bypasses the queue?
- The console is described as read-only in AGENTS.md. Does adding dispatch capability change its security model? Is there authentication needed before dispatch is permitted?
- If the daemon is not running when the user clicks "Run", what is the UX? Silent failure, immediate error, or auto-start attempt?
- Should this panel also allow stopping or pausing running sessions, or is dispatch the only write operation?

---

### Console interactivity and liveliness

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:1 Eff:2 Lev:1 Con:3 | Blocked: no

**Key areas:**
- **DAG node hover effects** -- nodes in `RunLineageDag` should have visible hover states: border brightens, subtle glow, cursor changes to pointer. This is the single highest-impact item.
- **Node selection highlight** -- selected node should pulse or glow, not just change border color
- **Live session pulse** -- sessions with `status: in_progress` could have a subtle periodic animation
- **Tooltip polish** -- fade in/out rather than appearing instantly

**Design constraint:** Dark navy, amber accent aesthetic. Additions should reinforce this language.

**Where to start:** `console/src/components/RunLineageDag.tsx`. The tooltip pattern (`handleNodeMouseEnter`/`handleNodeMouseLeave`) already exists; a hover glow is a natural peer addition.

**Related:** `docs/design/console-cyberpunk-ui-discovery.md`, `docs/design/console-ui-backlog.md`

**Things to hash out:**
- CSS animations on many simultaneously live nodes can cause layout thrash and frame drops. Is there a performance budget or a maximum animated-node count before animations are disabled?
- The dark navy + amber aesthetic is established but not formally documented as a design token system. Should a design token file be established before adding more visual elements?
- Live session pulse animations may be distracting when many sessions are running. Should animation be suppressible via a user preference?

---

### Console engine-trace visibility and phase UX

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

**Gap:** Users currently see only `node_created`/`edge_created`, which makes legitimate engine behavior look like missing workflow phases. Fast paths, skipped phases, condition evaluation, and loop gates are invisible.

**Recommended direction:**
- Keep phases as authoring/workflow-organization concepts
- Add an engine-trace/decision layer showing: selected next step, evaluated conditions, entered/exited loops, important run context variables (e.g. `taskComplexity`), skipped/bypassed planning paths

**Phase 1:** Extend console service/DTOs with a run-scoped execution-trace summary. Show a compact "engine decisions" strip or timeline above the DAG.

**Phase 2:** Richer explainability timeline with branches, skipped phases, condition results. Toggle between "execution DAG" and "engine trace" views.

**Things to hash out:**
- Engine decisions (evaluated conditions, skipped steps) are not currently captured as session events -- they exist only in memory during the run. What new event types need to be added to the session store to make this work?
- How does the "engine decisions" strip stay useful without becoming overwhelming for complex workflows with many branches and loop iterations?
- Should condition variable values (e.g. `taskComplexity=Small`) be visible in the trace? This surfaces potentially sensitive session context in a UI accessible to anyone with console access.
- Is Phase 2 (toggle between DAG and trace views) a separate ticket, or is it part of the same design effort as Phase 1?

---

### Console ghost nodes (Layer 3b)

**Status: idea** | Priority: low

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

Ghost nodes represent steps that were compiled into the DAG but skipped at runtime due to `runCondition`. Currently the DAG just shows fewer nodes with no indication of what was bypassed. Layer 3b would render skipped nodes as faded/ghost elements with a tooltip explaining the skip condition.

**Things to hash out:**
- Ghost nodes require knowing which nodes were compiled but skipped. Does the engine currently emit any event for skipped nodes, or is this information lost after compilation?
- For workflows with many conditional branches, ghost nodes could double or triple the visual complexity of the DAG. Is there a layout strategy that keeps it readable?
- Should ghost nodes be shown by default, or hidden behind a toggle? What is the right default for users who are not debugging a skip?

---

## Workflow Library

### Automatic root cause analysis when MR review finds issues post-coding (Apr 30, 2026)

**Status: idea** | Priority: high

**Score: 13** | Cor:3 Cap:3 Eff:2 Lev:3 Con:2 | Blocked: no

When an MR review session (run by a WorkTrain agent) finds issues in a coding session's output, WorkTrain should automatically investigate why the coding agent missed it and determine whether the workflow, the prompts, or the process can be improved.

**Two distinct triggers:**

1. **WorkTrain MR review finds something**: after a WorkTrain review session produces findings, the coordinator should automatically spawn an analysis session asking: why did the coding agent produce code with this issue? Was it a workflow gap (missing verification step, insufficient scrutiny at a phase), a prompt gap (the agent wasn't told to check this), or a context gap (the agent didn't have the information needed)?

2. **Human finds something post-review**: when a human reviewer comments on or requests changes to a PR that already passed WorkTrain's review, this is doubly significant -- it means both the coding agent AND the review agent missed it. WorkTrain should automatically investigate why both missed it and whether the review workflow has a systematic blind spot.

**Why this matters**: every finding that slips through is a signal about a workflow or process gap. Today that signal is lost. Capturing it systematically and feeding it back into workflow improvement closes the quality loop.

**Things to hash out:**
- How does WorkTrain detect that a human has commented on a PR post-review? This requires monitoring the PR for new review activity after WorkTrain's session completed -- either webhook events or polling.
- What does the analysis session actually produce? A structured finding about the gap? A concrete proposal for workflow improvement? Both?
- Who reviews the analysis output before it becomes a workflow change? Auto-applying workflow changes based on analysis is risky.
- How do you distinguish "the workflow is fine but this was a genuinely hard edge case" from "the workflow has a systematic gap"? A single miss doesn't prove a gap; multiple misses of the same kind do.
- Should the analysis result feed directly into `workflow-effectiveness-assessment`, or is it a separate concern?
- For the "coding agent missed it" case: is the right fix to change the coding workflow, or to make the review workflow more adversarial?

---

### Workflow previewer for compiled and runtime behavior

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

Add a workflow previewer for the `workflows/` directory that shows what a workflow actually compiles to and how the engine can traverse it at runtime.

**Why:** Authors currently have to mentally reconstruct branching, loops, blocked-node behavior, and other runtime structure from authored JSON plus tests. Advanced workflow authoring gets much easier when the compiled DAG and runtime edges are visible.

**What it should show:** compiled step graph/DAG; branch points and condition-driven paths; loop structure and loop-control edges; blocked/resumed/checkpoint-related node shapes; template/routine expansion boundaries; the gap between authored JSON structure and runtime execution structure.

**Design questions:**
- Should this live in the existing Console, as a dev-only page, or as a local authoring utility?
- Should it show only the compiled DAG, or also annotate likely runtime transitions such as blocked attempts, rewinds, and loop continuations?
- How much provenance should it expose for injected routines/templates?

Start as a read-only preview for bundled workflows; optimize for accuracy over polish.

**Things to hash out:**
- Should the previewer live in the existing Console, as a dev-only page, or as a local authoring utility (CLI command)?
- Should it show only the compiled DAG, or also annotate likely runtime transitions such as blocked attempts, rewinds, and loop continuations?
- How much provenance should it expose for injected routines/templates? Is it useful to show the boundary between authored steps and expanded routine steps?
- Does the previewer need to show all possible DAG paths, or only the "happy path"? For deeply conditional workflows, all-paths could be very large.
- Is this only useful during workflow authoring, or also useful for operators who want to understand a running session's possible future states?

---

### Native assessment / decision gates for workflows

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Add a first-class workflow primitive for structured assessments that can drive routing. The agent would assess a small set of named dimensions, give short rationales, and let the engine use explicit aggregation/gate rules to influence continuation, follow-up, branching, or final confidence.

**Why:** Some workflow decisions are clearer and more auditable as small assessment matrices than as long prompt prose. Confidence computation is a strong example: workflows may want to derive final confidence from dimensions like boundary, intent, evidence, coverage, and disagreement.

**Near-term shape:** keep reasoning with the agent, but let the workflow declare named assessment dimensions and allowed levels such as `High | Medium | Low`. Let the agent provide one short rationale per dimension. Let the engine compute caps/next actions/routing outcomes from explicit gate rules.

**Ownership split:** the agent assesses each dimension and gives the short rationale; the engine applies declared gate rules.

**Good early use cases:** MR review confidence assessment; planning readiness/confidence gates; debugging confidence and next-step routing; block-vs-continue/revisit-earlier-step decisions.

**Design questions:** should this be a narrow `assessmentGate` primitive or a more generic structured decision-table feature? Should reusable matrices be inline first, or backed by repo-owned refs? How should assessment provenance and rationales appear in compiled/runtime traces?

**Things to hash out:**
- When the agent provides a rationale for each dimension, is that rationale stored in the session event log and surfaced in the console? Or is it ephemeral?
- How does the engine enforce that the agent assessed all required dimensions before advancing? Is this a schema-validated output contract, or a soft expectation?
- If the engine applies gate rules and routes the session differently than the agent expected, how is that decision communicated back to the agent in the next step's context?
- Are assessment dimensions per-workflow or could they be shared across workflows via a named reference? What is the right reuse model?
- What is the relationship between this primitive and the existing `assessmentConsequenceTrigger` in assessment gates v1?

---

### Engine-injected note scaffolding

**Status: idea** | Priority: low

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

Add an opt-in execution-contract or note-structure feature that helps agents produce compact notes useful to both humans and future resume agents.

Some workflows want notes to consistently capture current understanding, key findings, decisions, uncertainties, and next-step implications. This is related to assessment-driven routing, but it is a different product concern.

**Open question:** should note scaffolding live as a separate execution-contract feature, or share underlying primitives with assessment gates?

**Things to hash out:**
- What does "opt-in" mean here -- a workflow-level flag, a step-level annotation, or a per-session config? Who decides whether a given workflow gets note scaffolding?
- Note structure injects requirements into what the agent writes. Does this constrain the agent's ability to express nuanced or non-standard findings that don't fit the scaffold?
- Are scaffolded notes stored differently from unstructured notes, or is the structure a soft suggestion that gets serialized the same way?
- If the scaffold template changes between workflow versions, are older session notes still readable/comparable to newer ones?

---

### Agent-reportable workflow bugs (Apr 28, 2026)

**Status: idea** | Priority: high

**Score: 10** | Cor:2 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Agents encounter problems with WorkTrain itself during runs -- confusing step prompts, broken output contracts, workflow logic that doesn't match the actual task, MCP tool bugs, unclear instructions. Right now there's no structured way for an agent to surface these. They either silently work around the issue or get stuck.

A mechanism for agents to report problems with the WorkRail system itself during a session -- distinct from `report_issue` (which is for the task). These reports should be visible to the operator and feed into workflow improvement.

**Things to hash out:**
- How does an agent decide whether a problem is a workflow bug vs a task obstacle? The boundary is fuzzy -- a confusing step prompt might just be a hard task.
- Does surfacing this tool change agent behavior in undesirable ways? Agents might blame the workflow instead of solving the problem.
- Should reports survive session cleanup, or is their lifetime tied to the session?
- Who owns acting on these reports -- the operator, the workflow author, or an automated system?
- Should this be available in interactive (MCP) sessions, or daemon sessions only?

---

### Per-run workflow improvement retrospective (Apr 28, 2026)

**Status: idea** | Priority: high

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Every workflow run is an opportunity to learn. At the end of each session, the agent has unique insight into what worked, what was unclear, what slowed it down, and what a better version of the workflow would look like. This insight currently evaporates when the session ends.

At the end of each session, the agent should have an opportunity to reflect on the process itself -- what was confusing, what took longer than it should, what context was missing, what it would change about the workflow.

**Things to hash out:**
- Is agent reflection on its own process reliable? Agents may lack the self-awareness to accurately identify what went wrong, or may default to saying everything was fine.
- Does this add unacceptable cost or latency for short/fast workflows? Should it be conditional on certain outcomes (e.g. only after a stuck or timeout result)?
- How does retrospective data get used? Who reads it, and does it feed automatically into workflow improvement proposals or require human triage first?
- Risk of agents gaming it -- saying the workflow was perfect to appear compliant rather than critical.
- Should this be opt-in per workflow, universal, or triggered by specific signals during the run?

---

### Verification and proof as first-class citizens (Apr 15, 2026)

**Status: idea** | Priority: high

**Score: 10** | Cor:1 Cap:3 Eff:1 Lev:3 Con:2 | Blocked: yes (needs coordinator infrastructure)

**The problem:** today there's no single place that tells you "here's everything that was done to verify this feature is correct." Tests pass, a review ran, an audit happened -- but it's scattered across session notes, PR descriptions, CI logs, and half-remembered conversations. No verification chain.

**The vision:** every shipped change has a **proof record** -- a structured document that answers: what was built, how was it verified, by whom (which agents), and what was the verdict at each gate. Not a summary for humans -- a queryable record that the coordinator and watchdog can use to enforce quality gates.

A proof record contains: `prNumber`, `goal`, `verificationChain` (array of `{ kind, outcome, findings, sessionId, timestamp }`), `gates` (unit_tests, mr_review, production_audit, architecture_audit), `overallVerdict`, `mergedAt`.

**Verification gates the coordinator enforces:**
| Gate | Required for |
|------|-------------|
| Unit tests pass | All changes |
| MR review approved (no Critical/Major) | All changes |
| Architecture audit | `touchesArchitecture=true` or `riskLevel=High` |
| Production audit | `riskLevel=High` or affects prod paths |
| Security audit | touches auth/input/external |

**Visibility surfaces:** Console PR view (full verification chain, expandable to session notes); `worktrain verify <pr-number>` command; proof record section in every PR description ("Verification chain: 14 unit tests | MR review (0 findings) | Production audit | Architecture audit (skipped: riskLevel=Low)").

**Why this matters:** "Has this been reviewed and audited?" becomes a query against proof records rather than reading through PRs and session notes. The knowledge graph stores these records. The watchdog checks them on a schedule. The coordinator gates on them before merging. Verification becomes infrastructure, not process.

**Things to hash out:**
- Proof records are associated with PRs, but WorkTrain sessions may span multiple PRs, or a PR may be created by a human after WorkTrain's work. How is the PR-to-session mapping established?
- Who writes the proof record -- the coordinator script (after each gate completes), the delivery pipeline (at merge time), or both incrementally?
- What is the storage model for proof records -- append-only event log (like sessions), a separate file per PR, or entries in the knowledge graph? Each has different query characteristics.
- "The coordinator gates on them before merging" requires the coordinator to read the proof record at merge time. What happens when the proof record is incomplete (a gate ran but its result was not recorded)?
- How does this interact with PRs that are merged manually by humans, bypassing the coordinator's merge gate? The proof record would be incomplete but the merge already happened.

---

### Scripts-first coordinator: avoid the main agent wherever possible (Apr 15, 2026)

**Status: partial** | Foundation shipped PR #908 (Apr 30, 2026)

**Score: 12** | Cor:1 Cap:3 Eff:2 Lev:3 Con:3 | Blocked: no

**What shipped:** `ChildSessionResult` discriminated union, `getChildSessionResult()`, `spawnAndAwait()`, `parentSessionId` threading, `wr.coordinator_result` artifact schema. The typed coordinator primitives that enable in-process coordinator scripts are now available.

**What's still needed:** the actual coordinator scripts (full development pipeline, bug-fix coordinator, grooming coordinator) and the `worktrain spawn`/`await` CLI commands that wrap these primitives for shell scripts.

**The insight:** In a coordinator workflow, the main agent spends most of its time on mechanical work -- reading PR lists, checking CI status, deciding whether findings are blocking, sequencing merges. That's all deterministic logic. An LLM is expensive, slow, and inconsistent for deterministic work.

**The principle:** the scripts-over-agent rule applies at the coordinator level too. The coordinator's job is to drive a DAG of child sessions. The DAG structure, routing decisions, and termination conditions should be scripts, not LLM reasoning.

**What this means concretely:** a coordinator script that calls `gh pr list`, spawns MR review sessions, awaits them, parses findings JSON, routes (clean -> merge queue, minor -> spawn fix agent, blocking -> escalate), awaits fix agents, and executes merge sequence when queue is empty. The LLM is only invoked for leaf work -- the actual MR review, the actual coding fix.

**What WorkTrain provides:**
- `worktrain spawn --workflow <id> --goal <text>` -> prints sessionHandle
- `worktrain await --sessions <handle1,handle2>` -> prints structured results JSON
- `worktrain merge --pr <number>` -> runs the merge sequence

The coordinator "workflow" is then a shell script or TypeScript file. Fully deterministic, fully auditable, no tokens burned on routing decisions.

**Build order:** `worktrain spawn`/`worktrain await` CLI commands; structured output format for leaf sessions (handoff artifact JSON block already exists); a reference `coordinator-groom-prs.sh` as the first coordinator template; Console DAG view updated to show coordinator-script-spawned sessions with parent-child relationships.

**Things to hash out:**
- `worktrain spawn` prints a `sessionHandle`. What is the format of this handle -- a session ID, an opaque token, or a structured JSON blob? The answer affects whether it can be safely passed between processes.
- `worktrain await` blocks until sessions complete. What is the behavior when a session crashes mid-run -- does `await` eventually return with an error, or block indefinitely?
- The coordinator is a shell script or TypeScript file, not a workflow. How does the coordinator's own execution get tracked in the session store or event log? Is it visible in the console?
- If the coordinator script is invoked by a trigger, who is responsible for the coordinator's lifecycle -- the daemon, or the OS (via launchd/cron)?
- How does a coordinator script handle partial failures (2 of 5 child sessions failed)? Is the failure handling logic in the script, or does WorkTrain provide a structured retry primitive?

---

### Full development pipeline: coordinator scripts drive multi-phase autonomous work (Apr 15, 2026)

**Status: idea** | Priority: high

**Score: 10** | Cor:1 Cap:3 Eff:2 Lev:2 Con:2 | Blocked: yes (needs classify-task workflow + scripts-first coordinator)

The full pipeline DAG for feature implementation, driven by a coordinator script:

```
trigger: "implement feature X"
  -> [always] classify-task
       outputs: taskComplexity, riskLevel, hasUI, touchesArchitecture
  -> [if taskComplexity != Small] discovery
  -> [if hasUI] ux-design
  -> [if touchesArchitecture] architecture-design + arch-review (parallel)
  -> [always] coding-task (inputs: context bundle + design spec + arch decision)
  -> [always] mr-review
       -> [if clean] auto-commit -> auto-pr -> merge
       -> [if Minor/Nit] -> spawn fix agent -> re-review (max 3 passes)
       -> [if Critical/Major] -> escalate to human
  -> [if riskLevel == High] prod-risk-audit
  -> [if merged] notify
```

**The key insight:** the coordinator script reads `taskComplexity`, `riskLevel`, `hasUI`, and `touchesArchitecture` from the classify step's output and decides which phases to spawn. A one-line bug fix runs: classify -> coding-task -> mr-review. A new UI feature runs everything. Zero coordinator LLM calls.

**The missing workflow:** `classify-task-workflow` -- fast, 1-step, outputs taskComplexity/riskLevel/hasUI/touchesArchitecture. This is the single most important missing workflow -- without it, the coordinator has to spawn everything for every task, which is wasteful.

**Things to hash out:**
- The coordinator script is described as "scripts, not LLM" -- but the pipeline DAG itself requires reading and interpreting `classify-task-workflow` outputs. Who validates that the script correctly handles all classification outcomes?
- What is the fallback when `classify-task-workflow` fails or returns an inconclusive result? Does the pipeline abort, escalate, or default to the most conservative path?
- How are errors in the coordinator script itself handled? A bug in the script could skip phases silently or merge without required gates.
- Should the pipeline support human checkpoints between phases (e.g. "approve before coding starts"), or is it fully autonomous by design?
- Who owns the coordinator script -- the workflow author, the workspace operator, or WorkTrain itself? Different owners have different update cadences.

---

### Additional coordinator pipeline templates (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:3 Eff:2 Lev:1 Con:2 | Blocked: yes (needs scripts-first coordinator)

Beyond the feature implementation pipeline, three more coordinator templates are high value:

**Backlog grooming coordinator:**
```
trigger: "groom backlog" (cron: weekly, or manual dispatch)
  -> [for each open issue] classify-issue -> label-and-size
  -> [for stale issues > 90 days] auto-close-or-ping
  -> [for duplicate issues] detect-duplicates
  -> [for high-priority bugs with no assignee] spawn bug-investigation-agentic
  -> produce grooming summary -> post weekly digest to Slack
```

**Bug investigation + fix coordinator:**
```
trigger: new issue labeled "bug" OR incident alert
  -> bug-investigation-agentic
       outputs: root cause hypothesis, affected files, severity, confidence
  -> [if severity == Critical] page-oncall
  -> [if severity <= High and hypothesis_confidence >= 0.8] attempt-fix
       -> coding-task-workflow-agentic
       -> mr-review -> [if clean] auto-commit -> auto-pr
  -> close-or-update-issue
```

The daemon can go from "bug filed" to "fix merged" with zero human involvement for well-understood bugs with high-confidence hypotheses. The `hypothesis_confidence` output from the investigation gates the auto-fix attempt.

**Incident monitoring coordinator:**
```
trigger: monitoring alert (CPU spike, error rate, latency P99 > threshold)
  -> triage-alert (classify real incident vs noise)
  -> [if isRealIncident] investigate
  -> [if mitigation is config change] auto-mitigate (NEVER auto-rollback code without human approval)
  -> page-oncall with full context + session DAG link
```

The operator gets paged with a complete picture: what happened, likely why, what was already done automatically, and exactly what decision they need to make.

**Things to hash out:**
- The backlog grooming coordinator auto-closes stale issues. What prevents it from closing issues that are still relevant but have no recent activity by design (e.g. long-term architectural items)?
- The bug investigation + fix path is fully autonomous when `hypothesis_confidence >= 0.8`. How is that threshold validated? What is the cost of a false positive (fixing the wrong thing) at that confidence level?
- "NEVER auto-rollback code without human approval" is a correct hard rule, but "auto-mitigate (config change)" is still a significant action. Who defines what qualifies as a safe config change vs a risky one?
- The incident monitoring coordinator pages oncall. What is the integration path for paging -- PagerDuty, Slack, email? Is the paging mechanism configurable per workspace?
- How do these coordinator templates relate to the general-purpose scripts-first coordinator concept? Are they instances of the same pattern, or separate implementations?

---

### Interactive ideation: WorkTrain as a thinking partner with full project context (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 7** | Cor:1 Cap:1 Eff:1 Lev:2 Con:2 | Blocked: yes (needs knowledge graph + project memory)

The ability to have a conversation with WorkTrain with full awareness of what's been built, what's in flight, what's in the backlog, and what decisions were made and why. Unlike Claude Code, WorkTrain already has: the session store (every step note from every session), the knowledge graph, the backlog, and in-flight agent state.

**What it needs:**
1. **A `worktrain talk` command** -- opens an interactive session that starts with a synthesized context bundle: recent session outcomes, open PRs, backlog top items, any findings from in-flight agents.
2. **Project memory** -- WorkTrain maintains a synthesized "project state" updated after each major session batch. Answers questions like "what did we build today?", "why did we choose polling triggers over webhooks?", "what's the biggest gap right now?"
3. **Idea capture** -- when the conversation surfaces something new, WorkTrain offers to record it to the backlog or open a GitHub issue.
4. **Context awareness** -- WorkTrain knows which agents are running, what they've found so far, and can report on it during a conversation.

**Architecture:** a `talk` workflow -- a conversational loop workflow with no fixed step count. The agent has access to `query_knowledge_graph`, `read_session_notes`, `read_backlog`, `list_in_flight_agents`, and `append_to_backlog` as tools.

**Things to hash out:**
- A conversational loop with no fixed step count could run indefinitely. What terminates a `worktrain talk` session -- user command, inactivity timeout, or a max-turns cap?
- The `append_to_backlog` tool modifies `docs/ideas/backlog.md`, which is a protected file per AGENTS.md. Is this an intentional exception for the talk workflow, or should the tool write to a separate ideas buffer?
- What is the "project state" synthesis cadence? After every session batch, continuously, or on demand? Who triggers it?
- How does `worktrain talk` handle sensitive information -- session notes may contain API keys, error messages with credential paths, or other private data. Is the talk session sandboxed?
- Does this replace `worktrain status` as the primary status surface, or do they serve different audiences?

---

### Automatic gap and improvement detection: proactive WorkTrain (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:1 Lev:2 Con:2 | Blocked: yes (needs knowledge graph + scheduled tasks)

WorkTrain notices things without being asked. After a batch of work lands, it scans for gaps, inconsistencies, missed connections, and improvement opportunities -- and surfaces them proactively.

**Two modes:**
1. **Event-triggered scans** -- fires after significant events (batch of PRs merge, new workflow authored, new bug filed, coordinator run completes)
2. **Periodic health checks** -- runs on a schedule (weekly): are there backlog items with prerequisites met but not started? open issues actually already fixed by merged PRs? PRs approved but not merged for more than N days? stale knowledge graph?

**Architecture:** a `watchdog` workflow that runs on a cron trigger. Queries the knowledge graph, reads recent session notes, lists open PRs and issues, reads backlog priorities, produces a `gap-report.md` with actionable findings. Each finding is either: auto-actionable (spawn a fix agent), conversation-worthy (add to ideation queue), or escalation-worthy (post to Slack/file a GitHub issue).

**The key difference from the coordinator:** the coordinator executes a known plan. The watchdog discovers things that aren't in any plan yet.

**Things to hash out:**
- The watchdog decides which findings are "auto-actionable." What safeguards prevent it from autonomously spawning sessions for things that should require human judgment?
- How does the watchdog avoid creating duplicate work if the findings it surfaces are already tracked as open issues or active sessions?
- What is the frequency trade-off for event-triggered scans? Firing after every PR merge could spawn many watchdog sessions per day on an active repo.
- The gap report is currently described as a `.md` file. Should it instead be structured data (JSON/events) that the console or coordinator can process programmatically?
- Who clears or acknowledges watchdog findings? If nobody acts on them, do they accumulate silently?

---

### Native multi-agent orchestration: coordinator sessions + session DAG (Apr 15, 2026)

**Status: partial** | Typed primitives shipped PR #908 (Apr 30, 2026)

**Score: 10** | Cor:1 Cap:3 Eff:1 Lev:3 Con:2 | Blocked: no

Everything we can do manually today -- spawn parallel agents, chain discovery->implement->review->fix, react to findings, merge when clean -- WorkTrain should do natively, fully autonomously, with full observability.

**New primitives required:**

`spawn_session` tool (available inside workflow steps) -- starts a child session with a given workflowId + goal. Non-blocking -- returns a `sessionHandle` immediately.

`await_sessions` tool -- blocks until one or all of a set of session handles complete. Returns their results and output artifacts.

**Coordinator workflow pattern:**
```
Phase 1: Gather work items (open PRs, open issues, failing tests)
Phase 2: Spawn workers in parallel (one per work item)
Phase 3: Await all workers
Phase 4: Classify results -- clean/findings/blockers
Phase 5: Await fix agents, re-review if needed (circuit breaker: max 3 attempts)
Phase 6: Execute final action (merge sequence, create summary, post to Slack)
```

**No-user-feedback policy logic:**
- Critical/Major finding -> block merge, spawn fix agent, re-review (max 3 passes), escalate if still failing
- Minor finding -> spawn fix agent if auto-fixable, else log and proceed
- Nit -> log, proceed without fix
- Clean -> queue for merge
- Circuit breaker -> after 3 failed fix attempts, post to Slack/GitLab and pause

**Observability:** Console session tree (not flat list) showing coordinator and all children with parent-child relationships, status icons, and critical path.

**Build order:** `spawn_session` + `await_sessions` tools; parent-child session relationship in session store (`parentSessionId` field); Console DAG view for session tree; coordinator workflow templates.

**Things to hash out:**
- `spawn_session` inside a workflow step means the engine must support async child session lifecycle management. Does the engine orchestrate this, or is it the daemon's responsibility?
- If a child session fails, does the coordinator session receive the failure as a return value or as an exception? What is the Result type shape for `await_sessions`?
- How does the console DAG view handle a coordinator with 10+ parallel children? Is there a rendering strategy for large session trees?
- The circuit breaker (max 3 attempts) is described as a hard rule, but who configures it -- workflow author, coordinator script, or daemon policy?
- What is the relationship between `parentSessionId` in the session store and the `spawn_session` tool call? Is one derived from the other, or do they need to be kept in sync?

---

### Autonomous merge: WorkTrain approves and merges its own PRs after full vetting (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:3 Eff:2 Lev:2 Con:2 | Blocked: yes (needs proof records + verified CI integration)

After the full verification chain passes (unit tests, MR review clean, all required audits green), WorkTrain runs `gh pr review --approve && gh pr merge --squash` itself.

**The auto-merge policy (what makes it safe):**

Auto-merge allowed when ALL of:
- All required verification gates pass (defined by task classification)
- MR review: 0 Critical, 0 Major findings
- CI is green (all required checks pass)
- No `needs-human-review` label on the PR
- The PR was authored by a WorkTrain session (not a human)

Auto-merge blocked when ANY of:
- Any Critical or Major finding in any review/audit
- CI is failing
- Circuit breaker has fired (3+ fix attempts on same finding)
- `riskLevel=Critical`

Human always required for: schema changes, dependency upgrades (major version), infrastructure/CI/CD changes, changes to WorkTrain's own merge policy.

**The coordinator script merge gate:** checks the proof record before calling merge. The merge decision is deterministic. A human can always override by adding `needs-human-review`. Every auto-merge is appended to `~/.workrail/merge-log.jsonl`.

**Things to hash out:**
- WorkTrain approving its own PRs (`gh pr review --approve`) requires the authenticated user to have self-approval rights. This is explicitly denied in many enterprise Git setups. Is this a supported configuration, or is self-approval gated behind an explicit setting?
- The auto-merge policy excludes "changes to WorkTrain's own merge policy." How does this self-referential exception get enforced -- static analysis, file path check, or manual discipline?
- `merge-log.jsonl` is a critical audit record. What is its retention policy, and is it protected from accidental deletion?
- If the CI check suite includes flaky tests that are known to fail intermittently, the "CI is green" requirement could block merges indefinitely. Is there a policy for handling known-flaky tests?
- Should auto-merge be opt-in per workspace or per trigger, or is it always enabled when the policy conditions are met?

---

### Coordinator context injection standard: agents start informed, not discovering (Apr 18, 2026)

**Status: idea** | Priority: high

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Every coordinator-spawned agent gets a pre-packaged context bundle. The coordinator assembles it before calling `worktrain spawn`. The bundle includes:
1. **Prior session findings** -- what relevant sessions discovered (from session store query)
2. **Established patterns** -- the specific invariants and patterns the agent needs (from knowledge graph or AGENTS.md)
3. **What NOT to discover** -- explicit list of things already known so the agent doesn't waste turns
4. **Failure history** -- what's been tried and didn't work (prevents re-exploring dead ends)

~2000 tokens max, injected as a `<context>` block before the task description. Structured so the agent can skip Phase 0 context gathering entirely when the bundle is complete.

Without this: every agent spawned without proper context burns tokens on discovery that should have been provided upfront. At 10 concurrent agents, that's 10x the waste.

**Things to hash out:**
- Who assembles the context bundle -- the coordinator script, the daemon, or a dedicated context assembly service? Where does the assembly logic live?
- The 2000-token budget is a guess. What is the actual optimal size -- enough to be useful, small enough not to crowd out the step prompt?
- How does the context bundle stay fresh across a long coordinator run? Prior session findings from 2 hours ago may be stale if main advanced significantly.
- If the knowledge graph is not yet built for a workspace, what is the fallback for context assembly? Does the coordinator skip bundling entirely, or manually assemble from known sources?
- Should the `<context>` block format be standardized so all workflows know how to consume it, or is it opaque content the agent reads naturally?

---

### Session identity: a unit of work is one session, not many (Apr 18, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:2 Eff:2 Lev:2 Con:3 | Blocked: no

A task involving discovery + design + implementation + review + re-review appears as 5 unrelated sessions in the console. The correct model: a session is a unit of work, not a workflow run.

**What's needed:**
1. `parentSessionId` optional field on `session_created` events
2. Root session as the visible identity (children are implementation details)
3. Console session tree view -- root sessions expandable to show children
4. `worktrain spawn --parent-session <id>` flag

**Why this matters:** with this, the console shows "here are my 5 units of work today" -- each telling a coherent story. Without it, users see 50 flat sessions and have to read goals to understand grouping.

**Things to hash out:**
- The "unit of work" concept is useful for coordinator-spawned sessions, but what about ad-hoc sessions started via CLI or MCP? Do those also have a unit-of-work identity, or is that concept only for coordinator-managed work?
- If a child session is retried after failure (new session ID, same `parentSessionId`), should both the failed and retried sessions appear in the tree, or only the successful one?
- How deep can the session tree go? A coordinator spawning workers that each spawn subagents could produce a 3+ level tree. Is there a depth limit?
- What happens when the root session is deleted or cleaned up but child sessions remain? Is the tree orphaned, or do children get promoted?

---

### Trigger-derived tool availability and knowledge configuration (Apr 18, 2026)

**Status: idea** | Priority: medium -- design-first

**Score: 6** | Cor:1 Cap:1 Eff:2 Lev:1 Con:1 | Blocked: no

The trigger already declares what external system matters. A `gitlab_poll` trigger means the agent will be working on GitLab content. WorkTrain should use this declaration to automatically configure what tools and knowledge sources the agent gets.

**Idea 1 -- implicit tool availability from trigger source:** if `provider: gitlab_poll` -> agent automatically gets GitLab MCP tools. If `provider: jira_poll` -> agent gets Jira tools. The trigger source is a declaration of intent.

**Idea 2 -- trigger as knowledge configuration:**
```yaml
- id: jira-bug-fix
  provider: jira_poll
  knowledge:
    general:   [glean, confluence]
    codebase:  [github, local-kg]
    task:      [jira-ticket, related-prs]
    style:     [team-conventions, agents-md]
```

The daemon assembles a pre-packaged context bundle from these sources before the agent starts. The agent skips Phase 0 discovery entirely for the declared knowledge domains.

**Needs a design-first discovery pass** before implementation.

**Things to hash out:**
- If the trigger source implicitly provides tool availability, what happens when a `gitlab_poll` trigger dispatches a task that turns out to need GitHub tools (e.g. cross-repo work)?
- How does the knowledge configuration in the trigger interact with the workspace's AGENTS.md? If both declare knowledge sources, which takes precedence?
- "Implicit tool availability from trigger source" means the daemon configures the agent's toolset based on the trigger. This is a significant change to how tools are injected. What is the migration path for existing triggers?
- Does this add a new surface for configuration mistakes -- e.g. a trigger that misconfigures knowledge sources causing the agent to miss critical context silently?

---

### Rethinking the subagent loop from first principles (Apr 18, 2026)

**Status: idea** | Priority: medium -- design-first

**Score: 8** | Cor:1 Cap:2 Eff:1 Lev:3 Con:1 | Blocked: no

Step back from all assumptions. The current design assumes the LLM decides when to spawn, what to give subagents, and handles results -- inherited from Claude Code's `mcp__nested-subagent__Task`. That's not the only model, and it might not be the best one for WorkTrain.

**Problems with LLM-as-orchestrator:** LLMs are bad at orchestration decisions; context passing is lossy; subagent output competes with everything in the parent's context window; no enforcement -- the LLM can skip delegation entirely and just do the work itself.

**Alternative: workflow-declared parallelism, daemon-enforced:**
```yaml
- id: parallel-review
  type: parallel
  agents:
    - workflow: routine-correctness-review
      contextFrom: [phase-3-output, candidateFiles]
    - workflow: routine-philosophy-alignment
      contextFrom: [phase-0-output, philosophySources]
  synthesisStep: synthesize-parallel-review
```

The daemon sees this step definition, automatically spawns child sessions with specified workflows, injects declared context bundles, waits for all to complete, passes results to a synthesis step. The parent LLM never decides to spawn anything. The workflow declares the orchestration pattern. The daemon enforces it.

**The shift:** from "agent as orchestrator" to "workflow as orchestrator, daemon as executor, agent as cognitive unit."

**Needs a discovery session to explore the design space** before any implementation.

**Things to hash out:**
- "Workflow-declared parallelism, daemon-enforced" requires the workflow schema to express parallelism declaratively. What does that schema look like, and is it backward compatible with existing workflows?
- In the proposed `parallel` step type, what happens if one child session fails while others are still running? Is it abort-all, continue-remaining, or configurable?
- The parent LLM never decides to spawn in this model. But what if the workflow author wants the LLM to decide dynamically whether parallelism is warranted? Is that expressible in a declarative schema?
- The "daemon as executor" model assumes a single daemon with visibility into all child sessions. How does this work in a distributed setup (multiple daemon instances, cloud-hosted)?
- How does this proposal relate to the existing `spawn_agent` tool, which does allow the LLM to decide when to spawn? Are both models supported simultaneously, or does this replace `spawn_agent`?

---

### Workflow runtime adapter: one spec, two runtimes (Apr 18, 2026)

**Status: idea** | Priority: low -- depends on subagent loop rethinking

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:2 Con:1 | Blocked: yes (needs subagent loop rethinking)

The workflow JSON is the canonical spec for what work needs to happen. A single adapter layer translates the canonical spec to runtime-specific execution plans.

**Two runtimes, one spec:**
- MCP adapter (human-in-the-loop): preserves `requireConfirmation` gates, presents `continue_workflow` tool call interface, LLM drives subagent spawning manually, maintains backward compat
- Daemon adapter (fully autonomous): removes `requireConfirmation` gates, replaces `continue_workflow` with `complete_step`, converts workflow-declared parallelism into automatic child session spawning

**Why this matters:** workflow improvements automatically benefit both runtimes. No dual maintenance, no parallel workflow files.

**Also eliminates "autonomous workflow variants":** the canonical workflow spec is the only version -- the daemon adapter handles what "autonomy: full" means in practice.

**Dependencies:** requires the subagent loop rethinking to be resolved first.

**Things to hash out:**
- The MCP adapter preserves `requireConfirmation` gates. The daemon adapter removes them. If a workflow is tested in one runtime context, how does the author verify it behaves correctly in the other?
- "Replaces `continue_workflow` with `complete_step`" implies a semantic difference between the two runtimes. Are there workflow patterns where this substitution changes behavior in ways the author must account for?
- Eliminating autonomous workflow variants simplifies the library, but authors currently write daemon variants for a reason. What are the cases where the adapter approach cannot replace a dedicated variant?
- Who owns the adapter implementations -- the WorkRail engine team, or workflow authors? If an adapter has a bug, every workflow using that runtime is affected.

---

### General-purpose workflow / intelligent dispatcher

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Two related ideas:

**`wr.quick-task`** -- the simplest possible workflow. 2 steps: do the work, call complete_step. No complexity routing, no design review, no phased implementation. For tasks under ~10 minutes. Currently small tasks go through `wr.coding-task`'s Small fast-path which is still heavier than needed.

**`wr.dispatch`** -- an intelligent routing workflow. Given a goal, classify it and route to the right workflow: `wr.quick-task` | `wr.research` | `wr.coding-task` | `wr.mr-review` | `wr.competitive-analysis`. The general-purpose entry point -- not a workflow that does everything, but one that decides which workflow to use. The adaptive pipeline coordinator already does this for the queue-poll trigger; the question is whether to expose it as a named user-facing workflow.

Open questions: does `wr.dispatch` replace `workflowId` in trigger config, or coexist alongside it? How does it handle tasks that don't fit any known workflow?

**Things to hash out:**
- How does `wr.dispatch` classify incoming goals accurately enough to route correctly? Classification errors could silently run the wrong workflow on real tasks.
- If `wr.dispatch` is the entry point for all triggers, a classification failure blocks all work. Is there a safe fallback workflow for unclassified tasks?
- Should `wr.dispatch` be visible to users as a selectable workflow in `list_workflows`, or is it infrastructure that only the coordinator and trigger config use?
- `wr.quick-task` deliberately skips review and design gates. Who is responsible for ensuring it is only used for tasks where skipping those gates is safe?
- How does `wr.dispatch` handle tasks that could fit multiple workflows (e.g. "investigate and fix this bug" spans `wr.bug-investigation` and `wr.coding-task`)?

---

### MR review session count inflation

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

A single PR review dispatches 6-12 autonomous sessions (one per reviewer family: correctness_invariants, runtime_production_risk, missed_issue_hunter, etc.). This inflates session counts, complicates cost attribution, and makes ROI calculations imprecise. Worth investigating: are all 6 families catching distinct issues, or is there significant overlap? Should families be parallelized into a single session with sub-agents rather than separate top-level sessions?

**Things to hash out:**
- Is the session count problem a UX/display problem (fixable by grouping under a parent session) or an actual cost and resource problem that requires consolidation?
- If families are merged into a single session, does the LLM context window reliably hold all review dimensions simultaneously without degrading quality on any single dimension?
- What data exists to measure overlap between reviewer families? Before consolidating, verify with empirical data which families have the most redundant findings.
- If families run as sub-agents in a single session, what is the failure mode when one sub-agent's findings are poor? Does it contaminate the overall review verdict?

---

### Session trigger source attribution (daemon vs MCP)

**Status: done** | Shipped PR #899 (Apr 30, 2026)

`triggerSource: 'daemon' | 'mcp'` added to `run_started` event data. Three-layer design: optional in Zod schema (old sessions still validate), required in `ConsoleSessionSummary` and `ConsoleSessionDetail` projections (old sessions backfilled via `isAutonomous`), `'daemon'` or `'mcp'` wired at every `executeStartWorkflow` callsite.

---

### Standup status generator

**Status: idea** | Priority: low

**Score: 8** | Cor:1 Cap:1 Eff:2 Lev:1 Con:3 | Blocked: no

A workflow that aggregates activity across git history, GitLab/GitHub MRs and reviews, and Jira ticket transitions since the last standup. Outputs a categorized ("what I did / doing today / blockers") human-readable message. Tool-agnostic: detect available integrations and adapt.

**Things to hash out:**
- "Since the last standup" requires knowing when the last standup was. How is that derived -- calendar, fixed schedule, explicit command?
- How should the workflow handle weeks where WorkTrain did mostly mechanical work (tests, chores) vs substantive features? Should it summarize at the commit level or the intent level?
- For team standup contexts, should this expose WorkTrain's work as the developer's own work, or explicitly attribute it to WorkTrain? This depends on the team's norms.
- Is the output format fixed (what I did / doing / blockers) or customizable per team format?

---

### Workflow effectiveness assessment and self-improvement proposals

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:2 Eff:2 Lev:2 Con:3 | Blocked: no

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

**Things to hash out:**
- How is a workflow improvement proposal validated before auto-application? A regression in a bundled workflow affects all users. Is test passage sufficient, or does it require human review?
- "High-confidence, low-risk proposals auto-applied" -- what defines low-risk? Prompt text changes are hard to classify by risk level automatically.
- Who owns the community PR process for workflow improvements? Auto-opened PRs against a community repo need a reviewer.
- If the same workflow is run with different models (Haiku vs Sonnet), the metrics will differ significantly. Are model-specific stats tracked separately or averaged?
- How does this prevent a positive feedback loop where the assessment workflow optimizes for metrics (fewer turns, faster completion) at the expense of quality?

---

## Platform Vision (longer-term)

### Lightweight agents for repeat tasks that don't need a full workflow (Apr 30, 2026)

**Status: idea** | Priority: high

**Score: 12** | Cor:1 Cap:3 Eff:2 Lev:3 Con:2 | Blocked: no

Not every task warrants a full WorkRail workflow. A full `wr.coding-task` session has discovery, shaping, multiple implementation phases, review, and verification. But many useful tasks are lighter: answer a question about the codebase, generate a standup summary, explain a recent change, do a quick impact analysis before a real task starts, check whether a PR is safe to merge, scan for stale TODOs, summarize what changed this week.

These tasks share a shape: they need a capable agent with full workspace context, but they don't need a structured multi-step workflow with output contracts and phase gating. Running a full workflow for them is wasteful and slow. Not supporting them at all means the operator has to do these things manually or context-switch to Claude Code.

**The idea:** a library of **lightweight agents** -- short-lived, purpose-built, invokable by name -- that handle repeat operational tasks without spinning up a full session. Similar in concept to Claude Code skills or shell aliases, but with workspace awareness and structured outputs.

Examples:
- `worktrain ask "why does the session store use a manifest file?"` -- answers a codebase question using the knowledge graph
- `worktrain explain pr/908` -- summarizes what a PR changed and why, in plain language
- `worktrain check-stale` -- lists sessions older than N hours that haven't advanced
- `worktrain diff-since "last week"` -- summarizes what shipped and what changed
- `worktrain impact src/trigger/coordinator-deps.ts` -- lists what would break if this file changed

**Key design tension:** these agents need workspace context (codebase understanding, session history) but shouldn't be expensive or slow. The knowledge graph is the enabler -- a well-indexed workspace means an agent can answer "what calls this function?" in seconds rather than spending 10 minutes reading files.

**Relationship to existing ideas:**
- `worktrain talk` (interactive ideation) is a heavyweight version of this -- a full conversational session. Lightweight agents are the stateless, single-purpose complement.
- Standup status generator is one specific instance of this pattern.
- Periodic analysis agents (weekly code health scan, etc.) are the scheduled variant.

**Things to hash out:**
- What is the invocation surface? CLI commands? Webhook triggers? Console buttons? All three?
- How does a lightweight agent get workspace context efficiently without running full discovery? This depends on the knowledge graph being built and indexed.
- Should lightweight agents be user-extensible (operator writes their own) or only built-in? If extensible, what is the authoring format -- a workflow JSON, a TypeScript function, a prompt template?
- What is the output contract? Some agents produce structured data (JSON), some produce prose. How does the caller know which to expect?
- Where does the boundary between a lightweight agent and a short `wr.coding-task` session lie? A task that seems quick might reveal complexity mid-run. How does a lightweight agent escalate to a full workflow when needed?

---

### Self-restart after shipping changes to itself (Apr 30, 2026)

**Status: idea** | Priority: medium

**Score: 11** | Cor:2 Cap:3 Eff:2 Lev:2 Con:2 | Blocked: yes (needs self-improvement loop operational)

If WorkTrain can build and ship changes to itself autonomously, the natural next step is that it also restarts itself with those changes. Today, after a WorkTrain daemon session ships a change to the workrail repo, the daemon continues running the old binary. The operator has to manually run `worktrain daemon --stop && worktrain daemon --start` to pick up the new version. In a self-improving system running overnight, this is a human intervention point that should not exist.

**What this requires:**
1. After a session that modifies WorkTrain itself merges to main, the daemon detects it was running on this repo
2. The daemon rebuilds (`npm run build`) and restarts itself cleanly -- completing any in-flight sessions first, then performing a graceful restart with the new binary
3. After restart, the daemon logs what changed so the operator can review

This is related to the "daemon binary stale after rebuild" P0 gap, but goes further: not just warning about staleness, but actually handling the upgrade cycle automatically.

**Why this matters for the self-improvement loop:** if WorkTrain ships 5 improvements to itself in a day but the operator has to manually restart it 5 times, the loop isn't truly autonomous. Full autonomy requires the restart to be part of the pipeline.

**Things to hash out:**
- What triggers the restart check? After every merge to main that touches `src/`? After a successful `npm run build`? On a heartbeat that detects binary staleness?
- How does the daemon ensure in-flight sessions complete before restarting? Does it drain the active session set or hard-stop?
- What is the rollback path if the new binary fails to start (startup crash, broken build)? The daemon needs to detect this and either roll back or alert the operator.
- Should the restart happen immediately or at a configurable "quiet period" (e.g. 2am) to avoid disrupting active sessions during the day?
- Self-modification is inherently risky -- a buggy change to the daemon's restart logic could make the daemon unable to restart at all. What safeguards prevent this?

---

### WorkTrain as a first-class project participant: ideal backlog and planning capabilities (Apr 30, 2026)

**Status: idea** | Priority: high (long-term)

**Score: 9** | Cor:1 Cap:3 Eff:1 Lev:3 Con:1 | Blocked: yes (needs knowledge graph + project memory layer)

Right now WorkTrain manages its backlog like a human with a text editor -- it reads a file, reasons about it, writes changes. Every session re-derives context it already derived before. There is no persistent structured understanding of the project that survives across sessions. The ideal is fundamentally different: the backlog is not a document WorkTrain edits, it is a live model of the project WorkTrain both reads and updates as a first-class participant.

The capabilities that make up the ideal:

**1. Persistent project memory**
WorkTrain accumulates understanding of the project over time -- what was tried, why things were decided, what the current trajectory is -- in a form that persists and updates incrementally across sessions. Not session notes (those already exist), but a synthesized model: "where is this project right now and where is it going?" Updated automatically as work happens, not reconstructed from scratch each time.

**2. Native structured backlog operations**
First-class tools -- `get_backlog_item(id)`, `update_score(id, scores)`, `add_item(...)`, `query_items(filter)`, `get_dependents(id)` -- rather than reading a markdown file and parsing it. The backlog is data. WorkTrain should treat it as data, not text.

**3. Dependency graph with automatic inference**
Not just manually declared `blocked_by` links, but WorkTrain inferring relationships from reading items and the codebase -- "implementing X will require Y to exist first" -- and recording those inferences persistently. The graph updates as work completes and dependencies resolve.

**4. Context-aware scoring**
Scores that understand the current moment -- what's in flight, what just shipped, what the operator is focused on -- so priority shifts as the project evolves without manual re-scoring. The rubric is not applied in isolation; it's applied against the current project state.

**5. Proactive surfacing**
WorkTrain doesn't wait to be asked "what should I work on?" It knows when a high-score unblocked item has been sitting idle too long, when a blocker just resolved making a previously-blocked item executable, or when work it just completed changes the relative priority of other items. It surfaces these unprompted.

**6. Honest self-assessment**
WorkTrain tracks its own execution history -- which item categories it completed cleanly vs got stuck on, where it overestimated confidence, which workflows it handles reliably vs which it doesn't. This history feeds back into scoring: a Correctness 3 item in a category WorkTrain consistently struggles with should score differently than one it handles well.

**7. Backlog and execution as one system**
When WorkTrain picks up an item, it is simultaneously dequeued from the backlog, tracked as in-flight, and -- on completion -- automatically marked done, dependent item scores updated, and newly-executable items surfaced. The backlog and the work queue are not separate systems maintained separately.

**Things to hash out:**
- What is the persistent project memory stored as -- a structured document, a database, a knowledge graph node, or a combination? The answer determines how it's queried and updated.
- Automatic dependency inference requires reading both items and code. How does WorkTrain know when its inference is reliable vs speculative? Incorrect inferences that block work are worse than no inference at all.
- Context-aware scoring means scores are not stable -- the same item can have a different score on different days. How does the operator reason about priority if scores shift? Is there a "score as of today" vs "canonical score" distinction?
- Self-assessment requires WorkTrain to have a model of its own capabilities and failure modes. This is subtle -- how does it distinguish "I got stuck because the task was hard" from "I got stuck because I handle this category poorly"?
- Proactive surfacing risks becoming noise if WorkTrain surfaces too many things or surfaces them at the wrong moment. What is the right cadence and channel for unprompted priority signals?
- The backlog-as-data model requires a defined schema. What happens to items that don't fit the schema cleanly -- highly exploratory ideas, resolved debates, historical context that matters but isn't actionable?

---

### Inspiration: openclaw (Apr 29, 2026)

**Source:** https://github.com/openclaw/openclaw

openclaw is worth studying deeply before building out the platform layer. Draw inspiration from it when designing: multi-agent orchestration patterns, coordinator architecture, context packaging for subagents, task queue and dispatch models, and the overall shape of an autonomous engineering platform. Review it before making architectural decisions on any of the Platform Vision items below.

---

### Knowledge graph for agent context

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:3 Eff:1 Lev:3 Con:2 | Blocked: no

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

**Things to hash out:**
- How large does a typical workspace KG get? For a medium-sized TypeScript monorepo, what are the expected node and edge counts for the structural layer?
- The incremental update strategy (re-index only `filesChanged`) requires accurate change tracking. What is the fallback when `filesChanged` is unavailable (e.g. for manually triggered sessions)?
- The embedding model (Ollama or `@xenova/transformers`) needs to be running locally. What is the setup story for a new workspace -- is it expected to already have an embedding model, or does WorkTrain set one up?
- DuckDB is in-process -- what is the concurrency story when multiple daemon sessions try to query or update it simultaneously?
- Is the KG per-workspace or global? If per-workspace, cross-workspace queries (multi-project WorkTrain) require a federation layer.

---

### Dynamic pipeline composition

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:3 Eff:1 Lev:2 Con:2 | Blocked: yes (needs classify-task workflow)

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

**Things to hash out:**
- How does the coordinator determine task maturity? Is this a classification workflow output, a field on the issue/ticket, or derived from artifact presence?
- When maturity is `idea`, the pipeline runs ideation + market research. These could take hours. Does the coordinator hold the queue slot during all upstream phases, or release and re-acquire?
- How are the new workflows (`ideation-workflow`, `spec-authoring-workflow`, etc.) different from `wr.discovery` and `wr.shaping`? Are these new workflows, or just renamed compositions?
- How does the pipeline composition interact with `workOnAll: true`? For a raw idea, the pipeline could autonomously run all the way to code without any human input -- is that the intended behavior?

---

### Per-workspace work queue

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

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

**Things to hash out:**
- How does the per-workspace internal queue (`queue.jsonl`) interact with the existing `github_queue_poll` and `gitlab_poll` triggers? Are they additive sources into the same queue, or separate systems?
- Who controls priority assignment for queue items? Is it explicit (operator assigns priority) or inferred (WorkTrain computes it)?
- What happens when the queue is empty and capacity is available -- does WorkTrain go idle or proactively seek work?
- Should the queue be inspectable and editable by the operator via CLI, or is it a fully opaque internal mechanism?
- How does per-workspace queue isolation interact with global concurrency limits? A workspace with a large queue could starve other workspaces.

---

### Remote references (URLs, GDocs, Confluence)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

**Design:** Extend the workflow `references` system to support remote sources (HTTP URLs, Google Docs, Confluence pages). WorkRail remains a pointer system -- it validates declarations are well-formed, delivers the pointer, and the agent fetches with its own tools. Auth is entirely delegated to the agent.

**Incremental path:**
- Phase 1: public HTTP URLs. `resolveFrom: "url"`. WorkRail delivers the URL; agent fetches. No auth surface in WorkRail.
- Phase 2: workspace-configured bearer tokens in `.workrail/config.json` keyed by domain
- Phase 3: named integrations (GDocs, Confluence, Notion) as first-class configured sources

**Design questions:**
- Should WorkRail attempt a reachability check at start time, or skip entirely for remote refs?
- How should remote refs appear in `workflowHash`? Content can change between runs.
- `kind` field (`local` vs `remote`) or infer from `source` value?

**Things to hash out:**
- Phase 2 (workspace-configured bearer tokens) puts credentials in `.workrail/config.json`. If this file is in the repo, tokens are at risk of being committed. What is the recommended credential storage model?
- The Phase 1 design (agent fetches the URL itself) means the agent has access to any URL declared in a workflow. Is there any validation or allowlist for what remote sources a workflow can reference?
- Remote document content changes between runs. Should WorkRail snapshot the content at session start for reproducibility, or always use live content?
- When a remote ref is unavailable (network error, auth failure), should the session fail, warn and continue, or fall back to a cached version?

---

### Declarative composition engine

**Status: idea** | Priority: low

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

**Summary:** Users or agents fill out a declarative spec (dimensions, scope, rigor level) and the WorkRail engine assembles a workflow automatically from a library of pre-validated routines. The agent is a form-filler, not an architect -- the composition logic lives in the engine.

**Why different from agent-generated workflows:** Engine-composed workflows are assembled from pre-reviewed building blocks using deterministic rules. Same spec always produces the same workflow shape.

**Good early use cases:** Audit-style workflows (user picks dimensions, engine assembles auditor steps), review workflows, investigation workflows.

**Things to hash out:**
- Who defines the "library of pre-validated routines"? How does a routine get accepted into the composition library vs remaining a workflow-specific step?
- How does the spec input interface work -- is it a YAML/JSON document, a CLI prompt sequence, or a tool call? Who calls it?
- "Same spec always produces the same workflow shape" is a strong determinism guarantee. How is this enforced when routines are updated? Does a spec locked to routine v1.2 still produce the same shape after routine v1.3 ships?
- Should the resulting workflow be persisted (so the user can inspect and modify it), or is it ephemeral (assembled fresh each run)?
- How does error handling work when the spec declares a combination of dimensions that no valid routine composition can satisfy?

---

### Workflow categories and category-first discovery

**Status: idea** | Priority: low

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

**Summary:** Improve workflow discovery by organizing bundled workflows into categories. Currently the catalog is large enough that flat discovery is becoming noisy.

**Phase 1 shape:** If no category is passed, return category names + workflow count per category + a few representative titles. If a category is passed, return the full workflows for that category.

**Design questions:**
- Should categories live in workflow JSON, in a registry overlay, or be inferred from directory/naming?
- Should `list_workflows` become polymorphic, or should category discovery be a separate mode?

**Things to hash out:**
- How does category assignment work for user-imported workflows? Can users assign categories, or is it only for bundled workflows?
- If a workflow fits multiple categories (e.g. a workflow that is both a "review" and an "audit"), can it appear in multiple categories, or does it have a single primary?
- Does category-first discovery change what gets returned in the existing `list_workflows` schema? Is this a backward-compatible extension or a new tool?
- Who maintains the category taxonomy as the library grows? What prevents categories from proliferating to the point they become as noisy as the flat list?

---

### Forever backward compatibility (workrailVersion)

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:2 Eff:2 Lev:2 Con:3 | Blocked: no

Every workflow declares `workrailVersion: "1.4.0"`. The engine maintains compatibility adapters for all previous declared versions -- old workflows run forever without author intervention. The engine adapts; authors never migrate.

**The web model:** this is how browsers handle HTML from 1995. A `<marquee>` tag still renders because the browser adapts, not because the author rewrote their page.

**Engineering implication:** permanent commitment. Once a version adapter is shipped, it cannot be removed. The tradeoff is real but the alternative (expecting external authors to track WorkRail releases and migrate) breaks the platform trust model.

**Phase 1:** Add `workrailVersion` field to schema. Default to `"1.0.0"` for existing workflows. Record in run events.
**Phase 2:** Introduce the first adapter when the first schema-breaking change is needed.
**Phase 3:** Build a compatibility test harness in CI.

**Related:** `src/v2/read-only/v1-to-v2-shim.ts` (existing precedent for version adaptation).

**Things to hash out:**
- "Once a version adapter is shipped, it cannot be removed" is a hard commitment. What is the governance process for accepting this commitment for a given version? Who signs off?
- How does `workrailVersion` interact with `schemaVersion` (the versioned schema validation idea elsewhere in this backlog)? Are these the same concept, or do they track different axes?
- If a workflow omits `workrailVersion` (the default-1.0.0 case), can WorkRail ever remove the v1.0.0 adapter? The default-to-1.0.0 mechanism means the adapter must be permanent.
- The compatibility test harness in CI must test all adapters on every release. For N historical versions, this is O(N) adapter tests. At what point does this become a maintenance burden?

---

### Parallel forEach execution

**Status: idea** | Priority: low

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

Sequential `forEach` (and `for`, `while`, `until`) all work -- implemented in the v1 interpreter and the v2 durable core. The idea here is parallel execution: run all iterations concurrently rather than sequentially. Requires design around: session store concurrent writes, token protocol isolation per iteration, and console DAG rendering for parallel branches.

**Things to hash out:**
- Token protocol isolation per iteration is not trivial. Each parallel branch needs its own HMAC token chain. How does the engine mint and track N independent token chains for a single forEach step?
- What is the semantics of a failure in one parallel iteration -- abort all, continue others, or configurable?
- How are the outputs of N parallel iterations combined for the next sequential step? Is there a built-in aggregation, or is the workflow author responsible for merging?
- How does the console DAG render parallel forEach branches without becoming unreadable for large arrays (e.g. 20 items in a forEach)?
- What is the concurrency limit for parallel forEach -- is it bounded by `maxConcurrentSessions`, or is there a per-step parallelism limit?

---

### Assessment-gate tiers beyond v1

**Status: idea** | Priority: low

**Score: 7** | Cor:1 Cap:1 Eff:2 Lev:1 Con:2 | Blocked: no

**Tier 1 (current):** Same-step follow-up retry. Consequence keeps the same step pending; engine returns semantic follow-up guidance.

**Tier 2 (future):** Structured redo recipe on the same step. Engine surfaces a bounded checklist. No new DAG nodes or true subflow.

**Tier 3 (future):** Assessment-triggered redo subflow. Matched consequence routes into an explicit sequence of follow-up steps. Introduces assessment-driven control-flow behavior.

**Design questions:** When does Tier 2 become necessary? What durable model would Tier 3 need for entering, progressing through, and returning from a redo subflow?

**Things to hash out:**
- Tier 3 (redo subflow) requires the engine to create new DAG nodes dynamically at runtime. What are the constraints on which steps can be the target of an assessment-triggered redo?
- How does Tier 2's "bounded checklist" differ from an existing assessment consequence in Tier 1? Is this a new execution contract, or just a richer prompt injection?
- When does Tier 2 become necessary? Before building it, is there evidence from real workflow runs that Tier 1 is insufficient for specific use cases?
- Tier 3 significantly increases engine complexity. How does it interact with existing features like `jumpIf`, `runCondition`, and loops?

---

### Workflow rewind / re-scope support

**Status: idea** | Priority: low

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

Allow an in-progress session to go back to an earlier point when new information changes scope, invalidates assumptions, or reveals the current path is wrong.

**Phase 1:** Allow rewind to a prior checkpoint with an explicit reason. Record a "why we rewound" note in session history.

**Phase 2:** Scope-change prompts ("our understanding changed", "the task is broader/narrower"). Let workflows declare safe rewind points explicitly.

**Design questions:**
- Should rewind be limited to explicit checkpoints, or support arbitrary node-level rewind?
- How should the system preserve notes from abandoned paths?
- Should some steps be marked non-rewindable once external side effects have happened?

**Things to hash out:**
- Who can initiate a rewind -- the agent, a human operator, or the coordinator? Are there different constraints for each initiator?
- If a rewind discards steps that made external side effects (e.g. a git push, a PR comment), the side effects remain but the session state rolls back. How is this inconsistency surfaced?
- What is the maximum rewind distance? Allowing arbitrary node-level rewind on a 30-step workflow could create very confusing session histories.
- How does rewind interact with the HMAC token protocol? Tokens are forward-only by design -- can a rewound session re-issue tokens for already-advanced steps?

---

### Subagent composition chains

**Status: idea** | Priority: low

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Native support for nested subagents -- an agent spawning a subagent, which spawns its own -- up to a configurable depth limit.

```yaml
agentDefaults:
  maxSubagentDepth: 3
  maxTotalAgentsPerTask: 10
```

**Depth semantics:** Coordinator=0, worker=1, subagent=2, sub-subagent=3.

`maxTotalAgentsPerTask` prevents exponential explosion: depth-3 tree with 3 agents per node = 27 concurrent agents without this cap.

**Things to hash out:**
- How does the depth counter propagate through `spawn_session` calls? Is it tracked in the session event log, or in-memory in the daemon?
- If a sub-subagent is killed (timeout, crash), does it count against the depth and total counts of its parent session? How are orphaned depth slots reclaimed?
- `maxTotalAgentsPerTask` requires a shared counter across all agents in a chain. What is the concurrency-safe mechanism for this counter -- is it in the session store, a daemon in-memory structure, or something else?
- Should composition chains be opt-in per workflow/trigger, or available to any workflow by default?

---

### Mobile monitoring and remote access

**Status: idea** | Priority: low (post-daemon-MVP)

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

**Goal:** Control and monitor autonomous WorkRail sessions from a phone.

**What's needed:**
1. Mobile-responsive console with touch-friendly layout and tap to pause/resume/cancel
2. Push notifications (via Slack/Telegram webhook -- no native app required for MVP)
3. Human-in-the-loop approval on mobile -- maps to `POST /api/v2/sessions/:id/resume`
4. Session log view -- linear timeline, not DAG

**Things to hash out:**
- Remote access requires the console to be reachable from outside the local network. What is the default security model -- is unauthenticated remote access acceptable for a tool managing autonomous code changes?
- Push notifications via webhook require a persistent endpoint (Slack/Telegram bot). Who sets this up -- WorkTrain automates it, or the operator configures it manually?
- "Tap to pause/resume/cancel" is write access from a mobile client. What authentication and authorization model protects these actions from unauthorized access?
- Should mobile monitoring be opt-in or default-on? Users who haven't configured remote access should not inadvertently expose their console.

**Remote access options:**
1. `workrail tunnel` command (Cloudflare Tunnel from the laptop) -- works behind any NAT/VPN
2. Tailscale integration -- zero WorkRail code needed
3. Cloud session sync -- daemon pushes events to S3/R2

**Priority:** Post-daemon-MVP. Design the REST control plane with mobile in mind from the start.

---

### WorkRail Auto: cloud-hosted autonomous platform

**Status: idea** | Priority: long-term

**Score: 9** | Cor:1 Cap:3 Eff:1 Lev:2 Con:2 | Blocked: yes (needs proven local daemon)

**Goal:** WorkRail Auto runs on a server 24/7, connected to your engineering ecosystem, working autonomously without a laptop open.

**What this enables:** GitLab MR opened -> WorkRail reviews, posts comment. Jira ticket moves to In Progress -> WorkRail starts coding task, pushes branch. PagerDuty fires -> WorkRail runs investigation, posts findings to Slack.

**Architecture implications:**
- Multi-tenancy: isolated session stores, isolated credential vaults per org
- Horizontal scaling: multiple daemon instances consuming from a shared trigger queue
- Rate limiting per org, per integration

**Relationship to self-hosted:** Self-hosted is always free, always open source, always works offline. WorkRail Auto is the natural SaaS layer -- same engine, same workflows, managed infrastructure.

**Priority:** Long-term. Design the local daemon with multi-tenancy seams in mind from the start (don't hardcode single-user assumptions). Don't build the hosted layer until the local daemon is proven.

**Things to hash out:**
- What is the business model for WorkRail Auto -- per-seat, per-org, usage-based (tokens consumed), or outcome-based?
- Multi-tenancy requires credential isolation between orgs. What is the threat model -- can a compromised tenant access another tenant's code or credentials?
- The "same engine, same workflows" promise requires the cloud version to stay in sync with the open-source version. What is the release cadence and sync mechanism?
- Horizontal scaling with multiple daemon instances requires a shared trigger queue. What is the queue technology (Redis, Postgres, SQS)? This is a significant infrastructure dependency to introduce.
- When does the decision to build the hosted layer get made? What are the criteria ("local daemon is proven" needs a concrete definition)?

---

### Multi-project WorkTrain

**Status: idea** | Priority: medium (to investigate)

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

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

**Things to hash out:**
- How does a workspace know about `relatedWorkspaces` in practice? Is this purely advisory metadata for human context, or does WorkTrain actively query related workspace KGs during sessions?
- If two related workspaces have conflicting behavioral rules in their respective `daemon-soul.md` files, what is the priority when a cross-workspace session runs?
- Is the workspace config (`~/.workrail/workspaces`) stored in the user's home directory or per-repo? If per-repo, what happens for repos shared across users or machines?
- What is the migration path for existing single-workspace setups? Does adding workspace namespacing require changes to all existing config files?
- Global shared items (token usage, message queue, merge audit log) need to remain consistent across workspaces. Who is responsible for multi-workspace consistency in these shared files?

---

### Message queue: async communication with WorkTrain from anywhere

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:2 Eff:2 Lev:2 Con:3 | Blocked: no

**Design:** A persistent message queue (`~/.workrail/message-queue.jsonl`) that decouples when you send a message from when WorkTrain acts on it.

```bash
worktrain tell "skip the architecture review for the polling triggers PR, it's low risk"
worktrain tell "add knowledge graph vector layer to next sprint"
```

Each command appends to the queue. The daemon drains between agent completions -- never mid-run, always at a natural break point.

**Outbox (WorkTrain -> user):** WorkTrain appends notifications to `~/.workrail/outbox.jsonl`. A mobile client polls this or an HTTP SSE endpoint wraps it.

**This is the foundation for mobile monitoring.** The mobile app is just a client that reads outbox and writes to message-queue.

**Things to hash out:**
- Messages in the queue are natural language instructions. How does the daemon interpret and act on them reliably? Is there a classification step, or is the message passed directly to an LLM for interpretation?
- What prevents a malicious or accidental message from authorizing dangerous actions ("merge all PRs" or "delete the worktree")? Is there a permission model for message queue instructions?
- "Drained between agent completions" means messages could wait minutes or hours during a long session. Is this latency acceptable for all message types, or should high-priority messages have a faster path?
- How long do messages persist in the queue? Is there a TTL, and what happens to messages that expire before being processed?
- Should the outbox and message queue be per-workspace or global? A global queue makes cross-workspace messaging simple but creates coordination complexity.

---

### Periodic analysis agents

**Status: idea** | Priority: low

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: yes (needs scheduled tasks)

Agents on a schedule that proactively identify issues, gaps, improvement opportunities:

- **Weekly: Code health scan** -- `architecture-scalability-audit` on modules not audited in 30 days
- **Weekly: Test coverage scan** -- files modified with zero/low test coverage
- **Weekly: Documentation drift scan** -- recently merged PRs changed behavior described in docs
- **Monthly: Dependency health scan** -- CVEs, active forks, lighter alternatives
- **Monthly: Performance baseline** -- benchmark scenarios vs previous month
- **Continuous: Security scan** -- on every PR merge, OWASP top 10 patterns in changed files
- **Monthly: Ideas generation** -- `wr.discovery` on codebase + backlog + session history, asking "what's the most impactful thing we could build next?"

**Things to hash out:**
- Each weekly/monthly agent runs on a schedule. What is the concurrency interaction with active task sessions? Do analysis agents run in background slots, or do they compete for the same pool?
- The "Monthly: Ideas generation" agent can write to the backlog. Who reviews ideas before they are acted upon? Without a review gate, the backlog could accumulate LLM-generated noise.
- What triggers the continuous security scan on every PR merge? Is this a delivery hook, a webhook, or a polling trigger? The latency requirement ("continuous") is different from the weekly scans.
- Should these agents be configurable per workspace (enable/disable, change schedule) or globally controlled by WorkTrain?
- What is the cost profile for running all of these agents monthly? Token cost, LLM API cost, and compute time add up across a busy repo.

---

### Monitoring, analytics, and autonomous remediation

**Status: idea** | Priority: low

**Score: 8** | Cor:1 Cap:2 Eff:1 Lev:2 Con:2 | Blocked: no

WorkTrain watches application health metrics (error rate, latency, session success/failure rate, queue depth), identifies anomalies, investigates root causes, and resolves what it can automatically.

**Monitoring loop:** Detect anomaly -> classify severity -> investigate with `bug-investigation.agentic.v2` -> if confidence >= 0.8 and severity <= High, attempt auto-remediation (config/feature-flag fix, code fix) or else escalate with full findings.

**Analytics dashboard:** Per-module PR cycle time, workflow step failure rates, token cost per session type, quality score (weighted composite of review accuracy + coding success rate + investigation accuracy).

**Things to hash out:**
- "Auto-remediation (config/feature-flag fix, code fix)" is a significant autonomous action in response to a production anomaly. What safeguards prevent a false positive from triggering a harmful automated change?
- What is the source of "application health metrics" -- is WorkTrain reading from an external monitoring system, or monitoring its own daemon health? These are very different scopes.
- The quality score is a weighted composite. Who determines the weights, and how are they recalibrated when the component metrics change?
- How does this interact with the knowledge graph and session store? The analytics dashboard presumably reads from both -- is there a query API, or is it direct file reads?
- "Continuous security scan on every PR merge" plus auto-remediation is a very tight loop. Who is responsible for reviewing auto-applied security fixes before they reach main?

---

### Cross-repo execution model

**Status: idea** | Priority: medium (post-MVP for hosted tier)

**Score: 9** | Cor:1 Cap:3 Eff:1 Lev:2 Con:2 | Blocked: no

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

**Things to hash out:**
- `BashInRepo`, `ReadRepo`, `WriteRepo` are new tool variants scoped to a named repo. How does the agent know which repo to address -- is the repo name part of the tool call, or is the default repo set at session start?
- If a session spans repos with different languages (Android/Kotlin + backend/TypeScript), does WorkRail need language-aware context strategies for each, or is the tooling language-agnostic?
- Dynamically cloning a repo to `~/.workrail/repos/<name>/` at session start could take significant time for large repos. Is this acceptable latency, or does the design require pre-cloned repos?
- Cross-repo sessions that make commits to multiple repos need atomic rollback semantics if one repo's commit fails. Is this in scope, or is it the agent's responsibility?
- Should cross-repo sessions be allowed for solo developers with a single GitHub account, or does this primarily target team setups with broader permissions?

---

### Long-term vision: WorkRail as a general engine, domain packs as configuration

**Status: idea** | Priority: long-term

**Score: 8** | Cor:1 Cap:2 Eff:1 Lev:2 Con:2 | Blocked: no

WorkTrain is not just a coding tool. The underlying engine -- session management, workflow enforcement, daemon, agent loop, knowledge graph, context bundle assembly -- is domain-agnostic.

**Domain packs:** Self-contained configuration bundles that specialize WorkTrain for a specific problem domain: a set of workflows, a knowledge graph schema, context bundle query definitions, trigger definitions, a daemon soul template.

**Examples:** `worktrain-coding` (current default), `worktrain-research`, `worktrain-creative`, `worktrain-ops`, `worktrain-data`.

**When to make it explicit:** The right time is when a second domain is ready to be added. Extract the coding-specific pieces into `worktrain-coding` and establish the domain pack contract.

**Things to hash out:**
- What exactly is the boundary between the "domain-agnostic engine" and the "coding domain pack"? Some features feel fundamental (session store, HMAC tokens) while others feel domain-specific (worktree management, git integration). Where is the line?
- How would domain packs be distributed and versioned? Is this a package manager model, a git submodule, or a bundled registry?
- Can multiple domain packs be active simultaneously for a single workspace, or is it one pack per workspace?
- The "right time is when a second domain is ready" -- what does "ready" mean? A prototype, a production use case, or explicit user demand?

---

### WorkTrain as a native macOS app (Apr 18, 2026)

**Status: idea** | Priority: low / long-term

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

Long-term vision: WorkTrain becomes a full native Mac app -- menubar icon, system notifications, windows, native UX.

**What this unlocks:** always-on menubar presence showing daemon status; native macOS notifications (currently via osascript -- the app version would use UserNotifications framework directly); `worktrain status` overview as a native window; message queue and inbox as a native interface; background daemon management from the menubar without terminal.

**Tech stack options:**
- Swift/SwiftUI: full native, best macOS integration
- Tauri: Rust core + existing web frontend, lighter than Electron (recommended path)
- Electron + existing console UI: fastest path, same TypeScript codebase, but heavy

**Things to hash out:**
- A native app wrapping a daemon means the daemon becomes an app subprocess or a launchd service. Which model fits better, and does it change the daemon's lifecycle management?
- Tauri requires Rust knowledge that the current team may not have. Is the recommended path realistic given the team's current skills?
- macOS Gatekeeper and notarization requirements add significant release overhead for a signed app. Is this factored into the timeline estimate?
- How does the macOS app interact with the existing console web UI? Are they two separate UIs, or does the native app embed the web console?
- What happens to the CLI (`worktrain` commands) in the native app world -- do they remain the primary interface or become secondary?

---

### Long-running sessions: stay open across agent handoffs (Apr 18, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: yes (needs session continuation)

Today when an MR review session completes, it writes its findings and exits. If the findings require fixes, a new fix agent starts from scratch with no shared context. Three sessions that are logically one unit of work are isolated from each other.

**The vision:** a session can stay open and wait -- dormant but alive -- while another agent does work. When that work completes, the waiting session resumes with full context continuity.

**The MR review example:**
```
[MR review session]  finds: 2 critical, 3 minor
  -> stays open, waiting for fixes
  [Fix agent session]  addresses all 5 findings -> signals "fixes ready"
[MR review session resumes]  re-reads the diff, re-evaluates
  -> all 5 verified fixed, 0 new findings -> completes with APPROVE verdict
```

The same session that found the issues verifies the fixes. No context reconstruction. No risk of re-review missing something the original reviewer knew.

**Requires:** session continuation / post-completion phases architecture (already in the backlog under "Session as a living append-only record").

**Things to hash out:**
- A dormant-but-alive session holds its conversation history in memory or must it be re-loaded from the event store on resume? If re-loaded, does the LLM truly have "full context continuity," or is it a reconstruction?
- How long can a session remain dormant? If the fix agent takes 2 hours, the reviewing session holds its slot for 2 hours. Is that acceptable given concurrency limits?
- What signals the reviewing session that "fixes are ready"? Is this a steer injection, a new `await_sessions` result, or a tool call from the fix agent?
- What happens if the fix agent fails or produces a partial fix? Does the reviewing session resume anyway, or only on clean completion?
- Should dormant sessions count against `maxConcurrentSessions`? If yes, long-running coordinated pipelines could exhaust the pool.

---

### Coordinatable workflow steps: confirmation points the coordinator can satisfy (Apr 18, 2026)

**Status: idea** | Priority: medium -- needs discovery before implementation

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:2 Con:1 | Blocked: no

Workflows already have `requireConfirmation: true` on certain steps -- these are natural coordination points. Right now they pause for a human. The idea is to make them also pausable-for-a-coordinator, so a coordinator (or another agent) can be the one that responds instead of a human.

**The vision:** a workflow reaches a `requireConfirmation` step. In MCP mode (human-driven), it behaves exactly as today -- pauses and waits. In daemon/coordinator mode, instead of blocking forever, the coordinator can:
- Inject a synthesized answer based on external work it just did ("architecture review found X, proceed with approach A")
- Spawn another agent to generate the answer and inject its output
- Simply forward a human's message from the message queue

The original session never knows whether a human or a coordinator satisfied the confirmation. It just receives the next turn with context.

**Open design questions:** How does the coordinator "subscribe" to pending confirmations? What's the protocol for injecting the response -- is it a steer, or a new continue_workflow call? What if a coordinator response conflicts with what the human would have said?

**Things to hash out:**
- Should the coordinator be able to satisfy any `requireConfirmation` step, or only steps explicitly marked as coordinator-satisfiable? An unexpected coordinator response on a step intended for human review could bypass important gates.
- If both a coordinator response and a human message queue entry are available for the same confirmation, which takes precedence?
- How does the session handle a confirmation that arrives after the session has timed out waiting? Is the response discarded, or does it attempt to resume the session?
- What is the audit trail for coordinator-satisfied confirmations? Operators need to be able to see "this gate was satisfied by the coordinator with this reasoning" distinct from human approvals.

---

### wr.shaping workflow: shape messy problems into implementation-ready specs (Apr 18, 2026)

**Status: ready to author** | Priority: medium

**Score: 11** | Cor:1 Cap:3 Eff:2 Lev:2 Con:3 | Blocked: no

WorkRail has `wr.discovery` (divergent) and `coding-task-workflow-agentic` (convergent). Shaping is the missing middle -- converting messy discovery output into a bounded, implementation-ready spec without mid-implementation rabbit holes.

**Design docs:** `docs/design/shaping-workflow-discovery.md` (WorkRail-internal discovery findings), `docs/design/shaping-workflow-external-research.md` (Shape Up, LLM failure modes, artifact schema).

**The 11-step skeleton:**
1. `ingest_and_extract` -- extract problem frames, forces, open questions
2. `frame_gate` -- MANDATORY HUMAN GATE: confirm problem + appetite
3. `diverge_solution_shapes` -- 4 parallel rough shapes with varied framings
4. `converge_pick` -- SEPARATE JUDGE (different model/prompt): pick best shape
5. `breadboard_and_elements` -- fat-marker breadboard + Interface/Invariant/Exclusion classification
6. `rabbit_holes_nogos` -- adversarial: risks, mitigations, no-gos
7. `scope_and_slices` -- break into implementable slices with dependencies
8. `spec_draft` -- write the shaped pitch in full (problem + appetite + solution + no-gos + slices)
9. `spec_review` -- second-pass review of the spec for completeness and ambiguity
10. `spec_gate` -- MANDATORY HUMAN GATE: approve spec before implementation starts
11. `output_artifacts` -- write `current-shape.json`, `SPEC.md`; update `open-work-inventory.md`

**Things to hash out:**
- `diverge_solution_shapes` produces 4 parallel shapes. Does this mean 4 parallel sessions, or 4 outputs from a single session? The resource and token cost differs significantly.
- `converge_pick` uses a "SEPARATE JUDGE (different model/prompt)." How is this different model/prompt configured -- is it a different workflow step, a different API call, or a workaround for bias?
- Who reads and validates the shaped spec between `spec_review` and the `spec_gate` human approval? If the human doesn't have context from the earlier steps, the gate is rubber-stamping.
- The 11-step workflow writes to `open-work-inventory.md` in the final step. This is a shared planning file -- what happens if two shaping sessions run concurrently for different problems?
- `Status: ready to author` -- what is blocking authoring? Is this waiting on the artifacts-as-first-class-citizens feature, or can it be authored with the current filesystem-based approach?

---

### Artifacts as first-class citizens: explorable, accessible, out of the repo (Apr 18, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Every autonomous session dumps `design-candidates.md`, `implementation_plan.md`, `design-review-findings.md` etc. as files in the repo root or worktrees. They are: not indexed or searchable, not visible in the console, not accessible to other sessions, polluting the repo with ephemeral working documents, lost when worktrees are cleaned up.

**The right model:** artifacts are WorkTrain data, not filesystem files. Any structured output from a session that has value beyond the session itself -- handoff docs, design candidates, implementation plans, review findings, spec files, investigation summaries -- should be stored in the session store and accessible via the console.

**What an artifact is:** a named, typed, versioned blob produced by a session. Stored in `~/.workrail/data/artifacts/<sessionId>/`. Referenced from the session event log via `artifact_recorded` event. Accessible to other sessions via `read_artifact(sessionId, name)`.

**Console integration:** "Artifacts" tab on session detail. Each artifact shows name, type, size, and content. "Add to repo" button copies the artifact to the workspace as a markdown file for the cases where the author wants it in git.

**Build order:** `artifact_recorded` event kind in the session store; `read_artifact` tool for daemon agents; Console artifacts tab; garbage collection policy (artifacts older than N days deleted unless pinned).

**Things to hash out:**
- If artifacts replace filesystem files, what happens to the existing workflow steps that write to `design-candidates.md`, `implementation_plan.md`, etc. in the repo? Is migration required, or do both models coexist?
- What is the artifact storage format -- raw Markdown, structured JSON, or type-specific? How does the console render artifacts of different types?
- The `read_artifact(sessionId, name)` API gives any session read access to any other session's artifacts. What is the authorization model -- should all sessions have access to all artifacts, or is it scoped to related sessions?
- How does garbage collection interact with the console's "Artifacts" tab? If an artifact is displayed in the console but has been garbage collected, what does the user see?
- Are artifacts immutable once written, or can a session append to or replace an existing artifact?

---

### Business model (tentative)

Three tiers:

| Tier | Who | Price | Notes |
|------|-----|-------|-------|
| **Personal / OSS** | Individual devs, open-source projects, non-commercial | Free forever | Builds community, reputation, workflow library. Never charge for this. |
| **Corporate self-hosted** | Companies running WorkRail on their own infrastructure | Paid license | Data never leaves their VPC. Priced per seat or per org. |
| **WorkRail Auto (cloud)** | Anyone who wants managed, zero-ops | Paid subscription | Higher price, lower friction. Pre-configured integrations. |

**License model options:**
- **Dual-license:** AGPL for open-source use, commercial license for everyone else who doesn't want AGPL obligations
- **MIT core + paid features:** Core engine stays MIT forever, advanced features (hosted dashboard, enterprise SSO, multi-tenant credential vault, audit logs) are paid

**The corporate self-hosted market is often the most lucrative.** Enterprises pay well for "runs in our VPC, vendor can't see our code." GitLab, Grafana, Jira -- all built significant businesses on self-hosted enterprise licenses before or alongside their cloud offerings.

**What NOT to do:** Don't charge for the workflow library or the core MCP protocol. Those are the commons that make WorkRail valuable. Charge for the infrastructure layer, not the knowledge layer.

**Priority:** Don't worry about this until there are users.

**Things to hash out:**
- The AGPL dual-license model requires companies using WorkRail in their products to either open-source those products or buy a commercial license. Is this the intended friction, and is it calibrated correctly for the target market?
- What qualifies as "commercial use" in the MIT core + paid features model? A company running the free engine internally without distributing it -- is that commercial use?
- Who decides which features are "advanced" (paid) vs "core" (free)? This decision shapes the community's willingness to contribute.
- The corporate self-hosted market requires sales, invoicing, and legal infrastructure. Is there a plan for those operational capabilities, or is this purely a product decision for now?
- How does the open-source community react if features they contributed to are moved behind a paywall? Is there a policy for handling contributions to the paid tier?

---

### WorkTrain benchmarking: prove it's better, publish the results (Apr 18, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:2 Eff:3 Lev:2 Con:2 | Blocked: no

If WorkTrain can demonstrably outperform one-shot LLM calls and human-in-the-loop for specific task types, with reproducible benchmarks published in GitHub and visible in the console, that's the killer adoption argument.

**What to benchmark:**

| Dimension | WorkTrain | One-shot | Human-in-loop |
|-----------|-----------|----------|---------------|
| MR review finding rate (Critical/Major caught) | ? | ? | ? |
| False positive rate | ? | ? | ? |
| Coding task correctness (builds + tests pass) | ? | ? | ? |
| Bug investigation accuracy (correct root cause) | ? | ? | ? |
| Time to complete | ? | ? | ? |
| Token cost per task | ? | ? | ? |

**Also within WorkTrain:** Haiku (fast, cheap) vs Sonnet (balanced) vs Opus (best) for each task type. Does workflow structure make Haiku competitive with Sonnet one-shot? (hypothesis: yes, for structured tasks)

**The benchmark suite:**
1. MR review benchmark -- 50 PRs with known ground truth. Score: recall + precision.
2. Coding task benchmark -- 50 tasks with objective completion criteria. Score: % completing correctly on first autonomous run.
3. Bug investigation benchmark -- 30 real bugs with known root causes. Score: % identifying correct root cause.
4. Discovery quality benchmark -- 20 design questions with expert-evaluated answers.

**How to publish:** `docs/benchmarks/` directory, GitHub Actions CI job on each release, Console "Benchmarks" tab, badge in README: "MR review recall: 87% (Sonnet 4.6, v3.36.0)".

**Starting point:** the mr-review workflow. Start with 20 PRs where bugs were later discovered and 20 PRs that shipped cleanly. Run each through `mr-review-workflow-agentic` on several model tiers. That's a publishable result with one weekend of work.

**Things to hash out:**
- "Ground truth" for benchmark PRs requires human expert labeling of what the correct findings should be. Who does this labeling, and how is inter-rater reliability ensured?
- Benchmark results are model-version-specific. When a new model version releases, do all benchmarks need to be re-run? What is the cost and cadence?
- Publishing benchmarks that compare WorkTrain to "one-shot LLM" requires a controlled experimental setup. How are prompt and model variables controlled for the one-shot baseline?
- Should benchmark results be published even when they show WorkTrain performing worse than expected? The commitment to honest benchmarking needs to be explicit.
- A CI job that runs 50 PR reviews on every release is extremely expensive. What is the governance for this -- is it run manually, on major releases only, or on a separate schedule?

---

### Autonomous feature development: scope -> breakdown -> parallel execution -> merge (Apr 18, 2026)

**Status: idea** | Priority: high

**Score: 9** | Cor:1 Cap:3 Eff:1 Lev:2 Con:2 | Blocked: yes (needs native multi-agent + scripts-first coordinator)

Give WorkTrain a feature scope -- from a vague idea to a fully groomed ticket -- and it figures out the rest. Discovery if needed, design if needed, breakdown into parallel slices, execution across worktrees, context management across agents, bringing it all back together.

**The four pillars:**
1. **Autonomy** -- WorkTrain takes a scope and figures out the work breakdown without hand-holding
2. **Quality** -- comes FROM autonomy + workflow enforcement + coordination
3. **Throughput** -- parallel slices across worktrees simultaneously
4. **Visibility** -- one coherent work unit you can track at a glance

**The pipeline for a scope:**
```
Input: "add GitHub polling support" (any level of definition)
  -> [if vague] ideation + spec authoring
  -> classify-task -> taskComplexity, hasUI, touchesArchitecture, taskMaturity
  -> [if Medium/Large] discovery
  -> [if touchesArchitecture] design + review
  -> breakdown -> parallel slices with dependency graph
       Slice 1: types + schema         (worktree A)
       Slice 2: polling adapter        (worktree B, depends: 1)
       Slice 3: scheduler integration  (worktree C, depends: 2)
       Slice 4: tests                 (worktree D, depends: 1-3)
  -> [parallel execution] each slice: implement -> review -> approved
  -> [serial integration] merge slices in dependency order
  -> [final] integration test -> PR created -> notification
```

**Context management:** Coordinator maintains a "work unit manifest" (current phase, slice status, shared invariants, decisions). Each spawned agent receives a context bundle. After each agent completes, its findings update the manifest.

**The coordinator's job (scripts, not LLM):** maintain the manifest, compute the dependency graph, decide parallelism vs serialization, route outcomes, track worktrees, detect conflicts, sequence merge order.

**The minimum viable version:** a coordinator that handles a Medium/Small scoped task -- takes 2-4 parallel slices, runs them, reviews each, merges when clean. No escalation handling in v1.

**Things to hash out:**
- "WorkTrain figures out the breakdown" -- how does it decompose a feature into independent, parallelizable slices without human input? What is the decision process, and how does it handle tasks that are fundamentally sequential?
- Parallel slices across worktrees can produce merge conflicts when their branches are integrated. Who detects and resolves conflicts -- the coordinator script or the agent?
- The breakdown step requires predicting which slices depend on which. Incorrect dependency analysis could cause a slice to start before its dependencies are complete. How is this validated before parallel execution begins?
- Is the "minimum viable version" intended to run fully autonomously, or does it require human review between phases?
- How does this relate to the full development pipeline entry earlier in the backlog? Are these the same concept or parallel efforts?

---

### WorkTrain analytics: stats, time saved, and quality metrics (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

WorkTrain should be accountable. Not just "it did work" but "did it do good work?" Stats without quality metrics are vanity. Quality metrics without stats lack context.

**Volume stats:** PRs opened/merged, PRs reviewed, bugs investigated, tasks completed, discoveries run, issues filed/resolved. Derived from session store + merge audit log + GitHub/Jira API.

**Time saved estimates:** calibrated human-equivalent time estimate per workflow type (e.g. MR review STANDARD = 25 min, coding task Medium = 2h). Honest: "Time saved is only real if the work would have been done by a human."

**Quality metrics:**
- MR reviews: reviews with 0 findings / reviews that caught Critical / reviews where human disagreed
- Coding tasks: PRs merged without rework / PRs that needed fix cycles / post-merge bug rate
- Bug investigations: correct root cause identified / confidence was too high (wrong) / escalated correctly
- **Overall quality score** (weighted composite): if score drops below 70, auto-trigger `workflow-effectiveness-assessment`

**Quality feedback loop:** post-merge outcome tracking (bugs filed against WorkTrain PRs within 30 days), MR review validation (author disputes a finding = signal), human override tracking, explicit `worktrain feedback "..."` command appending to `~/.workrail/feedback.jsonl`.

**Console Analytics tab:** quality score trend, volume/quality/cost summary, anomaly callouts with links to `workflow-effectiveness-assessment`.

**Things to hash out:**
- "Time saved" estimates require knowing what a human would have done in the same time. This is inherently speculative. How is the calibration model updated as norms change?
- "Reviews where human disagreed" requires a mechanism for tracking disagreement. What is the interface for a human to signal disagreement with a WorkTrain finding -- a label, a comment keyword, or an explicit command?
- The quality score dropping below 70 auto-triggers `workflow-effectiveness-assessment`. Who defines the threshold, and is it configurable per workspace or global?
- Post-merge bug tracking (bugs within 30 days) requires attributing bugs to specific PRs. What is the attribution mechanism -- PR metadata, commit SHA tracking, or manual annotation?
- The analytics data requires access to GitHub/Jira APIs. Who manages token rotation for these read-access integrations, and what happens when they expire?

---

### Live status briefings: WorkTrain narrates its own work in human terms (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

**The problem:** WorkTrain is doing a lot. Sessions are running, PRs are open, the queue has items. But the raw view -- session IDs, PR numbers, branch names -- is only meaningful to someone who's been following along. A user who checks in after a few hours needs a human-readable briefing, not a list of `sess_abc123` entries.

**`worktrain status` command:** assembles a briefing by reading active sessions (what's running, which step, how long), queue state, recent completions, blocked/waiting items. Summarizes each session in 2-3 plain English lines: what is being built, why it matters, where it is.

**Adaptation:** `--audience owner` (full technical detail, default) vs `--audience stakeholder` (capability level, no PR numbers) vs `--audience external` (outcome level, no internal terminology).

**Console Status tab** (default view): live session list with step progress, queue next items, done today. Updates via SSE. Click any row to expand.

**Push notifications:** milestone completions ("WorkTrain shipped: worktrain init is live"), blockers surfaced ("PR #406 came back with 2 issues -- fixing automatically, estimated 20 min"), optional daily digest.

**Things to hash out:**
- The briefing LLM call requires a full context assembly pass (session store, queue state, recent completions). This is expensive. Should `worktrain status` be a live query or cached periodically?
- Audience adaptation (`--audience stakeholder`) requires understanding what "capability level" vs "technical detail" means for each piece of information. Who defines this mapping?
- Push notifications require a notification channel (Slack, email, macOS, etc.). How does the user configure which channel(s) to use, and what is the default?
- "Estimated 20 min" requires the workflow execution time prediction system to be built first. Is the status briefing gated on that feature?
- Should the Console Status tab replace the existing Sessions tab as the default view, or be an additional tab?

---

### Pattern and architecture validation: WorkTrain enforces team conventions (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:2 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Beyond reviewing code for bugs, WorkTrain validates that the code matches the patterns and architecture the team expects.

**Two levels:**

**1. Philosophy lens (already partially built):** extend to be per-workspace configurable, and make some patterns machine-checkable (no direct db access outside the repository layer, no `console.log` in production code, no `any` types) rather than relying on the LLM.

**2. Architectural invariant checking (new):**
```yaml
workspaces:
  workrail:
    architectureRules:
      - id: no-daemon-imports-from-mcp
        rule: "src/daemon/** must not import from src/mcp/**"
        type: import_boundary
        severity: error
      - id: errors-as-data
        rule: "No throw statements in src/daemon/** -- use Result types"
        type: no_throw
        severity: warning
        exceptions: ["constructor", "assertExhaustive"]
      - id: no-exec-shell
        rule: "No child_process.exec() -- use execFile() with args array"
        type: forbidden_call
        severity: error
```

These rules run as scripts (static analysis, not LLM) -- fast, deterministic, zero tokens. Checked during coding-task workflow, as part of CI, and by the periodic architecture scan.

**The self-improvement connection:** when `workflow-effectiveness-assessment` finds that a class of bug appears repeatedly (e.g. "3 of the last 5 coding tasks had shell injection risks"), it can propose a new architecture rule that prevents the pattern going forward. Rules start as soft warnings, graduate to errors after validation. WorkTrain learns from its own failure patterns and codifies them as invariants.

**Things to hash out:**
- Static analysis rules (import boundaries, forbidden calls) are different from philosophy lens rules (LLM-evaluated). Should they live in the same configuration file and enforcement mechanism?
- Who owns the `architectureRules` configuration per workspace -- the workspace team, the workflow author, or WorkTrain itself? Conflicting ownership creates maintenance friction.
- When a new architecture rule is auto-proposed from failure patterns, how does it get reviewed and graduated from warning to error? Is there a human approval gate in the self-improvement loop?
- How does architecture rule enforcement interact with existing CI checks? Should WorkRail generate a lint-style CI step from the `architectureRules` config?
- Rules like "no throw in src/daemon/**" require nuance (exceptions for constructors). How is the exceptions list kept current as the codebase evolves?

---

### Resource management: preventing agent congestion under high concurrency (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

Running many simultaneous agents creates API rate limit bursts, host resource pressure, and context degradation. The `maxConcurrentSessions` semaphore addresses the daemon-level cap, but the broader resource management problem has several dimensions.

**The dimensions:**
1. **API rate limits** -- token-bucket rate limiter shared across all sessions: before each LLM call, acquire a slot from the bucket
2. **Host machine resources** -- each agent loop runs in-process, consuming RAM and CPU
3. **Tiered concurrency by task type** -- `coding-task-workflow-agentic: 2` (expensive), `mr-review: 3` (medium), `wr.discovery: 5` (cheap)
4. **Queue-aware throttling** -- prefer starting high-priority items even if slots are available for low-priority ones
5. **Graceful degradation** -- slow down polling intervals, prefer fast/cheap workflows, pause the queue drain when under load

**Build order:**
1. `maxConcurrentSessions` semaphore (simple global cap)
2. Token-bucket rate limiter in the agent loop
3. Per-workflow-type concurrency limits
4. Queue-aware slot allocation (high-priority first)
5. Adaptive throttling based on observed latency

**Things to hash out:**
- The token-bucket rate limiter must be shared across all concurrent sessions. Where does it live -- daemon-global singleton, or a lightweight IPC mechanism? Thread safety is required.
- Tiered concurrency limits by workflow type require the daemon to know the workflow type at dispatch time. How is this derived for dynamically dispatched sessions where the workflow is set at runtime?
- "Host machine resources" monitoring requires either OS-level telemetry (CPU, RAM sampling) or inference from session count. Which is more reliable for the adaptive throttling use case?
- Graceful degradation that pauses queue draining could leave important high-priority items waiting behind lower-priority work. Does degradation mode need priority awareness?
- What is the interaction between resource limits and the `worktrain kill-sessions` kill switch? Should resource exhaustion trigger a softer intervention before escalating to kill?

---

### Universal integration layer: WorkTrain interfaces with everything (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:1 Lev:2 Con:2 | Blocked: no

WorkTrain is not opinionated about your stack. It works with whatever version control, project management, communication, monitoring, and documentation systems you use.

**Integration categories:**
- **Version control:** GitHub, GitLab (already done), Bitbucket, Azure DevOps, Gitea, raw git
- **Project management:** GitHub Issues, GitLab Issues, Jira (Cloud + Server), Linear, Asana, Notion, Monday.com, Azure Boards
- **Communication:** Slack, Microsoft Teams, Discord, Telegram, Email, PagerDuty, OpsGenie, generic webhook
- **Monitoring:** Sentry, Datadog, New Relic, Grafana/Prometheus, CloudWatch, custom HTTP endpoint
- **Documentation:** Confluence, Notion, Google Docs, Markdown in repo, Docusaurus

**Three integration modes (all already architected):**
1. **Polling source** -- WorkTrain calls the external API on a schedule, deduplicates events, dispatches workflows
2. **Delivery target** -- WorkTrain POSTs results to an external system when a workflow completes
3. **Reference context** -- WorkTrain fetches external documents and injects them into agent context

**The integration manifest in triggers.yml:**
```yaml
integrations:
  github:
    token: $GITHUB_TOKEN
  jira:
    token: $JIRA_TOKEN
    baseUrl: https://mycompany.atlassian.net
  slack:
    webhookUrl: $SLACK_WEBHOOK_URL
    channels:
      reviews: "#code-review"
      incidents: "#incidents"
```

**Build order:** generic `callbackUrl` (already works); GitHub polling (same as GitLab, already written as template), Slack delivery (format + post to webhook); Jira polling + delivery (high enterprise value); Linear polling (high startup value); PagerDuty delivery. Each adapter is a bounded, testable, independently shippable unit.

**Things to hash out:**
- The integration manifest in `triggers.yml` centralizes credentials for all external systems. Is this the right location, or should credentials live in a separate secrets file (like `~/.workrail/.env`)?
- Each integration adapter is "independently shippable" -- but they share no common testing infrastructure. How is integration adapter quality maintained as the number of adapters grows?
- What is the versioning policy for integration adapters? If an external API changes (e.g. Jira Cloud v3 -> v4), how are adapter updates coordinated with WorkTrain releases?
- The "three integration modes" cover polling, delivery, and reference context. Are there integration use cases that don't fit these three modes?
- Who is the target user for the universal integration layer -- solo developers, small teams, or enterprise teams? The complexity of configuring many integrations is higher than the current single-trigger setup.

---

### Communication agent: Slack monitoring, email management, and suggested responses (Apr 16, 2026)

**Status: idea** | Priority: low

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

WorkTrain monitors your communication channels, understands context, and either responds on your behalf or prepares vetted drafts for you to send.

**Slack:** Monitor specified channels and DMs for messages that mention you, reference your projects, or require a response. Options: auto-respond for routine questions, draft a response for your review, or surface with a notification. Configurable per-channel.

**Email:** Monitor inbox, understand context, draft responses. Suggest email filters, folder rules, and unsubscribe candidates based on patterns. Priority surfacing: "3 emails need a response, here are the drafts."

**Important constraint:** WorkTrain never sends on your behalf without explicit approval for anything that goes to other people. Auto-respond is opt-in per-channel, with a review window before sending.

**Things to hash out:**
- Slack monitoring requires a Slack app with appropriate scopes. What is the setup experience -- does WorkTrain ship a Slack app manifest, or does the user create an app from scratch?
- The "review window before sending" implies the agent drafts a response and waits. What is the window duration, and what happens if the user doesn't review within the window?
- Email monitoring is significantly more sensitive than Slack. What are the minimum required email scopes, and how does WorkTrain prevent accidentally reading sensitive or confidential messages?
- Auto-respond for Slack is opt-in per-channel. If a channel is not explicitly opted in, are all messages in that channel completely invisible to WorkTrain?
- This is a significant scope expansion beyond code-related automation. What is the explicit boundary between WorkTrain as a coding tool and WorkTrain as a general productivity tool?

---

### Local file organization and maintenance (Apr 16, 2026)

**Status: idea** | Priority: low

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

- WorkTrain scans specified directories for stale, duplicate, and disorganized files
- Suggests folder structures based on file content and usage patterns
- Identifies documents that are out of date and offers to update them
- Keeps project-related files in sync with the repo
- "~/Downloads has 847 files, most untouched for 6 months -- here's what's safe to delete and what should be archived"
- Connects to the knowledge graph: files that reference code or projects get indexed alongside the code

---

### Worktree lifecycle management: automatic cleanup and inventory (Apr 18, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:2 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

With many concurrent agents using `branchStrategy: worktree`, worktrees accumulate. 10 agents running all day can produce dozens of worktrees, each triggering `git status` processes that saturate the host CPU.

**What's needed:**
1. **Automatic cleanup on session end** -- when a WorkTrain session completes (success or failure), the daemon automatically runs `git worktree remove <path> --force`. If the branch is already merged to main, also delete the local branch ref.
2. **Startup pruning** -- `worktrain daemon` startup runs `git worktree prune` in each configured workspace before starting the trigger listener.
3. **`worktrain worktree list`** -- shows all WorkTrain-managed worktrees: path, branch, session ID, age, whether the branch is merged.
4. **`worktrain worktree clean`** -- removes all worktrees whose branches are merged to main, or older than N days. Dry-run mode by default.
5. **`worktrain worktree status`** -- summary: count, total disk usage, any stale ones.

**Things to hash out:**
- `git worktree remove --force` discards uncommitted changes without warning. What is the policy for worktrees with uncommitted or unstaged work on session end? Is force-removal always safe?
- "If the branch is already merged to main, also delete the local branch ref" -- what constitutes "merged"? Squash-merges don't leave an ancestor relationship in git history. How is squash-merge detection handled?
- Startup pruning runs before the trigger listener starts. What is the time cost for pruning across many workspaces with many worktrees? Could it delay daemon startup noticeably?
- Should cleanup be skipped for manually-created worktrees (not WorkTrain-managed)? How does the cleanup tool distinguish WorkTrain-managed from human-created worktrees?

---

### Git worktrees and branch management as a first-class capability (Apr 16, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:2 Con:2 | Blocked: no

Critical for parallel work. WorkTrain needs native, sophisticated git management -- not just running git commands but understanding the full branching topology.

**Worktree management:** Create, list, switch between, and clean up worktrees automatically. Detect and warn about stale worktrees (branches that have been merged or abandoned).

**Branch lifecycle:** Know which branches are: active (being worked on), stale (no commits in N days), merged (on main), or orphaned (created but abandoned). Automatic cleanup proposals. Rebase management when main advances. Conflict detection before spawning a new session.

**Parallel work coordination:** When multiple tasks touch the same files, WorkTrain detects potential conflicts before they happen. Sequences tasks that would conflict, parallelizes those that won't. Maintains a "file lock" mental model.

**The `worktrain worktree` command family:**
```bash
worktrain worktree list                    # all worktrees and their status
worktrain worktree clean                   # remove merged/stale worktrees
worktrain worktree new <branch> [--task]   # create worktree + optionally link to queue item
worktrain worktree status                  # which files are locked by active sessions
```

Especially critical when WorkTrain is managing 10+ concurrent sessions -- without explicit worktree management, two sessions could clobber each other's changes on the same branch.

**Things to hash out:**
- The "file lock" mental model requires knowing which files each active session is touching. How is this tracked -- by inspecting the worktree, by recording what files each session reads/writes, or by static analysis of the task?
- Conflict detection before spawning is a prediction problem (which files will this session touch?). What is the accuracy requirement, and what is the cost of a false positive (unnecessarily serializing work)?
- "Rebase management when main advances" is a significant automated git action. Who triggers the rebase -- the daemon on a schedule, the coordinator, or the session itself?
- The command family (`worktrain worktree list`, `worktrain worktree clean`, etc.) overlaps significantly with the worktree lifecycle management entry above. Should these be unified into a single design effort?

---

### The single-conversation problem: WorkTrain needs multi-threaded interaction (Apr 16, 2026)

**Status: idea** | Priority: medium

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

When WorkTrain is managing 10 concurrent agents, a single chat where everything is happening at the same time is not ideal. You can't follow any one thread or distinguish "in progress" from "needs a decision."

**Threaded conversations per work group:** each active work group gets its own conversation thread. You can follow the polling-triggers work in thread A without seeing the spawn/await implementation in thread B.

**`worktrain talk` shows a thread list:**
```
Threads:
  WorkRail development     [3 active agents, 2 waiting]
  Storyforge chapter work  [idle]
  -> Select thread or type to start a new one
```

**`worktrain idea` for mid-conversation capture:** `worktrain idea "..."` appends to an ideas buffer without interrupting active work. The talk session reviews the buffer at the start of each conversation.

**Things to hash out:**
- What defines a "work group" for the thread list -- is it a workspace, a parent session ID, a trigger ID, or something the user explicitly creates?
- The thread list requires WorkTrain to know which work groups are active. Where does this mapping live, and who maintains it as sessions start and complete?
- Should thread history persist across conversations, or is each `worktrain talk` session a fresh start that synthesizes from the session store?
- `worktrain idea` writes to an ideas buffer. Is this buffer workspace-scoped, global, or per-thread? What is the path for ideas that don't belong to any active thread?

---

### Console session detail: more than the DAG when running standalone (Apr 16, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:1 Cap:2 Eff:2 Lev:1 Con:3 | Blocked: no

The session DAG shows structure but not meaning. When watching a session run in the console without being in Claude Code, you want to know what the agent is actually doing.

**What's missing:**
- The latest step output note, rendered inline and updating as it streams
- A plain-English summary of what the agent is doing right now ("Analyzing the diff for shell injection risks")
- Current step prompt visible on demand
- Token count and cost estimate for the session so far
- Time elapsed + estimated time remaining based on step history
- A live feed of tool calls as they happen ("Reading trigger-router.ts", "Running npm test")

**The streaming step output** is the most valuable addition. Right now the DAG shows a step as "in progress" with a spinner. It should show the last few lines of the step's output note as it's being written.

**Build order:**
1. Inline latest step output in the session detail panel (read from session store, poll every 2s)
2. Live tool call feed alongside the DAG (SSE from the daemon, log each tool call as it fires)
3. Token/cost counter (daemon tracks tokens per session, expose via GET /api/v2/sessions/:id)

**Things to hash out:**
- "Latest step output" streaming via 2s polling means up to 2s latency. For users watching a live session, is this acceptable, or is SSE needed here too?
- The "plain-English summary" ("Analyzing the diff for shell injection risks") requires either real-time LLM inference or a structured feed from the agent. Where does this text come from?
- Current step prompt exposed on demand could reveal sensitive context (workspace paths, credentials passed via goal). Should there be a filter or opt-in before showing prompt content?
- Token cost estimates require knowing the model's pricing, which changes over time and varies by provider. How is the pricing table maintained and kept current?
- "Estimated time remaining" requires historical session data for the same workflow. What is the minimum data needed for a meaningful estimate?

---

### Orphaned daemon session state: smarter recovery (Apr 16, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:2 Cap:1 Eff:2 Lev:1 Con:3 | Blocked: no

**The problem:** When the daemon is killed mid-session, the session's in-process `KeyedAsyncQueue` promise chain is lost. On restart, the startup recovery reads orphaned session files -- but any external state tied to the queue is now inconsistent. More critically: if a session stalls (Bedrock call hangs, exception suppressed), the daemon log shows nothing after "Injecting workspace context" -- no error, no completion.

**What needs to happen:**
1. Startup recovery should clear any pending queue slots -- if a session file exists at startup, that trigger's queue key should be treated as free
2. Session liveness detection -- if a session has been `in_progress` for more than N minutes with no `advance_recorded` events, the daemon watchdog should log a warning and optionally abort
3. Orphaned session cleanup should be user-facing -- `worktrain cleanup` or `worktrain status` should surface orphaned sessions with their age and offer to clear them
4. Better logging when `runWorkflow()` swallows errors -- the `void runWorkflow(...)` pattern drops errors silently; every path that ends in silence should log `[WorkflowRunner] Session died silently` with the session ID

**Things to hash out:**
- How long should an orphaned session file be allowed to persist before `worktrain status` marks it as stale? The threshold must account for very long sessions vs actually orphaned ones.
- "Optionally abort" for sessions exceeding N minutes with no advances -- who sets N, and should the threshold differ per workflow (a discovery session naturally advances slowly vs a coding session)?
- Queue slot clearing on startup: if the daemon restarts while a session is genuinely still resumable, clearing its queue slot could lose deduplication state and re-dispatch the same task.
- Should users be notified when an orphaned session is found, or only when they explicitly run `worktrain status`?

---

### Observability and logging as first-class citizens (Apr 17, 2026)

**Status: idea** | Priority: high

**Score: 11** | Cor:2 Cap:2 Eff:2 Lev:2 Con:3 | Blocked: no

WorkTrain should never be a black box. Every action, decision, failure, and state transition should be traceable after the fact.

**What "first-class" means:**
1. **Structured, not prose** -- every log line machine-parseable with consistent key=value pairs
2. **Levels matter** -- INFO for normal operations, WARN for recoverable anomalies, ERROR for failures. Silence = actively working, not unknown. A session that produces no logs for 5+ minutes should emit a heartbeat.
3. **Every state transition logged** -- session start, step advance, tool call, tool result (including errors), session end
4. **Errors always include context** -- which session, which tool, which step, how long it had been running, what the last successful action was
5. **Correlation IDs** -- every session has a `sessionId`, every tool call has a `toolCallId`; log entries include the relevant ID for cross-session filtering
6. **Log destinations are configurable** -- `--log-level` flag, `--log-format json|human`

**Specific gaps to close:** `continue_workflow` tool should log step ID and notes length; `makeBashTool` should log exit code and output length; `AgentLoop` should log each LLM turn (turn number, stop reason, tool count); `TriggerRouter` should log when a session is queued at capacity.

**The `worktrain logs` command:**
```bash
worktrain logs                          # tail daemon.log
worktrain logs --session sess_abc123    # replay full session from event store
worktrain logs --trigger test-task      # all sessions for this trigger
worktrain logs --level error            # only errors across all sources
worktrain logs --since 1h               # last hour
worktrain logs --format json            # machine-readable output
```

**Self-healing dependency:** the automatic gap detection, WORKTRAIN_STUCK routing, and coordinator self-healing patterns all depend on logs being structured and complete. Logging quality is a prerequisite for autonomous operation at scale.

**Things to hash out:**
- How do structured logs coexist with the existing session event store? Are they the same system, or parallel? Duplicating data in both would create consistency issues.
- Tool call argument logging could expose secrets (file paths, API responses, bash commands). Is there a sanitization policy for log output?
- The `worktrain logs --session` command replays from the event store. How is this different from what the console already shows? Is the CLI version for non-console users or for programmatic processing?
- Log rotation and retention -- how much disk space should logs consume, and who configures the retention policy?
- "Silence = actively working" requires the agent loop to emit heartbeats. What is the heartbeat interval, and is this a new event type in the session store?

---

### Event sourcing for orchestration: extend the session store to daemon and coordinator events (Apr 17, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:2 Eff:2 Lev:2 Con:3 | Blocked: no

Extend the existing WorkRail event store infrastructure to cover orchestration-level events. The session store is already append-only, crash-safe, content-addressed, and queryable -- rebuilding those properties would be wasteful.

**Multiple event streams, same infrastructure:**
```
~/.workrail/events/
  sessions/          <- already exists (per-session workflow events)
  daemon/            <- lifecycle, triggers, delivery, errors
  triggers/          <- per-trigger poll history and outcomes
  coordinator/       <- coordinator script decisions and routing
```

**Daemon event stream:** structured events like `daemon_started`, `trigger_fired`, `session_queued`, `session_started`, `tool_called`, `step_advanced`, `session_completed`, `delivery_attempted`, `poll_cycle`.

**`DaemonEventEmitter`:** thin wrapper around the event store, called from TriggerRouter, workflow-runner, delivery-client, and polling-scheduler. Zero overhead when nothing is listening. (Note: `DaemonEventEmitter` already ships -- this is about expanding what gets recorded and unifying with the session event store.)

**SSE extension:** the console already streams session events via SSE. Extend to also stream daemon events so the console live feed shows everything: trigger fires, tool calls, delivery attempts, errors -- not just step advances.

**Why this matters for self-healing:** the coordinator can react in real time to `tool_error` events rather than checking for WORKTRAIN_STUCK markers after the fact.

**Things to hash out:**
- The `coordinator/` event stream records coordinator script decisions. Does this require the coordinator to be a first-class WorkTrain concept with an event-emitting API, or can it be retrofit to shell scripts via a CLI command (`worktrain event emit ...`)?
- All four event directories live under `~/.workrail/events/`. What are the size and retention policies per directory? Trigger poll cycles could generate enormous volumes in `triggers/`.
- SSE extension for daemon events means the console must distinguish session events from daemon events in the same stream. What is the event envelope schema for mixed event types?
- Who is the primary consumer of coordinator events -- only the console, or also the coordinator itself (for self-healing)? The use cases have different latency and reliability requirements.

---

### Duplicate task detection: prevent agents from doing the same work twice (Apr 18, 2026)

**Status: idea** | Priority: medium

**Score: 9** | Cor:2 Cap:1 Eff:2 Lev:1 Con:3 | Blocked: no

With multiple agents running concurrently and a persistent work queue, it's easy to accidentally start two agents on the same task -- especially when the queue drains items from external sources that may be added again after a sync.

**Detection sources:**
1. **Open PRs** -- before starting any coding task, check `gh pr list --state open` -- if a PR already exists addressing the same issue/goal, skip it
2. **Active sessions** -- session store knows which workflows are currently running; a new dispatch can check for semantic overlap before starting
3. **Queue deduplication** -- each queue item from an external source carries its `sourceId` (e.g. `github:owner/repo:issues:123`). On enqueue, check if `sourceId` already exists in the queue
4. **Session history** -- before starting an investigation, check recent session notes for the same workflowId + goal combination

**Implementation:** queue-level dedup is the simplest and most reliable. PR-level dedup: before dispatching a coding task, run `gh pr list --search "<issue title keywords>"` and check for matches. For MVP, exact `sourceId` match + approximate PR title search is sufficient. Semantic dedup (same problem described differently) is a post-knowledge-graph feature.

**Things to hash out:**
- Approximate PR title search for dedup can produce false positives (skipping work that is actually unrelated). What is the policy for a false positive -- is the issue left unworked, or escalated?
- `sourceId`-based dedup is reliable only when the same external system generates the ID consistently. What happens for goals dispatched manually via the message queue with no `sourceId`?
- Should dedup checks happen at enqueue time, dispatch time, or both? Enqueue-time dedup is earlier but may not know about concurrent activity; dispatch-time is later but more accurate.
- How long does a `sourceId` remain "in use" for dedup purposes after a session completes? If the issue is re-labeled after a failed session, it should be re-dispatchable.

---

### Agent actions as first-class events in the session event log (Apr 18, 2026)

**Status: idea** | Priority: medium

**Score: 10** | Cor:1 Cap:2 Eff:2 Lev:2 Con:3 | Blocked: no

The console should be able to reconstruct exactly what an agent did in a session -- every tool call, every argument, every result -- by reading the event log alone.

**What's missing -- agent-level events:**
- `tool_call_started` -- tool name, args, timestamp
- `tool_call_completed` -- result (truncated), duration, success/error
- `llm_turn_started` -- model, input token count
- `llm_turn_completed` -- stop reason, output tokens, tools requested
- `steer_injected` -- what context was injected and why
- `report_issue_recorded` -- the structured issue from the `report_issue` tool

**Where to emit them:** in `src/daemon/agent-loop.ts` before and after each `tool.execute()` call and LLM call; in `src/daemon/workflow-runner.ts` for steer injection.

**Console rendering:** each session detail view gets a "Timeline" tab showing: `llm_turn (450 tokens -> 3 tool calls)`, `bash: git status (45ms)`, `read: AGENTS.md (8ms)`, `llm_turn (280 tokens -> advance)` per phase.

**Build order:** add `tool_call_started`/`tool_call_completed` to `agent-loop.ts` (smallest change, highest value); add `llm_turn_started`/`llm_turn_completed`; Console Timeline tab; wire `report_issue_recorded` and `steer_injected` events; once session events are comprehensive, `DaemonEventEmitter` daily log files become secondary.

**Things to hash out:**
- Tool call arguments are logged for `tool_call_started`. Arguments can contain sensitive content (file content, bash output, API responses). What is the sanitization or truncation policy?
- Every LLM turn logged means every token count is in the session event log. This is useful for analytics but also reveals cost information. Is this data considered sensitive?
- The "Timeline" tab in the console requires the agent-loop events to be in the session store, not just in daemon logs. Does the existing session store schema need to be extended, or is there already a path for agent-loop events?
- Should these events be emitted in MCP (interactive) sessions, or only in daemon sessions? The logging overhead may be more acceptable in one context than the other.

---

### Context budget per spawned agent (Apr 18, 2026)

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: yes (needs knowledge graph)

A pre-packaged bundle of ~2000 tokens that every coordinator-spawned agent starts with. The knowledge graph is what makes this scalable.

**Bundle contents:**
- `<relevant_files>` -- paths + key excerpts from files the agent will likely touch (from KG query)
- `<prior_sessions>` -- summaries of the last 3 sessions that touched related code
- `<established_patterns>` -- specific patterns the agent must follow
- `<known_facts>` -- things already proven true
- `<do_not_explore>` -- explicit list of dead ends and already-tried approaches

**Without the KG (today):** the coordinator manually includes key context in the prompt.
**With the KG (future):** `worktrain spawn --workflow X --goal "..."` automatically queries the KG and assembles the context bundle. Coordinator just provides the goal.

**Things to hash out:**
- This entry is closely related to "Coordinator context injection standard" earlier in the backlog. Are these the same idea, or does this entry specifically cover the KG-backed assembly vs the general standard?
- The KG query for "relevant files" must happen before the agent starts. What is the latency of this query, and does it add meaningful overhead to session dispatch time?
- "Prior sessions" summaries require the KG to have indexed session notes. Is session note indexing part of the KG build process, or a separate concern?
- If the KG is stale or unavailable at dispatch time, should the session start without a context bundle, or should dispatch be deferred?

---

### Work queue refinements: filtering, catch-all mode, and deadline-aware prioritization (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:2 Lev:1 Con:2 | Blocked: no

**Issue/ticket filtering:** richer than just a label -- filter by project, milestone, assignee, sprint, component. Per-source filter config with `notLabels` exclusion list.

**Catch-all mode:** if `filter` is omitted entirely, WorkTrain pulls everything open and unassigned in the project/repo. Requires explicit `catchAll: true` opt-in + `maxItemsPerCycle` limit.

**Deadline-aware prioritization:** WorkTrain reads deadline context from issue/ticket due dates, epic end dates, sprint end dates, release/milestone dates, and optionally Confluence/Google Calendar. Computes adjusted priority score:
```
deadline_urgency: < 2 days = +3, < 7 days = +2, < 14 days = +1, > 14 days = +0, past due = +4
adjusted_priority = base_priority + deadline_urgency
```

Items are queued in adjusted priority order. A medium-priority task due tomorrow beats a high-priority task due in 3 months.

**Escalation when deadlines are at risk:** if a queue item has a deadline within 48 hours and hasn't been started, the watchdog notifies: bumping to position 1, posting to Slack + message outbox.

**Things to hash out:**
- `base_priority` is referenced in the priority scoring formula but not defined in this entry. Where does base priority come from -- issue labels, explicit priority field, or inferred?
- Reading deadline context from Confluence and Google Calendar requires auth integration. Is this in scope for the initial implementation, or is it a phase 2 concern?
- "Past due = +4" could cause extremely stale tasks to permanently occupy the top of the queue. Is there a cap on urgency boost, or a different treatment for overdue items?
- Bumping a task to position 1 due to deadline urgency could interrupt a work sequence that was deliberately ordered. Who should be notified when an automatic priority bump happens?
- `catchAll: true` pulls all open unassigned items. In an active repo, this could mean hundreds of items entering the queue simultaneously. What is the behavior when `maxItemsPerCycle` is reached?

---

### Workspace pipeline policy: artifact gates vs autonomous decomposition (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 8** | Cor:1 Cap:2 Eff:1 Lev:2 Con:2 | Blocked: no

**The core tension:** some workspaces have rigorous pre-implementation processes (BRD required, design approved, shapeup doc reviewed). Others are solo/small-team projects where you figure it out as you go. WorkTrain should respect both.

**Two workspace modes:**

**Governed mode** -- for projects with existing process gates:
```yaml
pipelinePolicy:
  mode: governed
  requiredArtifacts:
    - type: brd
      sources: [confluence, jira_epic, google_docs]
      searchQuery: "BRD {{ticket.key}}"
  onMissingArtifacts: wait  # 'wait', 'skip', or 'escalate'
  waitCheckInterval: 3600
  waitTimeout: 168h
```

When WorkTrain picks up a ticket and required artifacts aren't found -- holds the ticket in "waiting" state, re-checks hourly, notifies when artifacts appear. When found, automatically extracts context and proceeds, skipping discovery/design phases since those artifacts already contain the answer.

**Autonomous mode** -- for projects without pre-existing process: WorkTrain runs the full pipeline including discovery, UX design, architecture review, and implementation.

**Automatic task decomposition:** when a task is classified as `Large` (or Medium with high complexity), WorkTrain decomposes it into sub-tickets before starting implementation. Sub-tickets are Small or Medium (never Large), added to the queue with `parentTicketId` and `dependsOn` links.

**The "patiently waiting" UX:** console Queue tab shows tickets waiting for artifacts with a distinct state, plus Slack notification when WorkTrain starts waiting and again when artifacts are found.

**Things to hash out:**
- Governed mode's `waitTimeout: 168h` (one week) means a ticket can hold a queue slot for a week. Does waiting hold a concurrency slot, or is it a separate "pending" state outside the concurrency pool?
- Automatic task decomposition into sub-tickets creates GitHub/Jira issues autonomously. Is this acceptable without human review, or should sub-ticket creation be a gate requiring approval?
- "Large = decompose" requires a reliable `Large` classification. What is the cost of a wrong classification that either skips decomposition (too large a task given to one agent) or decomposes unnecessarily (adding overhead)?
- How does the governed vs autonomous mode selection work? Is it a workspace config flag, or does WorkTrain infer the mode from the presence/absence of artifact gates?
- What does "context injection from BRD" look like at the agent level? Is the BRD injected as a reference, a context bundle field, or the full text?

---

### Templates, living docs, and external workflow ingestion (Apr 15, 2026)

**Status: idea** | Priority: medium

**Score: 6** | Cor:1 Cap:1 Eff:1 Lev:1 Con:2 | Blocked: no

**Templates:** WorkTrain knows the templates used in each workspace and applies them automatically. PR templates, Jira ticket templates, design spec templates, BRD templates. Templates are resolved at session start and injected as context. The agent is told "when creating a [type], use this template structure exactly."

**Living docs:** WorkTrain maintains documentation as a first-class output, not an afterthought.
- On-demand: `worktrain doc generate --type architecture-overview --workspace workrail`
- Continuous updates: when code changes, affected docs are flagged for update. `doc-drift-scan` (part of periodic analysis) identifies docs whose described behavior no longer matches the code.

**External workflow ingestion:**
- Workflow registry/marketplace: `worktrain workflow install community/postgres-migration-workflow`
- Org-level workflow libraries: teams publish workflow libraries to a git repo. WorkTrain pulls from it.
- `workflowSources` config: list of git repos + local paths to discover workflows from

**Things to hash out:**
- Template injection ("use this template exactly") is a soft instruction to the LLM. How is compliance verified? If the agent diverges from the template, is that a workflow error or acceptable deviation?
- `doc-drift-scan` requires comparing documentation to code semantically. Is this an LLM-based comparison or a static analysis? What is the false positive rate for "this doc is out of date"?
- The workflow registry/marketplace concept requires trust decisions: which authors, which workflows, what versions are safe to install? Is there a vetting process or is it caveat emptor?
- How does the `workflowSources` config interact with the existing workspace source discovery mechanism? Is this additive or a replacement?
- "Living docs" updated continuously could produce many noisy documentation PRs. Should doc update frequency be throttled, or batched with code PRs?

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
- `ActiveSessionSet` + mid-session steer injection + SIGTERM graceful shutdown (replaces SteerRegistry + AbortRegistry)
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
- runWorkflow() Phase 2 architecture (PR #830): `PreAgentSession`/`buildPreAgentSession`, `constructTools`, `persistTokens` Result type, `sidecardLifecycleFor` pure function, TDZ hazard fix for abort registry
- runWorkflow() Phase 3 architecture (PRs #835, #837): `buildTurnEndSubscriber` (539→426 lines), tool param validation at LLM boundary (8 factories), `buildAgentCallbacks` + `buildSessionResult` pure functions (426→308 lines), test flakiness fix (settleFireAndForget + retry:2)
- runWorkflow() Phase 4 / Track A+B architecture (PRs #839-#869, Apr 29, 2026): six-layer daemon decomposition -- `SessionScope`+`FileStateTracker`, tool extraction to `src/daemon/tools/`, `ContextLoader`+`ContextBundle`, `ActiveSessionSet`+`SessionHandle` (TDZ fix), `buildAgentReadySession`+`runAgentLoop`, `SessionSource`+`AllocatedSession`+full `_preAllocatedStartResponse` removal, `DispatchDeduplicator`, `DeliveryPipeline`, `createCoordinatorDeps`. workflow-runner.ts: 4,955 → 2,800 lines (44%). 38 new unit tests for new abstractions. `ActiveSessionSet` replaces `SteerRegistry`+`AbortRegistry`.

### WorkRail engine / MCP features

**Status: done**

- Assessment gates v1 with consequences
- Loop control -- all four types (`while`, `until`, `for`, `forEach`) implemented
- Fix: sequential `artifact_contract` while loops -- stale stop artifacts from earlier loops no longer contaminate later loops (PR #830). Root cause: `collectArtifactsForEvaluation()` passed full session history to `interpreter.next()`; fix passes only `inputArtifacts` (current step's submitted artifacts).
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

### wr.coding-task architecture enforcement + retrospective (v1.3.0)

**Status: done** -- shipped in PR #830 (Apr 29, 2026)

- Phase 0 architecture alignment check: agent scans candidate files and names philosophy violations explicitly by function name; captures `architectureViolations` and `architectureStartsFromScratch`
- Phase 1c conditional fragment: when `architectureStartsFromScratch = true`, blocks adapting existing violations as valid design candidates
- Phase 8 post-implementation retrospective: runs for all tasks (no complexity gate); four practical questions applicable to any task; requires 2-4 concrete observations with explicit disposition

---

### Worktree and branch lifecycle management

WorkTrain has no tooling to surface the state of worktrees and branches relative to main. Doing this manually today requires running git commands across every registered worktree, cross-referencing merged PR lists, and inspecting each branch's unique commits to determine if the work landed. Pain points observed in practice:

- Worktrees persist after their branch's PR is squash-merged -- no signal that they are safe to delete
- No inventory of which branches have genuinely unmerged work vs. fully superseded content
- Abandoned in-progress branches have no attached context about why they were abandoned or what state they were in
- Daemon-spawned worktrees under `~/.workrail/worktrees/` are opaque -- no indication of which session created them or whether cleanup is safe

**Things to hash out:**
- What is the authoritative source of truth for "is this worktree safe to delete" -- the session store, the git graph, or both?
- Squash-merged branches leave no ancestry trace. What is the detection mechanism? Is it based on PR close status in the GitHub API, or on file-content comparison with main?
- Should the inventory tool be reactive (shows current state on demand) or proactive (daemon monitors worktree state and alerts when stale ones accumulate)?
- How does this entry relate to the "Worktree lifecycle management" and "Git worktrees and branch management" entries elsewhere in the backlog? Are these the same problem captured multiple times, or genuinely different aspects?

---

