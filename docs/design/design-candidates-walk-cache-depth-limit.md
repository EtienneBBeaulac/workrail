# Design Candidates: Walk Cache, Depth Limit, Skip Dirs, Graceful Degradation

## Problem Understanding

### Tensions
1. **Walk cancellation vs simplicity**: `withTimeout` races the promise but cannot cancel the Node.js fs walk. The walk continues in the background. Subsequent calls within the 30s TTL window will hit the cache (acceptable tradeoff; must be documented).
2. **Cache freshness vs staleness window**: A 30s TTL means a `.workrail` dir created inside a remembered root within that window returns stale (missing) results. Spec explicitly accepts this.
3. **Module-level mutable state vs testability**: The cache is process-global. `clearWalkCacheForTesting()` is the escape hatch for tests.
4. **Graceful degradation vs error visibility**: `listRememberedRoots` currently throws, which is actually LESS visible (propagates uncaught). Changing to return `[]` + log is more operator-visible.

### Likely Seam
All changes are at the correct seams: `request-workflow-reader.ts` owns walk/discovery/cache logic; `v2-workflow.ts` owns handler error boundaries.

### What Makes This Hard
- **Depth guard placement**: The spec says "A `.workrail` entry at depth 5 must still be discoverable -- the limit stops recursing into children, not reading the current directory's entries." If the guard is placed at the TOP of `walkForRootedWorkflowDirectories` (`if (depth >= MAX_WALK_DEPTH) return`), then `.workrail` at depth 5 is missed (the function returns before reading any entries). The correct placement is INSIDE the loop, AFTER the `.workrail` check, BEFORE the recursive call:
  ```
  if (entry.name === '.workrail') { ... continue; }
  if (depth >= MAX_WALK_DEPTH) { /* log if dev mode */ continue; }
  await walkForRootedWorkflowDirectories(entryPath, discoveredPaths, depth + 1);
  ```

## Philosophy Constraints
- **Errors are data**: `listRememberedRoots` must return `[]` instead of throwing (matching `listManagedSourceRecords` pattern)
- **Immutability by default**: `SKIP_DIRS` is a `const Set` (immutable after module load)
- **Document why not what**: Comments required on cache TTL tradeoff, non-cancelling timeout, why `listRememberedRoots` returns instead of throwing
- **Validate at boundaries**: Timeout and cache are boundary concerns in `createWorkflowReaderForRequest`
- **Module-level mutable Map**: Technically violates "immutability by default" but is the correct tradeoff for a process-global TTL cache; mutation is minimal and confined

## Impact Surface
- Existing tests for `discoverRootedWorkflowDirectories` use unique `fs.mkdtempSync` paths so they will always miss the cache (no cross-contamination)
- New cache tests must call `clearWalkCacheForTesting()` in `afterEach`
- Both `handleV2ListWorkflows` and `handleV2InspectWorkflow` in `v2-workflow.ts` have the same `createWorkflowReaderForRequest` bare-await pattern -- both need fixing

## Candidates

### Candidate 1: Implement as Specified (only real candidate)

**Summary:** Apply all 10 changes exactly as specified, following established patterns already present in the file.

**Tensions resolved:**
- Walk cancellation: documented with comment, accepted as by-design
- Cache freshness: 30s TTL with explicit stale-window comment
- Error visibility: `listRememberedRoots` logs and returns `[]`
- Handler error boundary: try/catch returning `errNotRetryable`

**Boundary:** `request-workflow-reader.ts` for walk/discovery/cache; `v2-workflow.ts` for handler errors.

**Failure mode:** Depth guard placement. If placed at top of function, `.workrail` at depth 5 is missed. Must be inside the loop after `.workrail` check.

**Repo pattern:** Follows. `listManagedSourceRecords` already does graceful `{ records: [], storeError }`. `withTimeout` already in `v2-workflow.ts`. `errNotRetryable` used throughout.

**Gains:** Bounded walk, process-level caching, handlers never throw unexpectedly, operator-visible walk errors.

**Losses:** Module-level mutable state (acceptable).

**Scope:** Best-fit. Changes confined to two specified files plus test file.

**Philosophy:** Honors errors-as-data, immutability for the Set, document-why, validate-at-boundaries. Minor conflict with immutability for the module-level Map (accepted, documented).

## Comparison and Recommendation

Only one real candidate. The spec fully prescribes the design -- data structures (Map with TTL, Set for skip dirs), function signatures (depth param), and behavior (graceful degradation). No architectural choice needed.

**Recommendation:** Implement as specified.

## Self-Critique

**Strongest counter-argument:** The module-level Map cache could instead be passed as a dependency injection parameter to `discoverRootedWorkflowDirectories`. This would be stricter about "immutability by default". It loses because: no repo precedent for injecting caches, the cache is a pure optimization, `clearWalkCacheForTesting()` provides sufficient testability.

**Narrower option:** Just add depth limit + skip dirs, skip the cache and timeout. Loses because the spec requires both.

**Broader option:** Make TTL configurable via env var. Not justified -- YAGNI applies, no evidence of multiple TTL requirements.

**Invalidating assumption:** If `discoverRootedWorkflowDirectories` were called from multiple threads simultaneously, the module-level Map would need synchronization. Node.js is single-threaded so this does not apply.

**Pivot condition:** If depth-5 boundary test fails, the guard is likely placed at the top of the function instead of inside the loop.

## Open Questions for the Main Agent

None -- the spec is complete and the implementation path is clear.
