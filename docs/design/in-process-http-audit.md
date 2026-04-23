# In-Process HTTP Audit: Daemon Calling Its Own API

**Date:** 2026-04-19
**Scope:** WorkTrain daemon coordinator deps -- calls from inside the daemon process to the daemon's own HTTP console (port 3456) or webhook (port 3200) servers.

---

## Summary

The daemon's in-process `coordinatorDeps` block (wired in `src/trigger/trigger-listener.ts:410-752`) contains **two functions** that make HTTP calls to the daemon's own console server at port 3456. Both functions should use `ConsoleService` directly instead.

**Bugs confirmed: 2**
**False positives excluded: CLI HTTP calls (correct design)**

---

## 1. Every HTTP-to-Self Call Found

### Bug 1: `awaitSessions` -- HTTP polling for session status

**File:line:** `src/trigger/trigger-listener.ts:499-540`

**What it does:**

```typescript
awaitSessions: async (handles: readonly string[], timeoutMs: number) => {
  const { executeWorktrainAwaitCommand } = await import('../cli/commands/worktrain-await.js');
  await executeWorktrainAwaitCommand(
    {
      fetch: (url: string) => globalThis.fetch(url),  // <-- real HTTP fetch
      ...
    },
    {
      sessions: [...handles].join(','),
      port: DAEMON_CONSOLE_PORT,  // 3456
      ...
    },
  );
```

`executeWorktrainAwaitCommand` calls `pollSession()` in `worktrain-await.ts` which builds:

```
GET http://127.0.0.1:3456/api/v2/sessions/<sessionHandle>
```

...every 3 seconds until the session status is terminal (`complete`, `complete_with_gaps`, `blocked`, `dormant`).

**Is it broken today?** Yes. Two active failure modes:
1. **Port unavailable:** If another process holds port 3456, or if `startDaemonConsole()` hasn't been called yet, the `fetch()` calls return `ECONNREFUSED` and all sessions are reported as `failed`.
2. **Race condition:** A session created in-process by `spawnSession()` may not yet be visible to the HTTP layer when the first poll fires. The HTTP layer reads from the same session store, but there is no synchronization guarantee between the in-process write and the HTTP server's view.

**Used by:** `full-pipeline.ts` (discovery, shaping, ux-gate, coding sessions), `implement.ts` (ux-gate, coding), `implement-shared.ts` (review, fix-agent, audit, re-review), `pr-review.ts` (review, fix, re-review).

---

### Bug 2: `getAgentResult` -- HTTP fetching for artifacts and recap

**File:line:** `src/trigger/trigger-listener.ts:542-609`

**What it does:**

```typescript
getAgentResult: async (sessionHandle: string) => {
  // Step 1: get session detail
  const sessionUrl = `http://127.0.0.1:${DAEMON_CONSOLE_PORT}/api/v2/sessions/${encodeURIComponent(sessionHandle)}`;
  const sessionRes = await globalThis.fetch(sessionUrl, { signal: AbortSignal.timeout(30_000) });
  // ... extracts runs[0].preferredTipNodeId and all nodeIds ...

  // Step 2: fetch each node
  const baseNodeUrl = `http://127.0.0.1:${DAEMON_CONSOLE_PORT}/api/v2/sessions/${encodeURIComponent(sessionHandle)}/nodes/`;
  for (const nodeId of nodeIdsToFetch) {
    const nodeRes = await globalThis.fetch(baseNodeUrl + encodeURIComponent(nodeId), ...);
    // ... extracts recapMarkdown and artifacts ...
  }
}
```

Makes 1 + N HTTP calls (1 for session detail, N for each node) to the daemon's own console server to collect `recapMarkdown` (for verdict keyword-scan fallback) and `artifacts` (for typed verdict reading via `readVerdictArtifact`).

**Is it broken today?** Yes. Same failure modes as Bug 1. Additionally:
- Artifacts written during in-process session execution may not be flushed to the HTTP-visible layer before `getAgentResult` is called
- Each node fetch has a 30-second timeout; for sessions with many nodes this adds latency

**Used by:** `full-pipeline.ts` (after discovery, to read handoff artifact), `implement-shared.ts` (after review, to read verdict artifact and recap).

---

## 2. Priority Ranking

| Rank | Bug | Impact | Blocks pipeline today? |
|------|-----|--------|----------------------|
| 1 | `awaitSessions` HTTP polling (Bug 1) | All pipelines hang or report sessions as failed if port 3456 unavailable | Yes |
| 2 | `getAgentResult` HTTP fetching (Bug 2) | Discovery handoff context missing; review verdict read fails if port 3456 unavailable | Yes -- silently degrades to empty artifacts / keyword-scan only |

Both bugs are blocking, not cosmetic. Bug 1 is higher priority because it affects every pipeline phase (all spawned sessions must be awaited). Bug 2 causes a cascade: if `getAgentResult` returns empty artifacts after a coding session, the review verdict cannot be read via the typed path and falls back to keyword-scan on `recapMarkdown`, which is itself also empty -- causing an escalation with reason `review verdict parse failed`.

---

## 3. Recommended Fix for Each

### Fix for Bug 1: `awaitSessions` -- In-process polling via ConsoleService

**Replace** the `executeWorktrainAwaitCommand` delegation with a direct polling loop using `ConsoleService.getSessionDetail()`.

**In-process equivalent:** `ConsoleService.getSessionDetail(sessionId)` returns `ConsoleSessionDetail` which includes `runs[0].status: ConsoleRunStatus`. The status values (`complete`, `complete_with_gaps`, `blocked`) map directly to the existing `statusToOutcome()` logic in `worktrain-await.ts`.

**What to build:**
- Construct a `ConsoleService` instance in `startTriggerListener()` using the `ctx.v2` deps already available (`ctx.v2.sessionStore`, `ctx.v2.snapshotStore`, `ctx.v2.pinnedStore`, `ctx.v2.dataDir`, `ctx.v2.directoryListing`)
- Replace `awaitSessions` with an in-process polling loop that calls `consoleService.getSessionDetail(handle)` every ~3 seconds until `runs[0].status` is terminal
- Handle `dormant` separately: since `ConsoleService.getSessionDetail()` returns `ConsoleRunStatus` (not `ConsoleSessionStatus`), `dormant` won't appear in `runs[0].status`. The polling loop's own timeout covers the dormant case -- sessions that go quiet will be caught by `timeoutMs`
- Wire the `ConsoleService` instance into `coordinatorDeps` via closure (same pattern as `routerRef`)

**Key files:**
- `src/trigger/trigger-listener.ts` -- replace `awaitSessions` implementation
- `src/v2/usecases/console-service.ts` -- `ConsoleService.getSessionDetail()` -- no changes needed
- `src/v2/usecases/console-types.ts` -- `ConsoleSessionDetail`, `ConsoleRunStatus` -- no changes needed

---

### Fix for Bug 2: `getAgentResult` -- In-process node detail via ConsoleService

**Replace** the two-phase HTTP fetch with `ConsoleService.getSessionDetail()` (for node IDs) and `ConsoleService.getNodeDetail()` (for per-node recap and artifacts).

**In-process equivalent:**
- `ConsoleService.getSessionDetail(sessionId)` returns `ConsoleSessionDetail.runs[0].nodes: readonly ConsoleDagNode[]` where each `ConsoleDagNode` has `nodeId` and `isPreferredTip`
- `ConsoleService.getNodeDetail(sessionId, nodeId)` returns `ConsoleNodeDetail` with `recapMarkdown: string | null` and `artifacts: readonly ConsoleArtifact[]` -- exactly what the current HTTP implementation extracts

**What to build:**
- Reuse the same `ConsoleService` instance constructed for Bug 1 fix
- Replace `getAgentResult` with an in-process version that calls `getSessionDetail` then `getNodeDetail` for each node
- Preserve the existing logic: collect artifacts from all nodes; collect `recapMarkdown` from the preferred-tip node only

**Key files:**
- `src/trigger/trigger-listener.ts` -- replace `getAgentResult` implementation
- `src/v2/usecases/console-service.ts` -- `ConsoleService.getNodeDetail()` -- no changes needed
- `src/v2/usecases/console-types.ts` -- `ConsoleNodeDetail` -- no changes needed

---

## 4. The Correct Architecture

### Current (broken) wiring

```
TriggerListener (daemon process)
  ├── startTriggerListener() constructs coordinatorDeps
  │   ├── awaitSessions: calls executeWorktrainAwaitCommand
  │   │   └── polls http://127.0.0.1:3456/api/v2/sessions/<id>  ← HTTP-to-self
  │   └── getAgentResult: calls globalThis.fetch
  │       └── fetches http://127.0.0.1:3456/api/v2/sessions/<id>/nodes/... ← HTTP-to-self
  └── startDaemonConsole() constructs ConsoleService (separately)
      └── ConsoleService.getSessionDetail()  ← in-process, not used by coordinatorDeps
      └── ConsoleService.getNodeDetail()     ← in-process, not used by coordinatorDeps
```

### Target (correct) wiring

```
TriggerListener (daemon process)
  └── startTriggerListener() constructs:
      ├── consoleService = new ConsoleService({ ctx.v2.sessionStore, ... })
      └── coordinatorDeps
          ├── awaitSessions: in-process polling loop
          │   └── consoleService.getSessionDetail(handle).runs[0].status  ← no HTTP
          └── getAgentResult: in-process node reading
              ├── consoleService.getSessionDetail(handle).runs[0].nodes   ← no HTTP
              └── consoleService.getNodeDetail(handle, nodeId)            ← no HTTP
```

### Why the same ConsoleService instance works for both

`ConsoleService` is a stateless projection reader -- it reads from `ctx.v2.sessionStore` (the same append-only event log written by the in-process session execution). Sessions created in-process by `spawnSession()` write their events to the same store that `ConsoleService` reads. There is no HTTP layer in this path -- the data is immediately available after commit.

### What should NOT use in-process access

The CLI `run pr-review` command (`src/cli-worktrain.ts:1265-1501`) is a **separate process** from the daemon. Its `spawnSession`, `awaitSessions`, and `getAgentResult` implementations correctly use HTTP to communicate with a running daemon. These are NOT bugs and should not be changed.

### AdaptiveCoordinatorDeps interface notes

The `AdaptiveCoordinatorDeps` interface (`src/coordinators/adaptive-pipeline.ts:131-169`) and the `CoordinatorDeps` interface it extends (`src/coordinators/pr-review.ts:131+`) define the dep function signatures but make no assumptions about transport. The interface is correct as-is. Only the concrete implementations in `trigger-listener.ts` need to change.

---

## Excluded from Scope

- WorkRail MCP server HTTP calls (out of scope per investigation brief)
- CLI `run pr-review` HTTP calls (external process, correct design)
- Webhook server (port 3200) -- no HTTP-to-self calls to this port found
- `polling-scheduler.ts`, `trigger-router.ts` -- no HTTP-to-self calls found
