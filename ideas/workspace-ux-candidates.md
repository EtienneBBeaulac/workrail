# Design Candidates: Workspace UX Rethink

*Raw investigative material. Not a final decision.*

---

## Problem Understanding

### Core tensions

1. **Branch-as-unit vs repo-as-context.** Data model is correct (branch = work unit).
   Presentation should use repo as the organizational frame. Currently inverted.

2. **Multi-repo visibility vs single-repo simplicity.** Repo sections are valuable for
   2+ repos and noise for 1 repo. Must be data-driven conditional.

3. **Dense scanning vs rich context.** FeaturedCards are rich but tall. Compact rows
   are dense but lose the recap. Middle ground: compact rows with optional one-line
   recap subtitle.

4. **Priority visibility vs flat simplicity.** Active/Recent gave priority via section
   placement. Removing it requires sort order within sections to carry that signal.

### Real seam

Rendering layer only: `WorkspaceSection` + `FeaturedCard`/`CompactRow` + `sectionFor()`
in workspace-types.ts. The join data model (`WorkspaceItem`) is correct and unchanged.

### What makes it hard

The current design was built to a spec. Changing it means changing the spec. The
`multiRepo = true` hardcoded bool is a code smell -- repo-conditional rendering must
be data-driven.

---

## Philosophy Constraints

- **Architectural fix over patch**: making the badge bigger is a patch; repo sections
  is the architectural fix (correct axis)
- **Make illegal states unrepresentable**: `multiRepo = true` hardcoded is illegal --
  must be `repos.length > 1`
- **YAGNI**: no strip, no extra components for problems that sort order already solves
- **Compose with small pure functions**: `sectionFor()` can be replaced by `sortPriority()`

---

## Impact Surface

- `workspace-types.ts`: `sectionFor()` and `sortWorkspaceItems()` need updating
- `WorkspaceView.tsx`: `WorkspaceSection`, `FeaturedCard`, `CompactRow`, `WorkspaceEmptyActive`
- `App.tsx`: no changes needed
- `console/src/api/types.ts`: no changes needed

---

## Candidates

### A -- Minimal patch: fix badge visibility + dormant + multiRepo

Make repo badge `text-xs` with stronger contrast, move it above branch name, fix
`multiRepo = true` to `repos.length > 1`, move dormant to lower sort priority.

- **Tensions resolved**: repo visibility (partially), dormant false urgency
- **Tensions accepted**: no repo grouping, Active/Recent overhead remains
- **Failure mode**: multi-repo scanning still requires scanning each row for the badge
- **Repo pattern**: follows (adapts existing FeaturedCard/CompactRow)
- **Gain/Lose**: zero structural risk / doesn't fix the mental model mismatch
- **Scope**: too narrow
- **Philosophy**: YAGNI satisfied; 'architectural fix over patch' violated

---

### B -- Repo sections, compact rows (RECOMMENDED)

Replace Active/Recent split with repo-grouped sections. Header shown only when 2+
repos. All branches are compact rows sorted by status then activityMs within each
section. FeaturedCards removed. Expand-on-click for detail.

```
workrail                           [● 2 active · 3 uncommitted]
──────────────────────────────────────────────────────────────
  ● feature/auth-refactor    coding-task    5m ago   [3 uncommitted]
  ● feature/dashboard-v2     mr-review      2h ago
  ! feature/old-blocked      bug-inv        1d ago
    feature/old-thing                       3d ago

zillow-android-2                   [● 1 active]
──────────────────────────────────────────────────────────────
  ● feature/acei-1591        coding-task    1h ago   [5 uncommitted]
```

Sort within section: in_progress (●) > blocked (!) > uncommitted > recently active.
Dormant gets the same dot as complete -- it is NOT active, it is stale.

- **Tensions resolved**: all four (repo visibility, single-repo overhead, dormant,
  Active/Recent structural issues)
- **Tensions accepted**: recap not shown inline (expand required)
- **Failure mode**: repo with 20 branches = very long section; mitigate with 'show N
  older branches' collapse
- **Repo pattern**: adapts RepoSection from WorktreeList.tsx (already has repo-as-header)
- **Gain/Lose**: mental model match, YAGNI, zero single-repo overhead / recap requires expand
- **Scope**: best-fit
- **Philosophy**: architectural fix ✓, YAGNI ✓, make illegal states unrepresentable ✓

---

### C -- Narrow in-progress strip + repo sections

Compact strip at top showing only truly in_progress sessions. Below it, repo sections
as in B.

- **Tensions resolved**: same as B + 'what's running now' immediately visible
- **Tensions accepted**: strip adds height when empty or single-repo; in_progress
  branches appear twice (strip + section row)
- **Failure mode**: duplicate display is confusing; strip is often empty
- **Scope**: slightly too broad (sort order already handles priority)
- **Philosophy**: YAGNI tension (strip adds complexity sort covers)

---

### D -- Flat list, repo as row label (reframe)

Drop all sections. Single sorted list: in_progress > blocked > uncommitted > recent.
Repo shown as a text label on each row (not a badge).

- **Tensions resolved**: simplest structure, dormant fixed, in_progress floats to top
- **Tensions accepted**: no spatial grouping by repo
- **Failure mode**: 10 branches across 3 repos harder to scan than 3 short sections
- **Repo pattern**: departs (no precedent in codebase or comparable tools)
- **Scope**: best-fit for simplicity, too narrow for multi-repo UX

---

## Comparison and Recommendation

**Selected: B**

B is the only candidate that fixes all four problems without adding new overhead:
1. Repo visibility: section header (not a tiny badge)
2. Single-repo overhead: zero (conditional on 2+ repos)
3. Dormant false urgency: sort priority -- dormant sorts with complete, not in_progress
4. Active/Recent structural issues: eliminated entirely

Adapts the existing `RepoSection` pattern from `WorktreeList.tsx`. Strong precedent
in GitHub, VS Code, GitKraken. Philosophy-aligned (architectural fix, YAGNI, data-driven).

**Runner-up: A** -- if structural change is too risky and users are predominantly
single-repo.

---

## Self-Critique

**Strongest case against B:** Recap is no longer shown inline. Users lose the
'what was the agent doing?' at-a-glance signal. Mitigation: add a one-line recap
subtitle to the compact row (single line, muted, truncated to ~100 chars).

**What invalidates B:** If users are predominantly single-repo AND value the
Active/Recent distinction. In that case B mostly removes two section headers.

**Pivot condition:** If users report missing recap inline, add one-line subtitle
to compact rows. Additive, not a redesign.

---

## Open Questions for the Main Agent

1. Should the row show a one-line recap subtitle, or is branch name + status + time
   + git badges enough?
2. Should `dormant` get a visually distinct dot (e.g., hollow) vs in_progress (filled)?
3. Should the repo section header be clickable (collapse/expand the section)?
4. What's the collapse threshold for long sections? 5 branches? 8? User-configurable?
5. Should there be an inline search bar at the top of the Workspace (replacing the
   archive navigation)?
