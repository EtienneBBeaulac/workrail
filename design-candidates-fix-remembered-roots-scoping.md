# Design Candidates: Fix Remembered-Roots Scoping

## Problem Understanding

### Tensions

1. **Scoping vs. completeness**: Filtering to ancestors-only eliminates cross-repo bleed but removes the accidental (incorrect) behavior of seeing other projects' workflows. The spec calls cross-repo bleed incorrect.

2. **Cache key stability**: Filtering before `discoverRootedWorkflowDirectories` means different workspacePaths produce different cache keys. This is correct -- two unrelated workspaces should not share discovery results.

3. **Stale path reporting**: Roots dropped by the filter are silently omitted (not reported as stale). Correct behavior -- they are out of scope, not missing.

### Likely Seam

`createWorkflowReaderForRequest` at line 223 in `src/mcp/handlers/shared/request-workflow-reader.ts`. This is the per-request composition point where workspace context is available alongside remembered roots. The fix belongs here, not inside the discovery function or the data accessor.

### What Makes It Hard

Existing tests use sibling fixture layout (`tempRoot/workspace` and `tempRoot/repo`) to test discovery. After the fix, sibling roots are filtered out, so tests will fail. All affected tests need fixture updates to put the workspace inside the remembered root.

## Philosophy Constraints

Source: `/Users/etienneb/CLAUDE.md`

- **Validate at boundaries, trust inside**: filter at the boundary where roots enter discovery
- **Immutability by default**: filter creates a new array, does not mutate
- **Determinism**: same workspacePath always produces the same filtered root set
- **Compose with small, pure functions**: filter should be a pure function of (root, workspace), not mixed into helpers

No conflicts between stated philosophy and repo patterns.

## Impact Surface

- Walk cache: smaller root set = different cache key = fresh walk first call per workspace. Correct.
- `rootedCustomPaths` dedup (line 241): unaffected.
- `stalePaths` (line 239): filtered-out roots are not reported as stale. Correct.
- `manage_workflow_source` / `managedSourceStore` path: entirely separate, unaffected.
- `discoverRootedWorkflowDirectories`: exported function signature unchanged.
- Test fixtures: 4 existing tests need fixture layout updates.

## Candidates

### Candidate A: Filter at call site in `createWorkflowReaderForRequest`

**Summary**: Insert a 4-line filter between `listRememberedRoots` and `discoverRootedWorkflowDirectories`. Keep only roots where `path.relative(root, resolvedWorkspace)` does not start with `..` and is not absolute.

**Tensions resolved**: Scoping (cross-repo bleed eliminated). Cache stability (naturally different keys per workspace).

**Tensions accepted**: Engineers relying on cross-repo bleed lose that capability. (Per spec, this is correct.)

**Boundary**: `createWorkflowReaderForRequest` -- the per-request composition point. Best fit because scoping is a request-level concern; the discovery function stays generic.

**Failure mode**: If `workspaceDirectory` resolves to a very high path like `/tmp` or `/`, too many remembered roots pass the filter. Degenerate case not worth special-casing.

**Repo-pattern relationship**: Follows -- the function already performs multiple path filtering/dedup operations (lines 241-302).

**Gains**: Minimal change (4 lines), pure, no new types, no signature changes.

**Losses**: Nothing material. No valid use case exists for cross-repo bleed.

**Scope judgment**: Best-fit.

**Philosophy fit**: Honors validate-at-boundaries, immutability, determinism, compose-with-small-pure-functions. No conflicts.

---

### Candidate B: Filter inside `listRememberedRoots` (pass workspace as parameter)

**Summary**: Change `listRememberedRoots(store)` to `listRememberedRoots(store, workspaceDirectory)` and apply the filter there.

**Tensions resolved**: Same as A.

**Tensions accepted**: Conflates data access with scoping policy.

**Boundary**: Private helper -- mixes concerns.

**Failure mode**: If a future caller needs all roots (e.g., pruning), the signature change requires a separate unfiltered variant.

**Repo-pattern relationship**: Departs -- `listRememberedRoots` currently only accesses the store and resolves paths.

**Gains**: Slightly cleaner call site.

**Losses**: Separation of concerns; future flexibility.

**Scope judgment**: Too broad (modifies the contract of a data accessor unnecessarily).

**Philosophy fit**: Conflicts with compose-with-small-pure-functions.

---

### Candidate C: Filter inside `discoverRootedWorkflowDirectories` (optional param)

**Summary**: Add optional `workspacePath?: string` to `discoverRootedWorkflowDirectories` and apply the filter there.

**Tensions resolved**: Same as A.

**Boundary**: Generic walk function -- wrong layer for scoping policy.

**Failure mode**: Pollutes the public API of an exported generic function; breaks direct test usage.

**Repo-pattern relationship**: Departs significantly.

**Scope judgment**: Too broad.

**Philosophy fit**: Conflicts with compose-with-small-pure-functions.

---

## Comparison and Recommendation

**Recommendation: Candidate A.**

All candidates converge on A. B and C depart from repo patterns and philosophy without adding value. The filter belongs at the request-level composition point in `createWorkflowReaderForRequest`, not in helpers.

A resolves all tensions at the right boundary, follows repo patterns, is pure and reversible, and requires no signature changes.

## Self-Critique

**Strongest counter-argument**: The filter silently drops unrelated roots with no diagnostic output. If an engineer is confused about why their other-repo workflows disappeared, there is no log message. A `WORKRAIL_DEV` debug log could help, but is optional.

**Narrower option**: None -- test fixtures MUST be updated because the current sibling layout tests the behavior that is being fixed.

**Broader option**: Add a `manage_workflow_source` affordance for explicit cross-workspace root sharing. Evidence required: user demand for cross-repo sharing. Not present.

**Invalidating assumption**: If `path.relative(root, workspace)` produces incorrect results on Windows or for symlinked paths, the fix could over-filter. Node's `path` module handles Windows correctly; symlinks are an accepted limitation.

## Open Questions

None -- all decisions are deterministic from the problem spec and repo patterns.
