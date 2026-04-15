# Implementation Plan: Walk Cache, Depth Limit, Skip Dirs, Graceful Degradation

## Problem Statement

The `walkForRootedWorkflowDirectories` function has no depth limit and only skips `.git` and `node_modules`, making it vulnerable to very deep directory trees and slow on large repos. There is no caching, so every call to `createWorkflowReaderForRequest` does a fresh walk. `listRememberedRoots` throws on store failure, preventing callers from recovering. Both v2-workflow.ts handlers let `createWorkflowReaderForRequest` throws propagate uncaught, crashing handler responses.

## Acceptance Criteria

1. `shouldSkipDirectory` uses a `const SKIP_DIRS = new Set([...])` with 20 entries
2. `walkForRootedWorkflowDirectories` takes a `depth` param (default 0), stops recursing at depth >= 5, logs to console.debug if `WORKRAIL_DEV=1`, and still discovers `.workrail` entries at exactly depth 5
3. `discoverRootedWorkflowDirectories` has a module-level Map cache keyed on sorted resolved roots joined by `\0`, TTL 30s, exports `clearWalkCacheForTesting()`
4. `createWorkflowReaderForRequest` wraps the discovery call in a 10s timeout; timeout errors are caught inside the function and return the graceful fallback with `managedStoreError` set
5. `listRememberedRoots` returns `[]` on store failure (logs error, does not throw)
6. `handleV2ListWorkflows` wraps `createWorkflowReaderForRequest` in try/catch returning `errNotRetryable('INTERNAL_ERROR', ...)`
7. `handleV2InspectWorkflow` same fix
8. Test: depth-5 found, depth-6 not found
9. Test: cache hit (strict reference equality on second call)
10. Test: skip list (build/ subdirectory not discovered)
11. `npx vitest run` passes

## Non-Goals

- Cancelling the background walk after timeout
- Making TTL configurable
- Adding cache to `discoverWorkflowDirectoriesUnderRoot`
- Changing the v2 execution engine or session handling

## Philosophy-Driven Constraints

- `SKIP_DIRS` must be a `const Set` (immutability by default)
- `listRememberedRoots` must return `[]` on error (errors are data)
- Comments must explain WHY: cache TTL tradeoff, non-cancelling timeout, why `[]` not throw
- Try/catch in v2-workflow.ts must return structured `errNotRetryable` (errors are data)
- No new abstractions beyond what is specified (YAGNI)

## Invariants

- A `.workrail` entry at depth 5 MUST be discoverable
- Cache key uses `path.resolve` before building, then `sort().join('\0')`
- The timeout error must NOT propagate out of `createWorkflowReaderForRequest`
- `clearWalkCacheForTesting()` must be exported from `request-workflow-reader.ts`

## Selected Approach

Implement all 10 changes as specified. No runner-up. See design-candidates doc.

**Critical implementation detail:** The depth guard must be placed INSIDE the loop in `walkForRootedWorkflowDirectories`, AFTER the `.workrail` check, BEFORE the recursive call:
```typescript
if (entry.name === '.workrail') { ... continue; }
if (depth >= MAX_WALK_DEPTH) {
  if (process.env.WORKRAIL_DEV === '1') console.debug('[workrail] walk depth limit reached at:', currentDirectory);
  continue;
}
await walkForRootedWorkflowDirectories(entryPath, discoveredPaths, depth + 1);
```

## Vertical Slices

### Slice 1: `request-workflow-reader.ts` structural changes
- Replace `shouldSkipDirectory` with `SKIP_DIRS` Set
- Add `MAX_WALK_DEPTH = 5` constant
- Add `depth` param to `walkForRootedWorkflowDirectories`
- Fix depth guard placement

### Slice 2: `request-workflow-reader.ts` cache
- Add module-level `walkCache: Map<string, { result: WorkflowRootDiscoveryResult; expiresAt: number }>`
- Add cache key derivation and TTL check in `discoverRootedWorkflowDirectories`
- Export `clearWalkCacheForTesting()`
- Add cache comment

### Slice 3: `request-workflow-reader.ts` timeout + listRememberedRoots fix
- Import `withTimeout` from `./with-timeout.js`
- Add `DISCOVERY_TIMEOUT_MS = 10_000`
- Wrap `discoverRootedWorkflowDirectories` call in try/catch with timeout inside `createWorkflowReaderForRequest`
- Fix `listRememberedRoots` to return `[]` on error

### Slice 4: `v2-workflow.ts` handler fixes
- Wrap `createWorkflowReaderForRequest` ternary in try/catch in `handleV2ListWorkflows`
- Same for `handleV2InspectWorkflow`

### Slice 5: Tests
- Add depth boundary test (#8)
- Add cache hit test (#9)
- Add skip list test (#10)
- Add `afterEach(() => clearWalkCacheForTesting())` to test suite

## Test Design

**Test 8 (depth boundary):**
- Create temp dir with `.workrail/workflows` at depth 5 (5 levels deep from root)
- Create temp dir with `.workrail/workflows` at depth 6 (6 levels deep from root)
- Call `discoverRootedWorkflowDirectories([root])`
- Assert depth-5 path is in `discovered`
- Assert depth-6 path is NOT in `discovered`
- Must call `clearWalkCacheForTesting()` in afterEach

**Test 9 (cache hit):**
- Create a unique temp dir with a `.workrail/workflows` entry
- Call `discoverRootedWorkflowDirectories([root])` twice
- Assert `result1 === result2` (strict reference equality)

**Test 10 (skip list):**
- Create temp dir with `.workrail/workflows` at root level (should be found)
- Create `build/.workrail/workflows` inside the same root (should NOT be found)
- Call `discoverRootedWorkflowDirectories([root])`
- Assert root-level path is in `discovered`
- Assert build/ path is NOT in `discovered`

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Depth guard placed at wrong position | Low | Medium | Test #8 catches it |
| Cache TTL check using wrong comparison | Low | Low | Test #9 catches stale results |
| withTimeout import path wrong | Low | Low | TypeScript compile error will surface it |
| try/catch wrapping too much of createWorkflowReaderForRequest | Low | Medium | Code review + test |

## PR Packaging Strategy

Single PR. All changes are in two source files and one test file. The changes are tightly coupled (cache + timeout must both be present; handler fixes are independent but small).

## Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| Slice 1: SKIP_DIRS Set | Immutability by default | Satisfied -- const Set |
| Slice 1: depth limit | Validate at boundaries | Satisfied -- guard inside walk |
| Slice 2: module-level Map cache | Immutability by default | Tension -- mutation confined, clearWalkCacheForTesting() export makes it explicit |
| Slice 2: cache comment | Document why not what | Satisfied |
| Slice 3: listRememberedRoots fix | Errors are data | Satisfied -- returns [] not throws |
| Slice 3: timeout | Validate at boundaries | Satisfied -- at createWorkflowReaderForRequest boundary |
| Slice 4: handler fixes | Errors are data | Satisfied -- errNotRetryable not throw |
| Slice 5: tests | Prefer fakes over mocks | Satisfied -- real temp dirs |

## Unresolved Unknowns

`unresolvedUnknownCount`: 0

## Plan Confidence Band

High
