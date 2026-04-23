# IDE Context Files -- Design Review Findings

**Reviewing:** Candidate 3 (discriminated union + glob expansion + frontmatter stripping)
**Status:** Review complete. No blockers.

---

## Tradeoff Review

| Tradeoff | Verdict | Condition that invalidates it |
|---|---|---|
| `loadWorkspaceContext()` complexity grows | Acceptable | If function grows beyond ~100 lines, extract `expandGlobEntry()` helper |
| Type change `string[]` → `WorkspaceContextCandidate[]` | Safe | If constant is ever exported (currently unexported -- keep it that way) |
| `.cursorrules` + `.cursor/rules/*.mdc` may duplicate content | Acceptable | Priority order (glob first) naturally reduces duplication |

No tradeoffs violate acceptance criteria under realistic conditions.

---

## Failure Mode Review

| Failure Mode | Severity | Mitigation | Status |
|---|---|---|---|
| Glob returns many files (I/O cost + budget waste) | Medium | Add `MAX_GLOB_FILES_PER_PATTERN = 20` cap | Required -- add to implementation |
| `alwaysApply: false` rules injected unconditionally | Low-medium | None (Phase 1 known limitation) | Deferred to follow-up issue |
| Malformed frontmatter causes incorrect stripping | N/A (handled) | `startsWith('---\n')` guard + missing-delimiter guard | Fully handled by design |
| tinyglobby returns absolute paths | N/A (verified) | Empirically confirmed: returns relative paths | Not a risk |
| Glob traversal outside workspace | N/A | `cwd` option sandboxes to workspace | Not a risk |

**Highest-risk failure mode:** Many files per glob. **Mitigation required before shipping.**

---

## Runner-Up / Simpler Alternative Review

**Candidate 2 (runner-up)** contributed one element worth incorporating:
- Call `stripFrontmatter()` unconditionally on all files (not just those with `stripFrontmatter: true`). The function is a safe no-op for plain markdown files. This defends against unexpected frontmatter in any file while the `stripFrontmatter: boolean` field on the type documents which files are EXPECTED to have frontmatter.

**Simpler alternative considered:**
- Remove `sort: 'alpha'` field (rely on tinyglobby natural order). Rejected: filesystem-dependent order violates Determinism principle.

---

## Philosophy Alignment

8 of 9 applicable principles satisfied. 1 needs attention:

- **NEEDS ATTENTION:** "Document why not what" -- WHY comments needed on: (a) `WorkspaceContextCandidate` type definition, (b) `MAX_GLOB_FILES_PER_PATTERN`, (c) priority order for each entry in the array.
- **Minor tension:** YAGNI vs. discriminated union expressivity. Clearly acceptable -- glob paths are empirically confirmed, not speculative.

---

## Findings

### Yellow -- Documentation required

**Y1:** The `WorkspaceContextCandidate` type, `MAX_GLOB_FILES_PER_PATTERN` constant, and the priority order in `WORKSPACE_CONTEXT_CANDIDATE_PATHS` all need WHY comments explaining:
- Why `.cursor/rules/*.mdc` appears before `.cursorrules` (glob before legacy fallback)
- Why the 20-file cap exists
- Why frontmatter stripping is called unconditionally
- Source for each tool's file convention (URL or "empirical" note)

**Y2:** The `alwaysApply: false` limitation should be commented on the `GlobCandidatePath` type with a reference to the follow-up issue.

---

## Recommended Revisions

1. **Add `MAX_GLOB_FILES_PER_PATTERN = 20` constant.** Cap the number of files processed per glob entry to prevent I/O cost and context budget waste in large directories. Log a warning if the cap is hit.

2. **Call `stripFrontmatter()` unconditionally.** Apply to all files, not conditionally on the `stripFrontmatter` flag. The flag documents expected format; the implementation is unconditionally defensive.

3. **Add WHY comments** on the type definition, the constant, and each entry in the array.

4. **Create a follow-up GitHub issue** for `alwaysApply: false` frontmatter filtering (Phase 2 enhancement).

---

## Residual Concerns

1. **`alwaysApply: false` rules:** Path-scoped Cursor rules (e.g., `frontend/*.mdc`) will inject into every WorkTrain session regardless of which files are being worked on. This is redundant context but not incorrect. Acceptable for Phase 1.

2. **Cursor official docs inaccessible:** The `.cursor/rules/*.mdc` format was confirmed empirically (filesystem inspection of zillow-android-2) but not from official Cursor documentation (their docs site is a JavaScript SPA). If Cursor changes the format or path in a future release, the design doc will not catch it through re-research. Mitigation: note the empirical source explicitly in the design doc.

3. **`CLAUDE.local.md` not yet validated locally:** No `CLAUDE.local.md` files were found in the local filesystem scan. The path is added based on official Claude Code documentation. Low risk.
