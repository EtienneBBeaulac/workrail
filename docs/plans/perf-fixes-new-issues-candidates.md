# Performance Fixes: New Issues Discovery

**Date:** 2026-04-07
**Status:** Complete -- 5 new issues confirmed, HIGH confidence

## Final Summary

**Path:** full_spectrum (landscape reading + reframing)

**Problem framing:** The known 7 issues were derived from design doc analysis. Actual source code reading reveals 5 additional issues: one second unguarded call site (inspect_workflow), one test comment that describes nonexistent code, and three issues in `raw-workflow-file-scanner.ts` (a file the known list doesn't mention).

**Landscape takeaways:** All 4 target files are in pre-fix state. No implemented fixes. The design patterns for all fixes exist elsewhere in the codebase (`withTimeout` in v2-workflow.ts, `normalizeRootRecords` in the same remembered-roots file, `Promise.all` fan-out referenced in design docs, `sortedEntries` in request-workflow-reader.ts).

**Chosen direction:** All 5 new issues are confirmed and distinct. No single 'direction' -- this is a discovery output.

**Confidence band:** HIGH

**Residual risks:**
1. Issue A severity: if MCP transport already converts unhandled promise rejections to structured error responses, Issue A is degraded-response rather than crash. Verify before classifying as Red.
2. Issue C scope: `existsSync` is imported alongside `statSync` at raw-workflow-file-scanner.ts:2 -- audit its usage for the same event-loop concern.

**Next actions:**
1. Add Issue A to the known issue #1 ticket (or create a sub-item): inspect_workflow call site at v2-workflow.ts:332
2. Create a new ticket for raw-workflow-file-scanner.ts covering Issues C, D, E together (they are all in the same file)
3. Fix Issue B (test comment) as part of whichever PR implements the walk cache

This document records issues found by reading the actual current state of the four target files
(`request-workflow-reader.ts`, `raw-workflow-file-scanner.ts`, `remembered-roots-store/index.ts`,
`perf-fixes.test.ts`). All 7 previously known issues are confirmed present. The 5 issues below
are NEW -- not named in the known list.

---

## Problem Understanding

### Core tensions

1. **Known list completeness vs. actual code state**: The known 7 issues were derived from design
   doc analysis. Reading actual code reveals additional gaps that the design docs mentioned but the
   known issue list didn't capture explicitly.

2. **Fix scope vs. fix surface**: The design docs say 'all changes in request-workflow-reader.ts'
   for the walk fixes, but the unguarded call site issue extends to `handleV2InspectWorkflow` --
   a second handler not named in known issue #1.

3. **Test reliability vs. test accuracy**: The test file describes code behavior that doesn't exist
   yet (a walk cache), creating a maintenance hazard for future implementers.

### Likely seam

- Issues A (call site): `v2-workflow.ts` lines 332-339 -- identical structural pattern to known issue #1
- Issues B (test comment): `perf-fixes.test.ts` lines 17-18 -- inline comment describing phantom cache
- Issues C, D, E (scanner): `raw-workflow-file-scanner.ts` -- all three affect the same file,
  different functions: `statSync` at line 95, `scan()` sequential loop lines 19-35, unsorted return

### What makes this hard

- Issue A is easy to miss because the design doc says 'callers need not change' -- but it was
  wrong: there are two bare-await call sites, not one
- Issue B is invisible unless you cross-check test comments against actual source code
- Issues C/D/E all live in `raw-workflow-file-scanner.ts` -- a file the known issues don't mention,
  even though the design doc explicitly specifies all three fixes for it

---

## Philosophy Constraints

- **Errors are data**: Issue A violates this -- `createWorkflowReaderForRequest` can throw, and
  `handleV2InspectWorkflow` doesn't wrap it in a Result
- **Determinism over cleverness**: Issue E violates this -- filesystem readdir order is not stable
- **Document why not what**: Issue B violates this -- the comment describes a thing that doesn't
  exist, not the reason the test is structured as it is
- **Dependency injection for boundaries**: Issue C violates this tangentially -- `statSync` is a
  hidden sync I/O side effect inside an async function

---

## Impact Surface

- **Issue A**: `handleV2InspectWorkflow` in `v2-workflow.ts` -- any `listRememberedRoots` error
  thrown inside `createWorkflowReaderForRequest` reaches the MCP transport layer unhandled.
  `handleV2ListWorkflows` has the same exposure (known issue #1). `start.ts` is correctly wrapped.

- **Issue B**: `perf-fixes.test.ts` -- the misleading comment affects any future developer
  implementing the walk cache. They might skip writing cache tests because the comment implies
  the test already validates cache behavior.

- **Issues C/D/E**: `raw-workflow-file-scanner.ts` affects `FileWorkflowStorage.buildWorkflowIndex`
  (via `findWorkflowJsonFiles`) and `scanRawWorkflowFiles` (which calls `findWorkflowJsonFiles`
  then does per-file reads). Both callers receive non-deterministic, sequentially-scanned results.

---

## New Issues

### Issue A: `handleV2InspectWorkflow` has the same unguarded call site as the known #1

**Summary:** `v2-workflow.ts` line 332 uses bare `await createWorkflowReaderForRequest(...)` in
`handleV2InspectWorkflow`, identical to the known issue at line 193 in `handleV2ListWorkflows`.

- **Tensions resolved**: names the second unguarded call site
- **Tensions accepted**: requires the same fix pattern as known issue #1
- **Boundary**: `v2-workflow.ts:332` -- the `handleV2InspectWorkflow` function
- **Failure mode**: `listRememberedRoots` error propagates as unhandled exception to MCP transport
- **Repo pattern**: `start.ts` correctly uses `RA.fromPromise(createWorkflowReaderForRequest(...), mapper)` -- that is the right pattern
- **Gains**: fixing this gives complete handler coverage; losing it means inspect_workflow crashes on remembered-roots store errors
- **Scope**: best-fit -- single line change at the call site
- **Philosophy fit**: fixing restores 'Errors are data'

**Evidence**: `src/mcp/handlers/v2-workflow.ts` line 332:
```ts
? await createWorkflowReaderForRequest({
```
vs `src/mcp/handlers/v2-execution/start.ts` line 364:
```ts
? RA.fromPromise(
    createWorkflowReaderForRequest({...}),
    (err): StartWorkflowError => ({...})
  )
```

---

### Issue B: Test file comment describes a walk cache that does not exist

**Summary:** `perf-fixes.test.ts` lines 17-18 describe 'the module-level walk cache (keyed on
sorted root paths)' -- a data structure that is entirely absent from `request-workflow-reader.ts`.

- **Tensions resolved**: names the maintenance hazard
- **Tensions accepted**: fix is purely editorial (update the comment)
- **Boundary**: `tests/performance/perf-fixes.test.ts` -- the test file JSDoc block
- **Failure mode**: future implementer reads the comment, assumes the cache is already tested,
  and ships the cache implementation without writing cache hit/miss/TTL tests
- **Repo pattern**: departs from 'Document why not what' -- should describe why unique temp dirs
  are used (to prevent cross-test interference), not describe a feature that doesn't exist
- **Scope**: best-fit -- comment update only
- **Philosophy fit**: violation of 'Document why not what'

**Evidence**: `tests/performance/perf-fixes.test.ts` lines 17-18:
```
* Each test uses a unique mkdtemp path so the module-level walk cache
* (keyed on sorted root paths) does not mask the actual walk cost.
```
No cache exists anywhere in `request-workflow-reader.ts`.

---

### Issue C: `statSync` in `scanRawWorkflowFiles` blocks the Node.js event loop

**Summary:** `raw-workflow-file-scanner.ts` line 95 uses the synchronous `statSync` inside an
async function, blocking the event loop during file size checks.

- **Tensions resolved**: eliminates the sync I/O stall
- **Tensions accepted**: requires replacing with `await fs.stat(...)`
- **Boundary**: `scanRawWorkflowFiles` inner loop, line 95
- **Failure mode**: in the current state, every file in a workflow directory causes an event-loop stall during `scanRawWorkflowFiles` -- under concurrent load, all in-flight requests pause
- **Repo pattern**: `fs/promises` is already imported at line 1; `statSync` and `existsSync` are imported from `'fs'` at line 2. Switching to async stat removes the sync import.
- **Scope**: best-fit -- one-line replacement
- **Philosophy fit**: violates async contract ('Determinism over cleverness', implicit event-loop contract)

**Evidence**: `src/application/use-cases/raw-workflow-file-scanner.ts` line 2 and 95:
```ts
import { existsSync, statSync } from 'fs';
...
const stats = statSync(filePath);
```
The design doc (perf-fixes-design-candidates.md, Candidate B note) mentions replacing `statSync`
with async `fs.stat`.

---

### Issue D: `findWorkflowJsonFiles` uses sequential `await` inside a `for` loop (no parallelization)

**Summary:** `raw-workflow-file-scanner.ts` lines 19-35 implement `scan()` as a sequential
`for...of` loop with `await scan(fullPath)` inside -- each subdirectory is fully scanned before
the next one starts.

- **Tensions resolved**: names the sequential I/O bottleneck in the scanner
- **Tensions accepted**: parallelization requires explicit sort to restore deterministic order
- **Boundary**: `scan()` inner function inside `findWorkflowJsonFiles`, lines 19-35
- **Failure mode**: on a deep workflow directory with many subdirectories, scan is O(depth) sequential round trips even on fast SSDs
- **Repo pattern**: the design doc specifies `Promise.all` fan-out; this pattern is used elsewhere in the codebase
- **Scope**: best-fit -- change is inside `scan()`, no interface change
- **Philosophy fit**: honors 'Compose with small pure functions' when fixed (scan becomes fan-out); violates 'Determinism over cleverness' if fan-out added without sort (see Issue E)

**Evidence**: `src/application/use-cases/raw-workflow-file-scanner.ts` lines 23-35:
```ts
for (const entry of entries) {
  const fullPath = path.join(currentDir, entry.name);
  if (entry.isDirectory()) {
    if (entry.name === 'examples') { continue; }
    await scan(fullPath);  // sequential -- next dir waits for this one
  } else if (...) { ... }
}
```

---

### Issue E: `findWorkflowJsonFiles` returns files in non-deterministic filesystem order

**Summary:** The `files[]` array in `findWorkflowJsonFiles` is accumulated via sequential push
with no final sort, so output order depends on `readdir` order, which varies by OS and filesystem.

- **Tensions resolved**: names the non-determinism in the output
- **Tensions accepted**: a sort step adds minor overhead (negligible at workflow file counts)
- **Boundary**: return point of `findWorkflowJsonFiles`, after `await scan(baseDirReal)`
- **Failure mode**: callers that process workflows in order may behave differently on macOS vs Linux CI; integration tests could have latent order-dependency bugs
- **Repo pattern**: `request-workflow-reader.ts` already sorts entries: `const sortedEntries = [...entries].sort(...)` before iterating -- this is the established pattern
- **Scope**: best-fit -- `files.sort()` before return
- **Philosophy fit**: violates 'Determinism over cleverness'; fix restores it

**Evidence**: `src/application/use-cases/raw-workflow-file-scanner.ts` line 37-39:
```ts
  await scan(baseDirReal);
  return files;  // no sort -- order is readdir order (OS-dependent)
}
```
vs `request-workflow-reader.ts` line 233:
```ts
const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
```

---

## Comparison and Recommendation

| Issue | Severity | Category | Fix complexity |
|---|---|---|---|
| A: inspect_workflow unguarded | High | Robustness | Low (wrap in RA.fromPromise) |
| B: phantom cache comment | Medium | Maintenance hazard | Trivial (comment update) |
| C: statSync blocks event loop | Medium-high | Performance/correctness | Low (await fs.stat) |
| D: sequential scan | Medium | Performance | Medium (Promise.all + sort) |
| E: non-deterministic output | Low-medium | Correctness | Trivial (files.sort()) |

All 5 are real, actionable, and distinct from the known 7.

Fix priority: A first (crash exposure), then C (event-loop blocking), then D+E together
(parallelization + sort are coupled), then B (editorial).

---

## Self-Critique

**Strongest counter-argument against including all 5:**
- Issue D and Issue E are both about `findWorkflowJsonFiles`, and the design doc (Item 1) already
  covers them implicitly. But the known 7 issues don't name them explicitly -- they focus on the
  walk in `request-workflow-reader.ts`. They belong in the new list.
- Issue B (phantom cache comment) is 'just a comment' -- but it actively misrepresents the code
  state, which is a maintenance correctness issue, not cosmetic.

**Pivot conditions:**
- If known issue #1 is interpreted to cover 'all call sites of createWorkflowReaderForRequest',
  then Issue A would be a sub-item of #1, not a new issue. The known list's wording names only
  `handleV2ListWorkflows` specifically.
- If `findWorkflowJsonFiles` is not included in the perf fix scope, Issues D and E drop out.
  But the design doc explicitly targets this function (Item 1).

---

## Open Questions

1. Should Issue A be fixed as part of the existing issue #1 ticket, or as a separate item?
2. Is `existsSync` at line 2 of raw-workflow-file-scanner.ts also used synchronously? (It is
   imported but the actual uses should be audited -- it may introduce the same event-loop concern.)
