# Design Candidates: start_workflow Latency Fixes

## Problem Understanding

### Tensions
1. **Correctness vs. performance (Fix 1)**: The 3 git commands appear independent but the first one gates the others -- its result determines whether to continue at all. Naive full parallelization would always run all 3 even when the first fails, wasting I/O.
2. **ResultAsync composition vs. Promise-level parallelism (Fix 2)**: The neverthrow `andThen` chain is sequential by design. To run two RA branches in parallel requires breaking out of the chain using `ResultAsync.combine`, changing the structural shape of the execution.
3. **Type unification (Fix 2)**: `resolveWorkspaceAnchors` returns `RA<..., never>` while `loadAndPinWorkflow` returns `RA<..., StartWorkflowError>`. These error types must be unified for `ResultAsync.combine`.
4. **Semantic equivalence (Fix 3)**: The `pinnedStore.get` after `put` returns the persisted form parsed through Zod. Bypassing that parse means trusting that `enrichedCompiled` already has the correct shape.

### Likely Seam
The fixes are each self-contained: within a private method (`runGitCommands`), within a function (`executeStartWorkflow`), within an `.andThen` lambda, and within `discoverRootedWorkflowDirectories`. No architectural boundaries are crossed.

### What Makes This Hard
- Fix 2: The parallel structure requires restructuring the `andThen` chain. The `stalePaths` variable from `readerRA` must remain in scope for the final response assembly.
- Fix 3: The `put`-then-`get` pattern exists in many stores as a round-trip validation. Skipping `get` requires confirming the store is a pure write-through with no normalization.
- Fix 4: The `discoveredByPath` dedup Set currently accumulates across sequential iterations. With parallel execution, dedup must happen post-collection.

## Philosophy Constraints

From `AGENTS.md` and `/Users/etienneb/CLAUDE.md`:
- **Errors are data**: all parallelization must maintain Result/ResultAsync error paths
- **Functional/declarative over imperative**: prefer `ResultAsync.combine` / `Promise.all` over loops
- **Immutability by default**: no shared mutable state across parallel branches (except the dedup Set in Fix 4, which must be applied post-collection)
- **Document why, not what**: add comments explaining parallelization rationale
- No conflicts detected between stated philosophy and repo patterns

## Impact Surface

- Fix 1: `LocalWorkspaceAnchorV2.runGitCommands` -- private method, no external consumers
- Fix 2: `executeStartWorkflow` in `start.ts` -- consumed by the `start_workflow` MCP tool handler
- Fix 3: `loadAndPinWorkflow` in `start.ts` -- same function, cache-miss path only
- Fix 4: `discoverRootedWorkflowDirectories` -- called from `createWorkflowReaderForRequest`, which is called from multiple handlers

## Candidates

### Fix 1: Parallelize branch+SHA git commands

**Summary**: After the first sequential git call, use `Promise.all` for the independent branch and SHA reads.

```typescript
const [branch, sha] = await Promise.all([
  this.gitCommand('git rev-parse --abbrev-ref HEAD', cwd),
  this.gitCommand('git rev-parse HEAD', cwd),
]);
```

- **Tensions resolved**: sequential I/O latency
- **Tensions accepted**: first command still sequential (required by data dependency -- its result gates whether to proceed)
- **Boundary**: inside `runGitCommands` private method; no external impact
- **Failure mode**: `gitCommand` returns `null` on failure (graceful degradation pattern); `Promise.all([null, null])` is safe
- **Repo pattern**: identical to `loadSegmentsParallel` in `session-store/index.ts`
- **Gains**: ~2x speedup on branch+SHA leg (overlapped); ~5ms saved per anchor resolution
- **Losses**: none
- **Scope**: best-fit
- **Philosophy**: Functional over imperative, Determinism

---

### Fix 2: Parallel loadAndPinWorkflow + resolveWorkspaceAnchors

**Summary**: Start `anchorsRA` before the main chain, combine with `loadAndPinWorkflow` result using `ResultAsync.combine`.

```typescript
const anchorsRA = resolveWorkspaceAnchors(ctx.v2, input.workspacePath)
  .map((anchors) => anchorsToObservations(anchors))
  .mapErr((x: never): StartWorkflowError => x); // zero-cost cast, never error type

return readerRA.andThen(({ workflowReader, stalePaths }) => {
  const pinnedRA = loadAndPinWorkflow({ ... });
  return ResultAsync.combine([pinnedRA, anchorsRA])
    .andThen(([pinned, observations]) => { ... });
});
```

- **Tensions resolved**: sequential execution of two independent I/O paths
- **Tensions accepted**: minor code restructuring needed; `stalePaths` must remain in scope
- **Boundary**: inside `executeStartWorkflow`, contained
- **Failure mode**: if `resolveWorkspaceAnchors` gains a real error type in the future, the cast must be revisited
- **Repo pattern**: follows `ResultAsync.combine` as used in `src/mcp/handlers/v2-workflow.ts`
- **Gains**: workflow loading and workspace resolution overlap; anchor resolution (~5-10ms) no longer adds to the critical path
- **Losses**: slightly more complex chain structure
- **Scope**: best-fit
- **Philosophy**: Functional over imperative, Errors are data

---

### Fix 3: Eliminate redundant pinnedStore.get after put

**Summary**: Return `okAsync(enrichedCompiled)` directly after a successful `pinnedStore.put` instead of re-reading from disk.

```typescript
return pinnedStore.put(workflowHash, enrichedCompiled)
  .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
  .map(() => enrichedCompiled);  // was: .andThen(() => pinnedStore.get(...))
```

- **Tensions resolved**: unnecessary disk read + Zod parse on cache-miss path
- **Tensions accepted**: bypasses round-trip validation that could catch silent data corruption
- **Boundary**: inside `loadAndPinWorkflow`, cache-miss path only
- **Failure mode**: if `pinnedStore.put` silently transforms data (it does not -- verified: write-through store with lossless JSON serialization)
- **Repo pattern**: the cache-hit path already avoids the redundant get (comment at line 126 says so). This applies the same logic to the cache-miss path.
- **Gains**: eliminates one disk read + Zod parse on first-use (cold cache)
- **Losses**: none
- **Scope**: best-fit
- **Philosophy**: YAGNI with discipline (don't add defensive checks that the type system already covers)

---

### Fix 4: Parallelize root walk with Promise.allSettled

**Summary**: Replace the sequential `for...of` loop in `discoverRootedWorkflowDirectories` with `Promise.allSettled` over all roots, then merge dedup post-collection.

```typescript
const resolvedRoots = roots.map((r) => path.resolve(r));
const rootResults = await Promise.allSettled(
  resolvedRoots.map((rootPath) => discoverWorkflowDirectoriesUnderRoot(rootPath))
);

for (let i = 0; i < resolvedRoots.length; i++) {
  const rootPath = resolvedRoots[i]!;
  const result = rootResults[i]!;
  if (result.status === 'rejected') {
    stalePaths.push(rootPath);
    continue;
  }
  if (result.value.stale) { stalePaths.push(rootPath); continue; }
  for (const nextPath of result.value.discovered) {
    const normalizedPath = path.resolve(nextPath);
    if (discoveredByPath.has(normalizedPath)) continue;
    discoveredByPath.add(normalizedPath);
    discoveredPaths.push(normalizedPath);
  }
}
```

- **Tensions resolved**: sum(roots) latency -> max(slowest root)
- **Tensions accepted**: `Promise.allSettled` over `Promise.all` (allSettled preserves partial results on failure)
- **Boundary**: contained to `discoverRootedWorkflowDirectories`
- **Failure mode**: I/O contention on slow NFS mounts (unlikely for local dev; parallel walks are a clear win in typical cases)
- **Repo pattern**: adapts `loadSegmentsParallel` approach from session-store
- **Gains**: cold walk time goes from sum(all roots) to max(slowest root)
- **Losses**: ordering of discovered paths may differ if implementation changes (allSettled preserves input array order, so result is deterministic)
- **Scope**: best-fit
- **Philosophy**: Functional over imperative, Determinism

## Comparison and Recommendation

All 4 fixes converge on a single correct implementation. There is no genuine competing candidate design -- the code structure and neverthrow idioms constrain the solution space. All 4 are:
- Best-fit scope
- Low risk
- Parallel to existing repo patterns
- Type-safe

**Recommendation**: Implement all 4 fixes as described above.

## Self-Critique

**Strongest counter-arguments:**
- Fix 2: Restructuring the `andThen` chain adds surface area for bugs. A narrower option would be to just move `resolveWorkspaceAnchors` earlier in the sequential chain (so it runs before `loadAndPinWorkflow` on a hot cache but still sequential). This would lose the parallelism benefit but be safer structurally.
- Fix 3: The Zod round-trip in `get` could catch a future bug in `enrichedCompiled` construction. Removing it reduces defensiveness. But the type system already guarantees the shape.
- Fix 4: If roots share the same underlying filesystem (e.g., symlinks), parallel walks could do redundant work. The existing dedup Set handles this correctly post-collection.

**Pivot conditions:**
- If `resolveWorkspaceAnchors` is ever changed to have a real error type, Fix 2 needs the cast revisited
- If `pinnedStore` is changed to a store that normalizes on write, Fix 3 must be reverted

## Open Questions for the Main Agent

None. The implementation path is clear and unambiguous.
