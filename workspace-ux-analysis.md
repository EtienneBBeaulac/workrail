# Workspace Tab UX Analysis: Tensions and Assumptions

Deep analysis of the WorkRail console Workspace tab UX model. All line references are to the files as they exist in the repo.

---

## 1. Repo Visibility: Exactly How Broken Is It?

### FeaturedCard (`WorkspaceView.tsx` lines 487-491)

```tsx
<span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0">
  {item.repoName}
</span>
```

- Size: `text-[10px]` -- the smallest non-custom size in Tailwind, smaller than `text-xs` (12px)
- Color: `text-[var(--text-muted)]` -- the lowest-contrast text token in the design system
- Background: `bg-[var(--bg-tertiary)]` -- a badge that visually de-emphasizes its content
- Position: right side of the header row, after the branch name (`flex-1 truncate`) and before time
- Always shown: the constant `multiRepo = true` at line 463 hardcodes this -- the comment says "always show repo badge in featured cards"

**Key finding:** The badge exists and is always shown in FeaturedCard, but it is visually suppressed at every dimension -- smallest font, lowest contrast, background pill format that reads as metadata noise.

### CompactRow (`WorkspaceView.tsx` lines 628-631)

```tsx
<span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0 hidden sm:inline">
  {item.repoName}
</span>
```

- Same `text-[10px]` / `text-[var(--text-muted)]` / `bg-[var(--bg-tertiary)]` styling as FeaturedCard
- **Hidden on mobile**: `hidden sm:inline` -- on screens narrower than 640px (sm breakpoint), repo name disappears entirely
- No conditional: shown for every item regardless of whether the user has one repo or five

**Summary of repo name treatment:**
| Context | Shown? | Size | Contrast | Mobile |
|---------|--------|------|----------|--------|
| FeaturedCard | Always | 10px | Muted | Visible |
| CompactRow | Always | 10px | Muted | Hidden below 640px |
| Archive view (back nav) | Conditional | 14px (text-sm) | Muted | Visible |

The archive view (`line 291-293`) is the only place where repo name gets `text-sm` treatment, but only when `archive.repoName` is truthy -- and it's paired with `font-mono`, which reads it as a path rather than a label.

---

## 2. The Section Model: `sectionFor()` and Its Edge Cases

**`workspace-types.ts` lines 89-120**

Classification logic (in order of evaluation):

1. **Active** if `primarySession.status` is `in_progress`, `dormant`, or `blocked`
2. **Recent** if `worktree.changedCount > 0` OR `worktree.aheadCount > 0`
3. **Recent** if `nowMs - activityMs < THIRTY_DAYS_MS` (30 days)
4. If `scope === 'all'` return **Recent** (time-expired items become visible)
5. Else return **Hidden**

### Edge cases analyzed

**Branch with uncommitted changes but no sessions:**
Goes to **Recent** (step 2). The worktree exists, `changedCount > 0` fires before the session check is even reached. This is intentional and correct -- the worktree has local work even with no workflow history. `activityMs` is set to `wt.headTimestampMs` in `joinSessionsAndWorktrees()` line 262.

**Branch with only complete sessions from 25 days ago:**
- No in_progress/dormant/blocked -- not Active
- Worktree clean (assuming) -- step 2 doesn't fire
- 25 days < 30 days -- `isRecent = true` -- goes to **Recent**

**Branch with only complete sessions from 35 days ago (clean worktree):**
- No in_progress/dormant/blocked
- Worktree clean
- 35 days > 30 days -- `isRecent = false`
- In `active` scope: returns **Hidden** (omitted from the list entirely)
- In `all` scope: returns **Recent** (shown in the compact row section)

**Branch with dormant session and clean worktree:**
Goes to **Active** (step 1). `dormant` is treated identically to `in_progress` for section classification, even though dormant means idle-for-3-days. The user sees this in the FeaturedCard section -- it's treated as urgent even if nothing has happened for days.

**Branch with a worktree but no sessions at all:**
- `primarySession` is `undefined`
- Step 1 does not fire (`status === undefined`)
- If uncommitted/unpushed changes: **Recent**
- If clean but recently active (within 30 days based on `headTimestampMs`): **Recent**
- If clean and old: **Hidden** or **Recent** depending on scope

### Critical observation: dormant in Active is misleading

`dormant` is defined as a computed status (see `api/types.ts` line 6-8): it's not a run status, it's a projection computed from inactivity. A dormant session has been idle for 3+ days. But `sectionFor()` treats it identically to `in_progress` (line 96-98), placing it in the Active section in a FeaturedCard. This makes the Active section look busier than it is -- it can be populated with stale, idle work.

---

## 3. Sort Order: `sortWorkspaceItems()`

**`workspace-types.ts` lines 155-173**

Priority order (descending importance):

1. **Section**: active items first (`sectionOrder` returns 0 for active, 1 for recent, 2 for hidden)
2. **Status group** within section (`itemSortKey`):
   - 0: `in_progress` or `dormant`
   - 1: `blocked`
   - 2: has uncommitted or unpushed changes (any other status)
   - 3: clean, no pending work
3. **`activityMs` descending**: most recently touched first within the same status group

**Key observation**: `in_progress` and `dormant` are tied at sort key 0, meaning a dormant session from 4 days ago and an in_progress session from 1 hour ago will be sorted only by their `activityMs`. If the dormant session has a more recent `lastModifiedMs` (because the user manually touched something), it could appear above the actively running session.

**The hidden filter**: `sortWorkspaceItems` filters hidden items out at line 161 before sorting. This means the function already handles scope -- callers don't need to post-filter. However, the main component at lines 213-221 then re-runs `sectionFor()` for every item a second time to split into `activeItems` and `recentItems`. The same classification logic runs twice per render on every item.

---

## 4. The Join: `joinSessionsAndWorktrees()`

**`workspace-types.ts` lines 187-267**

The join key is `branch + '\0' + repoRoot` (line 205/196). This is correct and avoids false matches across repos that share branch names.

### Sessions with no worktree

```
worktree: undefined
activityMs = primarySession.lastModifiedMs ?? 0
repoName = repoNameByRoot.get(repoRoot) ?? repoRoot.split('/').at(-1) ?? repoRoot
```

- The branch shows up in the list -- not excluded
- `GitBadges` in the render layer returns `null` when `wt` is undefined (line 693): no git badges shown
- `SkeletonBadge` only shows if `fetching && item.worktree === undefined` -- once loading is done, no badge and no skeleton
- The `aheadCount` and `changedCount` for `sectionFor()` default to 0 via `?? 0`, so section classification falls through to the time-based check

**Implication**: A branch that has sessions but was run without a worktree (or whose worktree was deleted) appears as a plain row with no git status. This is silently degraded -- no indication to the user that git data is absent versus "nothing to show."

### Worktrees with no sessions

```
primarySession: undefined
allSessions: []
activityMs = wt.headTimestampMs
```

- Included in the workspace list
- `sectionFor()` will use the worktree's head timestamp for recency check
- No session status -- status dot renders with `accent = 'var(--border)'` (line 604), an empty/neutral dot
- `WorkspaceEmptyActive` is not shown for these -- that's only when the whole Active section is empty
- These branches show up in Recent with a neutral dot and no workflow info

**Implication**: A branch that was created, some commits made, but no WorkRail workflow started appears alongside branches with full workflow history. The neutral dot does not clearly distinguish "no workflow ever" from "workflow completed cleanly."

### repoName fallback chain (lines 233-237)

```typescript
const repoName =
  worktreeEntry?.repoName ??
  repoNameByRoot.get(repoRoot) ??
  repoRoot.split('/').at(-1) ??
  repoRoot;
```

For sessions without a current worktree, repoName falls back to the last path segment of the absolute repoRoot path (e.g., `/Users/etienneb/git/zillow/zillow-android-2` becomes `zillow-android-2`). This is reasonable but means the repo label shown in the badge may not match what the worktree API returns as `repoName` if the project was renamed or symlinked.

---

## 5. Tension Analysis

### What's most prominent vs what should be

**Most prominent (in order of visual weight):**
1. Branch name -- `font-mono text-sm font-medium` in FeaturedCard, `font-mono text-sm` in CompactRow. Always `flex-1` so it dominates horizontal space.
2. Session status dot + status label -- colored, positioned prominently below the branch name in FeaturedCard.
3. Recap excerpt -- `text-sm text-[var(--text-secondary)]`, the largest text block in a FeaturedCard.

**Least prominent:**
1. Repo name -- `text-[10px] text-[var(--text-muted)]`, always a small badge, hidden on mobile.
2. Workflow name -- `text-xs text-[var(--text-muted)]` after the status label, truncated.
3. Session count -- `text-xs text-[var(--text-muted)] ml-auto` pushed to the right edge.

The model assumes the branch name is sufficient identity. For a single-repo user this is true. For a multi-repo user, the branch name is often meaningless without repo context -- `feature/auth-refactor` could exist in three repos simultaneously.

### Single-repo vs multi-repo experience

**1 repo, 5 branches:**
- The `multiRepo = true` constant (line 463) still shows the repo badge on every FeaturedCard, even when there's only one repo. This is pure noise -- the user knows what repo they're looking at.
- Every CompactRow also shows the badge. The user sees the same repo name repeated 5 times in tiny muted text.
- The `ArchiveLinks` section shows one link: "All [repoName] sessions →" plus potentially "All sessions →" (shown unless `repos.length === 1`, line 909). For single-repo, the global link is suppressed, which is correct.

**3 repos, 15 branches:**
- The repo badge becomes meaningful but is visually suppressed. A user trying to find all branches for one repo has no grouping mechanism -- the list is sorted by status/activity, mixing repos together.
- `ArchiveLinks` shows one link per repo plus a global link. This is the only affordance for repo-level navigation, and it's at the bottom, below all branches, in `text-xs text-[var(--text-muted)]`.
- Branch names that coincide across repos (`main`, `develop`) will appear multiple times. The only disambiguator is the tiny repo badge.

### Does Active/Recent split add clarity or height?

The split adds semantic clarity (Active = needs attention, Recent = background work) but at a cost:

- The section header `h2` at line 398-400 uses `text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider` -- it's visually very subdued for something that's supposed to organize the page.
- `WorkspaceEmptyActive` (lines 926-934) is shown when Active is empty, creating a placeholder card that takes full card height before the Recent section begins. This adds visual weight even when there's nothing active.
- The Active/Recent distinction is invisible for worktree-only branches (neutral dot) -- it's only meaningful when sessions are present.
- In the `all` scope, the section label changes to "All branches" (line 345) while Active remains "Active". The mixed labeling (Active + All branches) is conceptually awkward -- "All branches" includes branches that are also Active.

### What the code cannot represent

1. **Repo-first grouping**: The data model supports it (all items have `repoRoot` and `repoName`), but the sort/section logic is entirely status-and-time-based. There's no way to view "all branches in repo X" in the workspace view -- only in the archive.

2. **Project/feature grouping**: WorkspaceItems have no concept of a parent project, epic, or ticket. Branch naming conventions (feature/TICKET-123) carry this signal but it's not parsed or surfaced.

3. **Explicit "no workflow" state**: Worktree-only branches (no sessions) are indistinguishable from branches with complete workflows, except by the neutral dot. There's no label or empty-state treatment for this case.

4. **Session count as a quality signal**: `allSessions.length` is shown as a count badge in FeaturedCard but only when expanded. A branch with 8 failed sessions and a branch with 1 successful session look identical in the collapsed view.

5. **Time context for Active**: The Active section can show items that are `dormant` (idle 3+ days) with no time elapsed shown until you look at the small `timeAgo` badge in the far right. The status label says "Dormant" but doesn't say "3 days ago" -- that's in the timestamp which is `text-[10px]`.

### The hardcoded `multiRepo = true`

Line 463: `const multiRepo = true; // always show repo badge in featured cards`

This was clearly intended to be a computed value (is there more than one repo?) but was hardcoded -- possibly as a temporary decision or MVP simplification. The consequence: even single-repo users see the repo badge, making it noisy for the majority case to properly support the minority multi-repo case.

---

## Summary of Key Tensions

| Tension | Code Location | Impact |
|---------|---------------|--------|
| Branch is primary unit, but branch names are not globally unique | `workspace-types.ts` join key design | Correct for data integrity, but rendering assumes branch = identity |
| `multiRepo = true` hardcode | `WorkspaceView.tsx` line 463 | Repo badge shown to everyone, meaningful to few |
| Repo badge is smallest/lowest-contrast element | Lines 488-491, 628-631 | Multi-repo disambiguation exists but is invisible |
| Repo badge hidden on mobile | Line 629 `hidden sm:inline` | Multi-repo users lose key context on phones |
| `dormant` treated identically to `in_progress` for section placement | `sectionFor()` lines 96-100 | Active section inflated with stale, idle work |
| `dormant` and `in_progress` tied at sort key 0 | `itemSortKey()` lines 135-137 | Idle sessions can float above active ones |
| 30-day cutoff is hardcoded | `THIRTY_DAYS_MS` line 50 | No user control, may be wrong for long-running projects |
| No repo-first grouping in the main list | Entire sort/section model | Multi-repo users cannot browse by project |
| Worktree-only branches indistinguishable from complete sessions | Join logic + neutral dot | "Never ran a workflow" and "ran and finished cleanly" look identical |
| Active section can be empty but still renders a placeholder card | `WorkspaceEmptyActive` line 926 | Adds height before the real content |
| `sectionFor()` called twice per item per render | Lines 213-221 | Minor perf issue, signals missed abstraction |

---

## What to Consider for Redesign

The core assumption of the current model is: **the user thinks in terms of branches, and status tells them what needs attention.** This works well for a single-repo power user. It breaks down when:

- The user has multiple repos (no grouping, tiny disambiguator)
- Dormant sessions dominate (Active section shows stale work prominently)
- The user has branches without workflows (neutral dot is ambiguous)
- The user is on mobile (repo name disappears)

If the question is "should repo/project be the primary unit?", the data model already supports it -- `ConsoleRepoWorktrees` groups by repo, and the join preserves `repoRoot` and `repoName` on every item. The limitation is entirely in the presentation layer, not the data layer. A repo-first grouping would require a new section strategy (group by repo, then sort within each repo by status/time) and would make the repo name a section header rather than a small badge.
