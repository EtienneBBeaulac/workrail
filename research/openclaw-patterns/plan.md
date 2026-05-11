# Research Plan: OpenClaw Pattern Extraction (deep, depth_serial)

**Regime:** depth_serial
**Sub-questions:** 7
**Subagent cap:** 10
**Per-subagent token budget:** 25,000
**Topological order:** SQ1 → SQ3 → SQ4 → SQ5 → SQ6 → SQ2 → SQ7

---

## SQ1: Service audit implementation

**Task:** Read `src/daemon/service-audit.ts` (full), `src/daemon/service-env.ts`, `src/daemon/service-managed-env.ts`. Extract: (a) the full list of audit codes and what each checks, (b) the data flow from plist/systemd file to `ServiceConfigAudit`, (c) which checks are environment-specific vs config-specific, (d) the `doctor --fix` repair logic if present.

**Stop rule:** min 3 file reads; stop when the full audit flow is understood end-to-end.

**Expected output:** Concrete list of audit checks WorkTrain should implement, mapped to WorkTrain equivalents.

---

## SQ3: Context engine registry/delegate

**Task:** Read `src/context-engine/registry.ts`, `src/context-engine/delegate.ts`, `src/context-engine/init.ts`. Extract: (a) how plugins register with the engine registry, (b) how `assemble()` / `compact()` calls are delegated to the active plugin, (c) what the minimal seam looks like for making `buildSystemPrompt()` pluggable without a full rewrite.

**Stop rule:** min 3 file reads; stop when the plugin dispatch mechanism is fully understood.

---

## SQ4: Task executor and registry portability

**Task:** Read `src/tasks/task-executor.ts`, `src/tasks/task-registry.ts`, `src/tasks/detached-task-runtime.ts`. Extract: (a) how tasks are created, run, and terminated, (b) what session machinery they depend on, (c) whether the registry is independently instantiable or requires the full gateway.

**Stop rule:** min 3 file reads; stop when the dependency surface is clear.

---

## SQ5: Cron patterns

**Task:** Read `src/cron/` directory listing, then `src/cron/` key files (scheduler, store, job definition). Extract: (a) skip-if-running implementation, (b) last-run persistence mechanism, (c) interval drift handling.

**Stop rule:** min 3 file reads; stop when skip-if-running and persistence patterns are clear.

---

## SQ6: Session lifecycle event schema (foundational for SQ2)

**Task:** Read `src/sessions/session-lifecycle-events.ts`, `src/sessions/transcript-events.ts`. Compare against WorkTrain's daemon event log format (`DaemonEvent` in `src/daemon/daemon-events.ts`). Extract: (a) full event type union, (b) shared fields vs divergent fields, (c) what a merge would look like.

**Stop rule:** min 2 file reads (one OpenClaw, one WorkTrain); stop when field-level comparison is possible.

---

## SQ2: Trajectory write path and unified schema design

**Task:** (Depends on SQ6) Read `src/trajectory/runtime.ts`, `src/trajectory/export.ts`, `src/trajectory/metadata.ts`. Extract: (a) how events are written to disk (append-only? batched?), (b) the bundle format for export, (c) what a WorkTrain adaptation would look like given the session event schema comparison from SQ6.

**Stop rule:** min 3 file reads; stop when the write path is fully understood.

---

## SQ7: Additional quick-win patterns (catch-all)

**Task:** (Depends on SQ1, SQ3, SQ4) Read: `src/agents/subagent-registry.ts`, `src/agents/subagent-target-policy.ts`, any security patterns not yet covered. Specifically look for: (a) patterns in subagent dispatch that WorkTrain's `spawn_agent` tool could adopt, (b) input validation / sanitization patterns relevant to WorkTrain's webhook payload handling, (c) anything in `src/process/` or `src/infra/` that looks broadly useful.

**Stop rule:** min 4 file reads; stop when no new pattern categories emerge for 2 consecutive reads.
