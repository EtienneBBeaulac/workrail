# Design Candidates: raw-workflow-file-scanner.ts async and parallelism fixes

## Problem Understanding

**Tensions:**
- Async correctness vs simplicity: replacing `statSync` with `await fs.stat` is mechanical, but sits inside a `try/catch` in a `for...of` loop -- the placement is critical.
- Parallelism vs shared mutable state: `files` array is mutated concurrently across parallel `scan()` calls. Safe in JS (single-threaded event loop) but push order becomes non-deterministic -- requires an explicit `files.sort()` afterward.
- Error isolation vs propagation: ENOENT on an individual entry during parallel scan must be swallowed at entry granularity, not at the `Promise.all` level.

**Likely seam:** Line 95 (`statSync` call site) and lines 19-35 (sequential scan loop). These are exactly where the symptoms live.

**What makes it hard:** Nothing architecturally complex. Main risks are: (1) placing `.catch()` at `Promise.all` level instead of per-entry, (2) forgetting `files.sort()` after parallelization, (3) leaving the now-dead sync import.

## Philosophy Constraints

Relevant principles from AGENTS.md:
- **Determinism over cleverness** -- `files.sort()` after parallel scan is mandatory.
- **Functional/declarative over imperative** -- `Promise.all(subDirs.map(...))` replaces `for...of await`.
- **Errors are data** -- `.catch(() => {})` discards ENOENT at the correct granularity; parse errors are still captured as `unparseable` results upstream.
- **Document why, not what** -- the sort comment must explain that parallel I/O completion order is non-deterministic.

No conflicts between stated philosophy and repo patterns.

## Impact Surface

- `src/application/use-cases/raw-workflow-file-scanner.ts` -- only file changed.
- `src/application/use-cases/validate-workflow-registry.ts` -- caller of `findWorkflowJsonFiles`; receives sorted output (strictly better).
- `src/infrastructure/storage/file-workflow-storage.ts` -- caller of `findWorkflowJsonFiles`; same.
- `tests/unit/validate-workflow-registry.test.ts` -- exercises the scanner indirectly; no changes needed.

## Candidates

### Candidate A (recommended): Direct in-place edit

**Summary:** Remove sync import line, replace `statSync` with `await fs.stat`, rewrite `scan()` body to split entries into subdirs/json-files and use `Promise.all(subDirs.map(d => scan(...).catch(() => {})))`, add `files.sort()` with determinism comment.

**Tensions resolved:** Blocking event loop (statSync), serial I/O (sequential scan), non-deterministic output (sort), dead import.

**Boundary:** `findWorkflowJsonFiles` and the `statSync` call site -- exactly where the problems live.

**Failure mode:** Placing `.catch()` at `Promise.all` level instead of per-entry would swallow all errors if any single subdir fails.

**Repo pattern:** Follows existing use of `fs/promises` throughout the file. `Promise.all(arr.map())` is a standard async parallelization pattern.

**Gains:** Non-blocking, parallel, deterministic. **Losses:** None meaningful.

**Scope:** Best-fit. Minimum change for full correctness.

**Philosophy:** Honors Determinism, Functional/declarative, Errors-as-data, Document-why.

### Candidate B: Functional scan returning Promise\<string[]\>

**Summary:** Rewrite `scan()` to return `Promise<string[]>` and flatten results with `.flat()`, eliminating the shared mutable `files` array.

**Tensions resolved:** Shared mutable state (more philosophically pure).

**Failure mode:** Deeper refactor changes the function signature and increases churn for no correctness gain. JS is single-threaded so shared array push is already safe.

**Scope:** Too broad. No evidence the shared array has caused bugs.

### Candidate C: Wrap fs.stat in a Result helper

**Summary:** Add a `statAsync(filePath): Promise<Result<Stats, Error>>` helper that returns a Result instead of throwing.

**Tensions resolved:** More consistent with errors-as-data principle.

**Scope:** Too broad. The call site is already inside a `try/catch` that converts errors to `unparseable` results; adding a Result wrapper is over-engineering for a one-call site.

## Comparison and Recommendation

**Recommendation: Candidate A.** Candidates B and C are strictly additive scope -- they address real philosophy points but have no bearing on correctness or safety here. The task instructions prescribe exactly the Candidate A pattern.

## Self-Critique

**Strongest counter-argument:** Candidate B (functional return from scan) would eliminate the shared mutable array and be more philosophically pure. Counter: the array is confined to function scope, JS is single-threaded, and restructuring the return type adds churn for zero safety gain.

**Narrower option:** Only fix `statSync` -> `await fs.stat`, leave the loop sequential. Insufficient -- still has serial I/O issue and task requires parallelization.

**Pivot conditions:** If `existsSync` were used in the file, the import removal would need adjustment. Confirmed: it is not used.

## Open Questions for the Main Agent

None. The task is fully specified and the path is clear.
