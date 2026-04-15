# Design Review Findings: Unified Workspace View

*For main-agent interpretation. Findings are actionable, not exhaustive.*

---

## Design Under Review

**B-plus (revised from E):** Workspace replaces both the Sessions tab and the Worktrees tab. Single rendering path — one `WorkspaceList` component showing branches as work items, joining worktree state + latest session per branch. Git-state columns (uncommitted, unpushed) degrade gracefully to "—" when no worktree data is available for a branch. "Show all sessions" toggle expands the full session archive inline. Both Sessions and Worktrees tabs retire.

---

## Tradeoff Review

| Tradeoff | Acceptable? | Condition where it fails |
|---|---|---|
| Two rendering paths (original E) | N/A — eliminated by B-plus | — |
| One extra click for archive users | Yes | If archive lookup is the majority use case (no data; acceptable risk) |
| Worktrees tab retirement required | Yes — and now explicit for BOTH tabs | If committed users have strong Worktrees tab habits (mitigated: tab was just shipped) |
| Trunk-based dev sees one large 'main' group | Yes | If WorkRail's user base shifts toward trunk-based development (pre-existing limitation) |

---

## Failure Mode Review

| Failure Mode | Handled? | Mitigation |
|---|---|---|
| FM1: Sessions tab survives → second source of truth | ✓ | Sessions tab retires; archive is ONLY via Workspace toggle |
| FM2: Worktrees tab survives → Workspace+Worktrees redundancy | ✓ | Worktrees tab retires; its content is a superset within Workspace |
| FM3: Low worktrees adoption → git columns always "—" | Partial | Degraded path still improves on today's Sessions; not a regression |
| FM4: Flicker between rendering paths | ✓ | Eliminated — B-plus has a single rendering path |

**Highest-risk failure mode:** FM1/FM2 combined — if either Sessions or Worktrees tab is not retired, Workspace adds a tab without removing one, strictly worsening navigation.

---

## Runner-Up / Simpler Alternative

**Why B-plus beats E:** E's adaptive rendering path (`if repos.length > 0`) is architectural complexity that exists to handle worktree-less users. B-plus solves the same problem more cleanly: one rendering path, git-state columns that show "—" when data is unavailable. No adaptive logic, no flicker risk, no inconsistent layout between environments.

**Why B-plus beats B:** B's "ungrouped bucket" for null repoRoot sessions is a poor UX — it feels like a trash bin for historical sessions. B-plus handles the same data by showing sessions without git-state columns rather than segregating them.

**C as safe fallback:** C (enrich Sessions with inline git state) remains valid if the retirement of both tabs is not committed. C improves the Sessions view without removing anything. It leaves the two-tab redundancy unsolved but is a zero-risk incremental step.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Architectural fixes over patches | ✓ Satisfied — replaces two overlapping tabs with one unified view |
| Compose with small pure functions | ✓ Satisfied — reuses `WorktreeCard`, `SessionCard`; new component is a composition layer |
| Make illegal states unrepresentable | ✓ Satisfied — null git state shown as "—", null repoRoot sessions shown in archive only |
| Determinism over cleverness | ✓ Satisfied — sort order explicit (in_progress → uncommitted → clean by recency) |
| Exhaustiveness | ✓ Satisfied — all session statuses and worktree states handled |
| YAGNI with discipline | ⚠ Tension — more surface area than C. Acceptable given concrete user pain. |

---

## Findings

### Red
*(none)*

### Orange
- **O1: Both tabs must retire.** If Sessions or Worktrees tab is not retired when Workspace ships, the result is strictly worse than today. This is a precondition, not a follow-up. Must be committed to before implementation begins.

### Yellow
- **Y1: Archive access is one click deeper.** Users who regularly use Sessions for archive lookup now navigate: Workspace → "Show all sessions" → find session. Not a blocking concern but worth monitoring post-launch.
- **Y2: Worktrees tab was just launched.** Habit formation is minimal, but the tab was promoted to users this session. Specify a concrete transition: both tabs show a "moved to Workspace →" banner for one release, then retire.
- **Y3: Trunk-based dev is a pre-existing limitation.** The "one large main group" problem affects all current views equally. Not introduced by B-plus. Track if user base shifts.

---

## Recommended Revisions (updated with gap closures)

1. **Confirm: retire both Sessions and Worktrees tabs when Workspace ships.** This is a prerequisite. If either tab is kept, switch to C instead. Transition: show "moved to Workspace →" redirect banner for one release before removing.

2. **Null repoRoot sessions belong in the archive, not the main view.** The main Workspace only shows branches with at least one non-null repoRoot session OR an active worktree. Null-repoRoot sessions are accessible via the "Show all sessions" archive toggle. This avoids cross-repo branch-name collisions entirely.

3. **Primary session selection priority:**
   - `in_progress` (most recently updated) → `blocked` → `complete_with_gaps` → most recently modified (any status)
   - If branch has uncommitted worktree work but no sessions at all: show branch with git state only, session row shows "—"
   - If multiple simultaneous in_progress sessions: show most recently updated, badge shows "N active"

4. **"Show all sessions" scope = per-repo, not global.** Clicking the toggle in the workrail section shows all sessions from that repo. A global "All sessions" link at the top of Workspace (above all repos) opens the full cross-repo archive. This preserves the archived Sessions-tab behavior without conflating repo-level and global archive.

5. **Default scope rules (applied independently):**
   - Always shown if: `changedCount > 0` OR `aheadCount > 0` OR has `in_progress`/`blocked` session — regardless of age. Work in progress never ages out.
   - Shown if: last session activity OR last commit within 30 days.
   - Drops off only if: clean, no active session, no activity in 30 days.
   - Scope toggle: "Active" (default) / "All" (no time filter).

6. **Activity timestamp = `max(lastSessionActivityMs, headTimestampMs)`.** Show whichever is more recent. Session activity is more relevant than commit time for context recovery; always prefer it when it's newer.

7. **WorkspaceItem card layout — session recap is the primary signal:**
   ```
   ┌──────────────────────────────────────────────────────┐
   │ feature/etienneb/auth-refactor          [workrail]   │
   │ ● in_progress  coding-task-workflow  ·  5m ago       │
   │                                                      │
   │ "Review and implement the token validation logic     │
   │  before moving to the test phase..."                 │
   │                                                      │
   │ [3 uncommitted]  [5 unpushed]      [2 sessions ▾]    │
   │ last commit: "feat: add jwt validation"  ·  2h ago   │
   └──────────────────────────────────────────────────────┘
   ```
   - Top: branch name (mono, prominent) + repo name badge
   - Second line: primary session status + workflow name + activity timestamp
   - Middle: **session recap snippet** (2 lines, prominent — the context-recovery signal)
   - Footer row 1: git-state badges + session count badge
   - Footer row 2: last commit message + commit time (muted — secondary)
   - If no session: recap area shows "—"; commit message takes the prominent slot
   - Click session count → inline session list (capped at 5 + "show more")
   - Click any session → SessionDetail; `← Back` returns to Workspace

7. **SessionDetail navigation:** `← Back` returns to Workspace (not Sessions tab). `App.tsx` `activeTab` becomes `'workspace'`; `selectedSessionId` remains the same as today.

8. **Git-state columns use "—" for missing data, not empty cells or hidden columns.** Makes the degraded state explicit rather than invisible.

9. **Sort order: in_progress → uncommitted → clean, each group by recency within scope window.** Explicit, deterministic.

10. **Multi-session branches:** Show primary session inline (per rule 3 above). "N sessions" badge expands inline list — not a tab switch.

---

## Homepage.tsx Analysis (untracked foundation)

`console/src/views/Homepage.tsx` exists in the working tree but was never committed to any branch and is not wired into `App.tsx`. It is sessions-only (calls `useSessionList()` only, no worktree data) and represents the right layout model with the wrong data scope.

### What to reuse directly
| Component / utility | Why keep |
|---|---|
| `excerptRecap(md, maxLen)` | Strips markdown, truncates to char limit — exactly right for recap-as-headline |
| `formatRelativeTime(ms)` | Already written, matches existing pattern |
| Two-tier layout (featured large + compact small) | Creates visual hierarchy; featured = "your 3 most important things" |
| Status color stripe on `FeaturedCard` | Visual differentiation without badge clutter |
| `AlertStrip` concept | Good UX for blocked/dormant attention signal |
| `FullEmptyState` with rotating prompts | Good onboarding for first-run; update wording only |
| `TipCard` concept | Keep — periodically rotating tips are ambient education for frequent users. Improve: auto-rotate every 60s with fade transition instead of static-on-mount |
| Button semantics throughout | Correct |
| Recap as headline in `FeaturedCard` | **The most important UX decision.** Already correct. |

### What to rescue from SessionList / SessionCard

These features exist today but are not explicitly mentioned in the Workspace design. Decisions:

| Feature | Decision | Placement |
|---|---|---|
| Full-text search (title, workflow, branch, session ID) | Keep | In "Show all sessions" archive view; add branch-name filter input to Workspace header for quick filtering |
| `hasUnresolvedGaps` ("⚠ gaps") | Surface explicitly | Add to `FeaturedCard` as an attention indicator alongside `blocked` status — a session that finished but left critical follow-ups is important to see |
| Corrupt health badge | Keep | Show on any card where `health === 'corrupt'`; renders nothing for healthy sessions so no noise |
| Status filter pills (All / In Progress / Dormant / Gaps / Blocked) | Partial | Keep in "Show all sessions" archive; drop from default Workspace view (section grouping handles this) |
| `tipCount` > 1 indicator | Add as subtle badge | Compact rows only — "N tips" is an interesting signal (agent explored multiple execution paths) without cluttering FeaturedCard |
| Stale discovery tips (3 reference retired features) | Update content | See tip content section below |

### Discovery tip content — what needs updating

Three of the 8 current tips reference things being retired. They will become misinformation:
- ❌ "Click a worktree in the **Worktrees tab** to jump to sessions filtered by that branch." — Worktrees tab retires
- ❌ "Use **Group by Status in the Sessions tab** to see all blocked sessions grouped together." — Sessions tab and grouping controls retire
- ❌ "**The Sessions tab** supports full-text search..." — Sessions tab retires

Replace these three with Workspace-aware tips, e.g.:
- "Branches with unresolved gaps appear with a ⚠ indicator — click to review what the agent left open."
- "Click any branch card to see its full session history and git state in one place."
- "The Workspace scope shows active and recently-touched branches. Switch to 'All' to see your full history."

Keep and leave unchanged (still accurate):
- "The DAG view shows every node the agent created, including blocked attempts and alternative paths."
- "Dormant sessions have been idle for 3 days — return to the original conversation to resume."
- "Gaps are open questions the agent flagged but could not resolve. Check them in the node detail panel."
- "Complete with gaps means the workflow finished but left critical follow-ups unresolved."
- "The preferred tip node (highlighted in yellow in the DAG) is the most recent forward position."

### What must change

1. **No branch grouping (critical).** Homepage shows individual sessions. A branch with 5 in_progress sessions consumes all 3 featured card slots. `FeaturedCard` and `CompactRow` must accept `WorkspaceItem` (branch + worktree + sessions), not `ConsoleSessionSummary`.

2. **No worktree data.** `useWorktreeList()` not called. Uncommitted/unpushed counts unavailable. Branches with uncommitted work but no sessions are completely invisible. Add the join: `joinSessionsAndWorktrees(sessions, repos) → WorkspaceItem[]`.

3. **Featured count hardcoded to 3.** Should be "all in_progress branches" in the featured tier, not a fixed count. If there are 8 in_progress branches, show all 8 as featured — compact tier is for "recent but not active."

4. **7-day compact window → 30-day.** `SEVEN_DAYS_MS` breaks context recovery for branches touched 8–30 days ago. Change to 30 days.

5. **No archive access.** No "show all sessions" link or toggle. Dead end if user needs something older than the scope window. Add a "Show all →" link at the bottom.

6. **No repoRoot disambiguation.** Same branch name across repos collides silently. `WorkspaceItem` includes `repoRoot`; card shows repo name badge.

7. **AlertStrip references "Sessions" tab.** "— view in Sessions" must change since Sessions tab retires. Change to "↓ see below" or just remove the destination text.

8. **TipCard.** Keep — periodically rotating tips are genuinely useful ambient education in a tool people check frequently. Improve current implementation: currently picks a random tip once on mount and never changes. Should rotate on a timer (every 60s) with a CSS fade transition so the change feels intentional rather than jarring. The 60s interval is independent of the data refresh cycle.

9. **FeaturedCard top line is workflow label.** Workspace design puts branch name there (most prominent) with repo badge and workflow label secondary.

10. **No scope toggle.** Add "Active" / "All" toggle in header to control whether the 30-day window applies.

### Integration shape
```
Workspace (replaces Homepage + SessionList + WorktreeList)
  useSessionList()       → raw sessions
  useWorktreeList()      → raw worktree data per repo
  joinSessionsAndWorktrees(sessions, repos) → WorkspaceItem[]
    WorkspaceItem = {
      branch: string,
      repoRoot: string,
      worktree?: ConsoleWorktreeSummary,
      primarySession?: ConsoleSessionSummary,
      allSessions: ConsoleSessionSummary[],
      activityMs: number,  // max(lastSessionMs, headTimestampMs)
    }
  applyScope(items, scope) → WorkspaceItem[]  // 'active' | 'all'
  sortItems(items) → WorkspaceItem[]           // in_progress → uncommitted → clean by activityMs
  featured = items filtered to in_progress OR uncommitted (regardless of count)
  compact  = remaining items within scope window
```

### What does NOT need to change
- `SessionDetail.tsx` — SessionDetail is unchanged; click any session → SessionDetail, ← Back returns to Workspace
- `useSessionList()` and `useWorktreeList()` hooks — unchanged
- `SessionList.tsx` — survives as the full archive, accessible via "Show all →" toggle within Workspace

---

## UX/UI Design Review

Six issues identified and resolved after reviewing the spec from a design perspective:

**1. Compact row layout was unspecified — now defined.**
Single-line format: status dot + branch name (truncated) + repo badge + git state (if non-clean) + activity time + optional `tipCount` badge. No recap, no commit message. This is a "still on radar" row, not an action item.

**2. Two-tier hierarchy lacked section headers — now named.**
"Active" (in_progress + uncommitted) and "Recent" (clean, touched in last 30 days). Without explicit headers, the visual hierarchy exists but users have no mental model for why some cards are big and others small.

**3. Featured card commit message row cut when recap is present.**
Commit message in footer row 2 was redundant noise on featured cards that already have a recap snippet. Now: commit message only appears as the middle line when there is no session at all (worktree-only cards). Removes one full row from the common case.

**4. Alert strip made actionable.**
Was informational decoration ("N sessions need attention — view in Sessions"). Now: clicking filters the view to affected sessions, scope expands automatically if they're outside the current window. Label updated to "click to focus."

**5. Two archive entry points given distinct names.**
"Show all sessions" was too generic. Now: "All [repoName] sessions →" (per-repo, scoped) and "All sessions →" (global, at the bottom of Workspace). Different names make the scope difference obvious.

**6. Scope toggle moved out of header.**
Header stays clean (title only). Scope toggle ("Active · All") sits above the first section header in the main content area. Persistent on scroll.

## Round 2 UX Review — 8 remaining gaps resolved

**1. Active/compact split definition corrected.**
Active (featured) = `in_progress` + `dormant` + `blocked` sessions only. Uncommitted-only branches (no active session) go in Recent (compact). The original spec incorrectly put all uncommitted branches in Active, which would flood the featured section.

**2. `dormant` status classified.**
`dormant` (in_progress session idle >3 days) belongs in Active as a featured card — the alert strip flags it as needing attention, so it should be visually prominent, not hidden in compact. Added to primary session priority list and scope rules.

**3. `activityMs` added to `WorkspaceItem` type.**
`activityMs: number` precomputed in the join function as `max(primarySession?.lastModifiedMs, worktree?.headTimestampMs)`. Sorting and display logic both need this; computing it in components would mean duplicate calculation and divergent results.

**4. "All" scope mode structure defined.**
Scope=All keeps the Active/Recent section structure but removes the 30-day cutoff. "Recent" section header updates to "All branches" to signal the change. Sort order unchanged.

**5. Empty Active section state defined.**
When no branches qualify for Active: show contextual message "No active work. Start a workflow with your agent to see it here." with rotating example prompt (reuses `FullEmptyState` from Homepage).

**6. `← Back` navigation context preservation specified.**
`← Back` from SessionDetail restores scroll position and re-expands the card the user came from. Stored in component state before navigating to SessionDetail.

**7. "clean" label removed from compact rows.**
Absence of git-state badges already communicates clean. The word was redundant noise.

**8. `tipCount` badge gets a tooltip.**
`[3 tips]` badge on compact rows includes tooltip: "N execution paths — the agent explored different routes or this session was resumed from multiple checkpoints." Makes an opaque signal educational.

## Residual Concerns

1. **Worktrees adoption rate unknown.** The enriched value (git state inline) depends on sessions having worktree data. Without usage analytics, we can't confirm the value proposition upfront. Low risk since the degraded path is still an improvement, but worth instrumenting after launch.
2. **Scope window (30 days) may need tuning.** Some teams have longer-cycle feature branches. The scope toggle ("Active" / "All") lets users override without configuration. Post-launch: instrument how often users switch to "All."
3. **Multi-session card height.** A card with an expanded session list showing 15 entries could become very tall. Cap expanded list at 5 rows with a "show more" link.
