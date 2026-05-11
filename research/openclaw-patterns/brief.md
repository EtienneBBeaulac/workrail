# Research Brief: OpenClaw Pattern Extraction for WorkTrain

**Intake question (verbatim):** What specific, directly-adaptable code patterns from OpenClaw's source can WorkTrain implement quickly to meaningfully improve -- across any part of the system?

---

## BLUF

OpenClaw's source contains at least 12 concrete, directly-portable patterns for WorkTrain across five subsystems. The highest-leverage item is the service audit accumulator pattern from `src/daemon/service-audit.ts` -- the entire `worktrain doctor` command can be built by adapting 6 pure functions and a `SERVICE_AUDIT_CODES` const object, directly addressing a confirmed P0 operational gap where daemon misconfiguration silently fails operators at 3am. The second cluster of quick wins are all hours-level changes: a `runId`/`provider`/`modelId` addition to `DaemonEvent` that closes the two-store correlation gap without schema migration, a 10-line `QueuedFileWriter` fix that prevents JSONL corruption under burst writes, and a two-layer path validation helper for file paths derived from config. The `computeBackoff()` pure function from OpenClaw's `src/infra/backoff.ts` is worth adopting opportunistically when WorkTrain builds a persistent retry queue, but has no confirmed wirable callsite today -- WorkTrain's `PollingScheduler` already uses `clearInterval()` (instant stop) and its delivery path uses at-most-once semantics with no retry loop.

---

## Ranked Findings

### F1: Service audit accumulator pattern (HIGH value, single-source) *(revised from F2)*

**Pattern:** `auditDaemonConfig(env, command, platform) -> { ok: boolean, issues: ServiceConfigIssue[] }`. `DAEMON_AUDIT_CODES` const object. Pure synchronous sub-functions + 2 async I/O sub-functions (plist read, binary path check). `checkTokenDrift()` as a standalone exported pure function.

**Evidence for:** `src/daemon/service-audit.ts` [SQ1-C1 through SQ1-C6]. Full flow read. `DaemonServiceCommand = { programArguments: string[], environment?: Record<string,string> } | null`.

**Evidence against:** No significant counter-evidence found.

**WorkTrain adaptation:** `src/daemon/daemon-audit.ts`. Phase 1 audit codes: `stale-binary`, `missing-api-key`, `api-key-embedded`, `plist-entrypoint-mismatch`, `plist-missing-run-at-load`, `plist-missing-keep-alive`, `port-mismatch`. `worktrain doctor` CLI command reads plist, constructs DaemonServiceCommand, calls auditDaemonConfig(), pretty-prints issues with suggested fixes.

---

### F2: runId + provider + modelId in DaemonEvent (MEDIUM value, inferred) *(revised from F4)*

**Pattern:** Add `runId` (process-local UUID, set once at session start and threaded through all events) + `provider` + `modelId` to `DaemonEvent`. `runId` enables correlation across the daemon event log and v2 session store without requiring `workrailSessionId` to be decoded first (~50ms gap after session start).

**Evidence for:** Inferred from `src/trajectory/types.ts` TrajectoryEvent schema [SQ6-C3] vs WorkTrain's `daemon-events.ts` [SQ6-C2]. TrajectoryEvent has `runId`, `provider`, `modelId`. WorkTrain has `workrailSessionId` (only available after token decode) but no `runId`, causing the console to miss events emitted before decode completes.

**Evidence against:** No significant counter-evidence. Additive -- no existing fields change.

**WorkTrain adaptation:** Add `runId?: string` to all per-session DaemonEvent interfaces. Set `runId = sessionId` (the process-local UUID) in `runWorkflow()` and thread through `buildPreAgentSession()`. Zero migration required.

---

### F3: QueuedFileWriter for DaemonEventEmitter (MEDIUM value, single-source)

**Pattern:** `Map<filePath, Promise<void>>` where each write chains onto the previous write for the same file. Prevents concurrent `appendFile()` calls from interleaving JSONL lines under burst writes.

**Evidence for:** `src/trajectory/runtime.ts` [SQ2-C1]. QueuedFileWriter keyed per filePath, capped at 100 entries (LRU eviction). Truncation sentinel reserves 2048 bytes so a full file still gets a closing marker.

**Evidence against:** Race only surfaces under burst (many tool calls in one turn); low priority at current traffic levels.

**WorkTrain adaptation:** Modify `DaemonEventEmitter._append()` to use a per-file promise chain: `this._writers.set(filePath, (this._writers.get(filePath) ?? Promise.resolve()).then(() => fs.appendFile(...)))`. ~10-line change.

---

### F4: Two-layer path validation + chmod 0o600 (MEDIUM value, single-source)

**Pattern:** For any file path constructed from user-controlled input: (1) `assertSafeId()` rejects '/', '\\', null bytes, (2) `isPathInside(safeDir, resolvedPath)` as second structural check. Then `chmod 0o600` on write.

**Evidence for:** `src/cron/run-log.ts` [SQ7-C7]. `assertSafeCronRunLogJobId()` + `isPathInside()`.

**Evidence against:** WorkTrain's `sessionId` values are `randomUUID()` (safe). The gap is `workflowId` and `triggerId` from config -- validated at parse time but not at file-construction time.

**WorkTrain adaptation:** Add `assertSafeFileSegment(id: string): string` to `src/infra/`. Apply to path construction using `workflowId` or `triggerId`. Add `chmod 0o600` to sidecar writes in `_shared.ts:persistTokens()`.

---

### F5: computeBackoff() pure function (LOW-MEDIUM value, single-source) *(revised from F1)*

**Pattern:** `BackoffPolicy = { initialMs, maxMs, factor, jitter }` + `computeBackoff(policy, attempt) -> ms`. Pure function, ~15 lines. `sleepWithAbort(ms, signal?)` is also useful but has no confirmed callsite in WorkTrain today -- WorkTrain's `PollingScheduler` already uses `setInterval()`/`clearInterval()` (already instant stop).

**Evidence for:** `src/infra/backoff.ts` [SQ7-C3, SQ7-C4].

**Evidence against (from dissent):** All three WorkTrain use cases cited in the original draft (callbackUrl POST retries, polling sleep, startup-recovery retries) require design work before backoff is applicable. callbackUrl is at-most-once; polling uses setInterval not sleep; startup-recovery makes one attempt not a retry loop [dissent.md].

**WorkTrain adaptation:** Copy `computeBackoff()` to `src/infra/backoff.ts`. Adopt when building a persistent retry queue for webhook delivery or callbackUrl POSTs. Not a "wire up now" item.

---

## Contradictions

None found among the claims. One factual error corrected via dissent (SQ7-C3 -- see Dissent section below).

---

## Falsified Priors

**P6 (falsified):** "OpenClaw's security subsystem has patterns for input validation / prompt injection scanning that WorkTrain could use for webhook payloads." Overturned by: GitHub issue #79168 (`[Feature] Content-based prompt injection scanning on tool output`) confirms this is NOT shipped -- it is a feature request. The `sanitizeHostExecEnv()` pattern from `infra/host-env-security.ts` IS useful but for Bash tool exec env, not webhook payload scanning.

---

## What we now know

- The service audit pattern's full accumulator flow is clear enough to implement `worktrain doctor` in one PR
- The task registry IS independently portable (no channel/gateway/session imports in task-registry.ts)
- OpenClaw's cron in-memory activeJobIds bug (#79196) is the exact failure mode WorkTrain should avoid when adding a task registry -- do not use an in-memory Set for active-session tracking without persisting it
- The spawn allowlist policy (`resolveSubagentTargetPolicy`) is a pure function extractable without any OpenClaw infrastructure
- `runId` + `provider` + `modelId` addition to DaemonEvent closes the console correlation gap without schema migration
- WorkTrain's `PollingScheduler` already uses `setInterval()` / `clearInterval()` -- stop() is already instant; `sleepWithAbort()` has no immediate application there
- `computeBackoff()` is a well-designed primitive for when WorkTrain builds a retry queue, not a current callsite fix

## What we still do not know

- Whether QueuedFileWriter is available as a standalone file in OpenClaw or requires heavy infrastructure (needs a 5-minute follow-up read of `src/agents/queued-file-writer.ts`)
- The performance profile of the SQLite task registry under WorkTrain's session rates (high insert, low query)
- Whether the `ContextAssembler` interface seam would require changing test harnesses that directly call `buildSystemPrompt()` today
- Commitment extraction: whether the LLM-extraction model for agent promises is reusable without OpenClaw's session machinery

---

## Implications for roadmap prioritization

| Priority | Pattern | Effort | Impact |
|----------|---------|--------|--------|
| 1 | Service audit / worktrain doctor (F1) | 1-2 days | Solves confirmed P0 operational gap |
| 2 | runId + provider + modelId in DaemonEvent (F2) | Hours | Closes console correlation gap |
| 3 | QueuedFileWriter for event emitter (F3) | ~10 lines | Prevents JSONL corruption under burst |
| 4 | Two-layer path validation + chmod (F4) | Hours | Security hardening |
| 5 | progressSummary + terminalSummary in session tracking | Half day | Enables worktrain status without store scan |
| 6 | Spawn allowlist policy (SQ7-C1) | Half day | Prevents coordinator workflow abuse |
| 7 | Interrupted-startup-run recovery category (SQ5-C3) | Half day | More precise crash recovery signal |
| 8 | computeBackoff() (F5) | Hours (copy) | Adopt now; wire up when retry queue is built |
| 9 | Centralized event data sanitization constants (SQ2-C3) | Hours | Consistency, not correctness |
| 10 | ContextAssembler interface (SQ3-C1) | 1-2 days | Enables pluggable context; non-urgent |

---

## Recommended next steps

1. **Create 3 GitHub issues for the hours-effort items (F2+F3+F4):** `runId/provider/modelId DaemonEvent fields`, `QueuedFileWriter for event emitter`, `two-layer path validation`. Collective effort < 1 day, combined impact: better correlation, no JSONL corruption, security hardening.

2. **Create the `worktrain doctor` issue** (F1, 1-2 days) with the audit codes list from F1 as acceptance criteria: `stale-binary`, `missing-api-key`, `api-key-embedded`, `plist-entrypoint-mismatch`, `plist-missing-keep-alive`. The complete design sketch in F1 is sufficient to start without further discovery.

3. **Before implementing F3: check QueuedFileWriter for standalone availability** -- `gh api repos/openclaw/openclaw/contents/src/agents/queued-file-writer.ts`. If small and self-contained, copy it. If heavy, reimplement the 10-line promise-chain version directly.

---

## Dissent

The original draft ranked `computeBackoff + sleepWithAbort` as finding #1 ("highest-leverage single item") and claimed `sleepWithAbort()` would make WorkTrain's `PollingScheduler.stop()` instant "rather than waiting up to `pollIntervalSeconds`." The adversarial review (WorkRail Executor subagent) identified this as a factual error: WorkTrain's `PollingScheduler` uses `setInterval()`/`clearInterval()`, not a sleep-loop. `stop()` is already instant. The "problem" does not exist. The error cascaded: none of the three claimed callsites for `computeBackoff()` (callbackUrl retries, polling sleep, startup-recovery retries) exist in WorkTrain today without design work. The ranking has been corrected: F1 is now the service audit pattern (confirmed P0 gap); `computeBackoff()` is demoted to F5 with the honest scope of "adopt now, wire up when retry queue is built." The dissent identified the load-bearing weak claim (SQ7-C3) and the systemic issue: patterns were evaluated by OpenClaw source existence, not checked against WorkTrain's actual implementation.

---

## Premortem

If this brief turns out to be wrong six months from now, the most likely reason is that the patterns were evaluated from type definitions and function signatures without running against WorkTrain's actual runtime behavior. The QueuedFileWriter fix (F3) could introduce a subtle ordering bug if two concurrent sessions share a file path (unlikely but not impossible). The service audit (F1) could produce false-positive "stale binary" warnings if the binary mtime check is sensitive to non-critical rebuilds. More broadly: the single-source confidence level means any of these patterns may have open bugs in OpenClaw's own issue tracker that were not checked.

---

## Evidence base

[1] `src/daemon/service-audit.ts` (openclaw/openclaw) -- SQ1-C1 through SQ1-C6
[2] `src/daemon/service-env.ts` (openclaw/openclaw) -- env var handling reference
[3] `src/context-engine/registry.ts` (openclaw/openclaw) -- SQ3-C1 through SQ3-C5
[4] `src/context-engine/delegate.ts` (openclaw/openclaw) -- SQ3-C5
[5] `src/tasks/task-executor.ts` (openclaw/openclaw) -- SQ4-C1 through SQ4-C2
[6] `src/tasks/detached-task-runtime.ts` (openclaw/openclaw) -- SQ4-C2
[7] `src/tasks/task-registry.ts` (openclaw/openclaw) -- SQ4-C3
[8] `src/cron/active-jobs.ts` (openclaw/openclaw) -- SQ5-C1
[9] `src/cron/run-log.ts` (openclaw/openclaw) -- SQ5-C2, SQ7-C7
[10] `src/cron/schedule.ts` (openclaw/openclaw) -- SQ5-C4
[11] `src/cron/service/ops.ts` (openclaw/openclaw) -- SQ5-C3
[12] `src/sessions/session-lifecycle-events.ts` (openclaw/openclaw) -- SQ6-C1
[13] `src/daemon/daemon-events.ts` (workrail/workrail) -- SQ6-C2
[14] `src/trajectory/types.ts` (openclaw/openclaw) -- SQ6-C3
[15] `src/trajectory/runtime.ts` (openclaw/openclaw) -- SQ2-C1 through SQ2-C3
[16] `src/agents/subagent-target-policy.ts` (openclaw/openclaw) -- SQ7-C1
[17] `src/daemon/runtime-hints.ts` (openclaw/openclaw) -- SQ7-C2
[18] `src/infra/backoff.ts` (openclaw/openclaw) -- SQ7-C3, SQ7-C4
[19] `src/infra/host-env-security.ts` (openclaw/openclaw) -- SQ7-C5
[20] `src/daemon/service-managed-env.ts` (openclaw/openclaw) -- SQ7-C6

---

## Appendix A: Priors Ledger (final state)

- P1 (corroborated): Service audit portable -- confirmed by SQ1-C1 through SQ1-C6
- P2 (corroborated): Task registry portable -- confirmed by SQ4-C3
- P3 (prior:unverified): Commitment extraction not a quick win -- not investigated
- P4 (corroborated): Cron patterns relevant -- confirmed by SQ5-C1 through SQ5-C4
- P5 (corroborated with nuance): Subagent model complex -- full role model is complex, but spawn allowlist policy IS a quick win
- P6 (falsified): Injection scanning not shipped -- overturned by GitHub issue #79168
- P7 (corroborated): Restart handling more sophisticated -- PID-wait handoff confirmed

## Appendix B: Source Map

See `source-map.md`

## Appendix C: Dependency Matrix

See `dependency-matrix.json`

## Appendix D: Gap Analysis Log

See `gap-analysis.md`

*Sources: GitHub repository openclaw/openclaw (MIT), WorkTrain source (direct read). All claims single-source unless marked [inferred]. Analysis date: 2026-05-07. Stale after: 2026-08-05.*
