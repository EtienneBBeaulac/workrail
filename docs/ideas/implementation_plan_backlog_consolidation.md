# Implementation Plan: Backlog Consolidation from docs/coordinator-and-scripts-spec

## 1. Problem Statement

Five sections were added to `origin/docs/coordinator-and-scripts-spec` (branch commit `ed9c9aaa`) and never merged to main. Main has since grown to 5330 lines with other content. The branch is stale (2088 lines total) and cannot be merged directly. The missing sections must be inserted at the correct chronological position in main's `docs/ideas/backlog.md`.

**Missing sections:**
1. `### Scripts-first coordinator: avoid the main agent wherever possible (Apr 15, 2026)` (branch lines 1776-1821)
2. `### Full development pipeline: coordinator scripts drive multi-phase autonomous work (Apr 15, 2026)` (branch lines 1822-1922)
3. `### Additional coordinator pipeline templates (Apr 15, 2026)` with subsections: Backlog grooming coordinator, Bug investigation + fix coordinator, Incident monitoring coordinator (branch lines 1923-2028)
4. `### Interactive ideation: WorkTrain as a thinking partner with full project context (Apr 15, 2026)` (branch lines 2029-2056)
5. `### Automatic gap and improvement detection: proactive WorkTrain (Apr 15, 2026)` (branch lines 2057-2088)

## 2. Acceptance Criteria

- All five section headings are present in `docs/ideas/backlog.md` on main after the change
- Line count of `docs/ideas/backlog.md` >= 5640 (5330 + ~313 inserted lines)
- The sections appear between the Verification/Proof records section and `### Dynamic model selection`
- No existing content on main is removed or altered
- No doubled `---` separator at the insertion boundary

## 3. Non-Goals

- Modifying any code files
- Processing `docs/apr-17-18-backlog-updates` branch (user confirmed fully subsumed)
- Deduplicating conceptually overlapping content (the backlog is a running log, not a deduplicated spec)
- Changing any existing section in `docs/ideas/backlog.md`

## 4. Philosophy-Driven Constraints

- **NEVER push directly to main** -- create feature branch `docs/consolidate-coordinator-specs`, commit there, open PR
- Commit message: `docs(backlog): consolidate missing coordinator specs from stale branch` (72 chars, no period)
- No em-dashes in commit message or any new written content

## 5. Invariants

- Insertion order: new content appears before `### Dynamic model selection: right model for the right task (Apr 15, 2026)` and after the `---` separator at current main line 1781
- No `---` separator is added to the start or end of the inserted block (main line 1781 already serves as the boundary separator)
- All five sections are inserted as a single contiguous block (they form a cohesive unit from a single branch commit)

## 6. Selected Approach + Rationale + Runner-Up

**Selected:** Use the Edit tool to insert the extracted block (branch lines 1776-2088) immediately before `### Dynamic model selection: right model for the right task (Apr 15, 2026)` in main's backlog. The `old_string` is the exact heading line; `new_string` is the inserted content followed by the heading.

**Rationale:** Only one file to edit. The insertion point is unambiguous and verified. Text insertion is correct because the branch file is a strict subset of main -- a git cherry-pick would regress the file.

**Runner-Up:** Insert only the two explicitly requested sections (Full dev pipeline + Backlog grooming coordinator). Lost because all five form a cohesive single-commit block; leaving three out is arbitrary.

## 7. Vertical Slices

### Slice 1: Create feature branch
- `git checkout -b docs/consolidate-coordinator-specs`
- Acceptance: branch exists, HEAD is at latest main commit

### Slice 2: Insert missing sections
- Edit `docs/ideas/backlog.md`: insert branch lines 1776-2088 before `### Dynamic model selection`
- Acceptance: all five headings present in file, line count >= 5640, no doubled `---`

### Slice 3: Commit
- `git add docs/ideas/backlog.md`
- `git commit -m "docs(backlog): consolidate missing coordinator specs from stale branch"`
- Acceptance: clean commit with only `docs/ideas/backlog.md` changed

### Slice 4: Push and open PR
- `git push -u origin docs/consolidate-coordinator-specs`
- `gh pr create` with appropriate title and body
- Acceptance: PR URL returned, PR is open, targets main

## 8. Test Design

**Post-edit verification:**
```bash
wc -l docs/ideas/backlog.md  # should be >= 5640
grep -c "Scripts-first coordinator" docs/ideas/backlog.md  # should be 1
grep -c "Full development pipeline: coordinator scripts drive" docs/ideas/backlog.md  # should be 1
grep -c "Additional coordinator pipeline templates" docs/ideas/backlog.md  # should be 1
grep -c "Interactive ideation: WorkTrain as a thinking partner" docs/ideas/backlog.md  # should be 1
grep -c "Automatic gap and improvement detection" docs/ideas/backlog.md  # should be 1
```

**Separator check:**
```bash
grep -n "^---" docs/ideas/backlog.md | grep -A1 -B1 "178[0-2]"  # verify no doubled separator
```

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Doubled `---` at boundary | Low | Low (visual) | Branch block verified not to start/end with `---` |
| Content duplication | None | Medium | All five headings confirmed absent from main via grep |
| Wrong insertion point | None | Medium | Main line 1782 verified as `### Dynamic model selection` |

## 10. PR Packaging Strategy

Single PR: `docs/consolidate-coordinator-specs` -> `main`
- Title: `docs(backlog): consolidate missing coordinator specs from stale branch`
- All five sections in one commit, one PR

## 11. Philosophy Alignment Per Slice

| Slice | Principle | Status |
|-------|-----------|--------|
| Create branch | NEVER push to main | Satisfied -- feature branch created |
| Insert sections | Surface information | Satisfied -- all missing content recovered |
| Commit | Commit format `docs(backlog):` | Satisfied |
| PR | NEVER push to main | Satisfied -- PR, not direct push |

---

- `implementationPlan`: complete
- `slices`: 4
- `testDesign`: grep-based line count + heading presence checks
- `estimatedPRCount`: 1
- `followUpTickets`: none
- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
