# list_workflows Latency Fix -- Implementation Plan

## Problem Statement

`list_workflows` latency exceeds 20 seconds (measured at 36.9s for zillow-android-2). Root cause: `walkForRootedWorkflowDirectories` in `src/mcp/handlers/shared/request-workflow-reader.ts` runs a fresh, unbounded recursive DFS on every call across all accumulated remembered roots. Four compounding factors: no walk cache, insufficient skip list, indefinitely accumulated roots, and the 30s timeout wrapping the wrong operation (AFTER the walk).

## Acceptance Criteria

1. `shouldSkipDirectory` skips: `build`, `dist`, `out`, `target`, `.gradle`, `.gradle-cache`, `.cache`, `DerivedData`, `Pods`, `vendor`, `__pycache__`, `.venv`, `venv`, `.next`, `.nuxt`, `.turbo`, `.parcel-cache`, `coverage`, `.nyc_output`
2. `walkForRootedWorkflowDirectories` stops recursing at depth 5
3. `discoverRootedWorkflowDirectories` caches the result with a 30s TTL, keyed on sorted root paths
4. All existing tests in `tests/unit/mcp/request-workflow-reader.test.ts` continue to pass
5. `npx vitest run` passes with no failures

## Non-Goals

- No changes to remembered-roots eviction policy
- No persistent disk cache
- No changes to `v2-workflow.ts` or the 30s loadAllWorkflows timeout
- No parallelization of the walk
- No explicit cache invalidation from write paths (TTL-only)

## Philosophy-Driven Constraints

- Cache value must be `readonly` (immutability by default)
- Cache miss must fall through to fresh walk -- no thrown exceptions (errors are data)
- Cache key must be deterministic: sorted root paths joined with null byte (determinism over cleverness)
- Comments must explain TTL rationale and depth limit reasoning (document why, not what)

## Invariants

- Stale path semantics: a root that does not exist (ENOENT) is reported as stale, not thrown
- Non-ENOENT errors from the root directory are re-thrown
- Subdirectory ENOENT mid-walk is silently swallowed (the root is not stale)
- Discovery order is deterministic (directory entries sorted lexicographically)
- All three invariants are covered by existing tests and must remain green

## Selected Approach

**Candidate C**: Expand skip list + add depth limit (5) + module-level 30s TTL cache in `discoverRootedWorkflowDirectories`.

Runner-up: Candidate B (skip list + depth, no cache) -- loses because repeated calls within a session still re-walk.

Rationale: All three compounding factors are addressed. The staleness window is explicitly specified in the acceptance criteria and is self-healing.

## Vertical Slices

### Slice 1: Expand shouldSkipDirectory
- File: `src/mcp/handlers/shared/request-workflow-reader.ts`
- Change: add 18 entries to the `shouldSkipDirectory` predicate
- Risk: none -- pure additive change to a pure function
- Test: no new tests needed; existing tests exercise `shouldSkipDirectory` indirectly

### Slice 2: Add depth limit to walkForRootedWorkflowDirectories
- File: `src/mcp/handlers/shared/request-workflow-reader.ts`
- Change: add `depth: number` parameter (default 0), stop at `depth >= 5`
- Risk: low -- theoretical miss for `.workrail` nested deeper than 5 levels
- Test: add one test: walk with `.workrail` at depth exactly 5 is found; at depth 6 is not found (validates the boundary)

### Slice 3: Add module-level TTL cache to discoverRootedWorkflowDirectories
- File: `src/mcp/handlers/shared/request-workflow-reader.ts`
- Change: module-level `Map<string, {readonly result: WorkflowRootDiscoveryResult, readonly expiresAt: number}>`, cache key = `[...roots].sort().join('\0')`, TTL = 30_000ms
- Risk: low -- mutable module state; acceptable given Node.js single-threaded execution
- Test: add one test: calling `discoverRootedWorkflowDirectories` twice with the same roots returns the same object reference (proves cache hit, not re-walk)

## Test Design

### Existing tests (must stay green)
All 9 tests in `tests/unit/mcp/request-workflow-reader.test.ts` -- cover deterministic ordering, stale paths, ENOENT handling, mid-walk disappearance. No changes needed to these tests.

### New tests to add (in the same file)

**Slice 2 test**: depth limit boundary
```
it('discovers .workrail at depth 5 but not depth 6', async () => {
  // create dir structure: root/a/b/c/d/.workrail/workflows (depth 5 -- found)
  //                       root/a/b/c/d/e/.workrail/workflows (depth 6 -- not found)
  // assert discovered contains depth-5 path, not depth-6 path
})
```

**Slice 3 test**: cache hit returns same result
```
it('returns cached result on second call with same roots within TTL', async () => {
  // call discoverRootedWorkflowDirectories([root]) twice
  // assert result1 === result2 (same object reference -- proves cache hit)
})
```

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| .workrail at depth > 5 missed | Very low | Medium | Convention places .workrail at project root; document in comment |
| 30s staleness confuses users | Low | Low | Self-healing; acceptable per acceptance criteria |
| Cache state leaks between tests | Very low | Low | Unique temp dir paths per test = unique cache keys |

## PR Packaging Strategy

Single PR. All three changes are in one file, are tightly related, and address a single root cause. Splitting would not add clarity.

Commit message: `perf(mcp): bound walk depth, expand skip list, cache discovery results`

## Philosophy Alignment per Slice

### Slice 1 (skip list)
- Immutability by default -> satisfied (pure function, no state)
- Architectural fixes over patches -> satisfied (changes the structural constraint)
- YAGNI with discipline -> satisfied (known real dirs, no speculation)

### Slice 2 (depth limit)
- Determinism over cleverness -> satisfied (fixed depth, predictable behavior)
- Compose with small pure functions -> satisfied (depth flows through recursion cleanly)
- Immutability by default -> satisfied (no new state)

### Slice 3 (cache)
- Immutability by default -> tension (module-level Map is mutable) -- acceptable, confined
- Dependency injection for boundaries -> tension (Date.now() not injected) -- acceptable, unique per-test keys prevent leakage
- Determinism over cleverness -> satisfied (sorted key = stable behavior)
- YAGNI with discipline -> satisfied (TTL-only, no persistent cache)

## Summary

- `implementationPlan`: Candidate C, all changes in `request-workflow-reader.ts`
- `slices`: 3 (skip list, depth limit, TTL cache)
- `estimatedPRCount`: 1
- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
