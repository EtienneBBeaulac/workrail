# Discovery: Unified Workspace View for WorkRail Console

## Context / Ask

The WorkRail console currently has two tabs:
- **Sessions** — flat list of all workflow runs, sortable/filterable, groupable by branch/workflow/status
- **Worktrees** — current git checkout state per repo, grouped into Active/Uncommitted/Clean sections

Both partially answer "what's happening in my workspace?" but neither does it well. Sessions is optimized for the archive use case ("find me session X from last week") rather than the ambient awareness use case ("what's running/pending right now?"). Worktrees shows git state but the session history is a click away per branch, not inline.

The user's insight: **the branch/worktree is the natural unit of work identity**, not the individual session. A user thinks "I'm working on feature X" not "I have session sess_abc123".

## Path Recommendation

**full_spectrum** — Both landscape grounding and reframing are needed:
- Landscape: what data is available (sessions API, worktrees API), how current components are structured, what users actually look for first
- Reframe: is branch the right unit? what about users without worktrees? what about multi-session branches? what about cross-repo scenarios?

## Constraints / Anti-goals

**Constraints:**
- Must degrade gracefully for users who don't use worktrees (sessions only)
- Must work with existing `/api/v2/sessions` and `/api/v2/worktrees` APIs (no new backend required for MVP)
- Sessions tab must remain as archive/fallback
- Must be configurable or adaptive (not forced on users who prefer current flat list)
- No new data model changes required for MVP

**Anti-goals:**
- Don't remove the Sessions tab (users need the archive)
- Don't require git worktrees — some teams don't use them
- Don't make it so opinionated that power users lose access to the raw list
- Don't over-engineer for multi-user scenarios (this is a dev-time personal tool)

## Landscape Packet

### Data available (APIs)

**Sessions API** (`/api/v2/sessions`):
```
ConsoleSessionSummary {
  sessionId, sessionTitle, workflowId, workflowName,
  status: 'in_progress' | 'complete' | 'complete_with_gaps' | 'blocked' | 'dormant',
  gitBranch: string | null,
  repoRoot: string | null,   ← null for sessions pre-dating the field
  recapSnippet: string | null,
  lastModifiedMs: number
}
```

**Worktrees API** (`/api/v2/worktrees`):
```
ConsoleRepoWorktrees {
  repoName, repoRoot,
  worktrees[]: ConsoleWorktreeSummary {
    branch: string | null,   ← null = detached HEAD
    changedCount, aheadCount, activeSessionCount,
    headMessage, headTimestampMs
  }
}
```

**Join key:** `branch + repoRoot`. Complications:
- Sessions pre-dating `repoRoot` have `repoRoot: null` — partial join only
- A worktree can exist with no sessions (manual work without WorkRail)
- A session can exist with no matching worktree (deleted, or different machine)
- Branches in different repos can share the same name — `repoRoot` disambiguates

### Current component structure
- `SessionList.tsx` — full list with sort/filter/group/pagination; accepts `initialSearch` + `initialRepoRoot` for pre-seeded filtering from worktree click-through
- `WorktreeList → RepoSection → WorktreeGrid → WorktreeCard` — per-repo git state, grouped Active/Uncommitted/Clean, click navigates to filtered Sessions
- `App.tsx` — three views (SessionDetail, WorktreeList, SessionList) switched by tab nav + sessionSearchNonce remounting trick
- `Homepage.tsx` — **untracked, never committed, not wired into App.tsx.** Sessions-only overview view (no worktree data). Already gets two-tier layout (featured large + compact small), recap-as-headline, in_progress-first sort, alert strip for blocked/dormant, and empty-state onboarding correct. **This is the right foundation for Workspace** — it needs branch grouping, worktree data, and a wider scope window added, not a full rewrite.

### Key tensions

1. **Session cardinality per branch:** A branch can have 1..N sessions. Common: 1 in-progress + 5-20 completed. Rare: multiple in-progress simultaneously. "Most recent in_progress" is likely the right primary to surface; collapsed history for the rest.

2. **Users without worktrees:** No worktree data available, but sessions still have `gitBranch`. Workspace view must degrade to sessions-by-branch with no git state column (changedCount/aheadCount unavailable).

3. **repoRoot null for old sessions:** Sessions pre-dating the repoRoot observation can't be reliably joined to a worktree. Must handle gracefully — show them ungrouped or under a "no repo" bucket.

4. **Scope:** "What's active now" vs "what's happened recently" vs "all time archive." These are different needs. The unified view should scope to recent/active; flat Sessions tab remains for the archive.

### Precedents (no web access — from general knowledge)
- **GitHub's branch list view** — branches with last commit + PR status, sorted by activity
- **Linear's "My Issues"** — activity-first, grouped by project, only your recent work
- **VS Code's Source Control panel** — per-repo, shows changed files + branch state
- **GitKraken Workspace** — branches with recent commits + open PRs across repos

Common pattern: **activity-first, recent scope, progressive disclosure** — show recent/active work prominently, archive accessible but secondary.

### Evidence gaps
1. No analytics on what users actually click first in the current console
2. Unknown: what percentage of current users use worktrees vs not
3. No data on what session-to-worktree join coverage looks like in practice (how many null repoRoot sessions remain in typical stores)

## Problem Frame Packet

### Primary users

1. **Active solo developer** — uses worktrees, 3–10 branches open at once, needs quick ambient awareness: "what do I have in flight right now?" Daily check-in behavior, <30 seconds.
2. **Context-recovering developer** — returning after interruption, needs: "where was I and what was the last thing that happened?" Branch + last session recap is the answer.
3. **Casual user** — runs a workflow occasionally, doesn't use worktrees, doesn't monitor sessions actively. The flat Sessions list works fine for them today.

### Jobs to be done

| Job | Frequency | Current friction |
|---|---|---|
| Ambient check ("what's in flight?") | Daily, multiple times | Must go to Sessions tab, sort by status, scan — not fast |
| Context recovery ("where was I?") | After interruptions | Sessions list doesn't surface branch state; Worktrees doesn't surface last session recap inline |
| Cross-branch decision ("which branch needs attention?") | Several times/week | Two-tab dance — worktrees for git state, sessions for workflow state |
| Archive lookup ("what did I do on X 3 weeks ago?") | Weekly/monthly | Sessions tab works fine for this today |

### Tensions

1. **Ambient awareness vs archive:** Sessions tab trying to be both makes it worse at both.
2. **Branch as unit vs session as unit:** The data model uses sessions as primary objects; users think in branches.
3. **Scope:** "Active" sessions only misses uncommitted worktrees with no workflow; "all time" creates noise. Right scope is probably "touched in last N days OR has uncommitted work."
4. **Third-tab problem:** Adding a Workspace tab risks fragmenting navigation further. The right solution might be to *replace* Sessions with Workspace and move archive behind a filter.
5. **Worktree-less degradation:** Git state (changedCount, aheadCount) is unavailable for sessions-only users. The view must be useful without it — branch + session state must be enough.

### Reframes

**Reframe 1: The real object is a "work item" (branch + worktree + sessions)**
Current: Sessions are primary; branch is a filter.
Better: A work item is the unit. Sessions and git state are attributes of a work item. The console shows you your work items, not your sessions.

**Reframe 2: Replace Sessions tab with Workspace; Sessions becomes "All history"**
Rather than adding a third tab, flip the default. Workspace becomes the landing page (shows recent/active work items). The current Sessions tab becomes "All History" accessible via a link or filter within Workspace. This removes the navigation fragmentation instead of adding to it.

**HMW questions**
1. HMW make the "what's in flight" check so fast it becomes a natural check-in habit?
2. HMW serve ambient awareness for users without worktrees using session data alone?
3. HMW avoid a third tab by replacing Sessions with Workspace instead of adding alongside?
4. HMW handle the "same branch name in different repos" disambiguation naturally?
5. HMW let the scope of "recent" adapt to different work rhythms without requiring configuration?

### Assumptions to challenge

1. **Branch is the right unit** — a developer might bounce between 3 branches for one logical "task." Git branch names are a proxy for work identity, not work identity itself.
2. **Sessions have stable gitBranch** — a session started on branch A might reflect work now on branch B (if branches were renamed or if the developer moved work).
3. **7 days is the right "recent" scope** — a dormant branch with uncommitted work from 2 weeks ago is still "active" in the worktree sense.
4. **Users want one view** — some users might prefer Sessions tab for keyboard-efficient filtering even with a new Workspace tab.

### Success criteria

1. A developer can answer "what do I have in flight?" in <10 seconds from opening the console
2. The view is useful without worktrees (sessions-by-branch with status)
3. Going from "what's in progress on this branch?" to "show me the session details" is one click
4. Active/in-progress work is prioritized by default without the user configuring anything
5. The flat archive is still accessible for power users who need it
6. The view handles null repoRoot sessions gracefully (shows them, doesn't crash)

## Candidate Directions

### Decision criteria (what any good solution must satisfy)

1. **Speed:** Answers "what's in flight?" in <10 seconds from opening the console
2. **Graceful degradation:** Still useful without worktrees — sessions-by-branch with status is enough
3. **Archive preserved:** The flat session list remains accessible without extra clicks for power users who need it
4. **Null tolerance:** Handles `repoRoot: null` sessions gracefully — shows them, doesn't hide them
5. **No third tab:** Either replaces an existing tab or enhances it — does not add navigation fragmentation

### Riskiest assumption
**"Branch is the right unit of work identity."** Breaks for trunk-based development workflows (everything on `main`). Mitigated by: WorkRail's current user base is feature-branch heavy; fallback is branch+repo disambiguation already in place.

## Challenge Notes

*To be filled during challenge phase.*

## Resolution Notes

*To be filled during resolution phase.*

## Decision Log

### Direction selection

**Winner: E (Adaptive Workspace) — conditional on Worktrees tab retirement**

E wins because it's the only candidate that eliminates the Sessions/Worktrees redundancy while gracefully degrading for worktree-less users. The challenge phase revealed the critical condition: E only works if the Worktrees tab is also retired. Without that commitment, E creates Workspace + Worktrees (still two overlapping tabs) and B becomes the better choice.

**Why B loses to E:** B's "null repoRoot bucket" is a poor UX for users with historical sessions. As repoRoot adoption grows, the bucket shrinks — but in the near term, most users with history will see their old sessions in a second-class bucket. E handles this via the adaptive fallback path.

**Why C loses to B and E:** C is a safe incremental step but doesn't solve the core redundancy. The user still has two semi-overlapping tabs after C ships.

**Runner-up: B (if Worktrees tab retirement is not committed)**
If the decision is made to keep the Worktrees tab as the dedicated git-state view, B is the right choice. Workspace replaces Sessions as the ambient-awareness-first view; Worktrees stays as the pure git-state view; the two serve genuinely different jobs without overlap.

**Safe fallback: C**
If structural changes are too risky, C (enrich Sessions with git state) is a meaningful improvement that leaves the current navigation unchanged.

## Final Summary

### Recommendation: B-plus (Adaptive Workspace, single rendering path)

**Foundation:** `Homepage.tsx` (currently untracked/unwired) is already the right layout model. Workspace builds on it rather than starting from scratch.

**What ships:**
- A new `Workspace` tab (renamed from "sessions") that is the default landing page
- `WorkspaceItem` cards — one per branch per repo, joining worktree state + primary session
- Git-state columns (`uncommitted`, `unpushed`) degrade to "—" when no worktree data; no separate rendering path
- Null-repoRoot sessions excluded from main view; accessible only via archive toggle
- "Show all sessions" toggle per-repo expands that repo's full session history inline
- Global "All sessions" link at top of Workspace opens cross-repo full archive
- Both the Sessions tab and the Worktrees tab are retired with a one-release redirect banner

**Prerequisite gate (must decide before implementation):**
Both Sessions and Worktrees tabs must retire when Workspace ships. If either tab is kept, the redundancy problem is made worse, not better. If this commitment can't be made, implement C (enriched Sessions) instead.

**Implementation shape:**
```typescript
type WorkspaceItem = {
  branch: string;
  repoRoot: string;                         // always non-null in main view
  worktree?: ConsoleWorktreeSummary;        // undefined = no worktree for this branch
  primarySession?: ConsoleSessionSummary;   // see priority order below
  allSessions: ConsoleSessionSummary[];
  activityMs: number;                       // max(primarySession?.lastModifiedMs, worktree?.headTimestampMs)
                                            // pre-computed in join function, not in components
};
```

**Primary session priority:** `in_progress` or `dormant` (most recently updated) → `blocked` → `complete_with_gaps` → most recently modified (any status). Multiple simultaneous `in_progress`: show most recently updated, badge shows "N active."

Note: `dormant` (idle in_progress session, >3 days without activity) is treated the same as `in_progress` for placement — it goes in the Active section as a featured card, because the alert strip already flags it as needing attention.

**Default scope rules (applied independently, not as a combined filter):**
- Always shown regardless of age: `changedCount > 0` OR `aheadCount > 0` OR has an `in_progress`/`blocked`/`dormant` session.
- Shown if: `activityMs` within 30 days.
- Drops off only if: clean (nothing uncommitted, nothing unpushed), no active session, no activity in 30 days.
- Scope toggle above content area: "Active" (default) / "All" (no time filter, shows everything).

The 30-day window applies only to clean/done branches. Work in progress never ages out.

**Sort order:** `in_progress`/`dormant` → `blocked` → uncommitted/unpushed → recently touched, each group by `activityMs` desc.

**Activity timestamp:** `max(primarySession?.lastModifiedMs ?? 0, worktree?.headTimestampMs ?? 0)` — precomputed as `activityMs` on `WorkspaceItem`. Session activity is more relevant than commit time; always prefer it when newer.

**Section definition (Active vs Recent — precise):**

| Condition | Section | Layout |
|---|---|---|
| Has `in_progress` or `dormant` session | Active | Featured card |
| Has `blocked` session | Active | Featured card |
| Has uncommitted/unpushed changes, no active session | Recent | Compact row |
| Clean, done, activity within 30 days | Recent | Compact row |
| Clean, done, no activity in 30 days (scope=Active) | Hidden | — |
| Any (scope=All) | Active or Recent per above, no time cutoff | — |

**Section headers (required — communicates the mental model):**
```
Active                         ← has running or stalled workflow, or needs attention
──────────────────────────────
  [featured card]  [featured card]

Recent                         ← clean branches touched in the last 30 days
──────────────────────────────
  [compact row]
  [compact row]
```
Empty Active section state: if no branches qualify, show a contextual message — "No active work. Start a workflow with your agent to see it here." with a rotating example prompt (reuse `FullEmptyState` logic from Homepage).

**"All" scope mode:** Scope toggle switches to "All" — section structure stays the same (Active / Recent) but the 30-day cutoff on Recent is removed. "Recent" section header updates to "All branches" to signal the change. Sort order unchanged.

**Featured card layout (Active section):**
```
┌─────────────────────────────────────────────────────────┐
│ feature/etienneb/auth-refactor        [workrail]        │  ← truncate branch, repo badge right
│ ● in_progress  coding-task-workflow  ·  5m ago          │  ← status + workflow + activity time
│                                                         │
│ "Review and implement the token validation logic        │  ← recap (prominent, 2 lines)
│  before moving to the test phase..."                    │
│                                                         │
│ [3 uncommitted] [5 unpushed] [⚠ gaps]  [2 sessions ▾]  │  ← git + gaps + session count
└─────────────────────────────────────────────────────────┘
```
- Last commit message **omitted** when a recap is available — it's redundant noise when the recap already tells you what's happening. Only shown (as the middle line) when there is no session at all.
- Corrupt session: shown as `⚠` icon with tooltip "This session's event log may be incomplete — some steps may not display correctly." Matches existing `⚠ gaps` visual pattern; no new vocabulary.
- Branch name truncates with ellipsis; repo badge and timestamp always visible

**Compact row layout (Recent section):**
```
  ● feature/etienneb/old-feature    [workrail]  [3 uncommitted]  3d ago
  ✓ feature/etienneb/done-branch    [workrail]                   1w ago  [3 tips]
```
- Single line: status dot + branch name (truncated) + repo badge (only when multi-repo) + git state badges if non-clean + activity time + `tipCount > 1` badge (tooltip: "N execution paths — the agent explored different routes or this session was resumed from multiple checkpoints")
- No "clean" text label — absence of git-state badges already conveys clean
- No recap, no commit message — this is a "still on your radar" row, not an action item
- Click → expands inline to show sessions for that branch (accordion — pushes content below down)
- Focus ring on keyboard selection; `Enter`/`Space` to expand; `Escape` to collapse

**Expand interaction (accordion):** Cards and compact rows expand in place — content below shifts down. No drawers, no modals. Expanded state shows a compact list of session rows inside the card (subtle border-top separator, same card background). Capped at 5 rows + "show more →". Click any session row → SessionDetail.

**Navigation context preservation:** `← Back` from SessionDetail restores scroll position and re-expands the card the user came from. The previously-expanded card and its scroll position are stored in component state before navigating to SessionDetail.

**Worktree data loading state:** Render cards immediately from session data. Show a skeleton shimmer on git-state badge area while `useWorktreeList` is still fetching (`isFetching === true`). When worktree data arrives, badges fill in without re-rendering the whole card. No flash of "—".

**Scope toggle placement:** Sits above the cards in the main content area (not in the header). The header stays clean with just the title. A simple pill toggle — "Active · All" — directly above the first section header. Persistent on scroll.

**Archive access — two distinct entry points with distinct names:**
- Per-repo: "All [repoName] sessions →" link at the bottom of each repo's section. Scoped to that repo's history.
- Global: "All sessions →" link at the very bottom of Workspace, below all repos. Cross-repo full archive.
- Both open an inline expanded SessionList with full-text search + status filter pills.
- "Show all sessions" naming retired — too generic, doesn't communicate scope.

**Alert strip — clickable, not decorative:**
- Clicking the alert strip filters the Workspace view to show only blocked/gap sessions (sets scope to "All" + highlights affected cards).
- Label changes to reflect action: "N sessions need attention — click to focus" rather than "— view in Sessions."
- If no affected sessions are visible in current scope, strip expands them automatically.

**Keyboard navigation (first-class, not an afterthought):**

Core loop:
- `j` / `↓` — focus next WorkspaceItem (card or compact row)
- `k` / `↑` — focus previous WorkspaceItem
- `Enter` / `Space` — expand/collapse focused item
- `Enter` on a session row inside an expanded card — open SessionDetail
- `Escape` — collapse expanded item; or if in SessionDetail, go back to Workspace (restores position)

Power shortcuts:
- `/` — open global search in archive view (vim muscle memory)
- `r` — manual refresh of workspace data
- `a` — toggle scope between "Active" and "All"
- `1` / `2` / `3`... — jump focus to the nth repo section (useful with multiple repos)

Visual: Focus ring is a 2px solid accent-color outline with slight offset — prominent, not the default browser outline. Tab order: scope toggle first, then cards top-to-bottom, then archive links.

**Transition plan:** Workspace ships with both old tabs showing a "moved to Workspace →" banner for one release. Second release removes the tabs.

**Strongest alternative:** C — enrich Sessions grouped-by-branch with inline git state. Zero structural change, leaves redundancy unsolved, safe if tab retirement is not committed.

**Confidence: High.** Architecture clear, implementation shape fully specified, prerequisite explicit.

**Residual risks:**
1. Worktrees adoption rate unknown — git columns may show "—" for most users initially
2. 30-day scope window may need tuning for longer-cycle teams (scope toggle handles this)
3. Trunk-based dev sees one large "main" group (pre-existing limitation, not new)

**Pivot triggers:**
- If >50% of users report archive is harder to reach → expose "All sessions" as a permanent nav option alongside Workspace
- If worktrees adoption is low enough that git columns are always "—" → retire git columns and implement C instead
- If trunk-based development is common → revisit with a time-ordered fallback
