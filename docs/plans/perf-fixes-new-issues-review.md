# Performance Fixes: New Issues Review Findings

**Date:** 2026-04-07
**Input:** `perf-fixes-new-issues-candidates.md`

---

## Tradeoff Review

| Tradeoff | Verdict | Condition under which it fails |
|---|---|---|
| Issue E (non-deterministic order) is low severity today | Acceptable | Becomes medium once Issue D (parallelization) is implemented -- the two are coupled |
| Issue D overlaps with design doc Item 1 | Acceptable | The design doc and the known-7 issue list are separate artifacts; Item 1 is not in the known list |

No tradeoffs fail under review.

---

## Failure Mode Review

| Failure Mode | Coverage | Highest Risk |
|---|---|---|
| Issue A: unhandled throw in inspect_workflow | No mitigation until fixed | YES -- production crash surface |
| Issue C: event-loop stall on statSync | No mitigation until fixed | Medium-high under concurrent load |
| Issue E: latent ordering bug after parallelization | No mitigation until fixed | Low today, medium once Issue D is fixed |

**Highest-risk failure mode:** Issue A -- the only one that causes a production runtime crash
(unhandled exception reaching the MCP transport layer).

---

## Runner-Up / Simpler Alternative Review

No runner-up -- this is issue discovery, not competing design options. All 5 issues are distinct
and minimal. No issue can be dropped without leaving a real defect or maintenance hazard.

Issues D and E are coupled (parallelization without sorting makes non-determinism worse) and should
be fixed together.

---

## Philosophy Alignment

| Principle | Issue | Status |
|---|---|---|
| Errors are data | A: bare await in inspect_workflow | Violated -- throw not a data value |
| Determinism over cleverness | E: unsorted file list | Violated -- same input, different output |
| Document why not what | B: phantom cache comment | Violated -- describes nonexistent feature |
| Async contract (no sync I/O in async) | C: statSync | Violated -- blocks event loop |
| Functional/declarative | D: sequential for-of await | Tension -- sequential where fan-out is idiomatic |

All violations are in the unfixed code. The issue list accurately names them.

---

## Findings

### Red

**Issue A: `handleV2InspectWorkflow` has an unguarded bare `await createWorkflowReaderForRequest(...)`**
- `v2-workflow.ts` line 332: same unhandled-throw exposure as known issue #1 at line 193
- `start.ts` line 364 is the correct reference: `RA.fromPromise(createWorkflowReaderForRequest(...), mapper)`
- A `listRememberedRoots` error propagates as an unhandled exception to the MCP transport layer
- Severity: production crash surface -- same as known issue #1, and equally urgent

### Orange

**Issue C: `statSync` at `raw-workflow-file-scanner.ts:95` blocks the Node.js event loop**
- Synchronous I/O inside an async function; the `'fs'` sync import at line 2 is the entry point
- Blocks all in-flight concurrent MCP requests during the stat call
- Fix: `await fs.stat(filePath)` using the already-imported `fs/promises`
- Secondary: audit `existsSync` (also imported from `'fs'` at line 2) for similar usage

### Yellow

**Issue D: Sequential `await scan(fullPath)` in `findWorkflowJsonFiles` (raw-workflow-file-scanner.ts:19-35)**
- Each subdirectory is fully scanned before the next starts
- Design doc (perf-fixes-design-candidates.md, Item 1) specifies `Promise.all` fan-out
- Not named in any of the known 7 issues; it is a distinct item in a different file
- Coupled with Issue E: must add `files.sort()` when parallelizing

**Issue E: `findWorkflowJsonFiles` returns files in non-deterministic OS-dependent order**
- `raw-workflow-file-scanner.ts:38`: `return files` without a preceding `files.sort()`
- `FileWorkflowStorage` and `scanRawWorkflowFiles` both consume this output
- Low risk today; escalates to medium the moment Issue D is fixed
- Fix is one line: `files.sort()` before `return files`

**Issue B: Test comment describes a walk cache that does not exist**
- `perf-fixes.test.ts` lines 17-18: 'module-level walk cache (keyed on sorted root paths)'
- No such cache exists in `request-workflow-reader.ts`
- Future implementer reading the test might skip writing cache tests, believing they already exist
- Fix: replace the phantom description with the actual reason (unique temp dirs prevent cross-test pollution)

---

## Recommended Revisions to the Candidates Document

1. Elevate Issue A to the same urgency as known issue #1 -- they are identical in failure mode
2. Add note to Issue C to audit `existsSync` usage (same file, same import line)
3. Note that Issues D and E must be implemented together -- fixing D without E makes ordering worse

---

## Residual Concerns

- **Issue A severity**: if the MCP transport layer already catches unhandled promise rejections
  from handler functions and converts them to error responses, Issue A is mitigated at the
  framework level. This should be verified before treating it as a crash vs. a degraded-response.
- **Issue E completeness**: `FileWorkflowStorage.buildWorkflowIndex` also calls
  `findWorkflowJsonFiles` -- order dependency there should be checked before declaring the fix safe.
