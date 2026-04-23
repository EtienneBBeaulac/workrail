# Coordinator Access Audit: HTTP vs. In-Process Dep Functions

**Date:** 2026-04-19
**Scope:** All `coordinatorDeps` functions in `src/trigger/trigger-listener.ts` (lines 410-752),
covering `CoordinatorDeps` and `AdaptiveCoordinatorDeps` interfaces.

**TL;DR:** Two dep functions (`awaitSessions`, `getAgentResult`) make HTTP calls to the daemon's
own console API (port 3456) from inside the daemon process. Both have direct in-process
replacements via `ConsoleService`. All other deps are correctly implemented.

---

## 1. Dep-by-Dep Audit Table

| Dep function | Lines | What it does | Transport | In-process access exists? | Breaks when HTTP fails? | Status |
|---|---|---|---|---|---|---|
| `spawnSession` | 411-476 | Allocate a session, dispatch to agent loop | **In-process** (`executeStartWorkflow` + `router.dispatch`) | n/a (already in-process) | No -- no HTTP | FIXED |
| `contextAssembler` | 478-497 | Assemble git diff + prior session notes | **CLI** (`git`, `gh` subprocesses) | No in-process alternative for `git`/`gh` | Only if `git`/`gh` binary unavailable -- acceptable | CORRECT |
| `awaitSessions` | 499-540 | Poll for session terminal status | **HTTP** to `GET /api/v2/sessions/:id` on port 3456 | Yes -- `ConsoleService.getSessionDetail()` | **Yes** -- ECONNREFUSED if port unavailable | **BUG** |
| `getAgentResult` | 542-609 | Fetch recap + artifacts from completed session | **HTTP** to `GET /api/v2/sessions/:id` + `/nodes/:id` on port 3456 | Yes -- `ConsoleService.getSessionDetail()` + `.getNodeDetail()` | **Yes** -- returns empty result silently | **BUG** |
| `listOpenPRs` | 611-622 | List open PRs via `gh pr list` | **CLI** (`gh` subprocess) | No in-process alternative | Only if `gh` unavailable -- acceptable | CORRECT |
| `mergePR` | 624-635 | Merge PR via `gh pr merge --squash` | **CLI** (`gh` subprocess) | No in-process alternative | Only if `gh` unavailable -- acceptable | CORRECT |
| `writeFile` | 637-639 | Write a file to disk | **Filesystem** (`fs.promises.writeFile`) | n/a | Only on disk I/O error -- acceptable | CORRECT |
| `readFile` | 641 | Read a file from disk | **Filesystem** (`fs.promises.readFile`) | n/a | Only on disk I/O error -- acceptable | CORRECT |
| `appendFile` | 643-644 | Append content to a file | **Filesystem** (`fs.promises.appendFile`) | n/a | Only on disk I/O error -- acceptable | CORRECT |
| `mkdir` | 646-647 | Create directory (recursive) | **Filesystem** (`fs.promises.mkdir`) | n/a | Only on disk I/O error -- acceptable | CORRECT |
| `homedir` | 649 | Return home directory path | **OS** (`os.homedir()`) | n/a | Never -- pure OS call | CORRECT |
| `joinPath` | 650 | Join path segments | **Pure** (`path.join`) | n/a | Never -- pure function | CORRECT |
| `nowIso` | 651 | Return ISO timestamp | **Pure** (`new Date().toISOString()`) | n/a | Never -- pure function | CORRECT |
| `generateId` | 652 | Generate UUID | **Pure** (`randomUUID()`) | n/a | Never -- pure function | CORRECT |
| `stderr` | 654 | Write to stderr | **Process** (`process.stderr.write`) | n/a | Never -- process I/O | CORRECT |
| `now` | 655 | Return current ms timestamp | **Pure** (`Date.now()`) | n/a | Never -- pure function | CORRECT |
| `port` | 656 | Resolved console port number | Constant (3456) | Not a function -- used by CLI context | n/a | REMOVE after fix |
| `fileExists` | 660 | Check file existence (sync) | **Filesystem** (`fs.existsSync`) | n/a | Only on unusual FS errors | CORRECT |
| `archiveFile` | 662-663 | Move a file (archive) | **Filesystem** (`fs.promises.rename`) | n/a | Only on disk I/O error -- acceptable | CORRECT |
| `pollForPR` | 665-692 | Poll `gh pr list` for a matching PR | **CLI** (`gh` subprocess in a loop) | No in-process alternative | Only if `gh` unavailable -- acceptable | CORRECT |
| `postToOutbox` | 694-705 | Append entry to `~/.workrail/outbox.jsonl` | **Filesystem** (direct JSONL append) | n/a | Only on disk I/O error -- acceptable | CORRECT |
| `pollOutboxAck` | 707-751 | Poll `~/.workrail/inbox-cursor.json` for ack | **Filesystem** (polling loop) | n/a | Only on disk I/O error -- acceptable | CORRECT |

**Summary:** 2 bugs (`awaitSessions`, `getAgentResult`). 20 deps correct. 1 constant to remove.

---

## 2. Priority-Ranked Fix List

### Priority 1 -- `awaitSessions` (all pipelines)

**File:** `src/trigger/trigger-listener.ts:499-540`

**Impact:** Every pipeline phase that spawns child sessions uses `awaitSessions`:
- `full-pipeline.ts`: discovery, shaping, ux-gate, coding sessions
- `implement.ts`: ux-gate, coding
- `implement-shared.ts`: review, fix-agent, audit, re-review
- `pr-review.ts`: review, fix, re-review

**Failure modes:**
1. Port unavailable (startup race, port conflict, test environment): `ECONNREFUSED` -- all handles returned as `outcome: 'failed'`. The coordinator interprets this as every spawned session having crashed, triggering cascading escalations.
2. HTTP server not yet bound: sessions created in-process by `spawnSession()` may be polled before the HTTP server starts. First poll returns 404 (session not found).

**Why high priority:** Failing `awaitSessions` terminates the entire coordinator pipeline. It is called at every await point across all pipeline modes.

---

### Priority 2 -- `getAgentResult` (verdict and handoff artifacts)

**File:** `src/trigger/trigger-listener.ts:542-609`

**Impact:** Called after every `awaitSessions` resolves with `outcome: 'success'` to extract recap markdown and artifacts. Used by:
- Review phases: reads `wr.review_verdict` artifact for typed verdict extraction
- Discovery phase (FULL pipeline): reads handoff artifact with shaping context

**Failure modes:**
1. Port unavailable: returns `{ recapMarkdown: null, artifacts: [] }` silently (no error thrown). The coordinator falls back to keyword-scan on `null` notes, producing `severity: 'unknown'` which routes to escalation.
2. 30-second per-fetch timeout: for sessions with many nodes, the N sequential node fetches can add minutes of latency.
3. Silent degradation: the `getAgentResult` fallback makes it look like the session succeeded but produced no usable output, causing the coordinator to escalate with opaque reasons.

**Why priority 2 (not 1):** Only fires after sessions actually complete. A broken `awaitSessions` prevents reaching `getAgentResult` entirely.

---

### Priority 3 -- Remove `port: DAEMON_CONSOLE_PORT` from `coordinatorDeps`

**File:** `src/trigger/trigger-listener.ts:656`

The `port` field is referenced in `pr-review.ts`'s `discoverConsolePort()` helper which is only called from the CLI entry point (`src/cli-worktrain.ts`), not from the in-process coordinator. After the two bugs above are fixed, this constant and the `DAEMON_CONSOLE_PORT = 3456` declaration (line 402) and its associated comment (lines 394-401) can be removed from `trigger-listener.ts`.

---

## 3. Recommended In-Process Architecture

### Root cause

`awaitSessions` and `getAgentResult` were implemented when the coordinator ran as an out-of-process CLI command (`worktrain run pr-review`). HTTP was the correct transport there. When the coordinator was moved into the daemon (TriggerRouter in `trigger-listener.ts`), only `spawnSession` was migrated to in-process. The other two deps were deferred. The comment at line 394 acknowledges this:

> `// WHY port=3456 (DAEMON_CONSOLE_PORT): still used by awaitSessions and getAgentResult which poll the console HTTP API`

### Current (broken) wiring

```
TriggerListener (daemon process)
  ├── coordinatorDeps (wired in startTriggerListener)
  │   ├── spawnSession:     executeStartWorkflow + router.dispatch  [in-process, CORRECT]
  │   ├── awaitSessions:    executeWorktrainAwaitCommand
  │   │                     └── fetch http://127.0.0.1:3456/api/v2/sessions/:id  [HTTP-to-self, BUG]
  │   └── getAgentResult:   globalThis.fetch
  │                         └── http://127.0.0.1:3456/api/v2/sessions/:id/nodes/...  [HTTP-to-self, BUG]
  └── startDaemonConsole() (separate call, after coordinatorDeps)
      └── consoleService = new ConsoleService({ ctx.v2.sessionStore, ... })
          ├── getSessionDetail()  [in-process, NOT wired to coordinatorDeps]
          └── getNodeDetail()     [in-process, NOT wired to coordinatorDeps]
```

### Target (correct) wiring

```
TriggerListener (daemon process)
  └── startTriggerListener()
      ├── consoleService = new ConsoleService({   [constructed BEFORE coordinatorDeps]
      │     directoryListing: ctx.v2.directoryListing,
      │     dataDir:          ctx.v2.dataDir,
      │     sessionStore:     ctx.v2.sessionStore,
      │     snapshotStore:    ctx.v2.snapshotStore,
      │     pinnedWorkflowStore: ctx.v2.pinnedStore,
      │   })
      └── coordinatorDeps
          ├── awaitSessions:    in-process polling loop
          │   └── consoleService.getSessionDetail(handle)  [no HTTP, no port]
          │       └── runs[0].status: ConsoleRunStatus
          └── getAgentResult:   in-process node reading
              ├── consoleService.getSessionDetail(handle)  [no HTTP, no port]
              │   └── runs[0]: { nodes, preferredTipNodeId }
              └── consoleService.getNodeDetail(handle, nodeId)  [no HTTP, no port]
                  └── { recapMarkdown, artifacts }
```

### `awaitSessions` in-process design

```typescript
awaitSessions: async (handles: readonly string[], timeoutMs: number) => {
  const startMs = Date.now();
  const pending = new Set(handles);
  const results = new Map<string, SessionResult>();

  while (pending.size > 0) {
    const elapsed = Date.now() - startMs;
    if (elapsed >= timeoutMs) {
      // timeout: remaining handles marked as 'timeout'
      break;
    }

    for (const handle of [...pending]) {
      const detail = await consoleService.getSessionDetail(handle);
      if (detail.isErr()) {
        // 'SESSION_LOAD_FAILED' or 'NODE_NOT_FOUND': session not yet visible or corrupt
        continue; // retry on next poll cycle
      }
      const run = detail.value.runs[0];
      if (!run) continue; // session started but no run yet

      const status: ConsoleRunStatus = run.status;
      // Terminal: complete, complete_with_gaps (success), blocked (failed)
      // in_progress: still running
      // ConsoleRunStatus does not include 'dormant' -- the poll timeout covers dormant.
      if (status === 'complete' || status === 'complete_with_gaps') {
        results.set(handle, { handle, outcome: 'success', status, durationMs: Date.now() - startMs });
        pending.delete(handle);
      } else if (status === 'blocked') {
        results.set(handle, { handle, outcome: 'failed', status, durationMs: Date.now() - startMs });
        pending.delete(handle);
      }
    }

    if (pending.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    }
  }

  // Any remaining pending handles: timeout
  for (const handle of pending) {
    results.set(handle, { handle, outcome: 'timeout', status: null, durationMs: timeoutMs });
  }

  const resultsArray = [...results.values()];
  return {
    results: resultsArray,
    allSucceeded: resultsArray.every((r) => r.outcome === 'success'),
  };
},
```

Key design decisions:
- `SESSION_LOAD_FAILED` on `getSessionDetail` is treated as "not ready yet" (retry), not as failure. This handles the case where the session event log has just been created by `spawnSession` but is not yet complete enough to project.
- `dormant` is not a `ConsoleRunStatus` -- it is a `ConsoleSessionStatus` computed by `ConsoleService` using mtime + `DORMANCY_THRESHOLD_MS`. The poll timeout (`timeoutMs`) handles sessions that go quiet.
- Poll interval of 3000ms matches the current `executeWorktrainAwaitCommand` default.

### `getAgentResult` in-process design

```typescript
getAgentResult: async (sessionHandle: string) => {
  const emptyResult = { recapMarkdown: null, artifacts: [] as readonly unknown[] };

  const detailResult = await consoleService.getSessionDetail(sessionHandle);
  if (detailResult.isErr()) return emptyResult;

  const run = detailResult.value.runs[0];
  if (!run) return emptyResult;

  const allNodeIds = run.nodes.map((n) => n.nodeId);
  const tipNodeId = run.preferredTipNodeId;
  if (!tipNodeId) return emptyResult;

  const nodeIdsToFetch = allNodeIds.length > 0 ? allNodeIds : [tipNodeId];

  let recap: string | null = null;
  const collectedArtifacts: unknown[] = [];

  for (const nodeId of nodeIdsToFetch) {
    const nodeResult = await consoleService.getNodeDetail(sessionHandle, nodeId);
    if (nodeResult.isErr()) continue;

    if (nodeId === tipNodeId) {
      recap = nodeResult.value.recapMarkdown;
    }
    if (nodeResult.value.artifacts.length > 0) {
      collectedArtifacts.push(...nodeResult.value.artifacts);
    }
  }

  return { recapMarkdown: recap, artifacts: collectedArtifacts };
},
```

Key design decisions:
- Mirrors the existing HTTP logic exactly: all nodes for artifacts, tip node only for recap. The field names on `ConsoleNodeDetail` (`recapMarkdown`, `artifacts`) match what the current HTTP JSON parsing extracts.
- `ConsoleArtifact` has `{ sha256, contentType, byteLength, content }`. The `content` field carries the artifact payload. `readVerdictArtifact()` in `pr-review.ts` receives this array and searches for `kind: 'wr.review_verdict'` -- the shape must match what `projectArtifactsV2` produces. Verify `ConsoleArtifact.content` matches the artifact schema expected by `ReviewVerdictArtifactV1Schema`.

### `ConsoleService` injection

`ConsoleService` is already constructed in `daemon-console.ts:123-129` from `ctx.v2` ports. The simplest approach for `trigger-listener.ts` is to construct a second instance locally -- there is no correctness issue since the summary cache is instance-scoped and mtime-invalidated. The instance is cheap to construct.

Alternatively, `ConsoleService` could be threaded from `daemon-console.ts` through the call chain to `trigger-listener.ts`. This avoids a duplicate instance but requires a parameter change in `startTriggerListener()`. The local construction approach is recommended as the lower-risk first step.

`ConsoleService` does NOT need to be added to `CoordinatorDeps` or `AdaptiveCoordinatorDeps` interfaces. It is an implementation detail of the specific concrete dep functions, not a contract concern.

### What must NOT change

The CLI `run pr-review` command (`src/cli-worktrain.ts:1265+`) runs in a **separate process** from the daemon. Its `spawnSession`, `awaitSessions`, and `getAgentResult` deps correctly use HTTP to communicate with a running daemon. These are not bugs and must not be changed.

---

## 4. `ConsoleService` Testability Audit

**Question:** Is `ConsoleService` properly abstracted for injection, or is it constructed inline making testing hard?

**Finding: Properly abstracted.**

`ConsoleService` takes `ConsoleServicePorts` in its constructor:

```typescript
// src/v2/usecases/console-service.ts:314-315
export class ConsoleService {
  constructor(private readonly ports: ConsoleServicePorts) {}
```

The `ConsoleServicePorts` interface:

```typescript
export interface ConsoleServicePorts {
  readonly directoryListing: DirectoryListingPortV2;
  readonly dataDir: DataDirPortV2;
  readonly sessionStore: SessionEventLogReadonlyStorePortV2;
  readonly snapshotStore: SnapshotStorePortV2;
  readonly pinnedWorkflowStore: PinnedWorkflowStorePortV2;
  readonly daemonRegistry?: DaemonRegistry; // optional
}
```

All ports are pure interfaces -- entirely fakeable in tests. No construction-inline issues. The same pattern as `WorktrainSpawnCommandDeps` / `WorktrainAwaitCommandDeps`.

**For testing the in-process coordinator deps:** A test can construct `ConsoleService` with a fake `sessionStore` that returns pre-seeded session events at specific statuses. This is far simpler than the current situation where tests must either start a real HTTP server or mock `globalThis.fetch`.

---

## 5. Evidence of Known Tech Debt

The source code explicitly acknowledges both bugs. `src/trigger/trigger-listener.ts:394-401`:

```typescript
// WHY port=3456 (DAEMON_CONSOLE_PORT): still used by awaitSessions and getAgentResult
// which poll the console HTTP API. This constant is kept for those paths.
```

`spawnSession` was already migrated (see lines 418-476 and its `WHY in-process (not HTTP)` comment). The comment at line 394 confirms that `awaitSessions` and `getAgentResult` are the remaining two deferred items from that migration.
