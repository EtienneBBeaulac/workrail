# Design Candidates: Unified Workspace View

*Raw investigative material for main-agent synthesis. Not a final decision.*

---

## Problem Understanding

### Core tensions

1. **Ambient awareness vs archive in the same surface.** The Sessions tab serves two jobs: "what's in flight now?" and "find session X from 3 weeks ago." Optimizing for the first degrades the second and vice versa.

2. **Join reliability vs view completeness.** The `branch + repoRoot` join is incomplete: `repoRoot: null` for sessions predating the observation feature. A view requiring the join has gaps; a view falling back to branch-only creates collisions (same branch name across repos).

3. **Rich default vs configurability.** An opinionated "show active work" default serves new users. Power users who relied on the flat list lose efficiency. No universally correct "active" scope exists.

4. **YAGNI vs architectural fix.** The minimal change (fix Sessions defaults) is YAGNI-compliant. The Replace approach is the architectural fix. Both are valid answers to different framings of the problem.

### Where the real seam is

The symptom is in `App.tsx`'s tab structure. The real seam is at the **data model boundary** — `ConsoleSessionSummary` and `ConsoleWorktreeSummary` are separate, unjoined types. The right seam for any unified view is a new `WorkspaceItem` client-side join type.

### What makes this hard

- **Session cardinality:** A branch with 15 completed sessions + 1 in-progress shouldn't show 16 rows. Collapse/expand UX is non-trivial.
- **Null repoRoot:** Must be surfaced as a valid state, not silently dropped.
- **React hooks constraints:** The existing `WorktreeList → RepoSection → WorktreeGrid → WorktreeCard` boundary pattern exists to prevent conditional hook calls. Any combined component must respect it.
- **Trunk-based dev breaks branch-as-unit:** All sessions on `main` creates one massive group.

---

## Philosophy Constraints

- **Architectural fixes over patches** → favors Replace/Workspace over minimal tweaks
- **YAGNI with discipline** → minimal-change candidate must be taken seriously as baseline
- **Make illegal states unrepresentable** → null repoRoot is a valid state to represent, not hide
- **Compose with small pure functions** → reuse `WorktreeCard` and `SessionCard`; new joining component is a composition layer
- **Exhaustiveness** → must handle all 5 session statuses × 3 worktree states explicitly

---

## Impact Surface

Changes must stay consistent with:

- `App.tsx` tab navigation + `sessionSearchNonce` remounting pattern
- `SessionList.tsx` `initialSearch` + `initialRepoRoot` pre-seeding
- `useWorktreeList` and `useSessionList` hooks (called separately, joined client-side)
- `WorktreeCard`'s `onSelectBranch(branch, repoRoot)` signature
- `ConsoleWorktreeListResponse` shape (`{ repos: ConsoleRepoWorktrees[] }`)

---

## Candidates

### A — Sessions defaults fix (minimal change)

**Summary:** Change Sessions tab defaults: group by branch, show in_progress first, make `recapSnippet` more prominent. No new tab or component.

- **Tensions resolved:** Ambient awareness served somewhat better
- **Tensions accepted:** No git state; Worktrees/Sessions redundancy persists; worktrees with uncommitted work but no sessions still invisible
- **Boundary:** `SessionList.tsx` props only
- **Failure mode:** Users relying on flat-by-recency broken; group-by-branch with 15 sessions/branch creates very long sections
- **Repo pattern:** Follows exactly
- **Gain/Lose:** Zero new surface area / doesn't solve redundancy
- **Scope:** Too narrow
- **Philosophy:** YAGNI ✓; architectural fix ✗

---

### B — Workspace tab replaces Sessions tab

**Summary:** Replace Sessions with a Workspace view (work items = branch + worktree + latest session); Sessions becomes "All History" toggle within Workspace.

- **Tensions resolved:** Ambient awareness fully served; redundancy eliminated; archive preserved via toggle
- **Tensions accepted:** Null repoRoot sessions in an "ungrouped" bucket; branch-as-unit baked in; trunk-based dev sees one big "main" group
- **Boundary:** New `WorkspaceList` + new `WorkspaceItem` client-side join type
- **Failure mode:** The null repoRoot "bucket" feels like a trash bin if most sessions are old (pre-repoRoot adoption)
- **Repo pattern:** Departs — new joining type; reuses `WorktreeCard` + `SessionCard`
- **Gain/Lose:** Best ambient awareness + eliminates redundancy / replaces working tab; risk of wrong defaults
- **Scope:** Best-fit
- **Philosophy:** Architectural fix ✓; YAGNI pressure ✗

---

### C — Enriched Sessions grouped-by-branch

**Summary:** Keep Sessions tab; when grouped by branch, fetch worktree data and show git state (changedCount, aheadCount, headMessage) inline in group headers.

- **Tensions resolved:** Git state visible alongside sessions; no new tab; trunk-based dev works
- **Tensions accepted:** Worktrees tab still somewhat redundant; ambient awareness requires user to choose group-by-branch; two API calls from SessionList
- **Boundary:** `SessionList.tsx` + `useWorktreeList` hook; `SessionGroup` enriched with optional worktree header
- **Failure mode:** Null repoRoot sessions show blank git-state header; performance hit from two fetches
- **Repo pattern:** Adapts — adds second data fetch to existing component
- **Gain/Lose:** No new tab; existing users undisturbed / Worktrees tab still partially redundant
- **Scope:** Best-fit (incremental)
- **Philosophy:** YAGNI ✓; compose with small functions ✓

---

### D — Activity feed (abandon branch-as-unit)

**Summary:** Replace Sessions with a time-ordered activity feed: "most recently touched branch + current state" — like a git reflog for workflow activity.

- **Tensions resolved:** Trunk-based dev works fine; no join required; most recent branch at top
- **Tensions accepted:** No persistent workspace state; archive awkward; batched workers lose cross-branch visibility
- **Boundary:** New `ActivityFeed` component; primary sort key `lastModifiedMs`; groups by branch within time windows
- **Failure mode:** Developer working batches (branch A today, branch B tomorrow) loses visibility into B while working on A
- **Repo pattern:** Departs — new concept
- **Gain/Lose:** Simple; solves trunk-based dev / loses persistent workspace state
- **Scope:** Too narrow for stated goal
- **Philosophy:** Determinism ✓; architectural fix ✗

---

### E — Adaptive Workspace (recommended)

**Summary:** Replace Sessions tab with Workspace that auto-adapts: with worktrees → enriched branch cards (worktree state + latest session); without worktrees → sessions-by-branch. "Show all sessions" button expands full archive inline in both paths.

- **Tensions resolved:** Ambient awareness as default; redundancy eliminated; graceful degradation for worktree-less users; archive in both paths
- **Tensions accepted:** Two rendering paths to maintain; adaptive logic adds cognitive overhead; trunk-based dev still sees one large "main" group
- **Boundary:** `App.tsx` tab rename + new `WorkspaceList` with adaptive rendering: `if (repos.length > 0) → enriched else → sessions-by-branch`
- **Failure mode:** Inconsistent layout between environments (worktrees on machine A, not machine B — different views)
- **Repo pattern:** Adapts — extends WorktreeList + SessionList pattern with a joining layer
- **Gain/Lose:** Best of B and C — eliminates redundancy while degrading cleanly / two rendering paths; more surface area than B or C alone
- **Scope:** Best-fit
- **Philosophy:** Architectural fix ✓; exhaustiveness ✓; make illegal states unrepresentable ✓; YAGNI tension

---

## Comparison

| Criterion | A | B | C | D | E |
|---|---|---|---|---|---|
| Ambient awareness | Partial | ✓ | Partial | ✓ (time) | ✓ |
| Archive in 1 click | ✓ | Toggle | ✓ | Awkward | Toggle |
| Git state visible | ✗ | ✓ | ✓ | ✗ | ✓ |
| Worktree-less degrade | ✓ | Partial | ✓ | ✓ | ✓ |
| Null repoRoot handled | Ignored | Bucket | Blank | Ignored | Adaptive |
| Trunk-based dev | ✓ | Big group | Big group | ✓ | Big group |
| No third tab | ✓ | ✓ | ✓ | ✓ | ✓ |
| Redundancy eliminated | ✗ | ✓ | Partial | Partial | ✓ |

**Recommendation: E**

E is the only candidate that eliminates the Worktrees/Sessions redundancy while gracefully degrading for worktree-less users. B also eliminates redundancy but the "null bucket" UX is poor for users with many historical sessions. C is a safe incremental step but leaves redundancy unsolved. A is too narrow. D abandons persistent workspace state.

**Runner-up: C** — if lower risk is preferred, C is the right choice.

---

## Self-Critique

**Strongest case against E:**
Two rendering paths are harder to maintain and test. The adaptive logic makes the view feel inconsistent between environments (worktrees on one machine, not another = different layout).

**What would tip toward C:** Primary concern is "git state visible next to sessions" rather than "eliminate two-tab redundancy." Safer, doesn't disrupt Sessions tab users.

**What would tip toward B:** If adaptive degradation logic in E proves complex. The null-repoRoot bucket is acceptable as repoRoot adoption grows over time (old sessions become rare).

**Assumption that would invalidate E:** If worktrees adoption is low, the enriched path rarely fires and Workspace looks like a slightly worse Sessions tab. Then C is a better investment.

---

## Open Questions for Main Agent

1. **What is worktrees adoption rate?** Most important unknown. E's value depends on the enriched path being the common case.
2. **Should the Worktrees tab be removed when Workspace ships?** It becomes redundant. Keeping during transition is safer.
3. **What is the right "active" scope?** In-progress only? In-progress + last 7 days + uncommitted worktrees?
4. **How do multi-session branches collapse?** Latest session inline + click to expand? Count badge?
5. **Does "Show all sessions" in Workspace replace the Sessions tab entirely, or does Sessions tab survive?**
