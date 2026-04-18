# Discovery: spawn_agent Failure Modes and Multi-Agent Coordination

## Context / Ask

**Original goal:** Discovery (precedent + failure modes angle): what can we learn from how spawn_agent actually works today, what failure modes exist, and what do competitors/references do for multi-agent coordination?

**Problem statement:** WorkTrain needs a coordinator that can spawn fix agents, await their results, and act on outcomes -- but the failure modes of that coordination loop are not yet cataloged, and no precedent has been reviewed to validate the design choices.

**Desired outcome:** A failure mode catalog with recommended mitigations, a "minimum viable robustness" checklist, and concrete precedent from reference architectures that directly applies to WorkTrain's coordinator design.

## Path Recommendation

**Chosen path:** `landscape_first`

**Rationale:** The dominant need is grounding -- understanding how spawn_agent actually works in the current codebase, what the existing error paths look like, and what reference architectures did for similar coordination problems. Reframing is secondary (the problem is already well-scoped). Design work comes after this grounding, not before.

Alternative paths considered:
- `full_spectrum`: Would add a reframing step, but the problem is already well-framed. The original goal is problem-shaped, not solution-shaped.
- `design_first`: Wrong here -- the risk is not solving the wrong problem, it is shipping a coordinator with unhandled failure modes.

## Constraints / Anti-goals

**Core constraints:**
- WorkTrain's first real run must not embarrass the project -- robustness over cleverness
- The coordinator must work with spawn_agent as it exists today, not a hypothetical redesign
- Depth limiting must account for real timeout/hang scenarios, not just recursion counts

**Anti-goals:**
- Do not over-engineer for theoretical failure modes that have no evidence in the codebase
- Do not adopt reference architecture patterns wholesale -- extract the principle, not the mechanism
- Do not build a new event bus, message queue, or distributed coordination layer

**Primary uncertainty:** Whether the current timeout path in worktrain-await.ts actually terminates cleanly when a spawned session hangs at max_turns.

**Known approaches to multi-agent coordination (to evaluate):**
- OpenClaw nexus-core: referenced in backlog deep-dive
- pi-mono: referenced in backlog
- Semaphore-based depth limiting (current WorkRail approach)
- Polling loop with not_awaited outcome (current worktrain-await approach)

## Artifact Strategy

This document is a **human-readable artifact** -- it is for people to read and reference. It is NOT execution memory.

- Execution truth lives in WorkRail step notes and context variables.
- If a chat rewind occurs, the durable notes/context survive; this file may not.
- This file is updated at each research step for readability, but workflow state does not depend on it.

## Capability Status

- **Delegation (subagent spawning):** Available via `mcp__nested-subagent__Task`
- **Web browsing:** Not available (WebFetch tool not active); all research is from codebase and checked-in docs only

## Landscape Packet

### spawn_agent mechanics (makeSpawnAgentTool)

**Function:** `makeSpawnAgentTool` in `src/daemon/workflow-runner.ts:1415-1591`

**Four error paths:**
1. **Depth limit exceeded (pre-spawn):** Synchronous check `currentDepth >= maxDepth`. Returns `{outcome: 'error', childSessionId: null}`. No child created. Fail-fast.
2. **Child session start failure:** `executeStartWorkflow()` returns `Err`. Returns `{outcome: 'error', childSessionId: null}`.
3. **Token decode failure (silent):** `parseContinueTokenOrFail()` fails -- logs a console warning, but child session still runs with `childSessionId: null`. Zombie risk: session runs but coordinator cannot trace it.
4. **WorkflowRunResult variants:** `success` -> `'success'`; `error` -> `'error'`; `timeout` -> `'timeout'`; `delivery_failed` -> **`'success'`** (silent bug: work done, notification failed, treated as success).

**Depth limit enforcement:**
- Depth is passed as a closure parameter, not a global semaphore or counter.
- Each tree path enforces independently. Siblings at the same depth do NOT share a pool.
- Default `maxDepth = 3` (line 2207). Root sessions start at depth 0 (line 2206).
- Enforcement is per-tree-path, not global.

**Semaphore bypass:**
- `dispatch()` uses a global Semaphore for concurrency limiting.
- `makeSpawnAgentTool` calls `runWorkflow()` directly -- **bypasses the semaphore entirely**.
- Reason (in code comment): dispatch() is fire-and-forget; calling it from inside a running session would deadlock.
- Child sessions pass `undefined` for `daemonRegistry` -- invisible to `worktrain status` and console live-session heartbeat.
- Consequence: a single root session can spawn multiple children that are all untracked by daemon tooling.

**Not used in practice:** Session store search found no spawn_agent calls in 3,278 daemon events (Apr 17-18 2026). Analysis is code-only, not runtime-observed.

### worktrain-await.ts

**Poll interval:** 3000ms (3 seconds). Configurable via `opts.pollInterval` for tests.

**Default timeout:** 30 minutes (1,800,000ms). Accepts duration strings like `"30m"`, `"1h"`, `"90s"`.

**Timeout handling:** Timeout is checked once per loop iteration (not per session poll). When timeout fires:
- All remaining pending sessions marked `{outcome: 'timeout', status: null}`.
- Loop breaks immediately.
- Exit code 1.
- The coordinator receives `'timeout'` -- then what? See failure mode catalog.

**`not_awaited` outcome:** Only fires when `--mode any`. When first session returns `success`, all other pending sessions are marked `not_awaited` with `status: null`. They were still running and healthy -- we just stopped waiting. Exit code 0.

**Race conditions identified:**
1. **No atomic timeout per session (high-risk):** Timeout check runs once per loop, not per poll call. If 10 sessions are polled serially and network is slow, sessions 6-10 may timeout before being polled that round. The durationMs recorded reflects when the check ran, not when each session was last polled.
2. **Concurrent timeout + poll result (low-risk):** Network delay between polling session A and session B could push next iteration past timeout boundary. Window is negligible at 3s poll / 30m timeout.
3. **`--mode any` early exit with stale status (by design):** Session B may have completed 1ms after Session A but gets marked `not_awaited`. This is intentional for latency optimization.

### Reference architectures

**OpenClaw (nexus-core)** -- Interactive, session-coordination system (NOT batch/DAG)
- `AcpSessionStore`: In-memory, 5k sessions, 24h TTL, LRU eviction. Not durable.
- `SessionActorQueue`: Serializes messages per session to prevent concurrent modification.
- `SpawnAcpParams`: Minimal spawn API (task, label, agentId, resumeSessionId, cwd, mode).
- Task flow chaining: workflow A completion auto-triggers workflow B via `linkTaskToFlowById`.
- **Transferable:** Session actor queue pattern (serialization per session).
- **Not transferable:** In-memory store (violates WorkRail's durability guarantee).

**pi-mono** -- Library of coordination primitives (not a system)
- `agentLoop()` returns `EventStream<AgentEvent, AgentMessage[]>` -- handles multi-turn without context degradation.
- `BeforeToolCallResult`: Can block a tool call with a reason.
- `AfterToolCallResult`: Can override tool result content.
- `ChannelQueue` (KeyedAsyncQueue): Serializes messages per channel.
- **Transferable:** Tool call hooks pattern (block/override tool calls from coordinator level).
- **Not transferable:** Entire library (WorkRail has its own agent loop).

**Claude Code (closest analog)** -- Interactive IDE agent with coordinator/subagent model
- Coordinator holds tokens; subagents report via durable store (not context).
- `PreToolUse` / `PostToolUse` hooks for evidence collection.
- Three compaction tiers: session memory > full compaction > microcompaction.
- **Transferable:** State-via-store pattern (WorkRail already does this). Evidence collection hooks.

**LangGraph** -- Batch/DAG pipeline (LOW comparability)
- Time-travel checkpointing (`fork` source) -- useful for WorkRail's rewind feature.
- Interrupt mechanism: node re-runs from scratch on resume (requires idempotency) -- NOT how WorkRail works.
- **Not transferable:** Core interrupt/resume model.
- **Partially transferable:** Checkpoint fork pattern.

**Temporal.io** -- Event-sourced code-defined workflows (MEDIUM comparability)
- Worker polling vs webhook push model.
- Workflow versioning via `patched()`.
- **Transferable:** Crash recovery patterns, namespace isolation for multi-tenant.

**Assumption revision:** Assumption 2 (reference architectures are batch/DAG systems) was partially wrong. OpenClaw and Claude Code are interactive session-coordination systems, making them more comparable than expected. This strengthens the transferability of their patterns.

## Problem Frame Packet

**Reframed problem:** What is the minimum coordinator design that handles the real failure modes in spawn_agent today, informed by precedent, without over-engineering for failures not yet observed?

**Primary stakeholders:**
- Etienne (WorkTrain developer and primary user) -- needs the coordinator to work on the first real run, robustness over cleverness
- WorkTrain session initiators running autonomous fix pipelines -- need predictable outcomes and visible failures

**Core tension:** The coordinator must be robust enough to handle failure modes, but WorkTrain's explicit anti-goal is "don't over-engineer." The minimum viable robustness point is: handle failures that would silently corrupt the coordinator's state or leave orphaned sessions. Adding observability, atomic timeouts, and session tracking beyond that is premature optimization.

**Framing risks:**
1. The coordinator doesn't exist yet -- all failure mode analysis covers infrastructure (spawn_agent + worktrain-await). The real design decisions happen in the coordinator layer, which is the missing piece. We may be analyzing the wrong layer.
2. spawn_agent has never been used in practice (0 calls in 3,278 daemon events) -- all identified failure modes are theoretical. A real run may surface completely different issues.
3. The "first real run must not embarrass" constraint could push toward over-engineering -- the right balance is a coordinator that fails loudly (not silently) and stops cleanly.

**HMW questions:**
- How might we design a coordinator that degrades gracefully when a spawned session times out, without requiring the coordinator to know why it timed out?
- How might we make spawn_agent's zombie risk (silent token decode failure) visible without requiring daemon tooling changes?

**Challenged assumptions (updated after landscape research):**
1. spawn_agent mechanics are the right research focus -- partially confirmed: coordinator protocol level is where the real design decisions happen, but spawn_agent has real silent failure modes that need fixing
2. Competitor/reference architectures are batch/DAG systems -- WRONG: OpenClaw and Claude Code are interactive session-coordination systems. Comparability is higher than assumed.
3. Depth=3 is the right safety boundary -- confirmed: the real question is timeout robustness, not depth arithmetic. A depth-1 coordinator can hang if the spawned session hangs.

## Candidate Directions

### Candidate Generation Expectations

This is a `landscape_first` + `THOROUGH` pass. Candidates must:

1. **Anchor to landscape precedents.** Each candidate must reference at least one observed precedent (OpenClaw, pi-mono, Claude Code, worktrain-await design, or spawn_agent behavior) -- not free invention.
2. **Cover the failure mode space.** The 5 decision criteria must be addressed by at least one candidate each. No criterion can be unaddressed across the whole set.
3. **Spread across the simplicity-completeness axis.** At least one candidate at each pole: a minimal wrapper that adds almost nothing, and a structured handoff protocol that addresses all 5 criteria.
4. **THOROUGH push:** If the first spread feels clustered around the middle, add one more candidate that is either maximally simple (borderline too simple) or takes a structurally different approach to the termination guarantee problem.
5. **No invented infrastructure.** Candidates must not require new daemon tooling, event buses, or message queues. They must work with spawn_agent and worktrain-await as they exist today.

### Candidates

*To be populated in candidate-generation step.*

## Challenge Notes

*To be populated after research.*

## Resolution Notes

### Recommendation

**v1 coordinator design: 5 components, no new infrastructure, all justified by evidence.**

1. **Infrastructure fix:** Change `delivery_failed` to return `outcome: 'error'` (not `'success'`) in `makeSpawnAgentTool` (~line 1580 of `src/daemon/workflow-runner.ts`). This is the highest-consequence silent failure. One-line change. **This is a hard blocker -- coordinator must not ship without it.**

2. **Hardcoded child session timeout:** Pass `agentConfig: { maxSessionMinutes: 15 }` in all spawn triggers. No LLM arithmetic. The hardcoded value is conservative but correct under uncertainty (being too conservative is recoverable; no timeout is not).

3. **Coordinator rule -- null childSessionId:** After spawn, if `childSessionId === null` with any outcome, treat as error. This catches the token decode failure zombie case (separate from the delivery_failed fix).

4. **Coordinator rule -- go/no-go time check:** Before spawning, if remaining session time < 20 minutes, do not spawn. Return error with reason "insufficient session time remaining." Prevents coordinator death in edge cases without LLM arithmetic.

5. **Layer D traceability:** Record spawn result JSON block in step notes BEFORE acting: `{ childSessionId, outcome, notes (truncated), spawnedAtEpochMs, durationMs }`. Step notes ARE injected into subsequent steps (MAX_SESSION_RECAP_NOTES=3 mechanism confirmed in code). This enables observability on first real run.

### Strongest Alternative (Runner-Up)

**B+C+D composition:** Coordinator-owned timeout budget (Layer B) + CoordinatorSpawnResult discriminated type (Layer C) + notes-as-retry-ledger (Layer D). Correct for v2 after empirical data. Loses for v1 because Layer B has silent failure modes (LLM arithmetic) and Layer C is a prompt-level workaround for a one-line infrastructure bug.

### Confidence Band

**HIGH.** Direction is grounded in code reading, challenged by an adversarial reviewer, and confirmed by design review. The challenger's false positive (Layer D notes not readable) was refuted by code evidence.

### Residual Risks

1. **Empirical validation of 15-min timeout.** The value is a heuristic. Real fix agents may need more or less time. Revisit after 3 real runs.

2. **delivery_failed frequency unknown.** Zero spawn_agent calls in 3,278 daemon events. The delivery_failed -> success bug is a real code path but may never fire in typical usage. The infra fix is still correct architecture, but urgency is not yet validated empirically.

### Constraints on Selected Direction

- **Single-spawn per coordinator session.** Multi-spawn (diagnose + fix + verify) requires Layer B (dynamic budget) and is a v2 concern. This constraint must be explicit in the coordinator design spec.
- **Infra fix is a hard blocker.** Do not ship coordinator without the delivery_failed -> error fix.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-18 | Path: landscape_first | Dominant need is grounding in current code and precedent, not reframing |
| 2026-04-18 | v1 coordinator: infra fix + hardcoded timeout + notes traceability | spawn_agent unused in practice (0 calls). B+C+D composition over-engineered for v1. Layer C is a prompt-level workaround for a one-line infrastructure bug. Layer B relies on LLM arithmetic with silent failure mode. Layer D (notes) does work (notes are injected) but retry is premature. v2 can add dynamic budgeting and result type mapping after observing real usage. |
| 2026-04-18 | Runner-up: B+C+D composition | Correct for v2+ after empirical data from real runs. Not justified for v1 on theoretical grounds alone. |

## Final Summary

### Selected Path
`landscape_first` -- grounding in current spawn_agent code and reference architecture comparisons. The problem was already well-framed; no reframing step needed.

### Problem Framing
WorkTrain needs a coordinator that can spawn fix agents, await results, and act on outcomes. The failure modes of that coordination loop are not yet cataloged. The real design seam is the coordinator layer (which doesn't exist yet), not spawn_agent infrastructure (which does).

### Landscape Takeaways
- spawn_agent bypasses the global semaphore (direct runWorkflow call, not dispatch). Child sessions are invisible to daemon tooling.
- `delivery_failed` is explicitly mapped to `outcome: 'success'` in makeSpawnAgentTool -- a silent failure the coordinator must guard against.
- Token decode failure proceeds with `childSessionId: null` and `outcome: 'success'` -- a separate zombie case.
- Reference architectures (OpenClaw, Claude Code) are interactive session-coordination systems, not batch/DAG pipelines. They are more comparable than initially assumed.
- Most transferable patterns: pi-mono tool call hooks, OpenClaw session actor queue, Claude Code state-via-store model (WorkRail already uses this).
- spawn_agent has never been used in practice (0 calls in 3,278 daemon events). All analysis is code-only.

### Chosen Direction
**v1: Infrastructure fix + hardcoded timeout + 4 coordinator rules**

1. Fix `delivery_failed -> 'error'` in `makeSpawnAgentTool` (hard blocker -- must ship with coordinator)
2. Hardcode `agentConfig: { maxSessionMinutes: 15 }` in all spawn calls
3. Coordinator rule: `childSessionId === null` with any outcome = error
4. Coordinator rule: go/no-go check -- if < 20 min session time remaining, do not spawn
5. Layer D: record spawn result JSON in step notes before acting

**Key constraint:** Single-spawn per coordinator session. Multi-spawn requires Layer B (v2).

### Strongest Alternative (Runner-Up)
B+C+D composition: coordinator-owned timeout budget (Layer B) + CoordinatorSpawnResult type mapping (Layer C) + notes-as-retry-ledger (Layer D). Loses for v1 because Layer B has silent failure modes (LLM arithmetic) and Layer C is a workaround for a one-line infrastructure bug.

### Why It Won
- Infrastructure fix addresses the root cause at the correct abstraction layer (not a prompt-level workaround)
- Hardcoded timeout eliminates silent failure mode of LLM arithmetic
- No speculative abstractions -- every component is justified by identified failure mode
- Adversarial review validated 3 of 4 components; false positive on Layer D was refuted by code evidence

### Confidence Band
HIGH. Direction grounded, challenged, reviewed, confirmed. Remaining gaps are empirical.

### Failure Mode Catalog

| # | Failure Mode | Mechanism | Severity | Mitigation | Status |
|---|-------------|-----------|----------|------------|--------|
| FM1 | delivery_failed treated as success | makeSpawnAgentTool maps delivery_failed -> 'success' | HIGH | Fix in infrastructure: return outcome: 'error' | Required (hard blocker) |
| FM2 | Zombie session (null childSessionId) | Token decode failure proceeds silently with childSessionId: null and outcome: 'success' | HIGH | Coordinator rule: treat null childSessionId as error | Required |
| FM3 | Spawned session hangs at max_turns | No bounded timeout on spawned session | HIGH | Hardcode maxSessionMinutes: 15 | Required |
| FM4 | Coordinator dies waiting for child | Nested timeout: coordinator and child have same timeout budget | HIGH | Go/no-go check: < 20 min remaining = don't spawn | Required |
| FM5 | Fix agent introduces new bug | Coordinator has no way to verify fix quality | MEDIUM | Out of scope for v1; requires verification spawn | Accepted / v2 |
| FM6 | Concurrent coordinators on same repo | spawn_agent bypasses semaphore | MEDIUM | WorkRail session queue prevents races at higher level | Already handled |
| FM7 | worktrain-await race condition | Timeout checked once per loop, not per poll | LOW | Negligible at 15-min sessions / 3s poll | Accepted (file as separate bug) |
| FM8 | Context compaction strips retry state | Context variables may be compacted | MEDIUM | Layer D: step notes are durable (MAX_SESSION_RECAP_NOTES=3 injects prior notes) | Mitigated |

### Minimum Viable Robustness Checklist

A pre-ship reviewer can use this to verify coordinator v1 is ready:

- [ ] **Infrastructure fix landed:** `makeSpawnAgentTool` returns `outcome: 'error'` for `delivery_failed` (not `'success'`). Check `src/daemon/workflow-runner.ts` ~line 1580.
- [ ] **Hardcoded timeout set:** All spawn triggers in the coordinator pass `agentConfig: { maxSessionMinutes: 15 }`. No dynamic calculation.
- [ ] **Null childSessionId check present:** Coordinator explicitly checks `childSessionId !== null` before treating outcome as success. If null, treats as error.
- [ ] **Go/no-go check present:** Coordinator checks remaining session time before spawning. If < 20 minutes, returns error without spawning.
- [ ] **Spawn record written to notes:** Before acting on spawn result, coordinator writes a JSON record to step notes: `{ childSessionId, outcome, elapsedMs }`.
- [ ] **Single-spawn constraint documented:** Coordinator design spec explicitly states this coordinator makes one spawn per session. Multi-spawn is not supported.
- [ ] **Real run performed:** At least 1 real coordinator session run before declaring v1 stable. Timeout values revisited after.

### Reference Architecture Precedents Applied

| System | Pattern | Applied In |
|--------|---------|------------|
| OpenClaw | Session actor queue: serialize messages per session | WorkRail's DaemonSessionManager already does this |
| pi-mono | Tool call hooks: BeforeToolCallResult / AfterToolCallResult | Evidence gating pattern (v2 concern) |
| Claude Code | State-via-store: subagents report to durable store, not context | Already in WorkRail's design; coordinator uses session store, not context |
| LangGraph | Time-travel checkpointing | WorkRail's checkpoint/rewind feature (existing) |
| nexus-core | Knowledge injection before each LLM call | WorkRail's session recap (MAX_SESSION_RECAP_NOTES) does this |

### Next Actions

1. **Now:** Fix `delivery_failed -> 'error'` in `makeSpawnAgentTool`. This is the infrastructure fix that unblocks coordinator design.
2. **Now:** Design coordinator workflow with the 4 coordinator rules above. Use `design-candidates-spawn-agent.md` as the design spec.
3. **After first 3 real runs:** Revisit 15-min timeout value. File worktrain-await race condition as a separate bug.
4. **v2:** Add Layer B (dynamic timeout budgeting at infrastructure level, not LLM arithmetic) and multi-spawn support.

### Residual Risks

1. 15-min timeout value is a heuristic with no empirical validation. May be too conservative or too liberal.
2. delivery_failed frequency unknown in practice (0 production spawn calls). The fix is correct architecture regardless.

