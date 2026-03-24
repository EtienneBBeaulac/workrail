# Legacy Planning Status Map

This doc records the status of the **major older planning initiatives and planning surfaces** so contributors can see what is still active, what is finished, and what should no longer shape current planning.

## Status meanings

- **done** — the core initiative is effectively delivered
- **partial** — important parts landed, but meaningful work remains
- **open** — still largely unimplemented
- **dropped** — intentionally not planned / not pursuing
- **parked** — still an idea, but not an active delivery commitment
- **historical** — no longer relevant for current planning

## Major legacy planning docs

| Doc | Status | What it means now | Recommended action |
| --- | --- | --- | --- |
| `docs/plans/agentic-orchestration-roadmap.md` | **partial** | Phase 1-style routine/subagent groundwork exists, but composition, adapters, and authorable supplements are still open. | Keep as initiative context, but treat `open-work-inventory` and `now-next-later` as the live priority view. |
| `implementation_plan.md` | **done** | The prompt-fragments implementation plan is effectively delivered. | Keep as finished initiative context; do not use as active backlog. |
| `docs/plans/library-extraction-plan.md` | **done** | Core engine extraction is delivered; remaining ideas are follow-on extensions, not a missing core milestone. | Keep as finished initiative context. |
| `docs/plans/native-context-management-epic.md` | **dropped** | We are not planning to pursue native context management; keeping it in active planning would be misleading. | Do not treat it as roadmap work. |
| `docs/plans/v2-followup-enhancements.md` | **partial** | Some items are shipped, but progress notifications, stronger verification contracts, and other follow-ups remain open. | Keep as a source initiative doc, but track active work through tickets and roadmap docs. |
| `docs/generated/v2-lock-closure-plan.md` | **done** | This generated closure plan appears complete. | Keep as completion evidence only. |
| `docs/implementation/03-development-phases.md` | **historical** | Old phase model with mixed stale assumptions; only a few ideas still matter. | Do not use for current planning. |
| `docs/implementation/11-implementation-planning-guide.md` | **historical** | Spec-era process guidance, not a live implementation tracker. | Do not use for current planning. |
| `docs/plans/workflow-validation-roadmap.md` | **partial** | Canonical roadmap/status doc for the validation initiative. | Prefer this over the old god-tier planning cluster. |
| `docs/plans/workflow-validation-design.md` | **partial** | Canonical durable design doc for the validation initiative. | Prefer this over the old god-tier design cluster. |
| `docs/plans/workflow-v2-roadmap.md` | **partial** | Canonical roadmap/status doc for WorkRail v2. | Prefer this over older v2 one-pager/resumption docs. |
| `docs/plans/workflow-v2-design.md` | **partial** | Canonical durable design doc for WorkRail v2. | Prefer this over older v2 design-resumption docs. |
| `docs/plans/prompt-fragments.md` | **done** | Canonical finished summary for the prompt fragments feature. | Prefer this over the old design/review/verification doc trio. |

## Validation initiative

The older multi-doc validation pack has been replaced by a simpler canonical pair:

- `docs/plans/workflow-validation-roadmap.md`
- `docs/plans/workflow-validation-design.md`

### Initiative status

- **Status**: **partial**
- **Meaning now**:
  - the validation pipeline and registry-centric validation work are largely shipped
  - lifecycle coverage and some closure claims are still not fully normalized
  - the former multi-doc validation pack has been collapsed into two canonical docs
- **Recommended action**:
  - use `docs/plans/workflow-validation-roadmap.md` for canonical initiative status
  - use `docs/plans/workflow-validation-design.md` for canonical durable design
  - use `docs/roadmap/open-work-inventory.md` for the remaining open work
  - ignore the older validation planning entrypoints for current planning

## Parked legacy ideas worth keeping visible

| Idea source | Status | Notes |
| --- | --- | --- |
| Marketplace / workflow sharing from `03-development-phases.md` | **parked** | Should live as an idea until there is clear product pull. |
| Cloud adapter direction from `agentic-orchestration-roadmap.md` | **parked** | Keep visible as a future adapter concept, not current roadmap work. |

## Workflow v2 initiative

Older overlapping v2 entrypoints were collapsed into:

- `docs/plans/workflow-v2-roadmap.md`
- `docs/plans/workflow-v2-design.md`

### Initiative status

- **Status**: **partial**
- **Meaning now**:
  - core v2 is largely shipped
  - remaining sign-off and follow-up work still exists
  - the old overlapping v2 entrypoints have been collapsed into canonical roadmap/design docs
- **Recommended action**:
  - use `docs/plans/workflow-v2-roadmap.md` for canonical status
  - use `docs/plans/workflow-v2-design.md` for canonical durable design
  - use `docs/plans/v2-followup-enhancements.md` for detailed remaining follow-up work

## Prompt fragments feature

The earlier prompt-fragments design/review/verification stack was collapsed into:

- `docs/plans/prompt-fragments.md`

### Initiative status

- **Status**: **done**
- **Meaning now**:
  - the feature is shipped
  - the earlier three-doc sequence was consolidated into one canonical summary
- **Recommended action**:
  - use `docs/plans/prompt-fragments.md`

## Live docs to prefer

- `docs/planning/README.md`
- `docs/plans/workflow-validation-roadmap.md`
- `docs/plans/workflow-validation-design.md`
- `docs/plans/workflow-v2-roadmap.md`
- `docs/plans/workflow-v2-design.md`
- `docs/plans/prompt-fragments.md`
- `docs/roadmap/open-work-inventory.md`
- `docs/roadmap/now-next-later.md`
- `docs/tickets/next-up.md`
