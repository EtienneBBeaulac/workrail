# WorkflowTrigger and Session Lifecycle Audit

**Date:** 2026-04-19
**Scope:** `WorkflowTrigger` interface field categorization; session lifecycle ownership map
**Status:** Findings only -- no implementation plan attached

---

## Part 1: WorkflowTrigger Field-by-Field Analysis

`WorkflowTrigger` is defined in `src/daemon/workflow-runner.ts` at line 288.
It currently has 14 top-level fields (plus 6 nested under `agentConfig`).

### Field inventory with category labels

| Field | Category | Notes |
|---|---|---|
| `workflowId` | Trigger config | Sourced from TriggerDefinition; known before session start |
| `goal` | Trigger config | May be dynamically interpolated from goalTemplate but is resolved before WorkflowTrigger is constructed |
| `workspacePath` | Trigger config | Doubles as the session working directory; passed to tool factories |
| `context` | Trigger config | Workflow context variables from contextMapping |
| `referenceUrls` | Trigger config | Pass-through from TriggerDefinition so workflow-runner stays decoupled |
| `soulFile` | Trigger config | Resolved path, cascade from trigger -> workspace -> global |
| `branchStrategy` | Trigger config | 'worktree' or 'none'; sourced from TriggerDefinition |
| `baseBranch` | Trigger config | Only meaningful when branchStrategy === 'worktree' |
| `branchPrefix` | Trigger config | Only meaningful when branchStrategy === 'worktree' |
| `botIdentity` | Trigger config / Delivery config | Set by polling-scheduler at trigger time; read by delivery-action.ts at commit time |
| `agentConfig.model` | Trigger config | Per-trigger model override |
| `agentConfig.maxSessionMinutes` | Trigger config | Session execution policy |
| `agentConfig.maxTurns` | Trigger config | Session execution policy |
| `agentConfig.maxSubagentDepth` | Trigger config | Session execution policy |
| `agentConfig.stuckAbortPolicy` | Session execution policy | Controls runtime behavior inside the agent loop |
| `agentConfig.noProgressAbortEnabled` | Session execution policy | Controls runtime behavior inside the agent loop |
| `_preAllocatedStartResponse` | Session runtime state | Set by dispatch HTTP handler or spawnSession; skips duplicate executeStartWorkflow() |
| `parentSessionId` | Session runtime state | Set by makeSpawnAgentTool; documented as 'not read by runWorkflow() directly' |
| `spawnDepth` | Session runtime state | Set by parent factory at child construction time; enforces maxSubagentDepth |

### Category summary

- **Trigger config (10 fields):** Known before session start, sourced from TriggerDefinition or resolved at dispatch time. These are the "input parameters" the operator writes in triggers.yml.
- **Session execution policy (2 fields in agentConfig):** Technically sourced from TriggerDefinition but they control runtime behavior inside the agent loop, not the trigger firing condition.
- **Session runtime state (3 fields):** Set during or after session creation. `_preAllocatedStartResponse` and `parentSessionId` carry infrastructure handshake data; `spawnDepth` carries tree-position state from the parent session factory.

### The mixing problem

Three categories of fields live in one flat struct with no structural boundary. The consequences:

1. **`_preAllocatedStartResponse` is an internal handshake field on a public-facing type.** The underscore prefix is the only signal. `trigger-listener.ts:467` constructs `WorkflowTrigger` with this field from outside the infrastructure layer, proving the underscore convention does not act as an access barrier.

2. **`parentSessionId` is documented as "not read by runWorkflow() directly"** (workflow-runner.ts line 382). It exists for documentation and potential future use. A field that is not read by the function it is passed to is a dead field on the input type.

3. **`botIdentity` is double-threaded.** It appears on `WorkflowTrigger` (input) and is explicitly re-surfaced on `WorkflowRunSuccess` (output, lines 506-521) so `trigger-router.ts maybeRunDelivery()` can pass it to `delivery-action.ts`. The threading comment says "follows the sessionId/sessionWorkspacePath threading pattern" -- meaning this pattern is now established and will repeat for any future delivery-config field added to the trigger.

4. **`branchStrategy`, `baseBranch`, and `branchPrefix` are pass-through forwarding fields** that exist solely because `workflow-runner.ts` must remain decoupled from `TriggerDefinition`. This is the right goal, but the mechanism (copy each field individually onto the flat struct) does not scale as the worktree feature grows.

### Proposed decomposition sketch

A future refactor could split the interface into three composed types:

```typescript
// Fields the trigger operator configures in triggers.yml
interface TriggerConfig {
  readonly workflowId: string;
  readonly goal: string;
  readonly workspacePath: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly referenceUrls?: readonly string[];
  readonly soulFile?: string;
  readonly agentConfig?: AgentConfig;
  readonly worktreeConfig?: WorktreeConfig; // branchStrategy, baseBranch, branchPrefix
}

// Fields set by delivery systems; read at git-commit time
interface DeliveryConfig {
  readonly botIdentity?: { readonly name: string; readonly email: string };
}

// Fields set by session infrastructure at creation time
interface SessionContext {
  readonly _preAllocatedStartResponse?: ...; // or move to a separate creation parameter
  readonly parentSessionId?: string;
  readonly spawnDepth?: number;
}

// WorkflowTrigger becomes a composition
type WorkflowTrigger = TriggerConfig & DeliveryConfig & SessionContext;
```

The immediate safe win -- without a full refactor -- would be to pull `_preAllocatedStartResponse`, `parentSessionId`, and `spawnDepth` into a separate `SessionContext` parameter to `runWorkflow()` rather than embedding them in the trigger input. This makes the contract explicit: `runWorkflow(config: TriggerConfig, ctx: V2ToolContext, sessionCtx?: SessionContext, ...)`.

---

## Part 2: Session Lifecycle Ownership Map

### Who does what

| Responsibility | Owner | Location |
|---|---|---|
| Session sidecar creation (initial) | `runWorkflow()` | `workflow-runner.ts:3279` -- `persistTokens(sessionId, token, checkpoint)` |
| Session sidecar update (add worktreePath) | `runWorkflow()` | `workflow-runner.ts:3333` -- second `persistTokens()` call after worktree creation |
| Session sidecar deletion (normal end) | `runWorkflow()` | `workflow-runner.ts:3376` -- `fs.unlink(DAEMON_SESSIONS_DIR/sessionId.json)` |
| Worktree creation | `runWorkflow()` | `workflow-runner.ts:3299-3354` -- `git worktree add` |
| Worktree removal (normal path, after delivery) | `trigger-router.ts maybeRunDelivery()` | `trigger-router.ts:382-394` -- `git worktree remove --force` |
| Orphan sidecar cleanup (restart recovery) | `runStartupRecovery()` | `workflow-runner.ts:917-928` -- `fs.unlink` per orphaned sidecar |
| Orphan worktree cleanup (restart recovery, after 24h) | `runStartupRecovery()` | `workflow-runner.ts:893-915` -- `git worktree remove --force` |
| Session spawn for adaptive pipeline | `coordinatorDeps.spawnSession` | `trigger-listener.ts:411-476` -- `executeStartWorkflow` + `router.dispatch()` |
| In-process liveness registration | `runWorkflow()` | `workflow-runner.ts:3258` -- `daemonRegistry.register()` |
| In-process liveness heartbeat | `runWorkflow()` -- `onAdvance` callback | `workflow-runner.ts:3162` -- `daemonRegistry.heartbeat()` |
| In-process liveness deregistration | `runWorkflow()` | Multiple early-exit paths and normal completion |

### Who is responsible for worktree creation/cleanup?

Worktree creation is owned by `runWorkflow()`. Worktree cleanup is **split**:

- **Normal path:** `trigger-router.ts maybeRunDelivery()` removes the worktree after delivery completes (success or error). The comment explains why it cannot be in `runWorkflow()`: delivery must run inside the worktree, so `runWorkflow()` must not remove it before returning.
- **Crash/orphan path:** `runStartupRecovery()` in `workflow-runner.ts` removes worktrees older than 24 hours.

This split is architecturally deliberate (the worktree comment at trigger-router.ts:370-381 explains the constraint) but it means no single location owns the full worktree lifecycle. The constraint that forces the split is real: delivery happens outside `runWorkflow()`. The design pressure to resolve it would be to either push delivery into `runWorkflow()`, or introduce a `SessionOwner` abstraction that holds the worktree handle and is responsible for cleanup regardless of which path ends the session.

### Is DaemonRegistry the authoritative source of truth for "what's running"?

No. `DaemonRegistry` is explicitly documented as "ephemeral in-process liveness tracking -- cleared on process restart -- this is intentional" (`src/v2/infra/in-memory/daemon-registry/index.ts:8`). It answers the question "is this session being heartbeated by the currently running process?" It cannot answer:

- Was this session running before the process restarted?
- Is this sidecar file for a live or crashed session?
- Did delivery complete before the process died?

Session sidecar files (`DAEMON_SESSIONS_DIR/*.json`) are the only durable record. `runStartupRecovery()` reads them directly (not through DaemonRegistry) because the registry is empty after a restart.

The result is two mechanisms answering the same question, with no overlap and no single API surface that gives a correct answer in all states:

| State | DaemonRegistry | Sidecar file |
|---|---|---|
| Session running, same process | Present, heartbeating | Present |
| Session completed normally | Absent (unregistered) | Absent (deleted) |
| Process crashed mid-session | Absent (process died) | Present (not cleaned up) |
| After restart, before recovery | Absent | Present (orphan) |

### Gaps and ambiguities

**Gap 1: No single owner for the session liveness question.**
There is no function, class, or module that can correctly answer "is session X currently running?" across all process states. `DaemonRegistry` answers it for the in-process case; sidecar files answer it for the post-crash case; but there is no unified interface. `ConsoleService` has to handle both separately.

**Gap 2: Worktree cleanup has two owners with different trigger conditions.**
The 24-hour threshold in `runStartupRecovery()` and the post-delivery immediate cleanup in `maybeRunDelivery()` are not coordinated. If a session's sidecar is orphaned but its worktree is less than 24 hours old, `runStartupRecovery()` will delete the sidecar but leave the worktree. The worktree becomes a resource leak that is only cleaned on the next startup after 24 hours have elapsed.

Confirmed path to this state:
1. `runWorkflow()` creates worktree and sidecar.
2. Session completes, `runWorkflow()` deletes the sidecar.
3. `maybeRunDelivery()` tries to remove the worktree but fails (disk full, git lock, etc.) -- error is logged and swallowed.
4. Worktree is now orphaned with no sidecar pointing to it. `runStartupRecovery()` can never find it because it searches sidecars, not the worktrees directory.

This is a real orphan leak path that the current recovery mechanism cannot reach.

**Gap 3: `_preAllocatedStartResponse` leaks infrastructure state into the public trigger type.**
`spawnSession` in `trigger-listener.ts` constructs `WorkflowTrigger` directly with this field. Any future caller that constructs `WorkflowTrigger` without understanding the `_preAllocatedStartResponse` invariant can accidentally call `executeStartWorkflow()` twice for the same session (the MUST NOT invariant documented at line 356).

**Gap 4: `parentSessionId` is a documented dead field.**
The comments on lines 379-383 say "This field is not read by runWorkflow() directly" and "exists for documentation purposes and potential future use." A field on an input type that is not read by the function it is passed to is not providing value and creates confusion about which fields are operative.

**Gap 5: `spawnDepth` has no compile-time enforcement.**
`spawnDepth` is an optional numeric field. Callers that construct `WorkflowTrigger` (e.g. `spawnSession` in `trigger-listener.ts:467`) must correctly set `spawnDepth` or the `maxSubagentDepth` enforcement in `runWorkflow()` will silently default to depth 0 for all sessions, allowing unlimited recursion depth regardless of the configured limit.

---

## Summary of findings

| Finding | Severity | Concrete risk |
|---|---|---|
| WorkflowTrigger mixes three concern categories in one flat struct | Medium | Type leaks, confusion about which fields are operative, MUST NOT invariant on `_preAllocatedStartResponse` easily violated |
| Worktree cleanup has two owners; the sidecar-less orphan case is unreachable by recovery | Medium | Disk space leak when delivery cleanup fails; orphaned worktrees accumulate indefinitely |
| DaemonRegistry is not authoritative; two mechanisms answer "is session alive?" | Low-Medium | No concrete bug today, but any code that reads DaemonRegistry as a complete truth (e.g. a future health check) will be wrong after a crash |
| `_preAllocatedStartResponse` is an internal field on a public type, constructed by the composition root | Medium | Double-session-creation risk if the invariant is violated by a new caller |
| `parentSessionId` is a dead field on the input type | Low | Confusion only; no operational risk |
| `spawnDepth` has no compile-time enforcement at construction sites | Low-Medium | Silent depth=0 default for coordinator-spawned sessions if the field is omitted |
