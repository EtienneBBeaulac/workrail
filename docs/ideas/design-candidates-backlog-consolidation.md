# Design Candidates: Backlog Consolidation from docs/coordinator-and-scripts-spec

## Problem Understanding

**What we're doing:** Five sections exist on `origin/docs/coordinator-and-scripts-spec` that never made it to main. They need to be inserted into `docs/ideas/backlog.md` at the correct chronological position.

**Missing sections (branch lines 1776-2088):**
1. `### Scripts-first coordinator: avoid the main agent wherever possible (Apr 15, 2026)`
2. `### Full development pipeline: coordinator scripts drive multi-phase autonomous work (Apr 15, 2026)`
3. `### Additional coordinator pipeline templates (Apr 15, 2026)` -- includes Backlog grooming, Bug investigation, Incident monitoring coordinators
4. `### Interactive ideation: WorkTrain as a thinking partner with full project context (Apr 15, 2026)`
5. `### Automatic gap and improvement detection: proactive WorkTrain (Apr 15, 2026)`

**Core tensions:**
- **Insertion order:** Must place content chronologically (Apr 15, before Dynamic model selection which is also Apr 15) -- wrong order scrambles the narrative flow
- **Separator hygiene:** The `---` separator at main line 1781 already separates the preceding Verification section from Dynamic model selection -- inserting content before Dynamic model selection means the separator now separates the new content from Dynamic model selection, which is correct

**What makes it hard:** Nothing technically hard. The only risk is a doubled or missing `---` at the insertion boundary.

**Likely seam:** Main line 1782, immediately before `### Dynamic model selection: right model for the right task (Apr 15, 2026)`.

---

## Philosophy Constraints

From `/Users/etienneb/CLAUDE.md`:
- **NEVER push directly to main** -- create a feature branch, open a PR (no exceptions)
- Commit format: `docs(backlog): <subject>`, max 72 chars, no period
- **Surface information, don't hide it** -- flag the push-to-main conflict explicitly

No philosophy conflicts affect the content insertion itself.

---

## Impact Surface

- `docs/ideas/backlog.md` only
- No code, no tests, no consumers of this file in the build system
- Readers of the backlog will gain five new sections; no existing content changes

---

## Candidates

### Candidate A: Verbatim extract and insert at chronological position (ONLY CANDIDATE)

**Summary:** Extract branch lines 1776-2088 verbatim and insert them immediately before `### Dynamic model selection` (main line 1782). The existing `---` at main line 1781 serves as the final separator -- no extra separator needed.

- **Tensions resolved:** Insertion order correct (Apr 15 chronological flow), separator hygiene maintained
- **Tensions accepted:** None
- **Boundary:** `docs/ideas/backlog.md`, single edit
- **Failure mode:** Doubled `---` if the branch content ends with one -- must verify (it does NOT end with `---`, so no risk)
- **Repo pattern:** Follows -- identical to how all recent backlog sections were added
- **Gains:** Complete, clean consolidation of all five missing sections
- **Losses:** Nothing
- **Scope:** Best-fit
- **Philosophy:** Honors 'surface information', 'document why not what'

**Why no other candidates exist:** This is pure text insertion into a markdown file. The insertion point is unambiguous. There are no architectural tradeoffs. Manufacturing alternative candidates would be dishonest.

---

## Comparison and Recommendation

**Recommendation:** Candidate A.

All analysis converges. The task is content consolidation with a single correct insertion point. Execute verbatim extract + insert.

---

## Self-Critique

**Strongest counter-argument:** These sections might have been intentionally left off main -- rejected or superseded by later content.

**Evidence against that:** No commit on main removes or contradicts these sections. The branch simply became stale when main moved on. The content is high-quality and self-consistent with the surrounding backlog.

**Narrower option:** Insert only the two sections mentioned in the task spec (Full dev pipeline + Backlog grooming coordinator). This would leave Scripts-first coordinator (the conceptual foundation for the other sections), Interactive ideation, and Automatic gap detection on the stale branch. All five are from the same commit block on the branch, all absent from main -- no reason to leave any out.

**Invalidating assumption:** If any of these headings appear on main under a slightly different title. Already verified with grep -- none present.

---

## Open Questions for the Main Agent

1. None -- execution path is clear. Insert branch lines 1776-2088 before main line 1782, create a feature branch, commit, open PR.
