---
title: Console UI Backlog
scope: console
status: active
branch: feature/etienneb/console-ui-redesign
last_updated: 2026-04-08
related:
  - docs/design/console-cyberpunk-ui-discovery.md
  - docs/roadmap/now-next-later.md
  - docs/roadmap/open-work-inventory.md
  - docs/tickets/next-up.md
---

# Console UI Backlog

Tracks all open, in-progress, and recently shipped UI work for the WorkRail Console.
The active branch for this work is `feature/etienneb/console-ui-redesign`.

> **Agent maintenance instructions:**
> Before committing or opening a PR for any console UI change, update this file:
> - Move completed items from their current section to **Shipped** with a short note
> - Add any newly discovered work to the appropriate section
> - Update `last_updated` in the frontmatter
> After merging to main, also update `docs/roadmap/now-next-later.md` (move items to done)
> and `docs/roadmap/open-work-inventory.md` (remove or mark complete).

---

## In Progress

*(work that has been started and is actively being developed)*

None currently -- the branch is ahead of main awaiting PR.

---

## Up Next

*(groomed, ready to implement, ordered by priority)*

### 1. Title bar redesign

**Spec:** Complete (produced by `ui-ux-design-workflow`, stored in conversation context).

Layout:
```
[ WR ]  WORKRAIL CONSOLE  |  WORKSPACE   WORKFLOWS   PERFORMANCE  |  [ IN PROGRESS: 2 ]
```

- Left: `[WR]` logo mark using `CutCornerBox` (cut=8, amber border) + `WORKRAIL CONSOLE` in monospace
- Center: tab navigation, monospace uppercase, active tab = 2px amber bottom border, inactive tabs use `--text-secondary` (not `--text-muted` -- WCAG contrast failure)
- Right: live session ticker showing `[ IN PROGRESS: N ]` count -- hidden when 0
- Session detail state: center becomes `← WORKSPACE // session-id` breadcrumb
- `corner-brackets` CSS class applied to the header element
- `energy-live-pulse` gets `prefers-reduced-motion` guard

**Files:** `console/src/AppShell.tsx`, `console/src/index.css`

---

### 2. Workflow detail modal

Replace the current full-page navigation to `WorkflowDetail` with a glassmorphism modal
that materializes from below over the workflow card grid.

- Animation: `translateY(20px) scale(0.97) opacity-0` → `translateY(0) scale(1) opacity-1`, 250ms ease-out
- Modal: `CutCornerBox` (cut=24, amber border glow), `blur(20px)` glass background, ~80% content width, max ~900px
- Backdrop: subtle dark scrim, click-outside to dismiss
- Cyberpunk markdown styling inside:
  - `# headers` → amber color, wide tracking
  - `**bold**` → amber
  - `` `code` `` → dark bg, cyan text
  - `> blockquote` → amber left border
  - List bullets → `//` prefix

**Files:** `console/src/views/WorkflowsView.tsx`, `console/src/views/WorkflowDetail.tsx`, `console/src/components/NodeDetailSection.tsx` (markdown styles)

---

### 3. Source filter pills in workflow catalog

Add source filter alongside existing tag pills: `All Sources | WorkRail | User Library | Project`.
Data already present on every workflow via `source.displayName`. Pure frontend change.

**Files:** `console/src/views/WorkflowsView.tsx`

---

### 4. Adopt new components everywhere

Sweep all views to consistently use the extracted primitives.
Currently only partially adopted.

| Component | Status |
|-----------|--------|
| `MonoLabel` | Used in `NodeDetailSection`, `RunLineageDag` -- NOT yet in views |
| `BracketBadge` | Used in `StatusBadge` -- NOT yet in title bar or modals |
| `ConsoleCard` | Used in `WorkflowsView` grid -- NOT in `SessionList` |
| `SectionHeader` | Used in `WorkflowsView` -- NOT in other views |
| `MetaChip` | Used in `SessionList.Chip` -- NOT in other views |

Priority: apply `ConsoleCard variant="list"` to `SessionCard` in `SessionList.tsx`.

**Files:** `console/src/views/SessionList.tsx`, `console/src/views/SessionDetail.tsx`, `console/src/AppShell.tsx`

---

### 5. WorkspaceView rethink

`repoRoot` was removed (2026-04-07). The WorkspaceView now sources repo context from
the worktree API (`process.cwd()`) only. Verify the view still makes sense without
per-session repo grouping, and redesign if needed.

Also: the WorkspaceView is largely unstyled in the cyberpunk theme -- it still uses
the old flat dark style.

**Files:** `console/src/views/WorkspaceView.tsx`, `console/src/views/workspace-types.ts`

---

## Parked / Ideas

*(worth keeping visible, not current delivery commitments)*

### Custom cyberpunk overscroll effect

When scrolling past the limits of a scrollable container (modal, session list,
DAG), add a themed visual effect instead of the default OS rubber-band bounce.
Options: amber glow flash at the boundary, a brief scan-line flicker, or a
subtle "resistance" indicator. Requires custom scroll event handling + CSS.

**Files:** `console/src/index.css`, scroll container components

---

### Nicer hover animations

Current hover state: border brightens, top stripe goes full opacity, ambient glow appears.
Explore richer micro-interactions:
- Subtle `transform: translateY(-1px)` lift on card hover
- The ambient glow (`energy-card`) could animate in with a short fade (100ms) rather than being instant
- Active/pressed state: slight scale down (`scale(0.99)`)
- The `corner-brackets` CSS could animate in on hover with opacity + scale transition for a "locking on target" feel (currently removed from cards, but could be a hover-only effect on selected state)

**Files:** `console/src/index.css`, `console/src/components/ConsoleCard.tsx`

---

### Background spotlight movement by active tab

The ambient radial glows in the body background should shift position based on which
tab is currently active -- the "light source" follows the user's focus.

```
Workspace tab (leftmost)   → amber glow at ~20% from left, cyan at bottom-right
Workflows tab (middle)     → amber glow centered (50%), cyan balanced
Performance tab (rightmost)→ amber glow at ~80% from left, cyan at bottom-left
```

Implementation: CSS custom properties (`--spotlight-x`, `--spotlight-y`) on `body`,
updated via JavaScript when the active tab changes. The `radial-gradient` in `body`
background-image references these properties. Transition: `background-position`
doesn't transition, but the CSS properties can be transitioned via a wrapper element
or by lerping the values with a short JS animation.

Alternative: three separate keyframe states on `body` driven by a `data-active-tab`
attribute, with a CSS transition on `background-position`.

**Files:** `console/src/index.css`, `console/src/AppShell.tsx`

---

### Project-specific workflow loading

When browsing sessions from a specific project, the workflow catalog could show
workflows from that project's `workflows/` directory.

What's needed:
- `/api/v2/workflows?workspacePath=<path>` query parameter
- Backend instantiates storage with `projectPath: workspacePath/workflows`
- Frontend passes workspace context when browsing a specific project

**Blocker:** `repoRoot` was removed as unreliable. Need a different mechanism to
identify which project the user is currently browsing. `workspacePath` per-session
is not stored (it's ephemeral). `repo_root_hash` is kept for resume ranking but
not surfaced to the UI. Design needed.

---

### Execution trace UI

Sessions have `executionTraceSummary` on `ConsoleDagRun` (field reserved, no frontend
consumer yet). Surface the agent's decision trace -- why it chose each path, which
conditions evaluated, what context facts were used.

**See:** `console/src/api/types.ts` (`ConsoleExecutionTraceSummary`),
`src/v2/projections/run-execution-trace.ts`

---

## Shipped (this branch)

| Item | Commit(s) | Notes |
|------|-----------|-------|
| Lineage DAG overhaul | PR #248 | Side-branch alignment, cycle guards, no windowing, scroll overhang |
| Inline NodeDetailSection | PR #248 | Replaced floating NodeDetailPanel |
| Floating node detail panel | `47cbb67`+ | Fixed-position glassmorphism panel, CutCornerBox |
| Session metadata card + hint banner | `42b7500` | Replaces sparse h2 header |
| Cyberpunk amber/gold theme | `d03310b` | Ambient glows, glassmorphism, amber accent |
| Cyberpunk enhancements | `166f8a1` | Scanlines, `//` separators, `[ BADGE ]` status, wider tracking, corner brackets |
| Workflow catalog redesign | `cdc56ed`+ | Section headers, grid cards, count pills, copy CTA |
| ConsoleCard, MonoLabel, BracketBadge, SectionHeader, MetaChip | `be06fb5` | 5 shared components extracted |
| Source `displayName` fix | `fd8f6b8` | Backend now enriches source with displayName |
| `src: WorkRail` fix (resolution layer) | `7a89132` | Bundled workflows correctly tagged via resolution, not storage hack |
| Remove `repoRoot` | `7880373` | Unreliable field nuked; backward-compat preserved for old event logs |
| Fix `src:` in workflow detail | `bbc83b7` | Detail endpoint now enriches source with displayName |
| SessionList SORT_AXES refactor | merged | Typed axis objects, debounce, grouped pagination |
| Audit findings (MR + prod + arch) | `60cf743`+ | All 3 audit cycles addressed |
| Unit tests for lineage layout | `609c343` | 22 tests covering F1 regression, cycle safety, compression |

---

### Theme the back navigation element

The `← Workflows` / `← Workflows / CODING` back link in WorkflowDetail
is plain text. Should match the cyberpunk aesthetic:
- Use `←` replaced with `//` or `<` in monospace, e.g. `< WORKFLOWS // CODING`
- Amber color on hover, muted at rest
- Could use `BracketBadge` or a dedicated nav arrow component
- Consistent with the `//` separator language established elsewhere

**Files:** `console/src/views/WorkflowDetail.tsx`

---

### Workflow catalog as inventory screen

Aesthetic direction: the workflow catalog should feel like a cyberpunk game's inventory
or loadout screen (CP2077 cyberware, Deus Ex augmentations, Starfield ship modules).
Each workflow is an "item" you can inspect and equip. Visual ideas:

- Card hover shows a full stat readout (step count, tags, source, compatibility)
- "Equipped" workflows visually distinguished from unequipped (active border glow vs dim)
- Possible grid rearrangement / drag to reorder priority
- Category grouping by "slot type" (coding, review, investigation) mirrors equipment slots

**Depends on:** equip/unequip feature below.

---

### Equip / unequip workflows from the console

Allow users to toggle workflows active/inactive from the console UI. An "equipped"
workflow is enabled in the MCP tool list (`list_workflows` returns it); unequipped
workflows are hidden from agents but still browsable in the console.

This maps to the existing pinned-workflows / managed-sources infrastructure
(`src/infrastructure/storage/` + `PinnedWorkflowStorePortV2`).

Implementation direction:
- Add an equip/unequip button to each workflow card and the detail modal
- Equipped state shown as an amber `[ EQUIPPED ]` badge on the card
- Backend: toggle in the pinned workflow store via a new `/api/v2/workflows/:id/equip` endpoint
- The MCP `list_workflows` handler already filters by source -- extend to respect equipped state
- Equipped workflows get the full amber border treatment; unequipped are dimmed (50% opacity)

**Design note:** This is the most natural extension of the inventory metaphor. A player
"equips" the tools they want their agent to use for a session. Session-scoped or
persistent equip state TBD.

**Dependencies:** requires backend API + pinned workflow store changes.
