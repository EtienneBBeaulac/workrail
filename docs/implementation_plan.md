# Implementation Plan: Managed Sources & Workflow References Audit Fixes

## 1. Problem Statement

A combined MR review, production readiness audit, and architecture scalability audit of the managed sources and workflow references subsystems identified 10 findings (F1-F10) ranging from High to Low severity. The findings span I/O timeout gaps, missing error propagation, sequential parallelism bottlenecks, missing exhaustiveness guards, enum duplication, dead code, and absent GC mechanisms.

## 2. Acceptance Criteria

- F1: `listManagedSourceRecords` + managed source stat loop is covered by a timeout budget. On timeout, degrade gracefully (stale records, not hang).
- F2: `resolveWorkflowReferences` in `start_workflow` has a timeout. On timeout, all references are marked `unresolved`; `start_workflow` still succeeds.
- F3: `start_workflow` response includes a `warnings` field when the managed source store was unavailable (consistent with `list_workflows` and `inspect_workflow`).
- F4: Managed source stat checks run in parallel (`Promise.allSettled`), not sequentially.
- F5: `deriveSourceCatalogEntry` has an `assertNever` guard at the end of its switch.
- F6: A single `RESOLVE_FROM_VALUES` constant and `ResolveFrom` type alias are the single source of truth for the `'workspace' | 'package'` enum. All Zod schemas and casts derive from it.
- F7: A comment at the `RA.fromPromise` call site in `enrichPinnedSnapshotWithResolvedReferences` explains why the error mapper is unreachable.
- F8: `v2-resolve-refs-envelope.ts` is deleted.
- F9: `PinnedWorkflowStorePortV2` exposes `list()` and `prune(olderThanMs)`. `LocalPinnedWorkflowStoreV2` implements both. `InMemoryPinnedWorkflowStore` and all test fakes implement both.
- F10: `clearWalkCacheForTesting()` comment explicitly states the test isolation requirement and shared-process-pool risk.
- All existing tests pass.
- New tests cover the timeout and parallelism fixes (F1/F2/F4).

## 3. Non-Goals

- Implementing actual snapshot deletion in `prune()` -- the no-op stub satisfies the port contract; real GC policy is a follow-up.
- Changing `resolveWorkflowReferences` return type to `ResultAsync<..., never>` (F7 accepts comment approach per finding specification).
- Wiring `v2-resolve-refs-envelope.ts` to call sites instead of deleting it.
- Adding prune trigger beyond `startAsyncServices()` (no periodic timers).

## 4. Philosophy-Driven Constraints

- No `throw` statements in new code -- use `ResultAsync` throughout
- Graceful degradation on timeout -- fail-open, not fail-hard
- `Promise.allSettled` for fan-out -- never `Promise.all` where individual failures should not abort the batch
- `assertNever` for exhaustiveness -- not runtime `default: return undefined`
- `readonly` arrays and `as const` for all new constants
- All new port methods return `ResultAsync<T, E>` where E is the existing `PinnedWorkflowStoreError`

## 5. Invariants

- A timeout in the managed source stat loop must not propagate as a hard error -- it must degrade to treating timed-out records as stale
- `start_workflow` must succeed even when `resolveWorkflowReferences` times out
- `prune()` must never delete a snapshot that a currently-running session depends on -- the no-op stub guarantees this
- `RESOLVE_FROM_VALUES` must be `readonly ['workspace', 'package'] as const` so Zod infers the correct discriminated union type
- `deriveSourceCatalogEntry` must remain exhaustive after F5 fix -- any new `WorkflowSource.kind` will be a compile-time error

## 6. Selected Approach

**Candidate A: Minimal targeted fixes at natural seams.**

Each finding is fixed at its natural seam in the existing code. No new abstractions. Follows established `withTimeout` + `Promise.allSettled` patterns already in `request-workflow-reader.ts`.

Runner-up was Candidate B (resurrect dead module), rejected because `enrichPinnedSnapshotWithResolvedReferences` does pinned-snapshot enrichment beyond envelope building -- the abstraction doesn't fit.

## 7. Vertical Slices

### Slice 1: F1 + F4 + F10 -- Managed source stat timeout and parallelism
**File:** `src/mcp/handlers/shared/request-workflow-reader.ts`
- Replace sequential `for (const record of allManagedRecords)` loop with `Promise.allSettled` fan-out
- Wrap the fan-out in `withTimeout(DISCOVERY_TIMEOUT_MS, 'managed_source_stat')`
- On timeout, treat all records as stale (append to `staleManagedRecords`)
- Per-record failure from `isDirectory` already returns `false` -- treat as stale
- Update `clearWalkCacheForTesting()` comment to explicitly state shared-process-pool isolation risk (F10)

### Slice 2: F2 + F7 -- Reference resolution timeout and contract comment
**File:** `src/mcp/handlers/v2-execution/start.ts`
- Add `REFERENCE_RESOLUTION_TIMEOUT_MS = 5_000` constant
- In `enrichPinnedSnapshotWithResolvedReferences`, replace bare `resolveWorkflowReferences(...)` call with:
  ```typescript
  const resolutionResult = await withTimeout(
    resolveWorkflowReferences(references, workspacePath),
    REFERENCE_RESOLUTION_TIMEOUT_MS,
    'reference_resolution',
  ).catch(() => null);
  ```
- Build `allUnresolved` fallback from input references when `resolutionResult` is null
- Add F7 comment at `RA.fromPromise` explaining unreachable error mapper

### Slice 3: F3 -- managedStoreError propagation in start_workflow
**Files:** `src/mcp/output-schemas.ts`, `src/mcp/handlers/v2-execution/start.ts`
- Add `warnings: z.array(z.string()).optional().describe('...')` to `V2StartWorkflowOutputSchema`
- In `start.ts`, change `.map(({ reader, stalePaths })` to also destructure `managedStoreError`
- Thread `managedStoreError` into response as `warnings: [...]` when present

### Slice 4: F5 -- assertNever in deriveSourceCatalogEntry
**File:** `src/mcp/handlers/v2-workflow.ts`
- Import `assertNever` from `../../runtime/assert-never.js`
- Add `assertNever(source)` after the switch in `deriveSourceCatalogEntry`

### Slice 5: F6 -- resolveFrom enum consolidation
**Files:**
- `src/types/workflow-definition.ts` -- add `export const RESOLVE_FROM_VALUES = ['workspace', 'package'] as const` and `export type ResolveFrom = typeof RESOLVE_FROM_VALUES[number]`
- `src/v2/durable-core/schemas/compiled-workflow/index.ts` -- use `z.enum(RESOLVE_FROM_VALUES)` (3 occurrences)
- `src/mcp/handlers/v2-reference-resolver.ts` -- use `ResolveFrom` type for cast
- `src/mcp/handlers/v2-execution/continue-rehydrate.ts` -- use `ResolveFrom` for cast

### Slice 6: F8 -- Delete dead module
**File:** `src/mcp/handlers/v2-resolve-refs-envelope.ts`
- Delete the file
- Verify no imports remain in production code

### Slice 7: F9 -- PinnedWorkflowStorePortV2 GC interface
**Files:**
- `src/v2/ports/pinned-workflow-store.port.ts` -- add `list()` and `prune(olderThanMs)` to interface
- `src/v2/infra/local/pinned-workflow-store/index.ts` -- implement `list()` (reads dir listing); implement `prune()` as no-op `okAsync(0)`
- `tests/fakes/v2/pinned-workflow-store.fake.ts` -- add to `InMemoryPinnedWorkflowStore`
- `tests/unit/v2/console-service-session-cache.test.ts` -- update `makePinnedWorkflowStore()`
- `tests/unit/v2/console-service-execution-trace.test.ts` -- update 2 inline objects
- `tests/unit/v2/export-import-roundtrip.test.ts` -- update inline class

## 8. Test Design

### New tests (required for highest-risk changes)

**test: managed source stat parallel execution** (Slice 1)
- Location: `tests/unit/mcp/request-workflow-reader.test.ts`
- Setup: inject a `ManagedSourceStorePortV2` fake with N=3 records pointing to real temp directories
- Verify: all 3 directories are discovered in a single `createWorkflowReaderForRequest` call
- Optionally verify parallelism via timing: 3 concurrent 0ms stats should not take 3x a single stat

**test: managed source stat timeout produces stale records** (Slice 1)
- Mock `fs.stat` (or `isDirectory`) to hang indefinitely
- Verify: `createWorkflowReaderForRequest` returns within timeout + buffer
- Verify: timed-out managed records appear in `staleManagedRecords`

**test: reference resolution timeout produces all-unresolved refs** (Slice 2)
- Inject `fileExists` that hangs longer than `REFERENCE_RESOLUTION_TIMEOUT_MS`
- Call `enrichPinnedSnapshotWithResolvedReferences` directly or through integration
- Assert: result is `Ok` (not `Err`) with all refs having `status: 'unresolved'`

**test: start_workflow surfaces managedStoreError as warnings** (Slice 3)
- Inject `managedSourceStore.list()` that returns an error
- Assert: `executeStartWorkflow` result response includes `warnings: [...]`

### Existing tests
- All tests in `tests/unit/mcp/request-workflow-reader.test.ts` and `tests/unit/mcp/v2-reference-resolver.test.ts` must continue to pass.
- TypeScript compile (`tsc --noEmit`) must pass after F5/F6/F9 changes.
- Vitest full run: `npx vitest run tests/unit/`

## 9. Risk Register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| F2 null-check missed, timeout propagates as error | Low | High | New test enforces successful result on timeout |
| F9 fake update count higher than 5 | Low | Low | TypeScript catches at compile time |
| F6 Zod type inference breaks | Low | Medium | `as const` on `RESOLVE_FROM_VALUES`; compile-time check |
| F9 prune threshold causes premature deletion | None (no-op) | N/A | No-op stub eliminates risk |
| Slice ordering causes interim compile errors | Medium | Low | Execute slices in order; each compiles clean before next |

## 10. PR Packaging Strategy

Single PR (`prStrategy: SinglePR`). All 10 findings are in the same two subsystems. Independent enough to review slice-by-slice, small enough to ship together.

Commit message format: `fix(mcp): <subject>` -- max 72 chars, no period.

## 11. Philosophy Alignment Per Slice

| Slice | Principle | Verdict |
|---|---|---|
| S1 (F1/F4/F10) | Errors-are-data | Satisfied -- timeout degrades to ResultAsync Ok |
| S1 | Graceful degradation | Satisfied -- stale records, not hang |
| S1 | Determinism | Satisfied -- allSettled processes results in input order |
| S2 (F2/F7) | Errors-are-data | Satisfied -- null catch never propagates as error |
| S2 | Document why not what | Satisfied -- comment explains unreachable path |
| S3 (F3) | Surface information | Satisfied -- warning surfaced to caller |
| S4 (F5) | Exhaustiveness | Satisfied -- assertNever enforced |
| S5 (F6) | Type safety first | Satisfied -- single source of truth for enum |
| S6 (F8) | YAGNI | Satisfied -- dead code removed |
| S7 (F9) | Errors-are-data | Satisfied -- ResultAsync throughout |
| S7 (F9) | YAGNI | Tension -- no-op prune defers GC policy; acceptable trade |

## 12. Estimates

- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
- `estimatedPRCount`: 1
- `followUpTickets`:
  - Implement real snapshot GC in `LocalPinnedWorkflowStoreV2.prune()` with configurable threshold and session-reference safety check
