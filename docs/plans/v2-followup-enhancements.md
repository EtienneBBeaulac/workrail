# WorkRail v2 Follow-up Enhancements

**Status**: In Progress — P1 implemented, P2–P6 planning  
**Date**: 2026-02-17  
**Updated**: 2026-02-18  
**Context**: Post-v2 core completion. All functional slices shipped, 2628 tests passing. This doc captures enhancement opportunities discovered during manual testing and production usage.

---

## Priority 1: MCP Roots Protocol Integration (Critical Bug Fix)

### Problem

`resume_session` fails to find sessions across Firebender workspaces because WorkRail detects git context from the MCP server process's CWD (`process.cwd()`), not the client's workspace.

**Scenario**:
- E1: Agent creates session in Firebender workspace A (zillow repo)
- Server: Detects git context from server CWD (workrail repo)
- Session observations: `git_branch: "main"`, `git_head_sha: "b419857..."` (workrail's main)
- E2: Agent searches for session in Firebender workspace A (zillow repo)
- `resume_session`: Filters by git context → no match (workrail main ≠ zillow branch)
- Result: ❌ Session not found despite being in the same client workspace

**Impact**: Cross-chat resumption is broken for multi-workspace users.

---

### Solution: Use MCP Roots Protocol

MCP provides `notifications/roots/list_changed` to notify servers when client workspace changes. Firebender sends this on workspace switch.

**Architecture**:
```
Client → notifications/roots/list_changed → Server stores latest roots
Server → start_workflow → resolves git from roots[0].uri (client workspace)
Server → resume_session → matches sessions by stored git observations
```

**Key invariant**: Workspace anchor is resolved **per-request** from current client roots, not once at server startup.

---

### Implementation Plan

#### 1. Immutable roots state manager

**File**: `src/mcp/workspace-roots-manager.ts`

Split read and write capabilities at the type level so handler code can only read — no
mutation surface leaks into consumers via `V2Dependencies`.

```typescript
/** Read-only view — passed into V2Dependencies. */
export interface RootsReader {
  getCurrentRootUris(): readonly string[];
}

/** Write capability — only the MCP notification handler holds this. */
export interface RootsWriter {
  updateRootUris(uris: readonly string[]): void;
}

export class WorkspaceRootsManager implements RootsReader, RootsWriter {
  private rootUris: readonly string[] = Object.freeze([]);

  updateRootUris(uris: readonly string[]): void {
    this.rootUris = Object.freeze([...uris]);
  }

  getCurrentRootUris(): readonly string[] {
    return this.rootUris;
  }
}
```

**Philosophy alignment**:
- Mutable cell is minimal, confined behind an explicit `RootsWriter` interface
- Handlers receive `RootsReader` — cannot call `updateRootUris`
- Single-writer (MCP notification handler on Node.js event loop)

---

#### 2. Add roots notification handler

**File**: `src/mcp/server.ts`

Two important protocol details:

1. `notifications/roots/list_changed` is a **signal only** — it carries no roots payload. After
   receiving it, the server must call `server.listRoots()` (which sends a `roots/list` request
   to the client) to get the updated list.
2. Initial roots must be fetched **after** `server.connect(transport)`. Some clients don't support
   `roots/list`; wrap in try/catch and degrade gracefully to CWD fallback.

```typescript
const rootsManager = new WorkspaceRootsManager();
// rootsWriter stays local — never passed to handlers
const rootsWriter: RootsWriter = rootsManager;

// Register before connect. Notification is signal-only; re-fetch via listRoots().
server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  try {
    const result = await server.listRoots();
    rootsWriter.updateRootUris(result.roots.map((r) => r.uri));
    console.error(`[Roots] Updated: ${result.roots.map((r) => r.uri).join(', ') || '(none)'}`);
  } catch {
    console.error('[Roots] Failed to fetch updated roots after change notification');
  }
});

// After server.connect(transport): fetch initial roots.
// Graceful: clients that don't support roots/list will throw; fall back to CWD.
try {
  const result = await server.listRoots();
  rootsWriter.updateRootUris(result.roots.map((r) => r.uri));
  console.error(`[Roots] Initial: ${result.roots.map((r) => r.uri).join(', ') || '(none)'}`);
} catch {
  console.error('[Roots] Client does not support roots/list; CWD fallback active');
}
```

---

#### 3. Make workspace anchor resolver per-request

**File**: `src/v2/infra/local/workspace-anchor/index.ts`

**Before**:
```typescript
export class LocalWorkspaceAnchorV2 implements WorkspaceAnchorPortV2 {
  constructor(private readonly cwd: string) {}
  resolveAnchors(): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    // uses this.cwd (singleton)
  }
}
```

**After**:
```typescript
export interface WorkspaceContextResolverPortV2 {
  resolveFromUri(rootUri: string): ResultAsync<readonly WorkspaceAnchor[], WorkspaceAnchorError>;
  resolveFromCwd(): ResultAsync<readonly WorkspaceAnchor[], WorkspaceAnchorError>;
}

export class LocalWorkspaceAnchorV2 implements WorkspaceContextResolverPortV2 {
  resolveFromUri(rootUri: string): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    const fsPath = this.uriToPath(rootUri);
    if (!fsPath) return okAsync([]); // Not file:// URI, graceful empty
    return this.resolveFromPath(fsPath);
  }
  
  resolveFromCwd(): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    return this.resolveFromPath(process.cwd());
  }
  
  private resolveFromPath(cwd: string): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    // run git commands in specified cwd (existing logic)
  }
  
  private uriToPath(uri: string): string | null {
    if (!uri.startsWith('file://')) return null;
    // Use fileURLToPath (node:url) — handles Windows drive letters and percent-encoding correctly.
    // decodeURIComponent(slice(7)) is wrong on Windows: file:///C:/foo → /C:/foo (leading slash).
    try { return fileURLToPath(uri); } catch { return null; }
  }
}
```

**Philosophy**: Pure functions, no constructor state, explicit about file:// URIs only.

---

#### 4. Update V2Dependencies

**File**: `src/mcp/types.ts`

```typescript
export interface V2Dependencies {
  readonly gate: ExecutionSessionGateV2;
  readonly sessionStore: ...;
  // Remove: readonly workspaceAnchor?: WorkspaceAnchorPortV2;
  // Add:
  readonly workspaceResolver?: WorkspaceContextResolverPortV2;
  // Per-request snapshot of client root URIs, injected at the CallTool boundary.
  // Optional: absent when client doesn't support roots/list (degrades to CWD).
  readonly resolvedRootUris?: readonly string[];
}
```

At the `CallToolRequestSchema` handler, snapshot roots once and spread into `V2Dependencies`:
```typescript
const requestCtx: ToolContext = ctx.v2
  ? { ...ctx, v2: { ...ctx.v2, resolvedRootUris: rootsManager.getCurrentRootUris() } }
  : ctx;
return handler(args ?? {}, requestCtx);
```

**Why `resolvedRootUris` as a value, not a `getCurrentRoots` thunk**: a function that reads
ambient state at call-time is not deterministic from the handler's perspective — the roots could
change between calls. Snapshotting at the request boundary gives handlers an immutable value for
their entire duration, consistent with the determinism-over-cleverness principle.

---

#### 5. Update start_workflow to use primary root

**File**: `src/mcp/handlers/v2-execution/start.ts`, around line 331

**Before**:
```typescript
const workspaceAnchor = ctx.v2?.workspaceAnchor;
const anchorsRA = workspaceAnchor
  ? workspaceAnchor.resolveAnchors()
  : okAsync([]);
```

**After**:
```typescript
const workspaceResolver = ctx.v2.workspaceResolver;
const primaryRootUri = ctx.v2.resolvedRootUris?.[0]; // snapshotted at CallTool boundary
const anchorsRA = workspaceResolver
  ? (primaryRootUri
      ? workspaceResolver.resolveFromUri(primaryRootUri)
      : workspaceResolver.resolveFromCwd()
    ).orElse(() => okAsync([]))
  : okAsync([]);
```

**Why**: Uses client's workspace URI if available (snapshotted at request boundary — deterministic
for this call), falls back to server CWD for clients that don't support roots/list.

---

#### 6. Tests (pending)

**Unit tests** (`tests/unit/v2/workspace-roots-manager.test.ts`):
- `updateRootUris` stores immutable copy; subsequent mutations don't affect the returned slice
- `getCurrentRootUris` returns frozen array
- `RootsWriter` interface is separate from `RootsReader` — consumers cannot call `updateRootUris`

**Unit tests** (`tests/unit/v2/workspace-anchor-resolver.test.ts`):
- `resolveFromUri` with valid `file://` URI
- `resolveFromUri` with non-`file://` URI (e.g., `http://`, `vscode-vfs://`) → returns empty (graceful)
- `resolveFromUri` with malformed URI → returns empty (graceful)
- `resolveFromCwd` uses the adapter's default CWD
- Windows path handling: `file:///C:/foo` → `C:\foo` (via `fileURLToPath`)

**Integration test** (`tests/integration/v2/resume-session-workspace-filtering.test.ts`):
- Create session in workspace A (mock `resolvedRootUris` pointing at a temp git repo on branch `feat-a`)
- Create session in workspace B (mock pointing at a different temp git repo)
- `resume_session` from workspace A → finds only workspace A session via git branch/SHA match
- `resume_session` with no roots → finds both via recency fallback

---

### Status

✅ **Implemented** (2026-02-18). Core implementation shipped; integration + unit tests for resolver remain pending.

---

## Priority 2: MCP Progress Notifications for Workflow Execution

### Problem

Long workflows (10+ steps, loops, subagents) take minutes to complete. Agents have no visibility into progress — they call `continue_workflow` and wait.

### Solution: Send `notifications/progress`

When a `continue_workflow` advance completes, send a progress notification to the client:

```json
{
  "method": "notifications/progress",
  "params": {
    "progressToken": "...", // from original request._meta.progressToken
    "progress": 3,
    "total": 10,
    "message": "Completed step 3/10: Hypothesis Development"
  }
}
```

**Agent UX**: The client UI shows "WorkRail: Step 3/10 (Hypothesis Development)" while the tool call is in-flight.

---

### Implementation

**File**: `src/mcp/handlers/v2-execution/advance.ts`

**After** successful append, before returning:
```typescript
// Send progress notification if client requested it.
// progressToken must be threaded from CallToolRequestSchema handler
// through ToolContext (or via a server reference passed to V2Dependencies).
if (progressToken) {
  const dag = projectRunDagV2(truthAfter.events);
  if (dag.isOk()) {
    const run = dag.value.runsById[runId];
    // Count only 'step' nodes — not 'blocked_attempt' or 'checkpoint' nodes.
    // Post-ADR 008, nodesById includes blocked_attempt nodes; counting all of them
    // would inflate 'total' and make progress percentages wrong.
    const stepNodes = Object.values(run?.nodesById ?? {}).filter(n => n.nodeKind === 'step');
    const totalSteps = stepNodes.length;
    const completedSteps = stepNodes.filter(n => n.isComplete).length;

    // Correct SDK API is sendNotification, not notification.
    await server.sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: completedSteps,
        total: totalSteps,
        message: `Completed step ${completedSteps}/${totalSteps}: ${currentStep.title}`,
      },
    });
  }
}
```

**Three implementation details to resolve before building**:

1. **`progressToken` plumbing**: `request._meta?.progressToken` is available in the raw
   `CallToolRequestSchema` handler, not in `executeAdvance`. Thread it through `ToolContext`
   (or a dedicated `RequestMeta` field) before calling the advance logic.

2. **`server` reference**: `advance.ts` has no access to the MCP `Server` instance today.
   Pass it via `V2Dependencies` or a `NotificationSender` port (interface segregation — expose
   only `sendNotification`, not the full server).

3. **`completedSteps` count**: See inline note above — filter by `nodeKind === 'step'` to
   exclude `blocked_attempt` and `checkpoint` nodes, which are in the same DAG post-ADR 008.

**Philosophy**:
- ✅ Pure projection (DAG → progress count)
- ✅ Side effect at edge (notification send)
- ✅ Opt-in (only if client provides progressToken)

---

### Open Question

Should progress be:
- **Step-granular** (1 notification per step) — simple, but may spam for 50-step workflows
- **Percentage-based** (notify on 10%, 20%, ..., 100%) — fewer notifications, but requires more logic
- **Time-based** (notify every 5 seconds) — smooth UX, but requires background timers

**Recommendation**: Start with step-granular (simplest, matches the execution model). Add throttling later if needed.

---

## Priority 3: Session State Change Notifications (Console/Dashboard Integration)

### Problem

When Console/Dashboard UI exists, users may have multiple views open:
- Session list showing all sessions
- Session detail showing a specific session's DAG
- Workflow execution view

When an agent advances a workflow, these views become stale. Currently they'd need manual refresh or polling.

### Solution: `notifications/resources/updated`

After durable events are written, notify clients watching that session:

```json
{
  "method": "notifications/resources/updated",
  "params": {
    "uri": "workrail://session/sess_abc123",
    "changes": {
      "lastEventIndex": 42,
      "preferredTipNodeId": "node_xyz",
      "isComplete": false
    }
  }
}
```

**Console benefit**: Auto-refresh session views when new events are written.

---

### Implementation

**Requires**:
1. Resource URI schema for sessions (`workrail://session/{sessionId}`)
2. Subscription tracking (which clients are watching which sessions)
3. Notification dispatch after `sessionStore.append()`

**Defer until**: Console UI exists (YAGNI — no UI to refresh yet)

---

## Priority 4: Logging Notifications (Server Diagnostics)

### Problem

When session health issues occur (lock contention, corruption detected, validation errors), agents see tool errors but operators have no server-side visibility.

### Solution: `notifications/logging/message`

Structured server logs sent to clients:

```json
{
  "method": "notifications/logging/message",
  "params": {
    "level": "warning",
    "logger": "workrail.session.gate",
    "data": "Session lock held for >5s — another process may be stuck"
  }
}
```

**Operator benefit**: Real-time server diagnostics visible in Firebender console.

**When to send**:
- Lock timeout warnings (held >5s)
- Session corruption detected
- Keyring initialization failures
- Feature flag changes

**Philosophy**: ✅ Errors as data, observability at edges

---

## Priority 5: Dynamic Tool List Updates

### Problem

Feature flags control which tools are available (`WORKRAIL_ENABLE_V2_TOOLS`). Changing a flag requires agent reconnect to see new tools.

### Solution: `notifications/tools/list_changed`

When feature flags change:
```json
{
  "method": "notifications/tools/list_changed",
  "params": {}
}
```

Client re-fetches tool list via `tools/list`.

**Complexity**: Requires runtime feature flag mutation (currently environment variables, immutable after boot).

**Defer until**: Feature flags become mutable via Console UI.

---

## Priority 6: Async Workflow Execution via MCP Tasks

### Problem

Long workflows block the agent's tool call. A 50-step workflow might take 10+ minutes, during which the agent is waiting on a single `continue_workflow` call.

### Solution: MCP Tasks for async workflows

**Flow**:
1. Agent: `start_workflow` with `task: { ttl: 600000, pollInterval: 5000 }`
2. Server: Returns `taskId`, begins async execution
3. Client: Polls `tasks/get` every 5s to check status
4. Server: Sends `notifications/tasks/status` when steps complete
5. Agent: Sees progress, continues other work
6. Server: Workflow completes, task result available
7. Agent: `tasks/get` returns final result

**Benefits**:
- Agent can do other work while workflow runs
- Progress via notifications instead of blocking
- Timeout-friendly (long workflows don't need infinite tool call timeout)

**Complexity**:
- Requires background workflow executor thread
- Task result storage + TTL management
- Cancellation support

**Defer until**: Workflows routinely take >60s (YAGNI for current 2-10 step workflows).

---

## Summary Table

| Enhancement | Priority | Status | Blocks | Philosophy Aligned |
|-------------|----------|--------|--------|-------------------|
| MCP Roots Protocol | P1 (bug fix) | ✅ Implemented (2026-02-18) | Cross-workspace resume | ✅ Pure functions, immutable |
| Progress Notifications | P2 | 🔲 Planned (3 open design issues) | Agent UX for long workflows | ✅ Side effects at edges |
| Resource Update Notifications | P3 | ⏸ Deferred (no UI) | Console auto-refresh | ✅ Event-driven |
| Logging Notifications | P4 | ⏸ Deferred | Operator visibility | ✅ Errors as data |
| Tool List Change Notifications | P5 | ⏸ Deferred | Runtime flag changes | ⚠️ Requires mutable flags |
| Async Workflows via Tasks | P6 | ⏸ Deferred (YAGNI) | 10min+ workflows | ⚠️ Requires background threads |

---

## Related Work from Earlier Session

From the "unfleshed v2 ideas" inventory:

### Already Addressed This Session

- ✅ **MCP Roots Protocol** — Per-request workspace anchor resolution; `RootsReader`/`RootsWriter` capability split; `fileURLToPath` URI handling; `resolvedRootUris` snapshot at CallTool boundary (2026-02-18)
- ✅ **Workflow migration** — All while-loops migrated to `wr.contracts.loop_control` (PR #69)
- ✅ **ADR 008 completion** — Terminal block path + projection query (this session)
- ✅ **Deprecated path removal** — `advance_recorded.outcome.kind='blocked'` removed from builder (this session, PR #70)
- ✅ **SessionManager Result refactoring** — All methods return `Result`, no throws (this session, PR #70)
- ✅ **V2ToolContext + requireV2 guard** — Eliminated `ctx.v2!` assertions (this session, PR #70)
- ✅ **Branded contractRef** — `ArtifactContractRef` type instead of `string` (this session, PR #70)
- ✅ **Compiler contract validation** — Compile-time check for unknown contract refs (this session, PR #70)
- ✅ **Manual test plan** — 23 scenarios for slices 4b, 4c, ADR 008, loop artifacts (this session)
- ✅ **Optimistic pre-lock dedup** — Checkpoint replay skips gate (this session, PR #73)

### Still Open

1. **Unflag v2 tools** — Remove `WORKRAIL_ENABLE_V2_TOOLS` gate (waiting on more testing)
2. **Console/Dashboard UI** — Zero UI exists, substrate complete
3. **Agent Cascade Protocol** — Cross-IDE delegation model, design complete
4. **Enforceable verification contracts** — `verify` block is instructional-only
5. **Parallel forEach execution** — Concurrent loop iterations
6. **Subagent composition** — Chained outputs (researcher → challenger → analyzer)
7. **Evidence validation contracts** — Replace prose `validationCriteria` with structured artifacts

---

## Decision: What to Do Next

### ✅ Done: MCP Roots Protocol

Implemented 2026-02-18. Per-request workspace anchor resolution, correct `listRoots()` flow,
`fileURLToPath` URI handling, `resolvedRootUris` snapshot at CallTool boundary.

### Next: Complete manual test plan validation

Run all 23 scenarios from `docs/testing/v2-slices-4b-4c-adr008-loops-manual-test-plan.md` with
the roots fix in place. Specifically verify E1+E2 (cross-workspace resume) now work correctly.

### Then: Unflag v2 tools (Production Readiness)

- **Impact**: Makes v2 default for all users
- **Effort**: 1 line change + documentation
- **Risk**: Medium (needs manual test sign-off first)

### Later: Progress Notifications (UX Improvement)

- **Impact**: Better agent feedback for long workflows
- **Effort**: Moderate — three design issues must be resolved first (see P2 above):
  1. `progressToken` threading through `ToolContext`
  2. `NotificationSender` port to give advance handler access to `sendNotification`
  3. Node counting: filter `step` nodes only, exclude `blocked_attempt` + `checkpoint`
- **Risk**: Low (opt-in via progressToken)

### Recommended Sequence

1. ~~**MCP Roots**~~ ✅ Done
2. **Complete manual test plan validation** (run all 23 scenarios with roots fix)
3. **Unflag v2 tools** (make default)
4. **Resolve P2 design issues** then implement progress notifications

---

## Open Questions

1. **Should resume_session support multi-root matching?** Current plan uses only `roots[0]`. If a client has 3 workspace roots, should sessions from any of them be eligible?
   - **Recommendation**: No (YAGNI). Use primary root only.

2. **What if client sends roots but they're all non-file:// URIs?** (e.g., `vscode-vfs://github/...`)
   - **Recommendation**: Graceful fallback to server CWD with a warning log.

3. **Should workspace anchor resolution be cached per root URI?** Git commands are expensive (fork + exec).
   - **Recommendation**: No for v1. Add caching later if profiling shows it's a bottleneck.

---

## References

- MCP Roots Spec: `https://modelcontextprotocol.io/specification/draft/client/roots`
- MCP SDK Types: `@modelcontextprotocol/sdk/types` (v1.24.0)
- Design Locks: `docs/design/v2-core-design-locks.md` §15 (single-writer), §1.3 (rehydrate separation)
