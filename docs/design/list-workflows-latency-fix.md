# list_workflows Latency Fix -- Design Candidates

## Problem Understanding

### Core tensions
1. **Correctness vs speed**: A deeper skip list and depth limit could miss legitimately nested `.workrail` directories. Chosen conservatively -- standard monorepo conventions don't nest `.workrail` deeper than 5 levels.
2. **Simplicity vs invalidation accuracy**: A TTL cache may serve stale results if a user creates a new `.workrail` dir within the 30s window. Explicit invalidation would require threading a cache-invalidation signal through unrelated write paths.
3. **Module-level mutable state vs dependency injection**: The cache as a module-level Map is pragmatic. Injecting a clock for testability would be over-engineered for a 30s TTL.

### Likely seam
All three fixes are confined to `src/mcp/handlers/shared/request-workflow-reader.ts`. No API surface changes. No callers need to change.

### What makes this hard
Nothing technically hard. The risk is under-fixing (skip list only) or over-engineering (persistent cross-process cache).

---

## Philosophy Constraints

Source: `/Users/etienneb/git/personal/workrail/AGENTS.md`

- **Immutability by default** -- cache value should be `readonly`; the Map is mutable but confined
- **Errors are data** -- cache miss falls through to fresh walk, no exceptions
- **Determinism over cleverness** -- sort roots for stable cache key
- **YAGNI with discipline** -- TTL only, no persistent cache

No conflicts between stated philosophy and existing repo patterns.

---

## Impact Surface

- `discoverRootedWorkflowDirectories` is called once per `createWorkflowReaderForRequest` invocation
- The cache is internal to the function -- callers observe no API change
- Tests in `tests/unit/mcp/request-workflow-reader.test.ts` use fresh temp dirs per test, so cache keys never collide between test cases (TTL won't cause cross-test leakage)

---

## Candidates

### Candidate A: Skip list expansion only

Expand `shouldSkipDirectory` to skip: `build`, `dist`, `out`, `target`, `.gradle`, `.gradle-cache`, `.cache`, `DerivedData`, `Pods`, `vendor`, `__pycache__`, `.venv`, `venv`, `.next`, `.nuxt`, `.turbo`, `.parcel-cache`, `coverage`, `.nyc_output`.

- **Tensions resolved**: width of walk (88% of Android monorepo eliminated)
- **Tensions accepted**: repeated calls still re-walk; no depth bound
- **Boundary**: `shouldSkipDirectory` pure predicate
- **Failure mode**: large tree with unusual directory names not in the list
- **Repo pattern**: follows exactly -- extends an existing two-entry check
- **Gains**: zero added complexity, zero new state
- **Losses**: no protection against deep trees or repeated calls
- **Scope**: too narrow for the stated acceptance criteria
- **Philosophy fit**: perfect -- pure function, no mutable state

### Candidate B: Skip list + depth limit

All of A, plus `depth: number` parameter (default 0) passed through `walkForRootedWorkflowDirectories`, stopping recursion at `depth >= 5`.

- **Tensions resolved**: wide trees and deep trees both bounded
- **Tensions accepted**: repeated calls still re-walk
- **Boundary**: `walkForRootedWorkflowDirectories` internal function; depth flows through the recursion
- **Failure mode**: `.workrail` at depth > 5 (e.g., `root/a/b/c/d/e/.workrail`) -- no real-world evidence of this
- **Repo pattern**: adapts -- passing context through recursion already done with `discoveredPaths[]`
- **Gains**: worst-case walk is bounded even for exotic directory structures
- **Losses**: minor theoretical miss for very deep repos
- **Scope**: best-fit if cache is not required
- **Philosophy fit**: honors determinism, small pure functions

### Candidate C: Skip list + depth limit + module-level TTL cache (full fix)

All of B, plus a `Map<string, {readonly result: WorkflowRootDiscoveryResult, readonly expiresAt: number}>` at module level in `discoverRootedWorkflowDirectories`. Cache key = root paths sorted and joined with `\0`. TTL = 30 seconds (matches diagnosis acceptance criteria).

- **Tensions resolved**: all three compounding factors; repeated calls within a session are near-zero cost
- **Tensions accepted**: up to 30s staleness if a new `.workrail` dir is created while cache is warm
- **Boundary**: `discoverRootedWorkflowDirectories` -- the public API for the discovery step; cache is entirely internal
- **Failure mode**: new `.workrail` directory not visible until TTL expires
- **Repo pattern**: departs -- no precedent for in-memory caching in this module, but pattern is standard
- **Gains**: eliminates 30s wall-clock penalty for repeated calls in the same process lifetime
- **Losses**: module-level mutable state; slight staleness window
- **Scope**: best-fit -- all changes in one file, no API changes, matches stated acceptance criteria
- **Philosophy fit**: slight tension with immutability (module Map is mutable) -- mitigated by confining it behind a pure functional interface

---

## Comparison and Recommendation

**Recommendation: Candidate C**

The diagnosis identified four compounding factors and three required fixes. Candidate C addresses all of them. The skip list alone eliminates the bulk of the Android walk but leaves repeated-call overhead and offers no protection against other large monorepos. The depth limit adds a safety net. The cache converts a 30s wall-clock penalty into a sub-millisecond repeat for the common case.

The 30s staleness window is the most manageable failure mode: it self-heals, requires no user action, and matches the stated acceptance criteria from the prior investigation.

---

## Self-Critique

**Strongest counter-argument**: The cache introduces the only real mutable state in the module. If a test runner reuses the module between test cases, cache state could leak. Mitigation: cache keys are based on the actual root paths, which are unique temp dirs per test -- no leakage in practice.

**Narrower option (B)**: Would lose the cache benefit for repeated calls within a session. Even with the skip list, repeated walks without cache cost real latency on large monorepos.

**Broader option (persistent disk cache)**: Not justified. The 30s in-memory TTL is sufficient; persistent cache adds I/O and invalidation complexity with no material gain.

**Pivot condition**: If `.workrail` conventions change to allow deeper nesting, increase the depth limit. If the 30s staleness window causes user-reported issues, add explicit cache invalidation triggered from the remembered-roots write path.

---

## Open Questions

None requiring human decision. The diagnosis and acceptance criteria are fully specified.
