# Design Spec: Cooperative Session Completion (No Hard Kill)

**Date:** 2026-05-09  
**Status:** Ready for engineering review  
**Trigger:** Fleet analysis showed wr.discovery succeeds in 17-43 min but fails at 30-min hard kills

---

## 1. Design Decision

**Direction B (Cooperative Completion) chosen** over Direction A (Budget-Aware with hard kill) and Direction C (Progress-based budget).

Direction A still has a hard kill -- it just adds a warning first. Direction C removes wall-clock time as the primary signal without a reliable replacement (step duration is too variable). Direction B fixes the actual contract: the agent and daemon cooperate to end a session cleanly, preserving work done and enabling resumption.

**Core insight from UX review:** A hard timeout is a *resource management* primitive (prevent runaway processes). Workflow management needs a *cooperative completion* contract. These are different things and should not share a single primitive.

**Hard kills are retained for:**
- Stall detection: no LLM API call for N seconds (tool hung or deadlocked)
- Stuck/repeated-tool-call detection: same tool + same args called N times in a row
These remain hard kills because they represent genuine failure modes where the session cannot recover without external intervention.

---

## 2. Information Architecture

### Session outcome hierarchy

The addition of 'paused' creates a new tier that does not fit cleanly alongside current outcomes:

| Tier | Outcomes | Operator action |
|---|---|---|
| Terminal-success | success | Review output |
| Terminal-failure | error, stuck | Diagnose and fix |
| Recoverable | **paused** | Resume, escalate, or abandon |
| Unrecoverable-kill | (hard kills: stall, stuck) | Diagnose and fix |

**Key architectural rule:** 'paused' must never be grouped with terminal-failure outcomes in `worktrain diagnose` or any other operator-facing view. It belongs in a "requires action" tier.

### Semantic migration of 'timeout'

**Breaking change:** 'timeout' currently means "budget-killed by wall clock." After this change, wall-clock budget exhaustion produces 'paused', not 'timeout'. 'Timeout' will mean only: stall-based kills and max-turns kills.

This migration must be documented explicitly. Any tooling or operator mental model that equates 'timeout' with 'budget ran out' will break silently without documentation.

### Content hierarchy of the paused result

When a coordinator or operator encounters a 'paused' session, information must be presented in this order (Zeigarnik: answer the resumption question first):

1. **What is left** -- remaining workflow steps and estimated remaining work
2. **Budget consumed** -- elapsed minutes / total minutes, to inform re-spawn viability
3. **Respawn generation** -- how many times this session chain has been re-spawned (cycle-break signal)
4. **What was done** -- completed steps with per-step notes
5. **Re-entry reference** -- the token needed to resume execution (opaque to the operator but present for coordinator use)
6. **Context variables** -- current workflow context state

---

## 3. Interaction Design

### Budget exhaustion flow (cooperative yield)

```
[Normal agent turn]
  → LLM generates response
  → Tools execute sequentially
  → turn_end subscriber fires
  → Budget check: elapsed >= maxSessionMinutes?
      NO  → steer queue drain → next LLM call (normal)
      YES → cooperative yield sequence:
              1. Write PausedCheckpoint to session store
              2. Call agent.abort() (cancels next LLM call, not current step)
              3. Return WorkflowRunResult { _tag: 'paused', checkpoint: ... }
              4. Coordinator reads result and decides
```

**Critical constraint:** The budget check fires at turn-end, AFTER the current step's tools have completed. The agent always finishes its current turn before yielding. This is the fundamental difference from the hard kill.

### The PausedCheckpoint artifact (carried inline in WorkflowRunResult)

```typescript
interface PausedCheckpoint {
  // Resumption-first ordering (answer 'what's left' before 'what was done')
  remainingStepIds: readonly string[];       // step IDs not yet completed
  budgetConsumedMs: number;                  // how much time was spent
  budgetTotalMs: number;                     // the configured limit
  respawnGeneration: number;                 // 0 = first run, 1 = first re-spawn, etc.
  
  // Re-entry (coordinator needs this to resume without a second store read)
  continueToken: string;                     // opaque, pre-resolved for coordinator use
  
  // What was done
  completedStepIds: readonly string[];       // in completion order
  stepNotes: readonly { stepId: string; notes: string }[];  // per-step, not aggregate
  contextVariables: Readonly<Record<string, unknown>>;
  
  // Metadata
  pausedAt: number;                          // Unix timestamp ms
  checkpointTtlMs: number;                   // expiry; coordinator should not resume after this
}
```

### Coordinator decision interface

On receiving `WorkflowRunResult { _tag: 'paused' }`, the coordinator follows this decision tree:

1. **Cycle-break check:** `respawnGeneration >= maxRespawnGenerations` (configurable, default 3) → escalate
2. **TTL check:** `pausedAt + checkpointTtlMs < now` → abandon (checkpoint stale)
3. **Progress check:** `completedStepIds.length === 0` → escalate (zero-progress, same session would repeat)
4. **Budget viability:** `budgetConsumedMs >= budgetTotalMs * 0.9` with few steps remaining → escalate (next session will also likely run short)
5. **Default:** re-spawn with checkpoint

### `spawn_agent` (blocking tool -- prerequisite change)

**Critical finding:** The current `spawn_agent` tool blocks the parent turn until the child session completes. With the cooperative yield model, the budget check fires at turn-end -- but if `spawn_agent` takes 45 minutes, the turn never ends. The budget is effectively advisory for delegation-heavy sessions.

**Required prerequisite:** `spawn_agent` must become async-by-default, or receive a per-tool-call cancellation token that the budget enforcer can signal. Two options:

Option A (async spawn_agent): `spawn_agent` enqueues the child session and returns immediately with a handle. The parent turn ends normally. Budget check fires. On the next turn, the agent can check the handle status. This changes the agent's programming model significantly.

Option B (cancellation token): Pass the session's budget-remaining as a timeout to `spawn_agent`'s child session creation. The child inherits a budget that ensures it completes before the parent runs out. This doesn't fully solve the problem but contains the damage.

**This prerequisite must be resolved before implementing the cooperative completion model.** Without it, the model only helps sessions that don't use delegation.

---

## 4. States

### Session lifecycle states

| State | Description | Coordinator action | TTL |
|---|---|---|---|
| running | Agent loop active | None | — |
| paused | Budget exhausted cooperatively | Decide: re-spawn / escalate / abandon | checkpointTtlMs |
| paused_unrecoverable | Budget exhausted but checkpoint write failed | Treat as timeout | None |
| success | Workflow completed | Deliver | — |
| error | Tool/engine failure | Diagnose | — |
| stuck | Repeated tool loop | Diagnose | — |
| timeout | Stall or max-turns kill (NOT budget exhaustion after this change) | Diagnose | — |
| abandoned | paused TTL expired or coordinator decided to abandon | Archive | — |

### Checkpoint write failure states

If the checkpoint write fails:
- Session yields `paused_unrecoverable` (distinct from `paused`)
- `WorkflowRunResult._tag = 'paused_unrecoverable'` carries no checkpoint
- Coordinator treats it as `timeout` (terminal, non-resumable)
- `worktrain diagnose` shows: "Session paused but checkpoint could not be written -- treat as timeout"

### Zero-progress paused state

If `completedStepIds.length === 0`:
- `PausedCheckpoint` still written (records what context was accumulated)
- `contextVariables` may carry partial state from an incomplete step -- coordinator must NOT pass this directly as resume context; it should start the session fresh with only the original trigger goal
- Coordinator escalates by default rather than re-spawning

### SIGKILL / process crash

No terminal event is written. `worktrain diagnose` shows ORPHANED. Indistinguishable from current behavior. **Heartbeat events** (daemon writes `daemon_heartbeat` every 30 seconds -- already implemented) allow operator to distinguish "session is running" from "process was killed."

### Stale checkpoint (TTL expired)

- Coordinator checks `pausedAt + checkpointTtlMs < now` before deciding to re-spawn
- If expired: abandons with a note in the outbox
- `checkpointTtlMs` default: 4 hours (configurable)
- After expiry, session is marked `abandoned`; checkpoint is retained for audit but not actionable

---

## 5. Operator-facing content (worktrain diagnose)

### New outcome label

```
[PAUSED]  sess_abc123  wr.discovery  Started: Fri 23:47  42m 15s  [STOPPED]

DIAGNOSIS: PAUSED -- budget exhausted cooperatively

  Completed:  7 of 23 steps (phase-0-reframe through phase-3b-candidates-deep)
  Remaining:  16 steps (phase-3c-candidates-deep-core through phase-7-handoff)
  Budget:     42m 15s of 55m used (77%)
  Generation: 0 (first run, not a re-spawn)

  Action:    Coordinator will re-spawn with checkpoint if within budget.
             Run: worktrain diagnose --session-chain <id> to see full chain.
```

### Semantic migration note (first appearance)

When 'timeout' is narrowed to stall/max-turns only:
```
[TIMEOUT]  sess_def456  wr.discovery  ...  [STOPPED]

DIAGNOSIS: TIMEOUT -- stall detected (no LLM call for 120s)

  Note: 'timeout' now means stall or max-turns only.
        Budget exhaustion produces [PAUSED] instead.
        See: worktrain diagnose --help for outcome meanings.
```

### Coordinator decision trail

New `worktrain diagnose --session-chain <id>` flag shows the full respawn chain:
```
Session chain for wr.discovery task "implement X":
  sess_aaa  gen=0  paused at step 7  →  re-spawned (coordinator)
  sess_bbb  gen=1  paused at step 14  →  re-spawned (coordinator)
  sess_ccc  gen=2  success at step 23
```

---

## 6. Reviewer Findings Addressed

| Finding | Severity | Resolution |
|---|---|---|
| spawn_agent blocks turn indefinitely | Critical | Prerequisite: async spawn_agent or cancellation token required before implementing this design |
| Coordinator needs checkpoint inline in paused result | Critical | PausedCheckpoint carried inline in WorkflowRunResult, includes pre-resolved continueToken |
| No re-spawn cycle-break | Critical | respawnGeneration field in checkpoint; coordinator checks maxRespawnGenerations before re-spawning |
| paused grouped with failure outcomes in diagnose | Major | Separate 'recoverable' tier in worktrain diagnose output |
| No coordinator decision trail visible | Major | worktrain diagnose --session-chain flag |
| Checkpoint missing budget-consumed field | Major | budgetConsumedMs and budgetTotalMs in PausedCheckpoint |
| timeout semantic migration breaking change | Major | Documented explicitly; 'timeout' narrowed to stall/max-turns only; operator note in diagnose output |
| Checkpoint artifact ordering (Zeigarnik) | Major | PausedCheckpoint fields ordered: remaining → budget → generation → completed → re-entry → context |
| Checkpoint write failure | Major | paused_unrecoverable outcome; treat as timeout |
| SIGKILL produces no terminal event | Major | Existing daemon_heartbeat events address this; no new mechanism needed |
| Zero-progress checkpoint carries corrupted context | Major | Coordinator does NOT pass contextVariables from zero-progress checkpoints; escalates instead |
| No TTL on paused state | Major | checkpointTtlMs field; coordinator abandons after expiry |
| Stall/slow-tool boundary ambiguous | Major | Stall = no LLM call for N seconds (inter-turn idle, not during tool execution); documented explicitly |
| Two-primitive lifecycle (Tesler) | Minor | Justified; boundary between healthy pause and degenerate slow-progress surfaced via steps-per-turn signal in checkpoint |
| operator-facing language: checkpoint not pause | Minor | CLI output uses 'budget exhausted cooperatively' and 'checkpoint' vocabulary, not just 'paused' |

---

## 7. Open Questions Requiring Human Decision

1. **async spawn_agent design:** Option A (returns handle, agent polls) vs Option B (child inherits parent's remaining budget). Option A changes the agent's programming model significantly -- is that acceptable? This is a prerequisite that needs a separate design before this spec can be implemented.

2. **maxRespawnGenerations default:** 3 is proposed. Is this the right ceiling for production use, or should it be per-workflow?

3. **checkpointTtlMs default:** 4 hours is proposed. For overnight sessions this may be too short. Should it be per-trigger configurable?

4. **'timeout' narrowing:** Operators who currently diagnose issues using 'timeout' as a signal for "budget ran out" will need to migrate to 'paused'. Is there a migration period where 'timeout' is kept for backward compat, or a clean break?

5. **`worktrain diagnose --session-chain`:** Does this belong on `diagnose` or on a new `worktrain chain` command?

---

## What requires human review

**Architecture decision (not verifiable by this workflow):**
- The async spawn_agent prerequisite is a significant behavioral change to how workflows use delegation. The right design for it requires understanding how `wr.discovery` phase-3b currently relies on blocking spawn_agent -- specifically, whether the workflow's logic depends on the child completing before the parent continues, or whether async would break the workflow's reasoning.

**Not verified by this workflow:**
- Whether the proposed `PausedCheckpoint` fields are sufficient for the coordinator to make good decisions in practice (requires real session data)
- Whether operators will understand the 'paused' vs 'timeout' distinction without training (requires usability observation)
- The correct `checkpointTtlMs` and `maxRespawnGenerations` values for production (requires empirical calibration)
