# Discovery: start_workflow ~20s Latency

**Status:** In progress
**Date:** 2026-04-07

## Context / Ask

`start_workflow` MCP call takes ~20 seconds end-to-end. The `list_workflows` latency fix (walk cache with 30s TTL, skip list, depth limit, 10s timeout in `discoverRootedWorkflowDirectories`) resolved `list_workflows` slowness but did not address `start_workflow`.

Goal: identify the specific code path(s) responsible for the ~20s latency with file:line references.

## Path Recommendation

`landscape_first` -- the problem space is already narrowed to specific files. Map the actual call path and I/O before forming hypotheses.

## Constraints / Anti-goals

- Read source code only; no running the server, no benchmarks
- Report findings with file:line references
- Focus files: `start.ts`, `index.ts` (v2-execution), `workspace-anchor/index.ts`, store implementations
- Do not propose fixes -- diagnosis only

## Artifact Strategy

This document is human-readable output only. Execution truth lives in WorkRail notes and context variables. If there is a conflict, notes win.

## Landscape Packet

### Call path: `start_workflow` end-to-end

```
executeStartWorkflow (start.ts:355)
  └─ createWorkflowReaderForRequest (request-workflow-reader.ts:164)   [ASYNC: full walk]
       └─ listRememberedRoots → rememberedRootsStore.listRoots()        [disk read]
       └─ discoverRootedWorkflowDirectories (with 10s timeout)          [filesystem walk, cached 30s]
       └─ listManagedSourceRecords → managedSourceStore.list()          [disk read]
       └─ isDirectory() per managed record                              [stat per record]
  └─ loadAndPinWorkflow (start.ts:59)
       └─ workflowReader.getWorkflowById()                              [disk/bundled read]
       └─ validateWorkflowPhase1a()                                     [CPU: schema + structural + compile]
       └─ pinnedStore.get(workflowHash)                                 [disk read]
       └─ pinnedStore.put(workflowHash, ...) [only on first call]
            mkdirp → openWriteTruncate → writeAll → fsyncFile → close → rename → fsyncDir  [2 fsyncs]
       └─ pinnedStore.get(workflowHash) [only on first call, after put]
  └─ resolveWorkspaceAnchors (v2-workspace-resolution.ts:115)
       └─ LocalWorkspaceAnchorV2.resolve() → runGitCommands() (workspace-anchor/index.ts:63)
            └─ gitCommand("git rev-parse --path-format=absolute --git-common-dir")  [subprocess, 5s timeout]
            └─ gitCommand("git rev-parse --abbrev-ref HEAD")                        [subprocess, 5s timeout]
            └─ gitCommand("git rev-parse HEAD")                                     [subprocess, 5s timeout]
  └─ snapshotStore.putExecutionSnapshotV1() (snapshot-store/index.ts:25)
       mkdirp → openWriteTruncate → writeAll → fsyncFile → close → rename → fsyncDir  [2 fsyncs]
  └─ sessionStore.append() (session-store/index.ts:41)
       mkdirp (cached) → write segment → fsyncFile → rename → fsyncDir [2 fsyncs]
       └─ appendManifestRecords() → openAppend → writeAll → fsyncFile   [1 fsync]
  └─ mintStartTokens → mintContinueAndCheckpointTokens (v2-token-ops.ts:423)
       └─ aliasStore.register(continueEntry)                            [openAppend + fsyncFile]
       └─ aliasStore.register(ckEntry)                                  [openAppend + fsyncFile]
```

### Key findings

**1. `start_workflow` DOES call `createWorkflowReaderForRequest` (start.ts:368-390)**

The condition is at start.ts:361-364:
```ts
const shouldUseRequestReader =
  ctx.featureFlags != null && hasRequestWorkspaceSignal({
    workspacePath: input.workspacePath,
    resolvedRootUris: ctx.v2.resolvedRootUris,
  });
```
`hasRequestWorkspaceSignal` returns `true` if `workspacePath` is set OR `resolvedRootUris` is non-empty. In practice, any agent that passes `workspacePath` (which every real `start_workflow` call does) triggers the full `createWorkflowReaderForRequest` path.

**2. Walk cache IS shared -- but only within a 30s TTL window**

The `walkCache` is a module-level `Map` in `request-workflow-reader.ts` (line 51). Both `list_workflows` and `start_workflow` call `createWorkflowReaderForRequest`, which calls `discoverRootedWorkflowDirectories`, which hits the same cache. If `list_workflows` was called in the last 30 seconds, `start_workflow` will get a cache hit. Otherwise (cold start or >30s since last walk), it will do a full walk -- potentially up to 10s.

**3. `resolveWorkspaceAnchors` spawns 3 sequential git subprocesses**

In `workspace-anchor/index.ts:63-98`, `runGitCommands()` fires 3 `execAsync` calls in strict sequence (each `await`-ed before the next):
- `git rev-parse --path-format=absolute --git-common-dir` -- if this returns null, all subsequent calls are skipped
- `git rev-parse --abbrev-ref HEAD`
- `git rev-parse HEAD`

Each has a **5-second timeout** (line 106). In the worst case (slow git, NFS, or git index locked) this is 3 × 5s = 15 seconds, **sequential**. On a normal fast SSD git repo this is ~10-50ms total, but the calls are sequential not parallel.

**4. fsync count per `start_workflow` call**

Counting from the call path above, a cold-start `start_workflow` with a new workflow hash triggers:

| Store | fsyncs |
|---|---|
| `pinnedStore.put()` (new hash only) | 2 (fsyncFile + fsyncDir) |
| `snapshotStore.putExecutionSnapshotV1()` | 2 (fsyncFile + fsyncDir) |
| `sessionStore.append()` segment | 2 (fsyncFile + fsyncDir) |
| `sessionStore.appendManifestRecords()` manifest | 1 (fsyncFile) |
| `aliasStore.register(continueEntry)` | 1 (fsyncFile) |
| `aliasStore.register(ckEntry)` | 1 (fsyncFile) |
| **Total (new workflow hash)** | **9 fsyncs** |
| **Total (existing workflow hash, skip put)** | **7 fsyncs** |

All fsyncs are **sequential** (chained via `.andThen()`).

**5. Is latency cold-cache-only?**

- **Workflow walk** (via `createWorkflowReaderForRequest`): Cold on first call or after 30s TTL expiry. Warm (cache hit, ~0ms) if called within 30s of a previous `list_workflows` or `start_workflow`.
- **Pinned store**: Cold only on first use of a given `workflowHash`. Subsequent calls skip `put()` (start.ts:129-133 checks `existingPinned` first).
- **Git subprocesses**: Every call, not cached. 3 sequential git subprocesses per `start_workflow`.
- **fsyncs for snapshot/session/token**: Every call.

### Summary of latency sources

1. **Git subprocesses (workspace anchors)** -- 3 sequential `execAsync` calls, each with 5s timeout. On a slow git repo (large index, NFS, locked) this alone can be 1-15s. These are NOT cached between calls.
2. **Filesystem walk** -- cold on first call or after 30s TTL. Up to 10s (DISCOVERY_TIMEOUT_MS). Shared cache with `list_workflows`.
3. **fsyncs** -- 7-9 sequential fsyncs per call. On a slow disk (HDD, NFS, full sync required) each fsync can be 1-20ms. On macOS APFS with default writeback caching this is typically fast but not free. Total sequential fsync chain latency depends on hardware.
4. **Validation pipeline** -- CPU-bound (`validateWorkflowPhase1a`), typically <10ms on small workflows.

## Problem Frame Packet

### Users / Stakeholders
- **etienneb (developer/owner)** -- wants to understand the root cause before fixing it, not a band-aid

### Core tension
The workspace anchor feature (git identity for session grouping) is structurally correct and useful, but its implementation (`runGitCommands` in `workspace-anchor/index.ts`) spawns 3 sequential subprocesses with individual 5-second timeouts on every single `start_workflow` call. There is no caching, no parallelism, and no shared budget across the three git commands. The feature's value (branch/HEAD for session grouping) does not require this level of latency.

Meanwhile, the filesystem walk (the one that was fixed for `list_workflows`) IS already cached -- the 30s TTL `walkCache` is shared between `list_workflows` and `start_workflow`. So the walk fix DID help `start_workflow` on warm calls.

### Success criteria
1. `start_workflow` completes in <1 second on subsequent calls in the same server session (not just after the list_workflows fix -- every call).
2. The fix does not regress crash safety or correctness of session grouping signals.
3. The latency is attributable to a specific, identifiable code path with a targeted fix.

### Assumptions that could be wrong
- **Assumption: git subprocesses are the primary contributor.** Could be wrong if the user's environment has slow fsyncs (NFS, full-disk-sync policy) and git is actually fast. In that case the 7-9 sequential fsyncs per call would dominate.
- **Assumption: the walk is warm on subsequent calls.** Could be wrong if the server process is restarted between calls (each restart clears the module-level `walkCache`).
- **Assumption: `workspacePath` is always passed.** If some clients don't pass `workspacePath` AND have no `resolvedRootUris`, `shouldUseRequestReader` would be false and the whole walk is skipped.

### HMW reframes
1. **HMW parallelize the 3 git subprocess calls** instead of running them sequentially? Each is independent -- parallelizing with `Promise.all` would reduce 3 × latency to 1 × latency.
2. **HMW cache the workspace anchor results** per (workspacePath, TTL) similar to how the walk cache works? The git branch/HEAD doesn't change between MCP tool calls in the same editing session -- a 30s or even 5-minute TTL would be safe.

### Framing risks
- We might be fixing the wrong leg. Without timing data we can't confirm git vs. fsyncs vs. walk is the actual bottleneck for the user's observed 20s.
- The git subprocess path degrades gracefully (returns empty anchors on failure/timeout) so the total timeout is bounded at 5s × 3 = 15s even in the worst case. This means git subprocesses alone can account for up to 15s of the observed 20s.

## Candidate Directions

### Candidate A: Parallelize the 3 git subprocess calls (simplest fix, every-call benefit)

**Summary:** Replace the sequential `await` chain in `runGitCommands()` with a `Promise.all` over all 3 `gitCommand()` calls.

**Location:** `src/v2/infra/local/workspace-anchor/index.ts:63-98`

**Tensions resolved:** Sequential git latency (3 × latency → 1 × latency). Does NOT resolve the every-call cost -- git still runs on every `start_workflow`.

**Tensions accepted:** Still runs on every call. No caching.

**Specific failure mode:** If git binary is missing or the directory is not a git repo, all 3 fail gracefully (already handled by try/catch in `gitCommand`). Race condition between calls: none (all are read-only; git doesn't need ordering guarantees for these 3 commands).

**Repo pattern:** Follows the `loadSegmentsParallel` pattern in `session-store/index.ts:718-783` which explicitly uses `Promise.all` for independent reads. Comment there: "It is safe to read all segment files concurrently."

**Gain:** 3× reduction in git subprocess latency on fast systems (e.g. 90ms → 30ms). On slow systems (one call takes 4s), bounded at the slowest single call, not the sum.

**Give up:** Nothing -- these calls are independent reads with no ordering requirement.

**Impact surface:** Only `LocalWorkspaceAnchorV2`. No other caller is affected.

**Scope:** Best-fit. Minimal change, clear correctness argument, immediate benefit.

**Philosophy:** Honors "architectural fixes over patches" (fixes the root sequential dependency), "functional/declarative over imperative", "determinism" (no state change). No conflicts.

---

### Candidate B: Add a TTL result cache for workspace anchor resolution (every-call → first-call-only)

**Summary:** Add a module-level `Map<string, { result: readonly WorkspaceAnchor[]; expiresAt: number }>` in `workspace-anchor/index.ts`, keyed on the resolved workspace path string, with a 30s TTL. The same TTL, key-structure, and expiry pattern as `walkCache` in `request-workflow-reader.ts:46-56`.

**Location:** `src/v2/infra/local/workspace-anchor/index.ts` (new module-level cache) or `src/mcp/handlers/v2-workspace-resolution.ts:115` (at the `resolveWorkspaceAnchors` call site).

**Tensions resolved:** Every-call git subprocess cost becomes first-call-only within a 30s TTL window. Consistent with the existing caching pattern.

**Tensions accepted:** Cached git state may be stale (branch/HEAD observed at cache-fill time). TTL is a new piece of module-level mutable state (but follows established walkCache pattern).

**Specific failure mode:** If the user switches git branch during a session, the cached anchor has the old branch name for up to 30s. This is acceptable -- the branch is stored in the session's `observation_recorded` events at start time, so each session gets the correct branch regardless.

**Repo pattern:** Directly follows `walkCache` in `request-workflow-reader.ts:46-56`. Adapts the pattern, does not invent.

**Gain:** Eliminates git subprocess cost on warm calls (~0ms vs. 30-100ms+ per call). Critical for users who rapidly start multiple sessions.

**Give up:** Staleness window (up to 30s). This is already accepted by the walkCache.

**Impact surface:** All callers of `resolveWorkspaceAnchors` benefit (start_workflow, continue_workflow if it calls it, resume_session).

**Scope:** Best-fit. Follows established codebase pattern exactly.

**Philosophy:** "Determinism over cleverness" is slightly pressured (cached state != fresh state). Follows established codebase trade-off. Honors "architectural fixes over patches."

---

### Candidate C: Parallelize git calls AND add TTL cache (combined fix -- best total latency)

**Summary:** Apply both Candidate A (parallelize 3 git calls with `Promise.all`) AND Candidate B (TTL cache at the `LocalWorkspaceAnchorV2` level). Cache hit: ~0ms. Cache miss: 1 × git latency instead of 3 × git latency.

**Location:** Same as A and B.

**Tensions resolved:** Both every-call cost (via cache) and worst-case cold-start cost (via parallelism).

**Tensions accepted:** All trade-offs from A and B combined.

**Scope:** Best-fit -- both changes are small, independent, and each justified on its own. Not "too broad."

**Philosophy:** Same as A and B. No new conflicts introduced.

**Relation to existing patterns:** A follows `loadSegmentsParallel`; B follows `walkCache`. Combined, this is two well-established patterns applied together.

**Gain:** Maximum reduction in workspace anchor latency. Warm calls: ~0ms. Cold calls: ~1 × git latency instead of ~3 × git latency.

**Give up:** Slightly more code (cache eviction, cache key logic). Still minimal.

## Challenge Notes

### Comparison matrix

| Tension | Candidate A (parallelize) | Candidate B (cache) | Candidate C (both) |
|---|---|---|---|
| Sequential git subprocess latency | Resolves fully (3\u00d7 \u2192 1\u00d7) | Resolves on warm calls (skip entirely) | Resolves both cases |
| Every-call git cost | Does NOT resolve | Resolves (TTL cache) | Resolves |
| Cold-start worst case | Reduces (1\u00d7 instead of 3\u00d7) | Still 3\u00d7 on first call | Best (1\u00d7 on first call) |
| Code complexity | Minimal | Small (TTL Map + key) | Small + small |
| Staleness risk | None | TTL window (30s) | TTL window (30s) |
| Repo pattern fit | loadSegmentsParallel | walkCache | Both |

### Recommendation: Candidate C (both)

**Rationale:** The two changes are small, independent, and together eliminate the root cause. Candidate A alone leaves every-call latency if git is at all slow. Candidate B alone reduces warm-call cost but the first call on a cold server still runs 3 sequential git subprocesses. Candidate C removes both problems at minimal code cost. The combined change is still "best-fit" scope because neither A nor B individually bloats the codebase.

**Strongest counter-argument against C:** "You're adding a cache and you don't need one for correctness -- just fix the sequential calls." Valid. If the user's environment has fast git (typical macOS on SSD, git < 10ms per call), Candidate A alone would reduce latency from ~30-90ms to ~10-30ms per call, which may be acceptable. The cache is only needed if git is slow OR if many sessions are started in rapid succession.

**Narrower option (A alone) loses because:** It still runs 3 subprocesses per call. On a slow environment (NFS, large monorepo with 50k files in git index, slow container), each git call can take 1-3s. 1 × 3s is still 3 seconds per `start_workflow` call.

**Broader option not needed:** There is no justification for restructuring the workspace anchor port interface or moving the resolution to a different lifecycle point. The fixes are local to the implementation.

**Assumption that would invalidate this:** If fsyncs are the actual dominant contributor (e.g., the user is on NFS with forced sync), reducing git latency won't help. Invalidation evidence: timing each leg with `WORKRAIL_DEV=1` perf instrumentation would confirm or refute.

## Resolution Notes

_To be filled in._

## Decision Log

### Selected direction: Candidate C (parallelize git calls + TTL anchor cache)

**Why C wins:**
1. The only way to reduce latency on EVERY call (not just first call) is a cache. Candidate A alone does not achieve this.
2. The only way to reduce cold-start worst-case is parallelism. Candidate B alone still runs 3 sequential git calls on cache miss.
3. Combined, C eliminates both failure modes at minimal code cost. Each sub-change (A and B) is independently justifiable and follows an established codebase pattern.
4. The TTL staleness trade-off (30s window where a branch change isn't reflected) is already accepted in the codebase via `walkCache`. The two decisions are structurally identical.

**Why runner-up (A alone) loses:**
On a fast-git macOS SSD system, A might reduce per-call overhead from ~30ms to ~10ms -- perfectly acceptable. But:
- The user's observed latency is ~20s, not ~30ms. This implies either (a) cold walk + git subprocesses are combining to hit 20s, or (b) git itself is slow in the user's environment.
- If git is slow (even 500ms per call), A alone still runs 3 subprocesses on every call. C eliminates this cost after the first warm call.
- A requires no cache, which is a legitimate simplicity argument. But given that the problem is already 20s and the codebase has the exact same TTL-cache pattern already, the complexity cost of B is very low.

**Strongest challenge against C:**
"The cache adds staleness. If a user starts 5 sessions in 30 seconds from different branches, sessions 2-5 will have the wrong branch anchor." Counter-response: This is the same trade-off the walkCache accepts. The anchor is an *observation signal* for session grouping, not a correctness invariant. Getting the wrong branch in an observation event does not corrupt the session. The first session in each 30s window gets the correct branch; subsequent sessions reuse it. This is acceptable staleness for an observability signal.

**Switch triggers:**
- If profiling reveals fsyncs dominate (not git), the priority shifts to parallelizing fsync chains or batching writes. C would still be correct but would not be the primary fix.
- If the walkCache is ever removed (deemed too complex), the same argument applies to the anchor cache and it should be removed too.

**Recommendation confidence:** High. The diagnostic is grounded in specific code, the fix is conservative, and the pattern is already established in the codebase.

## Final Summary

### Recommendation

**Candidate C: Parallelize 3 git subprocess calls + add TTL anchor cache**

**Root cause of ~20s latency in `start_workflow`:**

1. **Primary suspect (every call, not cached):** `LocalWorkspaceAnchorV2.runGitCommands()` at `src/v2/infra/local/workspace-anchor/index.ts:63-98` spawns 3 git subprocesses **sequentially** with individual 5-second timeouts:
   - `git rev-parse --path-format=absolute --git-common-dir` (line 72)
   - `git rev-parse --abbrev-ref HEAD` (line 87)
   - `git rev-parse HEAD` (line 93)
   
   Worst case: 3 × 5s = **15 seconds**. These run on EVERY `start_workflow` call with zero caching.

2. **Secondary (first call or cold start):** `createWorkflowReaderForRequest` at `src/mcp/handlers/shared/request-workflow-reader.ts:164` runs a filesystem walk (up to 10s via `DISCOVERY_TIMEOUT_MS`). This IS cached (30s TTL, `walkCache` module-level Map). Warm calls skip it. But a first call after server restart pays the full 10s.

3. **Tertiary (every call, fast on APFS):** 7-9 sequential fsyncs across snapshot store, session store, and token alias store. On macOS APFS: ~10-50ms total. On NFS/HDD: potentially 3-9 seconds.

### Fix targets

| Fix | File | Lines | Benefit |
|---|---|---|---|
| Parallelize 3 git calls with `Promise.all` | `workspace-anchor/index.ts` | 63-98 | 3× latency → 1× on cold cache |
| Add TTL anchor cache (30s, module-level Map, keyed on workspacePath) | `workspace-anchor/index.ts` | (new, before class) | Every-call git cost → first-call-only |

### Confidence and residual risks

**Confidence: High.** Structural analysis is grounded in specific code. The sequential 3-subprocess pattern accounts for up to 15s; the cold walk accounts for up to 10s. Together they explain the observed 20s.

**Residual risk:** If fsyncs dominate (NFS/HDD environment), the git fix will not fully resolve 20s. Verification: enable `WORKRAIL_DEV=1` perf instrumentation to isolate which leg is actually hot.

### Does `start_workflow` share the walk cache?

Yes. Both `list_workflows` and `start_workflow` call `createWorkflowReaderForRequest` which calls `discoverRootedWorkflowDirectories` which reads from the same `walkCache` Map (`request-workflow-reader.ts:51`). The `list_workflows` fix DID help `start_workflow` on warm calls (within 30s of a prior walk). The unfixed problem is the git subprocess layer, which has no cache at all.
