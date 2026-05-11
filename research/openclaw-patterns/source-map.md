# Source Map: OpenClaw Pattern Extraction

## Source entries (deep mode: max 8)

1. **`src/daemon/service-audit.ts`** -- Full audit implementation, not just type definitions. Contains the logic that produces `ServiceConfigAudit` from a live plist/systemd unit file. Direct model for `worktrain doctor`.

2. **`src/daemon/service-env.ts` + `service-managed-env.ts`** -- How OpenClaw manages environment variables in the daemon service (proxy env, inline managed env, secret refs). WorkTrain has a known gap around env var handling in the launchd plist (API key baked in at install time).

3. **`src/tasks/task-executor.ts` + `task-registry.ts`** -- Full task execution and registry implementation (not just types). The question is whether the execution model is portable or too tied to OpenClaw's session machinery.

4. **`src/trajectory/runtime.ts` + `export.ts`** -- How OpenClaw actually writes and exports trajectory events. The type schema is known; the write path determines what a WorkTrain adaptation would look like.

5. **`src/context-engine/registry.ts` + `delegate.ts`** -- How OpenClaw registers and delegates to context engine plugins. This is the seam between the interface (known) and the actual plugin dispatch mechanism.

6. **`src/sessions/session-lifecycle-events.ts` + `transcript-events.ts`** -- How session events are structured and written. WorkTrain's session event schema and OpenClaw's may share enough shape that a unified format is feasible.

7. **`src/agents/subagent-registry.ts` + `subagent-target-policy.ts`** -- Subagent dispatch policy and registry. WorkTrain's `spawn_agent` is simpler; these files will reveal whether OpenClaw's more sophisticated model is worth adopting wholesale or just partially.

8. **`src/cron/` directory** -- WorkTrain's `PollingScheduler` and OpenClaw's cron subsystem may share patterns for interval management, skip-if-running, and persistence of last-run state.

## Critic/contrarian sources
- **OpenClaw open issues (7498 open)** -- Where OpenClaw's patterns break. Any pattern we adopt should be checked against its open bugs. High-signal: issues tagged bug or regression in the relevant subsystems.
