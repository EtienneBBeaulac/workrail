# Implementation Plan: start_workflow Latency Fixes

## 1. Problem Statement

`start_workflow` latency was traced to 4 fixable sequential I/O patterns:
1. 3 git commands in `runGitCommands` that run sequentially when 2 of them are independent
2. `resolveWorkspaceAnchors` runs after `loadAndPinWorkflow` despite having no data dependency on it
3. A redundant `pinnedStore.get` immediately follows `pinnedStore.put` on the cache-miss path
4. Root walk in `discoverRootedWorkflowDirectories` processes roots sequentially instead of in parallel

## 2. Acceptance Criteria

- Fix 1: `runGitCommands` runs git branch and git SHA reads concurrently (not sequentially after the first command)
- Fix 2: `resolveWorkspaceAnchors` and `loadAndPinWorkflow` execute concurrently in `executeStartWorkflow`
- Fix 3: On cache-miss, `loadAndPinWorkflow` returns the compiled snapshot directly after `put` without calling `get` again
- Fix 4: `discoverRootedWorkflowDirectories` processes all roots in parallel; cold walk time is max(slowest root) not sum(all roots)
- All existing tests pass (`npx vitest run`)
- No behavior changes -- same outputs, same error handling, same graceful degradation

## 3. Non-Goals

- Parallelizing git command 1 (`--git-common-dir`) with commands 2+3 -- command 1 gates the rest
- Changing `resolveWorkspaceAnchors` return type
- Adding new tests (fixes are pure performance optimizations; existing tests cover correctness)
- Changing discovery timeout or TTL values

## 4. Philosophy-Driven Constraints

- **Errors are data**: all parallelization must maintain ResultAsync error paths; no exceptions
- **Functional over imperative**: replace loops with `Promise.all`/`Promise.allSettled`/`ResultAsync.combine`
- **Immutability by default**: no shared mutable state written during parallel execution (Fix 4 dedup Set is written post-collection)
- **Determinism**: `Promise.allSettled` and `ResultAsync.combine` preserve input-array ordering, so outputs are deterministic

## 5. Invariants

- Fix 1: First git command must complete before branch+SHA reads start (data dependency)
- Fix 2: `stalePaths` from `readerRA` must remain in scope for final response assembly
- Fix 3: `enrichedCompiled` has already passed Phase 1a validation -- no re-parse needed
- Fix 4: Dedup Set applied post-collection only, never during parallel walks

## 6. Selected Approach + Rationale + Runner-Up

**Fix 1**: `Promise.all([this.gitCommand(branch), this.gitCommand(sha)])` after the first sequential call.
- Rationale: identical to `loadSegmentsParallel` pattern in session-store
- Runner-up: start all 3 eagerly (rejected -- command 1 gates whether to proceed)

**Fix 2**: Start `anchorsRA` before `loadAndPinWorkflow`, use `ResultAsync.combine([pinnedRA, anchorsRA.mapErr(...)])` inside `readerRA.andThen`.
- Rationale: follows neverthrow idiom; `.mapErr((x: never): StartWorkflowError => x)` is a zero-cost cast
- Runner-up: move anchors earlier in sequential chain (rejected -- loses parallelism)

**Fix 3**: `.map(() => enrichedCompiled)` after `pinnedStore.put` instead of `.andThen(() => pinnedStore.get(...))`.
- Rationale: cache-hit path already does this; fix extends the same logic to cache-miss path
- Runner-up: keep redundant get (rejected -- adds disk read + Zod parse with no benefit)

**Fix 4**: `Promise.allSettled(roots.map(root => discoverWorkflowDirectoriesUnderRoot(path.resolve(root))))` then iterate results for dedup.
- Rationale: `allSettled` preserves partial results; more robust than `Promise.all`
- Runner-up: `Promise.all` (rejected -- one unexpected throw would discard all other roots)

## 7. Vertical Slices

### Slice 1: Fix 1 - Parallelize branch+SHA git commands
- File: `src/v2/infra/local/workspace-anchor/index.ts`
- Change: Replace two sequential `await this.gitCommand(...)` calls (lines 87, 93) with `const [branch, sha] = await Promise.all([...])`
- Self-contained -- no downstream changes needed

### Slice 2: Fix 3 - Eliminate redundant pinnedStore.get after put
- File: `src/mcp/handlers/v2-execution/start.ts`
- Change: In `loadAndPinWorkflow`, replace `.andThen(() => pinnedStore.get(workflowHash).mapErr(...))` on line 137 with `.map(() => enrichedCompiled)`
- Self-contained -- type of returned value is the same

### Slice 3: Fix 2 - Run resolveWorkspaceAnchors in parallel with loadAndPinWorkflow
- File: `src/mcp/handlers/v2-execution/start.ts`
- Change: In `executeStartWorkflow`, start `anchorsRA` before the `loadAndPinWorkflow` call, use `ResultAsync.combine([pinnedRA, anchorsRA.mapErr(...)])` instead of `.andThen` chaining
- Verify: `stalePaths` closure reference preserved; imports for `anchorsToObservations` correct

### Slice 4: Fix 4 - Parallelize root walk across roots
- File: `src/mcp/handlers/shared/request-workflow-reader.ts`
- Change: In `discoverRootedWorkflowDirectories`, replace `for...of` loop with `Promise.allSettled(resolvedRoots.map(root => discoverWorkflowDirectoriesUnderRoot(root)))`, then merge results with dedup
- Verify: cache key computation unchanged; cache write after all results collected

## 8. Test Design

No new tests needed. These are pure performance optimizations with no behavior changes:
- `gitCommand` returning null on failure is already covered
- `discoverRootedWorkflowDirectories` behavior is covered by existing walk tests
- `loadAndPinWorkflow` cache-miss path is covered by existing start_workflow tests
- `executeStartWorkflow` with workspace anchors is covered by existing lifecycle tests

Verify by running `npx vitest run` after all 4 slices.

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Fix 2: stalePaths out of scope after restructuring | Low | High | Verify stalePaths reference at lines ~533 after implementation |
| Fix 3: pinnedStore normalizes on write | Very Low | Medium | Comment in code noting this assumption; revert if store changes |
| Fix 4: unexpected throw from discoverWorkflowDirectoriesUnderRoot | Very Low | Low | allSettled catches all rejections; treated as stale |
| Fix 2: TypeScript type error from never cast | Low | Low | Zero-cost cast; TypeScript will catch if error type changes |

## 10. PR Packaging Strategy

Single PR with all 4 fixes. Each fix is small and independent. The PR description should explain the latency motivation and note that behavior is unchanged.

Commit message type: `perf(mcp)` (performance improvement affecting mcp scope)

## 11. Philosophy Alignment Per Slice

### Slice 1 (Fix 1)
- Functional over imperative -> Satisfied: Promise.all replaces sequential awaits
- Determinism -> Satisfied: Promise.all resolves in input order; null handling unchanged
- Errors are data -> Satisfied: gitCommand returns null on error, no exceptions

### Slice 2 (Fix 3)
- YAGNI with discipline -> Satisfied: removes redundant defensive code the type system makes unnecessary
- Errors are data -> Satisfied: ResultAsync chain preserved
- Validate at boundaries, trust inside -> Tension: removing Zod round-trip on cache-miss. Acceptable because validation already happened at Phase 1a boundary.

### Slice 3 (Fix 2)
- Errors are data -> Satisfied: ResultAsync.combine maintains error paths
- Functional over imperative -> Satisfied: declarative combine over sequential chain
- Compose with small, pure functions -> Tension: executeStartWorkflow is more complex. Acceptable -- complexity is minimal and localized.

### Slice 4 (Fix 4)
- Functional over imperative -> Satisfied: map+allSettled replaces for-of loop
- Immutability by default -> Satisfied: mutable Set applied post-collection, not during parallel execution
- Determinism -> Satisfied: allSettled preserves input-array order

## Plan Metadata

- estimatedPRCount: 1
- planConfidenceBand: High
- unresolvedUnknownCount: 0
- followUpTickets: none
