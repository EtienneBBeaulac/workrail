# WorkRail v2 Follow-up Enhancements

**Status**: Planning / Not Yet Implemented  
**Date**: 2026-02-17  
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

```typescript
import type { Root } from '@modelcontextprotocol/sdk/types.js';

export class WorkspaceRootsManager {
  private roots: readonly Root[] = [];
  
  updateRoots(newRoots: readonly Root[]): void {
    this.roots = Object.freeze([...newRoots]);
  }
  
  getCurrentRoots(): readonly Root[] {
    return this.roots;
  }
  
  getPrimaryRoot(): Root | null {
    return this.roots[0] ?? null;
  }
}
```

**Philosophy alignment**:
- Mutable cell is minimal and encapsulated
- API is read-only (immutable snapshots)
- Single-writer (MCP notification handler on event loop)

---

#### 2. Add roots notification handler

**File**: `src/mcp/server.ts`

**Changes**:
```typescript
const rootsManager = new WorkspaceRootsManager();

// Handle client workspace root changes
server.setNotificationHandler(RootsListChangedNotificationSchema, async (notification) => {
  const roots = notification.params?.roots ?? [];
  rootsManager.updateRoots(roots);
  console.error(`[Roots] Updated workspace roots: ${roots.map(r => r.uri).join(', ')}`);
});

// Optionally: request roots on connect (client may not send until workspace changes)
server.onConnect(() => {
  server.request({ method: 'roots/list' }, ListRootsRequestSchema);
});
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
    return decodeURIComponent(uri.slice(7));
  }
}
```

**Philosophy**: Pure functions, no constructor state, explicit about file:// URIs only.

---

#### 4. Update V2Dependencies

**File**: `src/mcp/types.ts`

**Changes**:
```typescript
export interface V2Dependencies {
  readonly gate: ExecutionSessionGateV2;
  readonly sessionStore: ...;
  // Remove: readonly workspaceAnchor: WorkspaceAnchorPortV2;
  // Add:
  readonly workspaceResolver: WorkspaceContextResolverPortV2;
  readonly getCurrentRoots: () => readonly Root[];
}
```

**Why**: Handlers get resolver (function) + current roots snapshot (immutable), not a singleton anchor.

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
const resolver = ctx.v2.workspaceResolver;
const primaryRoot = ctx.v2.getCurrentRoots()[0];
const anchorsRA = primaryRoot
  ? resolver.resolveFromUri(primaryRoot.uri)
      .orElse(() => okAsync([])) // Graceful: invalid URI → empty
  : resolver.resolveFromCwd()
      .orElse(() => okAsync([])); // Fallback: no roots → server CWD
```

**Why**: Uses client's workspace if roots available, falls back to server CWD (backward compat with old clients).

---

#### 6. Tests

**Unit tests** (`tests/unit/v2/workspace-roots-manager.test.ts`):
- `updateRoots` stores immutable copy
- `getCurrentRoots` returns frozen array
- `getPrimaryRoot` returns first or null

**Unit tests** (`tests/unit/v2/workspace-anchor-resolver.test.ts`):
- `resolveFromUri` with valid file:// URI
- `resolveFromUri` with invalid URI (http://, malformed) → empty
- `resolveFromCwd` falls back to process.cwd()
- URI decoding (spaces, special chars)

**Integration test** (`tests/integration/v2/resume-session-workspace-filtering.test.ts`):
- Create session with workspace A git context (mock roots)
- Create session with workspace B git context (mock roots)
- `resume_session` from workspace A → finds only workspace A session via git match
- `resume_session` with no query → finds both via recency fallback

---

### Rollout

1. Implement + test locally
2. Verify manual test E1+E2 works cross-workspace
3. Ship behind `WORKRAIL_ENABLE_V2_TOOLS` (already gated)
4. Monitor for roots support in MCP clients (Firebender supports it, others may not)
5. After 1-2 releases, consider making roots required (fail fast if client doesn't support it)

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
// Send progress notification if client requested it
if (request._meta?.progressToken) {
  const dag = projectRunDagV2(truthAfter.events);
  if (dag.isOk()) {
    const run = dag.value.runsById[runId];
    const totalSteps = Object.keys(run?.nodesById ?? {}).length;
    const completedSteps = run?.completedSteps ?? 0;
    
    server.notification({
      method: 'notifications/progress',
      params: {
        progressToken: request._meta.progressToken,
        progress: completedSteps,
        total: totalSteps,
        message: `Completed step ${completedSteps}/${totalSteps}: ${currentStep.title}`
      }
    });
  }
}
```

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
| MCP Roots Protocol | P1 (bug fix) | ❌ Not implemented | Cross-workspace resume | ✅ Pure functions, immutable |
| Progress Notifications | P2 | ❌ Not implemented | Agent UX for long workflows | ✅ Side effects at edges |
| Resource Update Notifications | P3 | ❌ Deferred (no UI) | Console auto-refresh | ✅ Event-driven |
| Logging Notifications | P4 | ❌ Deferred | Operator visibility | ✅ Errors as data |
| Tool List Change Notifications | P5 | ❌ Deferred | Runtime flag changes | ⚠️ Requires mutable flags |
| Async Workflows via Tasks | P6 | ❌ Deferred (YAGNI) | 10min+ workflows | ⚠️ Requires background threads |

---

## Related Work from Earlier Session

From the "unfleshed v2 ideas" inventory:

### Already Addressed This Session

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

### Option A: Fix MCP Roots (High Impact, Low Risk)

- **Impact**: Fixes cross-workspace resume (production bug)
- **Effort**: ~2-3 hours (roots manager + handler + tests)
- **Risk**: Low (backward compat via CWD fallback)
- **Philosophy**: ✅ Strongly aligned

### Option B: Add Progress Notifications (UX Improvement)

- **Impact**: Better agent feedback for long workflows
- **Effort**: ~1-2 hours (progress projection + notification send)
- **Risk**: Low (opt-in via progressToken)
- **Philosophy**: ✅ Aligned

### Option C: Unflag v2 Tools (Production Readiness)

- **Impact**: Makes v2 default for all users
- **Effort**: 1 line change + documentation
- **Risk**: Medium (needs more manual testing first)
- **Philosophy**: ✅ Aligned (soft YAGNI: don't gate working features)

### Recommended Sequence

1. **MCP Roots** (fixes the resume bug blocking manual tests)
2. **Complete manual test plan validation** (run all 23 scenarios with roots fix)
3. **Unflag v2 tools** (make default)
4. **Progress notifications** (nice-to-have UX improvement)

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
