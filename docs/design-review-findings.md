# Design Review Findings: raw-workflow-file-scanner.ts async and parallelism fixes

## Tradeoff Review

**Shared mutable `files` array** -- Acceptable. Node.js single-threaded event loop guarantees push safety. Would become unacceptable only if code migrated to Worker threads (not a realistic risk here).

**`.catch(() => {})` swallows all subdir errors, not just ENOENT** -- Acceptable per task spec. Task explicitly prescribes this pattern. EACCES could also be silently swallowed, but this is a transient file-system scanner in a dev tool, not a production storage system.

**Non-deterministic push order resolved by sort** -- Accepted and mitigated. `files.sort()` is lexicographic and stable. Callers confirmed to not depend on traversal order.

## Failure Mode Review

- **`.catch()` at wrong level** -- Highest-risk failure mode. Mitigated by explicit per-entry placement on `subDirs.map(d => scan(...).catch(() => {}))`. The task prescribes this pattern exactly.
- **Missing `files.sort()`** -- Easy to verify visually. No test enforces it but sort is cheap and the comment documents the invariant.
- **`await fs.stat` throwing unexpectedly** -- Handled by existing `try/catch` in `scanRawWorkflowFiles` converting to `unparseable` results.
- **Dead sync import remaining** -- TypeScript compiler enforces removal; zero residual risk.

## Runner-Up / Simpler Alternative Review

- **Candidate B (functional return)** -- No elements worth pulling in. Restructuring `scan()` to return arrays adds complexity for zero correctness gain.
- **Simpler variant (sequential loop, fix only statSync)** -- Does not satisfy acceptance criteria (parallelization required).
- **No hybrid is better than Candidate A as specified.**

## Philosophy Alignment

- **Satisfied:** Determinism, Functional/declarative, Errors-as-data, Document-why.
- **Under tension (acceptable):** Immutability (shared array, function-scoped, JS-safe), Pure functions (`scan()` mutates outer array -- existing pattern, not introduced by this change).

## Findings

**Yellow -- EACCES silently swallowed alongside ENOENT**
The `.catch(() => {})` pattern swallows all errors from subdir scans, not just ENOENT. For a dev-tool file scanner this is acceptable, but it is a broader suppression than the task description implies. No action required given task scope.

No Red or Orange findings.

## Recommended Revisions

None. The design as specified (Candidate A) is correct and complete.

## Residual Concerns

None. All failure modes are either handled by the design, enforced by the TypeScript compiler, or explicitly accepted per task specification.
