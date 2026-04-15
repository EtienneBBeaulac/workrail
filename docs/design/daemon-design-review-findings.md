# WorkRail Daemon Architecture: Design Review Findings

> Review output for the selected direction: Candidate 3 (Composite Same-Process) with
> Candidate 1 safety defaults (maxConcurrentSessions: 1 for v1).
> Generated: 2026-04-14.

---

## Tradeoff Review

| Tradeoff | Acceptable? | Failure Condition | Hidden Assumption |
|----------|-------------|------------------|-------------------|
| Shared process failure domain | Yes (local-first 12-month scope) | WorkRail deployed as shared multi-user server | Daemon agent loop is well-behaved (AbortController timeouts required) |
| Process-level init change (`initializeWorkRailProcess`) | Yes (internal, invisible to users) | `runtimeMode` discriminant insufficient for combined mode -- may need third mode or flags object | DI container initialization has no entry-point-specific services that conflict |
| Cross-repo deferred to post-MVP | Yes (backlog explicitly says post-MVP) | First real use case (MR review) requires cross-repo | MVP MR review workflow is single-repo -- must be confirmed with actual first workflow target |

---

## Failure Mode Review

| Failure Mode | Design Handling | Missing Mitigation | Risk Level |
|---|---|---|---|
| Hanging agent loops | `AbortController` in `DaemonSession`; REST cancel calls `abort()` | `runStep` must accept `AbortSignal` parameter -- currently not in spec | **ORANGE** -- manageable but must be explicit in design |
| Two `initializeContainer()` calls corrupting DI state | Process-level `initializeWorkRailProcess()` called once | Exact interface (`SharedEngineContext`) not yet specified; `mcp-server.ts` startup path needs refactor | **ORANGE** -- must be designed and tested first; highest-risk change |
| Lock contention under high concurrent load | `withHealthySessionLock` per session; v1 uses queue (concurrency=1) | Session concurrency limit in `DaemonSessionManager` (max N for v1.5) | **YELLOW** -- performance concern, not correctness |

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate 1: Sequential):**
- C1's FIFO queue ensures `engineActive` guard is never violated without requiring the guard to change
- This strength is worth borrowing: v1 runs with `maxConcurrentSessions: 1`
- C1 loses because it provides no live view and no human override path -- unacceptable for the trust model change that autonomous execution represents

**Simpler alternative (C3 without REST control plane):**
- Saves ~150 lines of code in v1
- Loses: operators cannot pause a runaway autonomous session
- For local dev (one developer, their own machine), acceptable
- For team deployment, unacceptable safety gap
- Decision: include REST control plane in v1; keep it simple (3-4 routes)

**Hybrid adopted: C3 with `maxConcurrentSessions: 1` default**
- C1 safety (queue) + C3 architecture (DaemonSessionManager, REST control plane)
- No `engineActive` guard change needed in v1 (queue ensures one engine call at a time)
- Path to full concurrency: design `SharedEngineContext`, enable in v1.5

---

## Philosophy Alignment

**Satisfied clearly:**
- Errors as data (ResultAsync throughout)
- Immutability (append-only events, typed status transitions)
- Make illegal states unrepresentable (`DaemonSession.status` discriminated union)
- Explicit domain types (`AnthropicApiKey`, `GitLabToken` branded types)
- Validate at boundaries (Zod for trigger payloads)
- DI for boundaries (`AgentLoopPort`, `ToolExecutorPort` injected)
- YAGNI with discipline (maxConcurrentSessions:1, cross-repo deferred)

**Under tension (all acceptable):**
- Determinism: LLM outputs are non-deterministic by nature; WorkRail's value is structural enforcement, not content determinism
- Pure functions: multi-turn LLM loop is inherently stateful; `runStep` API is as pure as possible
- Architectural fixes over patches: queue is a deliberate v1 design, not a hidden workaround; SharedEngineContext is designed and documented

---

## Findings

### RED (blocking -- must be resolved before implementation begins)

None.

### ORANGE (must address before shipping)

**[ORANGE-1] `runStep` missing `AbortSignal` parameter**
- Finding: The `step-runner` spec does not include an `AbortSignal` parameter. Without it, `DaemonSession.abortController.abort()` does not propagate to LLM calls or Bash subprocesses.
- Required fix: `runStep(pending: PendingStep, toolExecutor: ToolExecutorPort, llmPort: AgentLoopPort, signal: AbortSignal): RA<StepOutput, StepError>`
- Impact: REST `DELETE /api/v2/sessions/:id` (cancel) and `POST pause` do not work without this

**[ORANGE-2] `SharedEngineContext` interface not specified**
- Finding: The process-level `initializeWorkRailProcess()` function is identified as needed but its return type and contract are not designed.
- Required: `initializeWorkRailProcess(config: ProcessConfig): Promise<SharedEngineContext>` where `SharedEngineContext` exposes the engine instance + DI-resolved ports that both MCP server and daemon entry points need.
- Impact: If both entry points call `initializeContainer()` independently, DI container state is indeterminate. This is the highest-risk change; must be designed and tested first.
- Note: For v1 with `maxConcurrentSessions: 1`, the queue ensures the `engineActive` boolean guard is never violated -- so this is not needed for v1. But it must be designed in v1 and tested before enabling concurrency in v1.5.

### YELLOW (should address, not blocking)

**[YELLOW-1] Session concurrency limit not specified**
- Finding: `DaemonSessionManager` has no upper bound on concurrent sessions even in the v1.5 full-concurrency mode.
- Recommendation: Add `maxConcurrentSessions: number` to `DaemonConfig` with a safe default (e.g., 10). Sessions beyond the limit are queued, not rejected.

**[YELLOW-2] `runtimeMode` may be insufficient**
- Finding: The current `runtimeMode` discriminant (`library` | `server`) does not express "server + daemon combined" mode. A third mode or flags object may be needed.
- Recommendation: Evaluate whether `initializeContainer({ runtimeMode: 'server', daemon: true })` is sufficient or whether a new mode value is needed when designing `SharedEngineContext`.

**[YELLOW-3] Cross-repo tool executor interface not extensible**
- Finding: The v1 tool executor spec (`Bash`, `Read`, `Write`) is single-workspace. If the first real use case requires cross-repo, the interface must be redesigned.
- Recommendation: Design `ToolExecutorPort` to support an optional `repo` parameter from day one: `Bash(cmd: string, opts?: { repo?: string }): RA<string, ToolError>`. Single-workspace behavior when `repo` is absent; cross-repo routing when present. Costs nothing to include; prevents a breaking interface change later.

---

## Recommended Revisions

1. **[Required for v1]** Add `signal: AbortSignal` to `runStep` signature.
2. **[Required for v1]** Design `SharedEngineContext` interface and `initializeWorkRailProcess()` signature (even if only the queue-mode path is enabled in v1).
3. **[Strongly recommended for v1]** Design `ToolExecutorPort` with optional `repo` parameter to avoid a future breaking change.
4. **[v1.5]** Evaluate `runtimeMode` extension before enabling full concurrency.
5. **[v1.5]** Add session concurrency limit with safe default.

---

## Residual Concerns

1. **Agent loop correctness is the riskiest unknown.** The step-runner must correctly handle multi-turn LLM conversations with tool calls (not just single LLM calls). This is the piece that has never been built before in WorkRail. The pi-mono `agentLoop` reference is the best existing implementation to study. Whether to use pi-mono directly or implement from scratch against the Anthropic SDK is an unresolved dependency decision.

2. **`mcp-server.ts` refactor scope is uncertain.** Introducing `initializeWorkRailProcess()` requires refactoring how `startStdioServer` and `startHttpServer` initialize the container. The scope of this refactor depends on how deeply initialization is entangled in each transport entry point. This should be the first code spike when C3 implementation begins.

3. **Console integration is not specified.** The REST control plane additions are specified (`daemon-status`, `pause`, `resume`, `cancel`). How these appear in the console UI is not -- that is a separate design question for the console team / next iteration.
