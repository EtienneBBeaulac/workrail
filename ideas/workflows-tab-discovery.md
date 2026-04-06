# Discovery: Workflows Tab for WorkRail Console

**Status**: landscape research in progress
**Purpose**: human-readable record of what already exists about a Workflows tab in the console. This doc is for reading; execution truth lives in workflow notes and context.

---

## Context / Ask

Map what is already written, planned, or ideated about adding a Workflows tab to the WorkRail console. No design work yet — pure landscape research.

## Artifact Strategy

This file is a human-readable record only. It will be populated during the landscape phase with:
- What each existing doc says about a Workflows console surface
- What each reference assumes the tab would do
- What gaps exist between the scattered references

## Problem Frame Packet

### Primary user
**Solo developer / workflow author** (Etienne) — uses WorkRail daily for agentic coding, MR review, discovery, etc. Has authored many workflows. Needs to understand the landscape before designing a new console surface.

### Jobs to be done
1. **Before design**: "What has already been thought through about this? What constraints do I need to respect? What's assumed vs what's open?"
2. **After design (future)**: "Which workflows do I have? Which are stale? Where did they come from? Can I launch one directly from the console?"

### Core tension
The console today is entirely **run-oriented** (sessions, DAG nodes, execution trace). A Workflows tab introduces a **catalog-oriented** axis — managing templates, not runs. These are genuinely different mental models. The tension is: does adding a catalog tab help users or fragment the console into two separate tools?

### Success criteria for this research task
1. Every planning doc that references a Workflows tab has been found and summarized
2. What each reference assumes the tab would do is made explicit
3. Gaps between references (no design doc exists) are clearly stated
4. The user can make an informed decision about what to design without re-reading 6 planning docs

### Assumptions to challenge
1. **"Workflows tab" is the right mental model** — maybe the catalog belongs inside `WorkspaceView` as a section, not a separate tab
2. **The staleness detection plan's "console workflow list" means a tab** — it might mean a panel or overlay within the existing console
3. **A tab is needed now** — several referenced features (source setup phase 2B, staleness detection backend) aren't implemented yet; maybe the tab should wait

### HMW questions
1. HMW surface workflow catalog information without adding a tab that fragments the console?
2. HMW make workflow staleness visible without building a full management surface first?

### Framing risks
1. Scope creep: "Workflows tab" is small; "workflow management surface" is large. Planning docs conflate the two.
2. Premature: the backend features (staleness, source catalog) that would fill a Workflows tab are not yet implemented — a tab with no data is worse than no tab.

---

## Landscape Packet

### Current console structure

`console/src/App.tsx` — the console has **no tabs**. It is a single-page app that switches between two views:
- `WorkspaceView` — the default landing page (branch/session overview)
- `SessionDetail` — detail view for a selected session

The old Sessions and Worktrees tabs were deliberately retired. They were replaced by `WorkspaceView` per the completed design in `ideas/workspace-unified-view.md`. That decision is finalized and shipped.

`console/src/views/` contains:
- `WorkspaceView.tsx` — current landing page
- `SessionDetail.tsx` — session run detail
- `SessionList.tsx` — session archive (accessible inline from WorkspaceView, not a tab)
- `WorktreeList.tsx` — retired (no longer a tab)
- `Homepage.tsx` — untracked/unwired prototype, was the foundation for WorkspaceView

**There is no Workflows tab today.**

---

### Where a Workflows tab is referenced in planning docs

#### 1. `docs/plans/workflow-staleness-detection.md`
Most concrete reference. Explicitly calls for:
> "staleness indicator in **console workflow list**. `likely` should be visually more prominent than `possible`. Follow the existing `migration`/`staleRoots` visual pattern."

And in the implementation scope table:
> `Console | Staleness indicator in workflow list; likely > possible visual hierarchy`

**Assumes**: a "workflow list" surface exists in the console that shows per-workflow metadata including a staleness signal. This is the clearest functional requirement written anywhere — a list view of workflows with staleness badges.

#### 2. `docs/design/v2-core-design-locks.md`
> "The Console edits **source workflows**, never compiled snapshots."
> "Compiled workflows are derived artifacts used for pinning (`workflowHash`) and must not be user-editable."

**Assumes**: the console will have a workflow editing surface. A Workflows tab is the natural home for this — browse, inspect, and eventually edit source workflows. This is a design constraint, not a feature spec, but it implies the tab's edit behavior.

#### 3. `docs/roadmap/now-next-later.md` — Later section
> "Broaden the console from a node-only dashboard into a richer control-plane surface for engine state, execution trace, and decision explanation"
> "Dashboard artifacts: replace file-based docs with session-scoped structured outputs rendered in the console (design exists, blocked on console UI)"

**Implies**: the console is expected to grow. A Workflows tab is directionally consistent with "richer control-plane surface" but is not explicitly named here.

#### 4. `docs/plans/workflow-source-setup-phase-2.md` — Phase 2B scope
> "richer console/control-tower integration"
> "richer update and sync flows"
> "clearer health, revision, and last-sync reporting"
> "broader source-type onboarding such as registries, plugins, or community packaging"

**Implies**: a Workflows tab would eventually be the control surface for source management — showing which workflows come from which sources (bundled, user-installed, project-local, module-local), their health, and sync state. Phase 2B explicitly anticipates this, though it doesn't name a tab.

#### 5. `docs/plans/workrail-platform-vision.md`
> Grouped listing showing workflows by source (Built-in, team/repo, module)

This is described as MCP output format (`list_workflows` response), but the same grouped view is the natural model for a Workflows tab in the console.

#### 6. `ideas/workspace-unified-view.md` — Tension noted
> "Third-tab problem: Adding a Workspace tab risks fragmenting navigation further. The right solution might be to *replace* Sessions with Workspace..."

This tension was resolved by making Workspace the only tab. Any future Workflows tab must be evaluated against the same fragmentation concern — it must earn its place as a genuinely different axis (catalog/management) vs. the current run/session axis.

---

### What the existing references assume a Workflows tab would do

Synthesizing across all references, the anticipated functions are:

| Function | Source |
|---|---|
| Browse available workflows (grouped by source) | Platform vision, staleness detection |
| Show staleness indicator per workflow (`none`/`possible`/`likely`) | Staleness detection plan |
| Show workflow source (built-in, user, project, module) | Platform vision, source setup phase 2 |
| Inspect a workflow (compiled hash, spec version, steps) | v2 design locks |
| Edit source workflows (not compiled snapshots) | v2 design locks |
| Show source health/sync state | Source setup phase 2B |
| Link to "start this workflow" action | Platform vision (zero-config start) |

---

### Contradictions and tensions

1. **No formal design exists**: every reference above assumes the tab exists but none designs it. The staleness detection plan is the only one with concrete UI requirements.

2. **Edit surface vs browse surface**: v2 design locks say "the console edits source workflows" — but the console is currently a read-only run monitor. Adding editing is a significant capability jump, not just a new tab.

3. **Tab fragmentation risk**: the Workspace design explicitly resolved a three-tab problem by collapsing to one tab. Adding Workflows as a second tab reintroduces the fragmentation. The design rationale would need to justify why this is a genuinely different axis (it is — catalog/management vs. run monitoring — but this needs to be stated).

4. **Workflow list vs session list**: both are lists. The key distinction is that workflows are the *templates* and sessions are the *runs*. A Workflows tab must communicate this axis clearly to avoid user confusion with the session archive.

---

## Gaps and Open Questions

1. **No design doc exists** for the Workflows tab — the most concrete reference is a single row in a staleness detection implementation table.
2. **Edit surface scope** is unresolved — the v2 design lock says the console edits source workflows, but what that means in the UI (inline editing? launch editor? open file?) is undefined.
3. **Navigation model** is unresolved — should Workflows be a permanent top-level tab, or an on-demand panel/drawer accessible from within Workspace?
4. **Source setup phase 2B** would be the richest use of a Workflows tab (source catalog, health, sync), but phase 2B is not yet started.
5. **Staleness detection** is the most fully specified feature that would live in a Workflows tab — but staleness detection itself is not yet implemented on the backend or frontend.

## Candidate Directions

**Constraint for candidate generation** (`landscape_first`): candidates must be grounded in what the planning docs actually say and the constraints they establish — not in free invention. Each candidate must address: (1) the tab fragmentation risk, (2) v1 scope given existing API, (3) the catalog-vs-run axis distinction.

### A — Tab: `/api/v2/workflows` endpoint + `WorkflowsView.tsx` as a second tab

Add a REST endpoint proxying `list_workflows` output. A `WorkflowsView.tsx` tab renders workflows grouped by source (built-in, user, project) with staleness badges using the `staleness` field the API already returns.

- **Tensions resolved**: catalog vs run axis (separate tab); source grouping (already in API); staleness (additive when backend ships)
- **Tensions accepted**: adds a second tab (fragmentation risk)
- **Failure mode**: staleness returns `possible` for all unstamped workflows initially — badge is noisy
- **Repo pattern**: follows — adapts `WorkspaceView` pattern exactly (`useWorkflowList` mirrors `useWorktreeList`)
- **Scope**: best-fit
- **Philosophy**: architectural fix over patch ✓, YAGNI ✓ (no editing/management in v1), observability ✓

### B — Section: Collapsible accordion at bottom of WorkspaceView (no new tab)

Add an "Available Workflows" accordion section collapsed by default at the bottom of `WorkspaceView`.

- **Tensions resolved**: no tab fragmentation; minimal change
- **Tensions accepted**: catalog buried in run-oriented view; axis distinction lost; discoverability poor
- **Failure mode**: WorkspaceView overloaded; catalog feels out of place below session cards
- **Repo pattern**: follows (accordion pattern already exists)
- **Scope**: too narrow — patches rather than fixes
- **Philosophy**: architectural fix over patch ✗ (this is a patch)

### C — Panel: Slide-in panel from header action (no new tab)

A "Workflows" button in the console header opens a `WorkflowsPanel.tsx` overlay without changing tab structure.

- **Tensions resolved**: axis separation without a second tab; accessible from any view
- **Tensions accepted**: pattern novelty (no panels exist in the codebase); discoverability (button less prominent than tab)
- **Failure mode**: introduces new interaction model with no precedent
- **Repo pattern**: departs — no overlay/panel pattern in console today
- **Scope**: best-fit architecturally, but premature as v1 (pattern overhead unjustified)
- **Philosophy**: YAGNI ✗ (new pattern without evidence of need)

### Recommendation: A (Tab)

A is the architectural fix. The catalog/run axis distinction is real and deserves a first-class surface. B buries it (patch). C is architecturally clean but pattern-novel (YAGNI violation for v1). Two tabs are not the same problem as three overlapping tabs — Workspace and Workflows serve genuinely different axes.

**Pivot to B** if users never leave WorkspaceView. **Pivot to C** if additional tabs are anticipated (Settings, etc.). **Defer entirely** if staleness backend takes >6 months — a tab showing `possible` for everything has low value.

## Challenge Notes

### Findings

**Yellow — Staleness badge noise**
All unstamped workflows return `possible` from the API. A tab full of yellow badges is noise, not signal.
- **Mitigation**: show staleness badge only when `level === 'likely'`. No badge for `possible` (the default for unstamped workflows). The tab is useful as a pure grouped source browser even badge-free.

**Yellow — workspacePath scoping**
`list_workflows` requires a workspace path. The new `/api/v2/workflows` route must pass it.
- **Mitigation**: `console-routes.ts` already has workspace context for worktrees; same context can be used. No design change needed — implementation detail.

**No Red or Orange findings.** Design is sound for v1.

### Recommended Revisions

1. Update Candidate A spec: staleness badge renders only for `level === 'likely'`, not for `possible`
2. Add discriminated union type for staleness level in console frontend types; unknown values degrade to no badge

### Residual Concerns

- Staleness backend may never ship, leaving the tab permanently badge-free. Acceptable: source grouping is still useful.
- Two-tab limit should be treated as an architectural constraint going forward (not just a convention).

## Resolution Notes

Direction selected: **A (Tab)** with staleness badge showing only for `level === 'likely'`.

No further research or prototype needed. The recommendation is grounded in existing planning docs, confirmed API/route feasibility, and reviewed for failure modes.

## Decision Log

| Decision | Selected | Runner-up | Reason |
|---|---|---|---|
| Container for workflow catalog | Tab (A) | Section in WorkspaceView (B) | B is an architectural patch; catalog and run are genuinely different axes that deserve separate surfaces |
| Staleness badge scope | `likely` only | Show all levels | Showing `possible` for all unstamped workflows is noise; badge adds signal only when `likely` |
| v1 scope | Grouped list + source badge + `likely` staleness badge | Full management surface | YAGNI; building to the API that already exists |

## Summary

### What already exists about a Workflows tab

**No dedicated design doc or ticket exists.** A Workflows tab for the console is anticipated in 5 planning docs but never formally designed:

1. **`docs/plans/workflow-staleness-detection.md`** — the most concrete reference. Explicitly requires a "console workflow list" with staleness indicators (`none`/`possible`/`likely`). This is the only planning doc with a concrete UI requirement for a Workflows tab.

2. **`docs/design/v2-core-design-locks.md`** — establishes the constraint that "the console edits source workflows, never compiled snapshots." Implies a future console editing surface; a Workflows tab is the natural home for it.

3. **`docs/roadmap/now-next-later.md`** (Later section) — "Broaden the console from a node-only dashboard into a richer control-plane surface." Directional only, no tab spec.

4. **`docs/plans/workflow-source-setup-phase-2.md`** (Phase 2B) — "richer console/control-tower integration," source health/sync reporting. Phase 2B is the richest planned use case for a Workflows tab but is not yet started.

5. **`docs/plans/workrail-platform-vision.md`** — describes grouped workflow listing by source as the MCP output model; same structure is the natural v1 UI for a Workflows tab.

### What the console looks like today

Single `WorkspaceView` landing page (no tabs). The old Sessions and Worktrees tabs were retired per `ideas/workspace-unified-view.md`. `console/src/App.tsx` switches only between `WorkspaceView` and `SessionDetail`.

### Recommendation for when you're ready to design

**A: Add a Workflows tab** — `WorkflowsView.tsx` as a second tab, backed by a new `/api/v2/workflows` REST route in `console-routes.ts` that proxies the existing `list_workflows` handler output.

- v1 shows workflows grouped by source (built-in / user / project / module) with a staleness badge only when `level === 'likely'`
- Follows the exact `WorkspaceView` pattern (new hook + view component)
- The two-tab structure (Workspace + Workflows) covers two genuinely different axes: run monitoring vs catalog browsing

**Confidence: High.** Implementation path is clear, API exists, failure modes are mitigated.

**Pivot conditions**: defer if staleness backend won't ship soon (tab would be badge-free, reducing its value differential vs just using `list_workflows` via MCP).
