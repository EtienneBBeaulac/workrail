# Daemon Memory Audit

_Audit date: 2026-04-19. Auditor: Claude (wr.bug-investigation workflow)._

## Context

The WorkTrain daemon runs continuously for days. This audit catalogues every module-level or instance-level mutable variable, cache, Map, Set, and Array in six specified files, assesses whether growth is bounded, identifies the cleanup mechanism, and rates severity.

**Files audited:**

1. `src/trigger/trigger-router.ts`
2. `src/trigger/polling-scheduler.ts`
3. `src/v2/usecases/worktree-service.ts`
4. `src/v2/infra/in-memory/daemon-registry/index.ts`
5. `src/v2/infra/in-memory/keyed-async-queue/index.ts`
6. `src/daemon/daemon-events.ts`

**Out of scope:** `src/mcp/`, `src/v2/durable-core/`, all test files.

---

## Findings Table

| # | File | Variable | Type | Holds | Growth Bound | Cleanup Mechanism | Severity | Notes |
|---|------|----------|------|-------|-------------|-------------------|----------|-------|
| 1 | `polling-scheduler.ts` | `appendQueuePollLog` writes to `queue-poll.jsonl` | Disk file (not in-memory) | One JSON line per poll-cycle event | **Unbounded** | None -- single fixed path, `appendFile` only | **Critical** | See Finding 1 |
| 2 | `worktree-service.ts` | `enrichmentQueue` (module-level) | `Array<() => void>` | Pending waiter callbacks for foreground git semaphore slots | Unbounded in theory | `releaseEnrichmentSlot()` shifts and calls next | **Major** | See Finding 2 |
| 3 | `worktree-service.ts` | `backgroundEnrichmentQueue` (module-level) | `Array<() => void>` | Pending waiter callbacks for background git semaphore slots | Unbounded in theory | `releaseBackgroundSlot()` shifts and calls next | **Major** | See Finding 2 |
| 4 | `trigger-router.ts` | `_recentAdaptiveDispatches` (instance) | `Map<string, number>` | `${goal}::${workspace}` -> last dispatch timestamp | Bounded at 30s TTL, but only cleaned on next dispatch | Cleanup-on-entry: purge stale before check/insert | **Minor** | See Finding 3 |
| 5 | `polling-scheduler.ts` | `dispatchingIssues` (instance) | `Set<number>` | Issue numbers whose `dispatchAdaptivePipeline` Promise is in-flight | Bounded by session timeout (max ~65 min) | `.then()` + `.catch()` unconditionally delete | **Minor** | See Finding 4 |
| 6 | `daemon-registry/index.ts` | `entries` (instance) | `Map<string, DaemonEntry>` | Active autonomous session liveness records | Bounded by active session count | `unregister()` in `runWorkflow()` finally block | **Minor** | See Finding 5 |
| 7 | `keyed-async-queue/index.ts` | `queues` (instance) | `Map<string, Promise<void>>` | Per-key async serialization chains | Bounded by keys with pending work | `.finally()` identity check deletes on completion | **Acceptable** | Correct design |
| 8 | `trigger-router.ts` | `semaphore.waiters` (instance) | `Array<() => void>` | Callers waiting for a concurrency slot | Bounded by dispatch rate / completion rate | `semaphore.release()` shifts and calls next | **Acceptable** | Transient, not a leak |
| 9 | `worktree-service.ts` | `worktreeCache` (module-level) | `WorktreeCache \| null` | Single enriched worktree scan result | Bounded: single object, replaced on TTL expiry | Replaced every 45s (WORKTREE_CACHE_TTL_MS) | **Acceptable** | Large for big repos but not accumulating |
| 10 | `worktree-service.ts` | `backgroundEnrichmentInFlight` (module-level) | `boolean` | Single dedup guard flag | n/a (scalar) | Reset in `finally` block of `runBackgroundEnrichment` | **Acceptable** | No growth |
| 11 | `worktree-service.ts` | `onEnrichmentComplete` (module-level) | `(() => void) \| null` | Single SSE broadcast callback | n/a (single reference) | Overwritten by `setEnrichmentCompleteCallback` | **Acceptable** | No growth |
| 12 | `worktree-service.ts` | `activeEnrichments` (module-level) | `number` | Count of running foreground enrichments | Bounded by MAX_CONCURRENT_ENRICHMENTS=8 | Decremented in `releaseEnrichmentSlot()` | **Acceptable** | No growth |
| 13 | `worktree-service.ts` | `activeBackgroundEnrichments` (module-level) | `number` | Count of running background enrichments | Bounded by MAX_BACKGROUND_ENRICHMENTS=16 | Decremented in `releaseBackgroundSlot()` | **Acceptable** | No growth |
| 14 | `daemon-events.ts` | `_dir` (instance) | `string` | Output directory path | n/a (immutable after construction) | n/a | **Acceptable** | No state accumulation |
| 15 | `polling-scheduler.ts` | `intervals` (instance) | `Map<string, interval handle>` | Active setInterval/setTimeout handles | Bounded by trigger count (fixed at startup) | `stop()` clears all handles | **Acceptable** | Fixed at startup |
| 16 | `polling-scheduler.ts` | `polling` (instance) | `Map<string, boolean>` | Skip-cycle guard flags per trigger | Bounded by trigger count (fixed at startup) | Reset in `runPollCycle()` finally block | **Acceptable** | Fixed at startup |

---

## Detailed Findings

### Finding 1 -- Critical: `queue-poll.jsonl` grows without bound

**File:** `src/trigger/polling-scheduler.ts`, `appendQueuePollLog()` at line 800  
**Also:** `src/cli-worktrain.ts` line 717

`queue-poll.jsonl` is written to a single fixed path (`~/.workrail/queue-poll.jsonl`) using `fs.appendFile`. There is no rotation, no size cap, and no TTL. The file grows one or more JSON lines per poll cycle for every event (task_selected, task_skipped, poll_cycle_complete, poll_cycle_skipped).

`cli-worktrain.ts` line 717-718 explicitly states:
> "WHY constants: queue-poll and stderr are permanent files that never rotate."

This is a design choice, not an oversight, but it creates a disk exhaustion risk for any 24/7 deployment.

**Growth estimate:**

| Poll interval | Events per cycle | Lines per day | Size per day | Size per month |
|--------------|-----------------|---------------|--------------|----------------|
| 5 min | 5 | 1,440 | ~290 KB | ~8.7 MB |
| 1 min | 10 | 14,400 | ~2.9 MB | ~87 MB |

**Recommended fix:** Add size-capped rotation. When `queue-poll.jsonl` exceeds a configurable threshold (default: 50 MB), rename to `queue-poll.jsonl.1` and start a new file. Keep at most 2 rotated files. Alternatively, switch to the same daily-rotation pattern used by `DaemonEventEmitter` (daily JSONL files under `~/.workrail/events/daemon/YYYY-MM-DD.jsonl`), which already handles rotation by filename.

**What happens if cleanup fails:** File continues to grow. On a 1-min polling daemon with many skipped issues, the file could reach gigabyte scale within weeks.

---

### Finding 2 -- Major: `enrichmentQueue` and `backgroundEnrichmentQueue` have no depth cap

**File:** `src/v2/usecases/worktree-service.ts`, `acquireEnrichmentSlot()` at line 143 and `acquireBackgroundSlot()` at line 182

Both functions implement a Promise-based semaphore by pushing a resolve callback to a module-level Array when all slots are occupied. There is no `if (queue.length >= MAX)` guard before the push.

```
// Current code -- no capacity check:
enrichmentQueue.push(resolve);
```

**Impact:** If an HTTP client disconnects before the request completes, the dangling resolve callback is retained in the array indefinitely (there is no AbortController or request-lifecycle cleanup). If many concurrent requests arrive (e.g., a frontend bug that loops on failure), the array grows without bound.

**Normal operation:** Under single-client usage, the `backgroundEnrichmentInFlight` guard prevents multiple background scans from running simultaneously (one scan per 45s TTL window). The foreground queue only fills during burst scenarios. In practice, arrays stay near-empty under normal single-browser-client console usage.

**Recommended fix:** Add a max-depth guard before each push:

```typescript
const MAX_ENRICHMENT_QUEUE_DEPTH = 32; // or configurable

// In acquireEnrichmentSlot:
if (enrichmentQueue.length >= MAX_ENRICHMENT_QUEUE_DEPTH) {
  reject(new Error('enrichment queue full -- too many concurrent worktree requests'));
  return;
}
enrichmentQueue.push(resolve);
```

For correctness, also add cleanup when an HTTP request is cancelled (tie into `req.on('close', ...)` and remove the specific resolve from the array or replace it with a no-op).

**What happens if cleanup fails:** Waiter callbacks accumulate in memory. On a long-running daemon with a misbehaving frontend or test harness, this could eventually cause OOM. Under normal usage, the risk is low.

---

### Finding 3 -- Minor: `_recentAdaptiveDispatches` retains stale entries during idle periods

**File:** `src/trigger/trigger-router.ts`, `_recentAdaptiveDispatches` at line 500

The cleanup-on-entry pattern is documented and intentional (avoids background timers). Stale entries older than `ADAPTIVE_DEDUPE_TTL_MS` (30s) are purged when the next dispatch arrives. During idle periods (no dispatches), stale entries from the last active burst persist.

**Impact:** Each entry is a `string -> number` pair (goal::workspace key + timestamp). The key length is bounded by goal string length (capped implicitly by webhook payload size). After a burst of N unique dispatches, N entries persist until the next dispatch. For a daemon that processes 100 unique GitHub issues per hour during peak and then goes idle for 12 hours, 100 entries remain in memory. At ~200 bytes each, that is ~20 KB -- negligible.

**Recommended fix:** Either accept as a design tradeoff (entries are small and bounded by the last burst size), or add a low-frequency background sweep:

```typescript
// In constructor, after semaphore init:
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of this._recentAdaptiveDispatches) {
    if (now - ts >= TriggerRouter.ADAPTIVE_DEDUPE_TTL_MS) {
      this._recentAdaptiveDispatches.delete(key);
    }
  }
}, TriggerRouter.ADAPTIVE_DEDUPE_TTL_MS * 2).unref();
```

The `.unref()` prevents the timer from keeping the process alive.

**What happens if cleanup fails:** Stale entries persist beyond their TTL. Maximum impact is a slight memory overhead proportional to the last dispatch burst size. No correctness impact (entries only guard against duplicates within the 30s window, which is already expired).

---

### Finding 4 -- Minor: `dispatchingIssues` bounded but imperfectly

**File:** `src/trigger/polling-scheduler.ts`, `dispatchingIssues` at line 113

Issue numbers are added before `dispatchAdaptivePipeline()` (I1) and removed unconditionally in both `.then()` and `.catch()` (I2). The Promise returned by `dispatchAdaptivePipeline` (which calls `runAdaptivePipeline` -> executor -> `runWorkflow`) is guaranteed to settle within the configured session timeout because `workflow-runner.ts` line 3792 uses `Promise.race([agentLoop, timeoutPromise])`.

**Residual risk:** If the `timeoutHandle` in `workflow-runner.ts` is somehow garbage-collected before firing (extremely unlikely in V8), or if the WorkRail MCP server becomes permanently unresponsive while the Promise is awaiting it (no top-level abort signal), the Promise could hang and the issue number would persist in `dispatchingIssues` until daemon restart.

**Recommended fix:** Add a conservative defense-in-depth timeout in the polling scheduler:

```typescript
const ISSUE_DISPATCH_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h safety ceiling

const dispatchP = this.router.dispatchAdaptivePipeline(...);
const timeoutP = new Promise<void>((_, reject) =>
  setTimeout(() => reject(new Error('dispatch timeout')), ISSUE_DISPATCH_TIMEOUT_MS)
);
void Promise.race([dispatchP, timeoutP])
  .then(() => { this.dispatchingIssues.delete(top.issue.number); })
  .catch(() => { this.dispatchingIssues.delete(top.issue.number); });
```

**What happens if cleanup fails:** The issue is permanently skipped with reason `active_session_in_process`. On a long-running daemon, progressive issue numbers accumulate in the set. After N such leaks, N issues are silently skipped every poll cycle, degrading queue throughput.

---

### Finding 5 -- Minor: `DaemonRegistry.entries` leak on abnormal session exit

**File:** `src/v2/infra/in-memory/daemon-registry/index.ts`

`DaemonRegistry.unregister()` is called from `runWorkflow()` in a `finally` block, which executes on both success and failure paths. This is the correct pattern.

**Residual risk:** If the outer async chain holding `runWorkflow()` is abandoned (e.g., the process receives SIGKILL mid-session), the `finally` block does not run and the entry leaks. However, `DaemonRegistry` is an instance-level variable that is cleared on process restart. The console's `AUTONOMOUS_HEARTBEAT_THRESHOLD_MS` check provides a secondary liveness gate -- stale entries stop showing as "live" once their `lastHeartbeatMs` ages beyond the threshold.

**Recommended fix:** No urgent action needed. Optionally, add a scheduled cleanup pass that removes entries where `lastHeartbeatMs` has not been updated within 2x the heartbeat interval:

```typescript
// In DaemonRegistry: periodic stale-entry sweep
sweep(maxStalenessMs: number): void {
  const now = Date.now();
  for (const [id, entry] of this.entries) {
    if (now - entry.lastHeartbeatMs > maxStalenessMs) {
      this.entries.delete(id);
    }
  }
}
```

**What happens if cleanup fails:** Stale entries show as "running" in the console beyond SIGKILL scenarios. Bounded by the heartbeat threshold check; no correctness impact on session execution.

---

## Summary by Severity

| Severity | Count | Items |
|----------|-------|-------|
| Critical | 1 | queue-poll.jsonl unbounded disk growth |
| Major | 2 | enrichmentQueue depth (no cap), backgroundEnrichmentQueue depth (no cap) |
| Minor | 3 | _recentAdaptiveDispatches idle stale entries, dispatchingIssues session-bounded leak, DaemonRegistry SIGKILL leak |
| Acceptable | 9 | All others -- correct cleanup, bounded, or scalar |

---

## Recommended Fix Priority

1. **queue-poll.jsonl rotation** -- disk exhaustion risk on any always-on deployment. Implement size-capped rotation or daily files (1-2 hours work).
2. **enrichmentQueue/backgroundEnrichmentQueue depth cap** -- add max-depth guard before push (30 min work). Low-impact under normal usage but correctness risk under misbehaving client scenarios.
3. **_recentAdaptiveDispatches background sweep** -- add `.unref()` setInterval sweep (15 min work). Can also be deferred as an accepted tradeoff.
4. **dispatchingIssues defense timeout** -- add 4-hour `Promise.race` ceiling as defense-in-depth (15 min work).
5. **DaemonRegistry stale-entry sweep** -- add optional scheduled sweep (15 min work). Not urgent.
