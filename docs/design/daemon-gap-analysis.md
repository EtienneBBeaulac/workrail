# Daemon Gap Analysis: WorkRail vs Competitor Reference Architectures

**Date:** 2026-04-14
**Path Recommendation:** landscape_first
**Rationale:** The task is fundamentally comparative -- the existing implementation is partially built, the competitor research is complete, and the dominant risk is missing gaps rather than mis-framing the problem. A landscape_first pass (map what exists, map what competitors do, diff) is the right structure. full_spectrum would add overhead without new insight here.

---

## Artifact Strategy

This document is a human-readable reference for gap findings. It is NOT execution truth for the workflow -- that lives in step notes and context variables. If notes and this doc conflict, notes win.

**delegationAvailable:** yes (mcp__nested-subagent__Task available)
**webBrowsingAvailable:** yes (WebFetch available)
**Why neither was used:** All source material is local (backlog.md + source files). Delegation and web browsing would add latency without new information. The fallback (read files directly) is sufficient and faster.

---

## Context / Ask

Compare WorkRail's autonomous daemon implementation (`src/daemon/workflow-runner.ts`, `src/trigger/`) against the competitor research captured in `docs/ideas/backlog.md` (OpenClaw, pi-mono, nexus-core). Identify concrete gaps with severity ratings and suggested fixes.

---

## Landscape Packet

### Landscape Summary

**Existing approaches / precedents:**
1. **OpenClaw `deliveryContext`**: bind delivery target at spawn time, not completion time -- crash-safe routing
2. **nexus-core `SOUL.md`**: behavioral principles injected into every agent session system prompt
3. **nexus-core `inject-knowledge.sh`**: ancestry recap + repo context injected before each LLM call
4. **pi-mono `agent.steer()`**: step injection via steer (not followUp) -- already adopted correctly
5. **OpenClaw `KeyedAsyncQueue`**: serialize per session (not per trigger type) to prevent token corruption

**Hard constraints from the world:**
- `daemon-state.json` temp-rename pattern is correct (atomic write) -- do not change the write side
- In-process engine model is decided and locked -- daemon must share DI with MCP server
- pi-mono `Agent` class is already the loop driver -- do not replace it

**Notable contradictions:**
1. **GAP-1 vs backlog claim**: Backlog says "crash recovery invariant" -- but there is no reader. The write side exists, the read side does not.
2. **GAP-5 vs OpenClaw pattern**: Backlog says "serialize per session ID." Implementation serializes per trigger ID. These are different semantics.
3. **GAP-2 vs system prompt comment**: `buildSystemPrompt` has a `sessionState` parameter and the `<workrail_session_state>` XML block -- clearly intended to be populated -- but always receives an empty string.

**Evidence gaps (what could not be verified from local files):**
- Whether `agent.steer()` fires correctly inside pi-mono's Agent loop after each tool batch (depends on pi-mono internals; the backlog has a correction documenting this is correct, but the pi-mono source is not in this repo)
- Whether `executeStartWorkflow`'s third argument (`internalContext`) is correctly written to the session store as a `context_set` event (would require reading `src/mcp/handlers/v2-execution/start.ts` more deeply)

---

### What is built

**`src/daemon/workflow-runner.ts`** (~550 LOC)
- `runWorkflow(trigger, ctx, apiKey)` calls WorkRail's engine in-process via `executeStartWorkflow` / `executeContinueWorkflow`
- Uses `@mariozechner/pi-agent-core` `Agent` class as the loop driver
- `agent.steer()` for step injection (correct -- not `followUp()`)
- `persistTokens()` atomically writes `continueToken + checkpointToken` to `~/.workrail/daemon-state.json` via temp-rename pattern -- called before returning from each `continue_workflow` tool call
- Injects `is_autonomous: 'true'` via the third argument to `executeStartWorkflow` (maps to `internalContext` -> `context_set` event in session store)
- System prompt includes a `<workrail_session_state>` XML block (content is empty string at Agent construction -- not populated from prior session notes at this time)
- No `sessionId` stored in `daemon-state.json` -- only `continueToken + checkpointToken + ts`

**`src/trigger/trigger-router.ts`** (~250 LOC)
- `KeyedAsyncQueue` IS wired in -- `private readonly queue = new KeyedAsyncQueue()` at line 177, `this.queue.enqueue(trigger.id, ...)` at line 233
- Serializes concurrent webhooks per `triggerId` (correct key -- prevents token corruption for same-trigger concurrent fires)
- On completion/failure: `console.log()` to stdout only -- no delivery back to trigger source
- No `deliveryContext` stored at session creation

**`src/trigger/trigger-store.ts`** (~460 LOC)
- Narrow hand-rolled YAML parser (no external dependency)
- Secret resolution via `$ENV_VAR_NAME` pattern
- Only `generic` provider supported
- No `deliveryContext` or `triggerSource` fields in `TriggerDefinition`

**`src/trigger/trigger-listener.ts`** (~240 LOC)
- Express server on port 3200
- `POST /webhook/:triggerId` -> `router.route()` -> 202
- Feature-flagged behind `WORKRAIL_TRIGGERS_ENABLED=true`
- No daemon restart / crash-recovery path

### What competitors do (relevant to gaps)

**OpenClaw:**
- `deliveryContext` bound at spawn time (`SpawnAcpParams.thread`): delivery target stored so post-crash restart can still route results
- `DaemonRegistry` (`RuntimeCache`): in-memory map of active sessions with `lastTouchedAt` for heartbeat/GC
- `TaskNotifyPolicy`: `done_only | state_changes | silent` -- configurable per-trigger notification behavior
- Session persistence is in-memory only (LRU, 24h TTL) -- WorkRail's disk store is already better here
- No SOUL.md or behavioral principles injected into agent sessions

**nexus-core:**
- `SOUL.md`: behavioral principles (not just workflow steps) injected into every agent session system prompt
- `inject-knowledge.sh`: before each Claude API call, inject ancestry recap + `~/.workrail/knowledge/` + repo `.workrail/context.md`
- Session lifecycle hooks: `session-start` injects context; `session-end` writes checkpoint atomically

**pi-mono:**
- `agent.steer()` is the correct loop control (confirmed -- WorkRail uses this correctly)
- `afterToolCall` pattern recommended for token persistence (WorkRail does this in tool `execute()` -- equivalent)
- `mom` pattern: one `Agent` instance per session, reconstructed from store on each run -- WorkRail creates `new Agent()` per `runWorkflow()` call (correct)

---

## Gap Analysis

### GAP-1: No crash recovery path reads daemon-state.json back

**Severity: BLOCKER**

`persistTokens()` writes `continueToken + checkpointToken` atomically. But there is no code anywhere in the codebase that reads `daemon-state.json` on restart. The backlog notes describe this as "tokens written before each step -- crash recovery invariant," but the invariant is only half-implemented.

**What happens on restart after a crash mid-step:**
1. Daemon process restarts (triggered by systemd, supervisor, or manual restart)
2. A new webhook fires -- `trigger-router.ts` calls `runWorkflow()` with a fresh trigger
3. The interrupted session from before the crash is never resumed -- the `checkpointToken` in `daemon-state.json` is ignored
4. The interrupted session is orphaned: the session lock eventually expires (stale-lock detection), but the session's work is lost

**What's needed:**
- A `DaemonStateStore` module with `readState(): Promise<DaemonState | null>` and `clearState(): Promise<void>`
- At daemon startup (before accepting triggers), check if `daemon-state.json` exists
- If it does: attempt to resume via `executeContinueWorkflow({ continueToken, intent: 'rehydrate' })` -- or pass the `checkpointToken` as `resumeCheckpointToken` to a fresh `runWorkflow()` call
- After successful resume or explicit abandon: clear `daemon-state.json`
- The `daemon-state.json` should also store `sessionId` (not currently stored) so the resume path can log which session is being recovered

**Suggested fix in `workflow-runner.ts`:**
```typescript
const state = JSON.stringify(
  { continueToken, checkpointToken, sessionId: trigger.workflowId, ts: Date.now() },
  null, 2
);
```
Add `readDaemonState()` and `clearDaemonState()` exports. Wire into a `src/daemon/startup-recovery.ts` that the trigger-listener calls before `server.listen()`.

---

### GAP-2: `<workrail_session_state>` XML block is empty

**Severity: IMPORTANT**

`buildSystemPrompt()` at line 370 accepts a `sessionState: string` parameter and includes it in the system prompt as `<workrail_session_state>{sessionState}</workrail_session_state>`. But `runWorkflow()` calls it with `buildSystemPrompt(trigger, '')` -- always an empty string.

The backlog mandates: "Inject ancestry recap into system prompt (last 3 step note summaries, ~200 tokens each)."

**What happens without this:**
- If the agent's context window compacts mid-workflow, the prior step notes are gone
- The agent restarts a fresh context with no knowledge of what steps have already been completed
- Step notes are written to WorkRail's session store (durable) but the agent has no way to access them without an explicit re-inject

**What's needed:**
- A `buildSessionStateRecap(sessionId, ctx): Promise<string>` function that reads the last N step notes from the session store
- Called between `executeStartWorkflow` (which returns the `sessionId`) and agent loop start
- Injected into `buildSystemPrompt(trigger, recap)`
- For subsequent advances: `agent.state.systemPrompt` needs to be updated or the system prompt re-injected via `agent.steer()` with the updated recap

The session ID is available after `executeStartWorkflow` returns -- but the current code constructs the Agent before calling `start_workflow` (the tool calls `executeStartWorkflow` internally). The system prompt is set at `new Agent({initialState: {systemPrompt: ...}})` time and not updated.

**Immediate fix (MVP):** Update `buildSystemPrompt` to accept optional context from the `WorkflowTrigger` and embed it. Pass prior session recap (if any) via `trigger.context.__sessionRecap` as a workaround until proper system prompt mutation is wired.

**Proper fix:** Build `buildSessionStateRecap()`, call it after `start_workflow` tool fires and the sessionId is known, then inject via `agent.steer()` as a user message containing `<workrail_session_state>...</workrail_session_state>`.

---

### GAP-3: No deliveryContext -- results go to stdout only

**Severity: IMPORTANT**

The backlog explicitly identifies this: "OpenClaw stores the delivery target at session creation. WorkRail's trigger-router currently just logs to stdout on completion."

After `runWorkflow()` completes, `trigger-router.ts` does:
```typescript
console.log(`[TriggerRouter] Workflow completed: triggerId=${trigger.id} ...`);
```

There is no way for the workflow result to be posted back to the system that triggered it (no GitLab MR comment, no Jira comment, no Slack message, no webhook callback).

**What's needed (from OpenClaw's `deliveryContext` pattern):**
1. Add `deliveryContext` to `TriggerDefinition` in `trigger-store.ts`:
   ```typescript
   interface DeliveryContext {
     kind: 'http_callback' | 'stdout_only';
     callbackUrl?: string;
     headers?: Record<string, string>;
   }
   ```
2. Store it in `daemon-state.json` alongside the tokens (crash recovery: on restart, the delivery target is still known)
3. After `runWorkflow()` completes, `DeliveryRouter.resolve(deliveryContext)` posts the result
4. Pass `deliveryContext` as part of the workflow's initial context so the agent can reference it for posting results (e.g., a GitLab MR comment tool call)

**MVP minimum:** Add `callbackUrl` as an optional field to `TriggerDefinition`. After workflow completion, POST the `WorkflowRunResult` JSON to `callbackUrl` if set. ~20 LOC.

---

### GAP-4: No SOUL.md equivalent -- daemon has no behavioral principles

**Severity: IMPORTANT**

nexus-core injects `SOUL.md` behavioral principles into every agent session system prompt. WorkRail's `buildSystemPrompt()` defines the execution contract ("call start_workflow, read the step, do the work, call continue_workflow") but has no behavioral principles layer.

**What's missing:**
- "Evidence before assertion" -- the agent should not claim work is done without demonstrating it
- "Ask before assuming scope" -- when a step is ambiguous, surface the ambiguity rather than guess
- "Fail loudly, not silently" -- tool failures should propagate as errors, not be absorbed into the notes
- "Prefer idempotent operations" -- write files to temp paths and rename; use `--dry-run` before destructive commands

Without these, the daemon's agent is operating on workflow mechanics alone. The backlog explicitly notes: "WorkRail Auto should ship a SOUL.md equivalent in daemon session system prompts -- agent character beyond workflow steps."

**Suggested fix:**
- Create `src/daemon/daemon-soul.md` (or embed as a constant in `workflow-runner.ts`)
- Append to `buildSystemPrompt()` as a `## Principles` section
- Make it overridable via `~/.workrail/daemon-soul.md` (nexus-core pattern: user can override defaults)
- ~20-40 lines of behavioral guidance

---

### GAP-5: `KeyedAsyncQueue` key is triggerId, not sessionId

**Severity: IMPORTANT**

`trigger-router.ts` serializes concurrent runs with `this.queue.enqueue(trigger.id, ...)`. The key is `trigger.id` (the trigger definition ID, e.g. `"mr-review"`).

This means: two concurrent webhooks for the same trigger (e.g. two MRs opened in rapid succession) are serialized. The second webhook waits for the first `runWorkflow()` call to complete before starting.

**The problem:** A single `runWorkflow()` call can take minutes (a full coding task workflow). During that time, all subsequent webhooks for the same trigger are blocked in the queue. If 10 MRs are opened, they execute sequentially -- not concurrently.

**What's intended (from OpenClaw):** Serialize per *session*, not per *trigger*. The purpose of `KeyedAsyncQueue` is to prevent *concurrent modification of the same session* (token corruption if two webhooks advance the same session simultaneously). Different webhook events should create different sessions and run concurrently.

**The correct key:** Should be `sessionId` (returned by `executeStartWorkflow`). But at the time of `queue.enqueue()`, the session hasn't been created yet -- the session is created inside `runWorkflow()` when the `start_workflow` tool fires.

**Suggested fix:**
- Queue key = `trigger.id + '-' + Date.now()` (unique per invocation) -- this allows all webhooks to run concurrently but prevents duplicate processing
- OR: restructure so `executeStartWorkflow` is called before `queue.enqueue()`, and the queue key is the returned `sessionId`
- The original token-corruption concern (two webhooks corrupting the same session's tokens) doesn't actually apply here since each webhook creates a *new* session with new tokens -- there's no shared mutable token state between concurrent runs for the same trigger

**Note:** If the intended behavior is intentionally serial (only one autonomous run per trigger at a time), document this explicitly and add a `concurrencyMode: 'serial' | 'parallel'` option to `TriggerDefinition`.

---

### GAP-6: Bash tool does not throw on non-zero exit code

**Severity: IMPORTANT**

The pi-mono contract states: "Tools MUST throw on failure -- never encode errors in content. LLM sees and can retry." The `makeBashTool` execute function:

```typescript
const { stdout, stderr } = await execAsync(params.command, { ... });
const output = [stdout, stderr].filter(Boolean).join('\n');
return { content: [{ type: 'text', text: output || '(no output)' }], ... };
```

`child_process.exec` throws when the process exits with a non-zero code -- but the error object contains `stdout` and `stderr` as properties. The current code does NOT catch this. If `execAsync` throws, the exception propagates out of `execute()`, which is the correct behavior per pi-mono contract. But the error message the LLM sees is the raw Node.js exception text, not the structured stdout/stderr output from the failed command.

**What's needed:**
```typescript
try {
  const { stdout, stderr } = await execAsync(params.command, { cwd, timeout: BASH_TIMEOUT_MS });
  return { content: [{ type: 'text', text: [stdout, stderr].filter(Boolean).join('\n') || '(no output)' }] };
} catch (e: unknown) {
  const execErr = e as { stdout?: string; stderr?: string; message?: string };
  const detail = [execErr.stdout, execErr.stderr].filter(Boolean).join('\n');
  throw new Error(`Command failed: ${detail || execErr.message || String(e)}`);
}
```

This preserves the "throw on failure" contract while giving the LLM useful error content to reason about and retry.

**Resolved in PR #385 (2026-04-15):** try/catch wraps execAsync; structured error message includes command, exit code/signal, stdout, and stderr.

---

### GAP-7: `daemon-state.json` stores only one in-flight session

**Severity: NICE-TO-HAVE (blocker for multi-session daemon)**

`daemon-state.json` stores a single `{ continueToken, checkpointToken, ts }` flat object. When two triggers fire concurrently (different triggerId values), the second `persistTokens()` call overwrites the first.

**Current impact:** Low -- the `KeyedAsyncQueue` currently serializes all runs for the same triggerId, and concurrent runs for different triggers are allowed but share the same state file. If trigger A is at step 3 and trigger B fires, B's token write will overwrite A's checkpoint.

**Suggested fix:** Key the state file by sessionId:
```json
{
  "sessions": {
    "sess_abc123": { "continueToken": "ct_...", "checkpointToken": "st_...", "triggerId": "mr-review", "ts": 1234567890 },
    "sess_def456": { "continueToken": "ct_...", "checkpointToken": "st_...", "triggerId": "jira-triage", "ts": 1234567891 }
  }
}
```
This requires storing `sessionId` (available after `start_workflow` executes) and updating the `persistTokens()` signature.

---

### GAP-8: No wall-clock timeout or max-turn limit

**Severity: NICE-TO-HAVE**

The backlog notes: "Pre-production (not MVP blocking): Add `agent.abort()` after wall-clock limit + max-turn counter via `getSteeringMessages`. No built-in timeout in pi-mono's loop."

If the LLM enters a loop (repeatedly calling tools without advancing the workflow), `runWorkflow()` never returns. The trigger-router's queue entry is stuck indefinitely, blocking subsequent triggers for the same triggerId.

**Suggested fix:** Add a `maxTurns` counter and a wall-clock abort:
```typescript
const timeout = setTimeout(() => agent.abort(), MAX_RUN_MS); // e.g. 30 minutes
// In turn_end subscriber: if turns++ > MAX_TURNS { agent.abort(); }
```
This is explicitly flagged as post-MVP in the backlog.

---

## Problem Frame Packet

**Primary user / stakeholder:** Etienne (sole maintainer + sole user of the daemon at this stage). Downstream: any engineer who adopts WorkRail autonomous mode.

**Jobs to be done:**
1. Run autonomous workflows reliably without losing progress after a daemon crash
2. Get results delivered back to the system that triggered the workflow (GitLab comment, Jira post, etc.)
3. Have the agent behave predictably and principle-driven, not just mechanically correct
4. Support concurrent workflows for different trigger sources without bottlenecks

**Core tensions:**

1. **Completeness vs. ship velocity**: The crash recovery reader (GAP-1) is a correctness hole, but the daemon is also pre-production. Fixing it now vs. shipping MVP-that-works-most-of-the-time.

2. **Serial vs. parallel execution (GAP-5)**: Serializing all runs per trigger type is safe and simple. Parallel runs per different triggers are more useful but require multi-session state file (GAP-7) first. These are coupled.

3. **SOUL.md depth vs. maintenance overhead**: Behavioral principles in the system prompt help agents behave better but become implicit contracts. If WorkRail's enforcement model changes, the SOUL.md can drift.

**Success criteria:**
1. A daemon that crashes mid-step can be restarted and resumes from the last checkpoint without human intervention
2. A GitLab MR webhook fires -> workflow runs autonomously -> result is posted as MR comment (no stdout required)
3. The agent does not claim work is done without demonstrating it (SOUL.md enforcement)
4. Two different triggers (e.g. mr-review and jira-triage) can run concurrently without corrupting each other's tokens

**Assumptions to watch:**
- Assumed: pi-mono `agent.steer()` fires after each tool batch (correct per backlog correction, not directly verifiable here)
- Assumed: GAP-5 serialization is unintentional (may be a design choice for simplicity at MVP)
- Assumed: daemon-state.json is a single-session file by design (may be intended for single-session MVP)

**Framing risks (what could make this analysis wrong):**
1. GAP-5 may be intentional -- if the intent is "only one autonomous run at a time per trigger type," the current behavior is correct
2. GAP-1 may be deferred by design -- "crash recovery is post-MVP, manual restart is acceptable" is a valid MVP stance
3. The comparison to OpenClaw/nexus-core may overweight features that matter for those platforms but are not relevant to WorkRail's current usage (single developer, no production traffic)

**HMW questions:**
1. How might we structure crash recovery so it does not require a separate startup path but instead makes `runWorkflow()` naturally idempotent?
2. How might we design `deliveryContext` so it works for multiple delivery targets (GitLab, Jira, Slack) without becoming a switch-case of integrations?

---

## Candidate Directions

### Candidate Generation Expectations (landscape_first, THOROUGH)

**Required:** Candidates must clearly reflect landscape precedents and constraints rather than free invention. Specifically:
- Each candidate must cite at least one competitor precedent (OpenClaw, nexus-core, pi-mono) justifying its ordering
- Candidates must respect the locked constraints: in-process engine model, existing DI, pi-mono Agent loop
- At least one candidate must treat GAP-5 as the ambiguous variable it is (decision-dependent)
- For THOROUGH rigor: at least one candidate must push beyond the obvious "fix in severity order" clustering

**What good looks like:** A candidate that reduces the risk of the riskiest assumption (GAP-5 intentionality) while still shipping the blocker fix (GAP-1). Not just sequential by severity.

---

### Candidate A: Minimal correctness fix (simplest possible change)

**One-sentence summary:** Add `readDaemonState()` + startup recovery call in `trigger-listener.ts`, and add `catch` + structured error re-throw in `makeBashTool` -- no other changes.

**Tensions resolved:** GAP-1 (crash recovery read side), GAP-6 (Bash error content).
**Tensions accepted:** GAP-2 through GAP-5 deferred. Serial-per-trigger behavior unchanged.

**Boundary solved at:** `src/daemon/workflow-runner.ts` (add `readDaemonState()` peer to `persistTokens()`) + `src/trigger/trigger-listener.ts` (call recovery before `server.listen()`).

**Specific failure mode to watch:** Stale `daemon-state.json` from a successfully completed run left on disk -- startup recovery tries to resume an already-complete session. Fix: add `ts` staleness check (e.g. ignore if older than 2 hours) and clear after successful resume.

**Relation to repo patterns:** Follows -- `persistTokens()` already uses temp→rename; `readDaemonState()` is its natural peer. The `Result<DaemonState | null, DaemonStateError>` shape follows `loadTriggerConfigFromFile()`'s pattern exactly.

**Gain:** Fixes the blocker with ~80 LOC. No interface changes. No breaking changes.
**Give up:** Multi-session crash recovery (GAP-7 coupling) -- only the most recent session is recoverable. Concurrent trigger runs still overwrite each other's tokens.

**Impact surface:** `src/daemon/workflow-runner.ts` + `src/trigger/trigger-listener.ts`. Zero changes to trigger-router, trigger-store, engine, or MCP server.

**Scope judgment:** Best-fit for current stage (pre-production, single user, infrequent triggers). Too narrow once concurrent multi-trigger scenarios are common.

**Philosophy:** Honors *validate at boundaries*, *errors are data*, *YAGNI with discipline*. Accepts *make illegal states unrepresentable* (multi-session overwrite is still representable).

---

### Candidate B: Correctness + session state injection (follow existing pattern)

**One-sentence summary:** Fix GAP-1 (crash recovery), GAP-2 (session state injection via `agent.steer()` after `start_workflow`), and GAP-4 (SOUL.md as a constant in `buildSystemPrompt()`), while explicitly documenting GAP-5 as a product decision gate.

**Tensions resolved:** GAP-1, GAP-2, GAP-4. GAP-5 resolved by product decision (document and decide).
**Tensions accepted:** GAP-3 (delivery context) deferred. GAP-7 (multi-session state) deferred.

**Boundary solved at:**
- GAP-1: `src/daemon/workflow-runner.ts` + `src/trigger/trigger-listener.ts` (same as Candidate A)
- GAP-2: `makeStartWorkflowTool.execute()` calls a new `buildSessionRecap(sessionNotes)` function; injects via `agent.steer()` after start_workflow tool fires (adds one user-message turn)
- GAP-4: New constant `DAEMON_SOUL` in `workflow-runner.ts` (or read from `~/.workrail/daemon-soul.md` with fallback to bundled default), appended to `buildSystemPrompt()`
- GAP-5: Add explicit `// PRODUCT DECISION: serial-per-trigger-type is intentional for MVP` comment + `TriggerDefinition.concurrencyMode?: 'serial' | 'parallel'` field (parse from triggers.yml)

**Specific failure mode to watch:** The extra `agent.steer()` call for session recap adds an LLM turn before the first workflow step. If pi-mono's steer() fires immediately and the agent doesn't distinguish "context injection" from "step instruction," the agent may try to act on the recap as a step. Mitigation: wrap recap in explicit `<context>` XML tag, not a step-like heading.

**Relation to repo patterns:** Adapts -- the `agent.steer()` pattern is documented in backlog as the correct mechanism. The `buildDaemonSoul()` function follows the existing `buildSystemPrompt()` composition pattern.

**Gain:** Daemon sessions survive compaction (step notes injected). Agent has behavioral principles. Product decision on GAP-5 is made explicit.
**Give up:** GAP-3 delivery still stdout-only. The extra LLM turn adds latency.

**Impact surface:** `src/daemon/workflow-runner.ts` (SOUL + recap), `src/trigger/trigger-store.ts` + `src/trigger/types.ts` (concurrencyMode field), `src/trigger/trigger-listener.ts` (startup recovery).

**Scope judgment:** Best-fit for getting to a production-quality daemon. Incrementally shippable (each gap fixable in separate PRs).

**Philosophy:** Honors *immutability by default*, *validate at boundaries*, *errors are data*, *document 'why' not 'what'* (GAP-5 comment). Minor tension with *YAGNI* for the concurrencyMode field (may not be needed at MVP).

---

### Candidate C: Full delivery loop (resolves the end-to-end story)

**One-sentence summary:** Fix all important gaps (GAP-1 through GAP-6) in one arc, structured as: correctness first (GAP-1, GAP-6), then delivery (GAP-3 as `callbackUrl` in `TriggerDefinition`), then behavioral (GAP-2 + GAP-4), then queue semantics (GAP-5 with `concurrencyMode`).

**Tensions resolved:** All 6 important gaps resolved. GAP-7 + GAP-8 explicitly deferred with rationale.
**Tensions accepted:** Multi-session daemon-state (GAP-7) requires sessionId exposure -- defer until `executeStartWorkflow` response schema is updated to include sessionId. Wall-clock timeout (GAP-8) is post-MVP.

**Boundary solved at:**
- GAP-3: Add `callbackUrl?: string` to `TriggerDefinition` (triggers.yml + types.ts). After `runWorkflow()` returns, trigger-router calls `DeliveryClient.post(callbackUrl, result)` -- a new ~30 LOC module returning `Result<void, DeliveryError>`
- GAP-7 prerequisite identified: expose `sessionId` in `V2StartWorkflowOutputSchema` (MCP schema change). The `session_started` response already has the session ID internally; it just needs to be included in the response JSON
- Everything in Candidate B also included

**Specific failure mode to watch:** `callbackUrl` delivery failure must not fail silently (it's the whole point of the daemon). Add a `deliveryFailed` log entry + `WorkflowRunResult` discriminant `_tag: 'delivery_failed'` to distinguish "workflow succeeded but posting failed" from "workflow failed."

**Relation to repo patterns:** Departs slightly -- introduces `DeliveryClient` as a new module. But it follows the same `Result<T, E>` + discriminated union pattern as all other modules.

**Gain:** Full end-to-end story (trigger → run → post result). Workflow results are actually useful, not just logged to stdout.
**Give up:** More scope than needed for "prove it works." The delivery failure mode adds new error handling surface.

**Impact surface:** `src/trigger/types.ts` (new field), `src/trigger/trigger-store.ts` (parse new field), `src/trigger/trigger-router.ts` (call DeliveryClient), new `src/trigger/delivery-client.ts`, `src/mcp/handlers/v2-execution/start.ts` (sessionId in response -- larger change).

**Scope judgment:** Slightly broad for current single-user pre-production stage, but not too broad if the goal is "production-ready daemon." The sessionId schema change is the highest-risk item and should be gated on the other fixes being stable first.

**Philosophy:** Honors all principles. The `DeliveryError` discriminated union ensures delivery failures are represented as data, not exceptions. The `_tag: 'delivery_failed'` variant makes illegal "silently-lost delivery" unrepresentable at the type level.

---

### Recommended: Candidate B

Candidate A is too narrow (fixes only the blocker, leaves 5 important gaps). Candidate C is slightly broad for the current stage -- the sessionId schema change and `DeliveryClient` module add risk without being strictly necessary for proving the daemon works. Candidate B ships the blocker fix, addresses the two most important capability gaps (session state survival, behavioral principles), and makes the queue semantics decision explicit without committing to the larger delivery infrastructure yet.

**Delivery context (GAP-3) can be Candidate C's scope -- it deserves its own focused PR once Candidate B is stable.**

---

## Challenge Notes

- GAP-1 and GAP-7 are coupled: fixing crash recovery properly requires GAP-7's multi-session state format first
- GAP-5 (queue key) may be intentional -- if serial execution per trigger is desired, the current behavior is correct. Needs a product decision before fixing
- GAP-6 (Bash error handling) is technically correct (exceptions propagate as required by pi-mono) but the error content is poor -- a UX fix more than a correctness fix

---

## Resolution Notes

Path recommendation: **landscape_first** -- the task is purely comparative with no ambiguity about what to solve. The design doc documents the gap analysis for future sessions to act on.

---

## Challenge Notes

**Challenge 1: B defers delivery, therefore B is useless**
If the daemon runs workflows autonomously and results go to stdout, there's no one watching to see them. This attacks B's "production-quality" claim.

*Verdict: partially lands.* B is correctly positioned as correctness work (pre-production). But the design doc must acknowledge that C's delivery context is the *required next PR*, not a future optional. B + C together = production-ready. B alone = proof-of-concept with crash recovery.

**Challenge 2: concurrencyMode is premature YAGNI violation**
Adding `concurrencyMode` to `TriggerDefinition` for a decision not yet made adds schema surface area.

*Verdict: fails.* The field documents an explicit product decision (even if default preserves current behavior). Without it, GAP-5 stays implicitly ambiguous. ~5 LOC, zero runtime impact with default 'serial'.

**Challenge 3: steer() injection timing is unverified**
pi-mono `agent.steer()` semantics are not verifiable from local source. If steer() fires only after turn_end (not before first LLM call), the session recap arrives after the agent has started the first step.

*Verdict: weakened but not eliminated.* The backlog correction documents that steer() fires after each tool batch inside the inner loop. Since start_workflow fires the tool, steer() fires after it -- before the agent's first continuation. The `<context>` XML wrapper is a safety net if timing is unexpected. Mark GAP-2 fix as `needsPrototype: true`.

**Challenge 4: B doesn't update selectedDirection from C**
Challenge 1's partial landing: should delivery context (GAP-3) be pulled into B's scope?

*Verdict: No.* B is still the right recommendation. But the recommendation must be paired with "C is the follow-on PR, not a future optional." The design doc now makes this explicit.

---

## Decision Log

- 2026-04-14: Chose `landscape_first` over `full_spectrum` -- competitor research is already complete in backlog.md, reframing is not needed
- 2026-04-14: GAP-5 flagged as potentially intentional design -- requires product decision before fixing
- 2026-04-14: GAP-6 flagged as UX (not correctness) -- pi-mono contract is met (throw propagates), but error content is poor
- 2026-04-14: **SELECTED DIRECTION: Candidate B** -- correctness + behavioral quality. ~200 LOC, 4 independent PRs. Addresses GAP-1/2/4/5/6.
- 2026-04-14: **RUNNER-UP: Candidate C** -- required as the follow-on PR for GAP-3 delivery. Not optional -- B alone is proof-of-concept, B+C is production-ready.
- 2026-04-14: Adversarial challenge did not flip the recommendation. GAP-2 steer() timing marked as needing prototype verification.
- 2026-04-14: sessionId not in public response schema -- GAP-7 fix requires either generated runKey or schema change. Deferred.
- 2026-04-14: GAP-8 (wall-clock timeout) explicitly post-MVP.

---

## Final Summary

**8 gaps identified.** 1 blocker (crash recovery write-only), 5 important, 2 nice-to-have.

**Selected direction: Candidate B** -- correctness + behavioral quality, ~215 LOC, 5 independent PRs. Strengthened by runKey hybrid (GAP-7 partial) and rehydrate-based staleness check.

**Confidence band: HIGH** -- five independent analysis passes, adversarial challenge, and design review all converge. No direction-level uncertainty remains. GAP-2's steer() timing is an implementation-level risk resolved by a smoke test during PR development.

### Implementation is architecturally sound

`KeyedAsyncQueue` is wired. `is_autonomous: true` is injected. `persistTokens()` uses atomic temp-rename. `agent.steer()` (not `followUp()`) is used correctly. The gaps are missing features and one correctness hole, not structural problems.

### Recommended build order (Candidate B)

**PR 1: GAP-1 -- crash recovery reader** (~80 LOC)
- `readDaemonState(): Result<DaemonState | null, DaemonStateError>` in `workflow-runner.ts`
- Startup recovery in `trigger-listener.ts` before `server.listen()`: call rehydrate on recovered token, clear if token is expired/invalid
- runKey (UUID) added to `persistTokens()` -- keyed multi-session state map
- Fixes: blocker

**PR 2: GAP-6 -- Bash error content** (~10 LOC)
- catch block in `makeBashTool.execute()` extracts `stdout` + `stderr` from exec error object
- Throws structured message for LLM to reason about and retry
- Fixes: important (but trivial)

**PR 3: GAP-4 -- SOUL.md behavioral principles** (~30 LOC)
- `DAEMON_SOUL_DEFAULT` constant embedded in `workflow-runner.ts`
- `loadDaemonSoul(overridePath?: string): Promise<string>` reads `~/.workrail/daemon-soul.md` with fallback
- Appended to `buildSystemPrompt()` as `## Behavioral principles` section
- Content to review before shipping: "Evidence before assertion", "Prefer idempotent operations", "Ask before assuming scope", "Fail loudly not silently"
- Fixes: important

**PR 4: GAP-5 -- queue semantics decision** (~5 LOC + product decision)
- Add `concurrencyMode?: 'serial' | 'parallel'` to `TriggerDefinition` in `types.ts`
- Parse in `trigger-store.ts`: default explicitly to `'serial'` at parse time (not at use time)
- In `trigger-router.ts`: if `'parallel'`, key = `trigger.id + ':' + crypto.randomUUID()` (unique per invocation)
- Prerequisite: decide the product question first -- is serial-per-trigger-type intentional?
- Fixes: important (ambiguity)

**PR 5: GAP-2 -- session state injection** (~90 LOC, smoke test required)
- `buildSessionRecap(notes: string[]): string` pure function
- After `start_workflow` tool fires and session exists, call `agent.steer()` with `<context>` XML block wrapping the recap
- Merge gate: `src/daemon/__tests__/workflow-runner-steer.test.ts` smoke test must pass before merging
- Fixes: important

**Follow-on Candidate C (when real webhooks are configured):**
- GAP-3: `callbackUrl?: string` in `TriggerDefinition` + new `src/trigger/delivery-client.ts` + `_tag: 'delivery_failed'` in `WorkflowRunResult`
- GAP-7 complete: sessionId exposed in `V2StartWorkflowOutputSchema` (schema change); keyed state map already in PR 1

**Explicitly deferred:**
- GAP-8: wall-clock timeout + max-turn limit (post-MVP, non-blocking for single-developer usage)

### Residual concerns (not blocking)

1. **pi-mono version pin**: Pin `@mariozechner/pi-agent-core` version in package.json. steer() semantics must be re-verified before any upgrade.
2. **GAP-5 product decision**: "serial-per-trigger-type" must be explicitly decided and documented before PR 4 ships.
3. **Delivery discriminant timing**: `_tag: 'delivery_failed'` must be in `WorkflowRunResult` from Candidate C's first PR (not a follow-on). Silent delivery failures must be unrepresentable at the type level before production use.
