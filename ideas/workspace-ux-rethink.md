# Discovery: Workspace UX Rethink

## Context / Ask

The Workspace view was designed theoretically and is now built and visible.
First real-use observation: repo/project is nearly invisible -- a tiny muted
`text-[10px]` badge that's also `hidden sm:inline` on mobile. The user asked
if we need to step back and rethink the whole UX.

## Path Recommendation

`full_spectrum` -- concrete implementation to react to makes landscape grounding
easy; the mental model question (branch-as-unit vs repo-first) requires reframing.

## Constraints / Anti-goals

**Constraints:**
- Existing API data only (sessions + worktrees, no new endpoints)
- Must answer "what am I working on?" in <10 seconds
- Must degrade gracefully for single-repo users

**Anti-goals:**
- Don't add more information density (cards are already large)
- Don't require user configuration for a useful default
- Don't optimize for edge cases (10+ repos, 50+ branches)

## Landscape Packet

### What the current implementation actually renders

**FeaturedCard (Active section):**
Branch name (large, mono, flex-1) + repo badge (text-[10px], muted, always shown) +
timestamp. Then status dot + workflow name. Then recap (220 chars). Then git badges
(uncommitted, unpushed, gaps, health). Then session count + expand chevron.

**CompactRow (Recent section):**
Status dot + branch (flex-1) + repo badge (text-[10px], hidden on mobile) + git
badges (compact) + tip count + time + chevron.

**`const multiRepo = true` is hardcoded** (WorkspaceView.tsx line 463). The repo
badge always renders. Single-repo users see their repo name repeated in every row
as pure noise.

### What the current model gets wrong

**1. Repo is a badge, not a grouping axis.**
`item.repoName` is rendered at `text-[10px]` with `text-[var(--text-muted)]` and a
muted badge background -- the lowest contrast, smallest font used anywhere in the
view. Meanwhile `item.branch` gets `text-sm font-medium text-[var(--text-primary)]`.
The primary signals are inverted: branch name dominates, repo barely whispers.

Mental model mismatch: developers think "what am I doing in workrail? what about
zillow?" They think repo-first, branch-second. Every comparable tool reflects this:
- **GitHub branch list**: repo is the container
- **VS Code Source Control**: repo is the container, changes inside it
- **GitKraken Workspace**: multi-repo first-class, branches within each repo
- **Linear "My Issues"**: project/status grouping

**2. `dormant` in Active is misleading.**
`sectionFor()` treats `dormant` = `in_progress` (both priority 0). A session idle
for 3+ days gets a large FeaturedCard in the Active section, looking just as urgent
as something actively running. Active can be full of stale work.

**3. Active/Recent split creates structural overhead.**
- When Active is empty: `WorkspaceEmptyActive` renders a placeholder card that
  pushes Recent content down -- page starts with a "no active work" card
- In All scope: page shows "Active" section + "All branches" section -- mixed labels
  that are conceptually awkward
- The `sectionFor()` call happens twice per item per render (in sortWorkspaceItems
  AND in activeItems/recentItems split)

**4. Search requires navigation away.**
Clicking "All sessions →" navigates to a full SessionList, abandoning the Workspace
view. No inline search in the main view.

### What was lost vs. old tabs

**From SessionList:** full-text search, sort options (recent/status/workflow/nodes),
group by (workflow/status/branch), 6-option status filter, nodeCount, HealthBadge
on all rows.

**From WorktreeList:** worktree directory name, commit SHA, activeSessionCount per
branch, detached HEAD visibility, **repo as an explicit section header**.

### Fields available but unused
`ConsoleWorktreeSummary`: path, name (directory basename), headHash, activeSessionCount
`ConsoleSessionSummary`: nodeCount, edgeCount (lost from old tabs)

## Problem Frame Packet

### Primary users

1. **Single-repo developer** -- 3-5 branches, wants to scan what's in flight. Sees
   the repo name repeated in every row as noise. Gets no benefit from the repo badge.
2. **Multi-repo developer** -- 2-3 repos, 5-10 branches total, needs to know which
   repo each branch belongs to at a glance. Currently can barely see the repo name.

### Jobs to be done

| Job | Current friction |
|---|---|
| Ambient check: what's in flight? | Active section is cluttered with dormant sessions |
| Context recovery: where was I? | Branch name is primary but provides no project context |
| Multi-repo scan: what's happening in repo X? | Have to scan tiny muted badges |
| Find a specific session | Must navigate away to archive/search |
| Understand branch/repo relationship | Badge is nearly invisible |

### Core tension

**Branch-as-unit vs repo-as-context.** The data model is correct (one WorkspaceItem
per branch per repo), but the PRESENTATION assumes branch is primary and repo is
secondary metadata. Real developer mental models invert this.

### HMW questions

1. HMW make repo the organizing axis without creating overhead for single-repo users?
2. HMW reduce the Active section's false urgency from dormant sessions?
3. HMW keep compact/dense rows while making the repo relationship obvious?
4. HMW surface search/filter without navigating away from the Workspace view?

## Candidate Directions

### A -- Repo sections (recommended direction)

**Summary:** Remove Active/Recent split. Group all branches by repo. Each repo gets
a section header showing repo name + summary counts. Within each repo, branches
sorted by status/activity (in_progress first, then blocked, then uncommitted, then
recent). FeaturedCard layout simplified -- no giant recap, just branch + status + key
signal.

```
workrail                           [2 active · 3 uncommitted]
───────────────────────────────────
  ● feature/auth-refactor          coding-task · 5m ago      [3 uncommitted]
  ● feature/dashboard-v2           mr-review · 2h ago
  ✓ feature/old-thing                                         3d ago

zillow-android-2                   [1 active]
───────────────────────────────────
  ● feature/acei-1591              coding-task · 1h ago      [5 uncommitted]
```

- **Repo is the primary axis** (section header, prominent)
- **Branch is the item** within the repo context
- **No Active/Recent distinction** -- just sorted within each repo
- **Dormant is not promoted** to Active status
- **Single-repo users**: one section, no overhead (no redundant label)
- **Failure mode**: one repo with 20 branches is a very long section (mitigated by
  a "show N older branches" collapse)

---

### B -- Hybrid: urgent strip + repo sections

**Summary:** Keep a narrow "needs attention" strip at the top (in_progress only,
NOT dormant) showing 1-3 active sessions compactly. Below it, full repo section
layout as in A. The strip answers "what's running right now" without large cards.

```
● coding-task on feature/auth-refactor  [workrail]  5m ago
● mr-review on feature/acei-1591        [zillow]    1h ago
──────────────────────────────────────────────────────────

workrail                           [1 active · 3 uncommitted]
───────────────────────────────────
  ● feature/auth-refactor          ...
```

- **Running sessions are immediately visible** at top
- **Repo sections give full context below**
- **dormant is NOT in the strip** -- only truly in-progress
- **Failure mode**: strip adds cognitive overhead for single-repo users who can see
  the active branch in the repo section anyway

---

### C -- Status-first (linear model)

**Summary:** Remove repo sections. Group by status: Running (in_progress), Needs
attention (blocked/dormant), Has changes (uncommitted/unpushed, no session), Recent.
Repo is a badge (but larger and more visible).

- Closest to Linear's "My Issues" model
- **Failure mode**: multi-repo users still can't quickly answer "what's in workrail?"
  -- they have to scan status groups for their repo badge

---

### D -- Single sorted list + inline search

**Summary:** Drop all sections. One flat list sorted by activity. Repo as a visible
label (not a tiny badge -- actual text or a colored prefix). Prominent search input
inline.

- Simplest structure
- Search is the power tool
- **Failure mode**: no visual grouping means scanning is harder; cognitive load on the user

---

## Comparison

| Criterion | A (repo sections) | B (hybrid) | C (status-first) | D (flat+search) |
|---|---|---|---|---|
| Repo visibility | ✓ header | ✓ header | Badge (medium) | Label |
| Single-repo overhead | None | Strip adds height | None | None |
| Dormant false urgency | Resolved | Resolved | Resolved | Resolved |
| Search | Archive link | Archive link | Archive link | Inline |
| Mental model match | ✓ repo-first | ✓ repo-first | Status-first | None |
| Simplicity | High | Medium | Medium | Highest |
| Precedent | GitHub, VS Code, GitKraken | GitHub Projects | Linear | None strong |

**Recommendation: A** -- Repo sections. Matches the dominant mental model, resolves
all three core problems (repo visibility, dormant false urgency, Active/Recent
overhead), has strong precedent, and creates no overhead for single-repo users.

**Runner-up: B** -- If the user wants an "at a glance what's running RIGHT NOW" strip
without scanning the sections.

## Challenge Notes

**Strongest case against A:** Destroys the Active/Recent distinction that was designed
for ambient awareness. A developer with 15 branches in one repo now has one massive
section with no priority ordering within it -- except that sorting within the repo
(in_progress first) provides exactly that priority ordering, just without the section header.

**What would tip toward B:** If the "what's running now" job is primary and scanning
the repo section to find the in_progress row is too slow.

**What would tip toward C:** If users are status-oriented and repo context is genuinely
secondary (unlikely for a multi-repo dev tool).

## Resolution Notes

(to be filled after challenge phase)

## Decision Log

(to be filled)

## Final Summary

(to be filled)

## Decision Log

### Winner: B -- Repo sections, compact rows

**Why B beats A (minimal patch):** A treats the symptom (badge too small) without fixing the cause (wrong primary axis). Multi-repo users still scan rows for repo context after A. B fixes the root cause: repo becomes the organizing frame, not a per-row badge.

**Why B beats C (strip + sections):** The in_progress strip duplicates entries and adds height when empty. Sort order within sections gives the same priority signal without duplication.

**Why B beats D (flat + label):** No spatial organization for multi-repo. All comparable tools (GitHub, VS Code, GitKraken) use repo-as-container.

**Runner-up: A** -- safe if structural change is too risky or single-repo is confirmed dominant.

**B+ hybrid on the table:** One FeaturedCard per section for the most recent in_progress session, rest compact. Natural evolution if recap subtitle alone is insufficient. Not required for initial implementation.

## Final Summary

### Recommendation: B (Repo sections, compact rows) -- confidence High

**What changes:**
- Remove `Active` and `Recent` section labels + `WorkspaceSection` two-section model
- Replace with repo-grouped sections (`RepoSection` per repo, header conditional on 2+ repos)
- All branches are compact rows within each section
- Sort within section: `in_progress` > `blocked` > `dormant` (distinct dot) > uncommitted > recently active > old
- Remove `FeaturedCard` component
- **Mandatory**: add one-line `recapSnippet` subtitle to compact rows (truncated, muted)
- **Mandatory**: `dormant` gets distinct hollow/warning dot and its own sort tier
- Fix `const multiRepo = true` → `repos.length > 1`
- Section collapse at 7 visible rows + 'show N more'

**What stays:**
- `WorkspaceItem` type and `joinSessionsAndWorktrees()` -- unchanged
- Scope toggle (Active/All) -- can be kept or dropped (less critical with repo sections)
- Alert strip -- kept
- Keyboard navigation -- kept
- Archive links -- kept

**Row spec (compact row with subtitle):**
```
● feature/auth-refactor
  "Review the token validation logic before moving to the test phase..."
  coding-task  5m ago  [3 uncommitted]
```

**Repo section header spec:**
```
workrail                      [● 2 active · 3 uncommitted]
──────────────────────────────────────────────────────────
```

**Dormant visual state:** hollow ring dot (not filled), sorts between `blocked` and uncommitted.

**Residual risk:** If single-repo users are majority, the main wins are (1) recap subtitle visible, (2) dormant correctly positioned, (3) empty-state overhead gone. The repo section header adds no value for them but also no overhead (hidden for single repo).

**Pivot condition:** If users report missing the rich card view, ship B+ (one FeaturedCard per section for in_progress). Additive, not a redesign.
