# Performance Fixes: Design Candidates

**Context:** Four remaining performance fixes after a prior session implemented expanded skip list,
`MAX_WALK_DEPTH=5`, and 30s TTL walk cache.

---

## Problem Understanding

### Core tensions

1. **Determinism vs. performance** (findWorkflowJsonFiles parallelization): Making directory scan
   concurrent breaks output insertion order. Resolved by sorting the result -- adds negligible
   overhead at realistic file counts.

2. **Simplicity vs. targeted protection** (timeout on walk): The simplest placement wraps all of
   `createWorkflowReaderForRequest`. But the walk is only one sub-phase -- a tighter, more targeted
   timeout should wrap just `discoverRootedWorkflowDirectories`.

3. **Lazy vs. eager eviction** (TTL in remembered roots): Lazy eviction (on write) is simple and
   has no background-timer risk. It only runs when `rememberRoot` is called, so a workspace seen
   once and never evicted persists until the next write. Acceptable per issue #241.

4. **Real I/O vs. mocked infra** (latency test): A test using real `fs.mkdir` can be slow on CI.
   A 500ms budget for a small synthetic tree is generous enough to avoid flakiness.

### Likely seam

- **Parallelization**: inside `scan()` in `findWorkflowJsonFiles` -- collect subdirs, fan out with
  `Promise.all`, sort final `files` array.
- **Timeout**: inside `createWorkflowReaderForRequest` wrapping `discoverRootedWorkflowDirectories`
  -- single place, both handlers automatically protected.
- **TTL eviction**: inside the `andThen` chain in `rememberRoot()`, just before
  `this.persist(nextRoots)` -- lock is already held, `nextRoots` already computed.
- **Latency test**: `tests/performance/perf-fixes.test.ts` following `cache-eviction.test.ts` style.

### What makes this hard

- Parallelization + determinism: need explicit sort, not just `Promise.all`
- Timeout constant calibration: 10s is generous for most environments but may be tight on
  cold-start NFS mounts before the 30s cache warms
- TTL eviction placement: must be on write path (not read path) to avoid per-call overhead
- Latency test flakiness: tree must be small enough to be fast on CI, large enough to exercise
  the depth limit

---

## Philosophy Constraints

From `AGENTS.md` and `/Users/etienneb/CLAUDE.md`:

- **Determinism over cleverness**: parallelization requires explicit sort to restore determinism
- **Errors are data**: `withTimeout` throws; callers use `ResultAsync.fromPromise(withTimeout(...))`
  -- no change to that pattern needed
- **Immutability by default**: TTL filter produces a new `nextRoots` array (does not mutate)
- **YAGNI with discipline**: no configurable TTL parameter -- use a named constant
- **Prefer fakes over mocks**: latency test uses real `fs` operations
- **Document 'why', not 'what'**: TTL constant and parallelization rationale need explanatory
  comments

### Conflicts

- **Stated: no exceptions** vs **practiced: `withTimeout` throws**. Consistent in practice:
  `withTimeout` is a low-level utility; callers convert at boundary with `ResultAsync.fromPromise`.

---

## Impact Surface

- `findWorkflowJsonFiles` is called by `scanRawWorkflowFiles` (same file). No caller asserts
  order today. Sort makes the new order contract explicit and stable.
- `createWorkflowReaderForRequest` is called from `handleV2ListWorkflows` and
  `handleV2InspectWorkflow`. Adding timeout inside the shared function protects both handlers
  without modifying them.
- `rememberRoot` is called from `remembered-roots.ts` shared handler helper -- no interface
  change needed.
- `LocalRememberedRootsStoreV2` implements `RememberedRootsStorePortV2` -- port interface
  unchanged.

---

## Candidates

### Item 1: Parallelize `findWorkflowJsonFiles`

#### Candidate A (recommended): `Promise.all` fan-out + final sort

Inside `scan()`, collect subdirectory paths from `entries`, push files immediately, then
`await Promise.all(subdirs.map(dir => scan(dir)))`. After `scan(baseDirReal)` returns, call
`files.sort()` before return.

- **Tensions resolved**: sequential scan latency
- **Tensions accepted**: minor sort overhead (negligible)
- **Boundary**: inside `scan()`, no interface change
- **Why best-fit**: targets the anti-pattern directly
- **Failure mode**: if a caller depends on insertion order (none currently do)
- **Repo pattern**: follows `Promise.all` fan-out used elsewhere
- **Gain**: concurrent I/O; **Lose**: insertion order (replaced by stable sort)
- **Scope**: best-fit
- **Philosophy**: honors Determinism (via sort), Compose with small pure functions

#### Candidate B: Replace `statSync` with async `fs.stat`, keep sequential loop

Replaces the blocking sync call in the scan loop with async stat, but keeps sequential descent.

- Too narrow: doesn't fix the `for...of await` sequential descent -- the main bottleneck
- **Scope**: too narrow

---

### Item 2: Timeout protection for walk

#### Candidate A (recommended): Wrap `discoverRootedWorkflowDirectories` inside `createWorkflowReaderForRequest`

Add `DISCOVERY_TIMEOUT_MS = 10_000` constant. Replace:
```ts
const { discovered, stale } = await discoverRootedWorkflowDirectories(rememberedRoots);
```
with:
```ts
const { discovered, stale } = await withTimeout(
  discoverRootedWorkflowDirectories(rememberedRoots),
  DISCOVERY_TIMEOUT_MS,
  'workflow_root_discovery',
);
```

- **Tensions resolved**: hung walk blocking handler forever; single place to maintain
- **Boundary**: `createWorkflowReaderForRequest` in shared module
- **Failure mode**: 10s may be tight on cold NFS walk -- mitigated by 30s cache for subsequent calls
- **Repo pattern**: adapts exact same `withTimeout` pattern from `v2-workflow.ts` lines 215/363
- **Scope**: best-fit

#### Candidate B: Wrap `createWorkflowReaderForRequest` in each handler

Two call sites. If a 3rd handler is added, it misses the timeout. Departs from DRY.

- **Scope**: too broad (and duplicated)

---

### Item 3: TTL eviction in `LocalRememberedRootsStoreV2`

#### Candidate A (recommended): Filter `nextRoots` in `rememberRoot()` before persist

Add `const TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000`. In `rememberRoot()`:

```ts
const withEviction = nextRoots.filter(
  (root) => root.lastSeenAtMs >= nowMs - TTL_30_DAYS_MS
);
return this.persist(withEviction);
```

- **Boundary**: inside `rememberRoot()`, lock already held, `nextRoots` already computed
- **Failure mode**: roots seen once and never evicted until next write -- acceptable
- **Repo pattern**: adapts `normalizeRootRecords` filter pattern in same file
- **Philosophy**: Immutability (new filtered array), YAGNI (no configurable TTL)

#### Candidate B: Filter in `listRootRecords()` (read path)

Eviction on read removes stale entries from the in-memory result but does not persist them.
Stale entries remain on disk. Read path is called much more often -- wrong seam.

- **Scope**: wrong boundary; doesn't reduce disk accumulation

---

### Item 4: Latency regression test

#### Candidate A (recommended): Synthetic tree in `tests/performance/perf-fixes.test.ts`

Create a temp directory tree (depth 5, branching factor 3) with real `fs.mkdir`. Call
`discoverRootedWorkflowDirectories([treeRoot])`. Assert elapsed < 500ms.

- **Boundary**: black-box test of the exported function
- **Failure mode**: flaky on slow CI if tree is too large -- mitigated by small breadth (3) and depth (5)
- **Repo pattern**: follows `cache-eviction.test.ts` style
- **Philosophy**: Prefer fakes over mocks (real FS); Determinism (reproducible tree)

---

## Comparison and Recommendation

All candidates converge. Genuine diversity does not exist for these changes -- each problem has
one clearly best-fit mechanical solution.

**Proceed with all four Candidate A choices.**

Each change:
- Touches exactly one function
- Requires no interface or contract changes
- Is reversible (one-line revert if assumptions are wrong)
- Follows an existing repo pattern

---

## Self-Critique

### Strongest counter-arguments

- **Parallelization**: if downstream validation depends on processing order, sorting may not be
  enough and could mask a latent ordering bug. No test currently asserts order -- low risk.
- **Walk timeout at 10s**: first cold walk on a large monorepo on NFS might legitimately exceed 10s.
  Would produce a user-visible timeout error on first use. The 30s cache means subsequent calls
  are instant -- only the first call is at risk.

### Pivot conditions

- If cold walk times > 10s in production: raise `DISCOVERY_TIMEOUT_MS` or add per-root timeout
  inside `walkForRootedWorkflowDirectories`.
- If `findWorkflowJsonFiles` results need filesystem order: remove sort, document non-determinism.
- If TTL eviction needs to run on stale roots that are never written again: add eviction to the
  read path as a side-effecting read or add a separate `evictStaleRoots()` method.

### Narrower option that lost

Sequential `findWorkflowJsonFiles` with only `statSync` → `fs.stat`: fixes minor blocking I/O
but doesn't address the actual sequential descent anti-pattern.

---

## Open Questions

None that require human decision. All design choices are bounded by existing constraints.
