# Workflow Source Setup Phase 2

This is the **canonical durable plan/design doc** for the next workflow-source setup phase after rooted-sharing phase 1.

Use it for:

- the recommended **phase 2A / phase 2B** boundary
- the canonical **effective source catalog** direction
- the intended onboarding model for repo/folder-driven setup
- migration stance for env-first and legacy live/runtime-configured sources
- the trust, conflict, and explainability guardrails that should constrain implementation

Do **not** use this doc as a code-shadow full of exact APIs, file layouts, or ticket-level implementation slices. Those should come later in tickets, code, and tests.

## Goal

Make broader workflow hookup feel like a coherent WorkRail product surface without losing the trust model established in phase 1.

Phase 2 should make it easier for a user to:

- connect a repo or folder without env-first setup
- inspect all effective workflow sources in one coherent model
- understand whether a source is rooted, installed, legacy, or external
- understand the trust, conflict, and migration implications of onboarding a source

## Why phase 2 exists

Phase 1 established the trust and visibility baseline for rooted team sharing:

- explicit `workspacePath`
- remembered roots
- recursive rooted discovery
- source-aware visibility
- migration-aware precedence explanation

That solved the common team-sharing path, but it did **not** yet provide:

- a canonical control surface for all effective workflow sources
- a WorkRail-owned onboarding path for repo/folder-style source hookup
- a coherent migration layer for env-first configuration

Phase 2 exists to add those capabilities without regressing explainability.

## Core phase-2 stance

Phase 2 should **not** be framed as “add an install wizard.”

It is better understood as:

- a **canonical effective source catalog**
- plus **managed onboarding** for a narrow set of common intents
- while preserving compatibility with current runtime source heterogeneity during migration

This is a control-layer expansion, not an immediate runtime rewrite.

## Phase-2 structure

### Phase 2A — Catalog + onboarding foundation

Phase 2A is the first credible slice of phase 2.

It should:

- define the **canonical effective source catalog**
- introduce **managed source entries** for explicit install/connect actions
- add narrow onboarding for common intents
- make legacy/env-first sources visible and migration-targetable
- require trust review and conflict rehearsal before enabling new managed sources

### Phase 2B — Lifecycle and breadth expansion

Phase 2B follows after the 2A foundation is stable.

It should expand into:

- richer update and sync flows
- clearer health, revision, and last-sync reporting
- receipts / setup transcripts / stronger observability
- broader source-type onboarding such as registries, plugins, or community packaging
- richer console/control-tower integration

## Canonical phase-2 model

### Effective source catalog

The **effective source catalog** is the canonical inspectable model of what sources effectively exist right now and how they relate.

It should answer, at minimum:

- what the source is
- where it came from
- what scope it affects
- what mode it is in
- whether it is preferred, legacy, or overlapping another source
- what trust/conflict/migration implications apply

The catalog is a **truth surface**, not necessarily the persistence format.

### Internal entry families

The preferred internal model is hybrid:

#### Derived effective entries

These exist because WorkRail can currently observe or derive them from existing behavior:

- built-in workflows
- user-library workflows
- rooted-sharing sources discovered from remembered roots
- legacy project `./workflows`
- env-configured live/runtime-configured sources

These should be visible in the catalog even if WorkRail did not explicitly create them.

#### Managed source entries

These exist because WorkRail explicitly attached, installed, or connected them.

They are the right place for durable metadata such as:

- selected mode
- origin
- revision or branch intent
- trust/review result
- migration target state

Users should not need to think in terms of “derived” versus “managed,” but this distinction is useful internally and in the planning model.

## User-facing phase-2 language

The product should prefer user intents over raw source-kind jargon.

The early onboarding surface should be shaped around intents like:

- `use folder`
- `use repo`
- `share repo workflows`

This is better than forcing the user to choose directly among `custom`, `git`, `remote`, or `plugin` semantics.

## Phase-2A onboarding scope

### In scope for onboarding

Phase 2A should focus on **repo/folder-first** onboarding.

That means:

- local folder onboarding
- local repo onboarding
- remote repo onboarding
- rooted-sharing continuity for repo-local `.workrail/workflows/`

### Out of scope for onboarding

Phase 2A should **not** try to support every source kind equally from day one.

Explicitly defer:

- broad registry onboarding
- broad plugin onboarding
- community/package distribution breadth
- richer import flows for archives/chat/shared artifacts

Those belong later, once the catalog and onboarding foundation are proven.

## Remote-source stance

### Default for new onboarding

For **new remote onboarding**, the default should be:

- **managed local sync**

That means:

- the remote repo is the acquisition/update source
- WorkRail operates over a local effective copy for discovery, validation, and explainability

### Why this is the default

This default:

- preserves a local effective state that is easier to inspect and debug
- supports a stronger provenance and update story
- avoids forcing users to think in low-level Git/storage modes
- aligns with the design-thinking direction around managed sync

### Important constraint

Managed local sync should be treated as the **default for new onboarding**, not as an immediate semantic rewrite of every existing remote/live source.

Legacy live/runtime-configured sources should remain:

- supported during migration
- visible in the catalog
- explainable as legacy or advanced paths

### Other remote modes

The long-term model may also include:

- **pinned snapshot**
  - stronger reproducibility, lower-trust, or explicit-update scenarios
- **live remote**
  - if retained, advanced-only and not the preferred onboarding path

Phase 2A does not need to finalize the long-term fate of live remote mode to be useful.

## Migration stance

Phase 2 must coexist with current configuration reality instead of pretending it is already gone.

The product and docs should continue to acknowledge:

- `./workflows`
- `~/.workrail/workflows`
- rooted-sharing via remembered roots
- env-configured custom paths
- env-configured Git repositories
- env-configured remote registries
- env-configured plugin-style sources

### Legacy visibility

Env-first and other legacy-configured sources should appear in the catalog as **legacy-effective** or equivalent user-facing categories.

### Migration proposals

Visibility alone is not enough.

Phase 2A should include **basic migration proposals / change plans** such as:

- this source is currently env-configured
- this is the recommended preferred path
- this is the target mode WorkRail recommends
- this is the overlap/conflict implication if you enable it

This does **not** require full migration automation in 2A, but it should make the path forward explicit.

## Trust and conflict requirements

### Trust review

Phase 2A should require a lightweight explicit trust/review summary before enabling third-party or external managed sources.

At minimum, that summary should make clear:

- origin
- scope
- selected mode
- any auth implication
- any important portability warning

### Conflict rehearsal

Before attaching or enabling a source, WorkRail should perform a preflight-style conflict rehearsal that can surface:

- shadowing / precedence effects
- workflow ID conflicts
- bundled-protection implications
- obvious portability or compatibility concerns

This is part of making the onboarding path trustworthy rather than surprising.

## Config and persistence stance

### What is decided now

- Phase 2A should avoid overloading `.workrail/config.json` prematurely.
- The effective catalog does **not** have to be the same as the persistence format.
- Managed-source durability can be designed separately from the catalog surface.

### What this implies

Phase 2A can plausibly use a dedicated WorkRail durable-state pattern for managed source records without first resolving every long-term `.workrail/*` ownership question.

### What is still intentionally unresolved

- exact managed-source record schema
- exact storage/layout path
- final ownership split between user-global config, repo-local metadata, and durable managed-source state

The implementation should preserve flexibility here rather than baking in a premature single-file assumption.

## Acceptance criteria

Phase 2A is successful when all of the following are true:

### User-facing outcomes

- A user can connect a repo or folder without falling back to raw env-first setup.
- A user can inspect all effective sources in one coherent model.
- A user can understand whether a source is rooted, legacy, managed, or external without reading implementation details.
- A user can understand trust/conflict implications before enabling a managed source.
- A user can see a migration path for legacy/env-first sources.

### Product/design outcomes

- The effective source catalog is canonical for inspection.
- Managed onboarding exists for repo/folder-first intents.
- Conflict rehearsal exists before enable/attach.
- Lightweight trust/review exists before enabling external managed sources.
- Legacy live/env-configured sources remain visible and supported during migration.

### Maintenance outcomes

- Another maintainer can use this doc as the durable phase-2 reference without replaying the exploration.
- Future ticketing can proceed without reopening the entire option space.
- The doc preserves clear boundaries between 2A, 2B, and later phases.

## Non-goals for phase 2A

Phase 2A is **not**:

- a full source-lifecycle platform
- a richer console control tower
- a full registry/plugin/community onboarding rollout
- a complete runtime-source redesign
- the final answer to every `.workrail/*` ownership question
- a full receipt/history/transcript system

Those may follow in 2B or later phases, but they are not required for 2A to be useful and coherent.

## Risks to guard against

- **Wizard over chaos**: guided onboarding without a real canonical catalog
- **Another hybrid setup story**: old and new source paths coexist without a coherent catalog view
- **Hidden runtime rewrite**: phase 2A quietly changes source semantics instead of productizing them safely
- **Config overload**: phase 2A pushes too much state into `.workrail/config.json` too early
- **Migration theater**: legacy sources are labeled but not meaningfully guided toward a better path
- **Invisible conflicts**: onboarding enables sources without clear rehearsal of overlap or precedence

## Remaining design decisions

These are still important, but now belong inside the chosen direction rather than blocking it:

- exact minimal managed-source record schema
- exact storage/layout recommendation for those records
- whether any repo-local metadata artifact is worth adding in 2A
- long-term role of explicit live remote mount

## Recommended next planning step

If this phase-2 direction is accepted, the next high-value artifact should be a more focused **phase-2A design / execution plan** that refines:

- catalog entry shape
- managed-source record shape
- conflict-review / trust-review surface
- migration-proposal surface

before ticket creation begins.

## Companion docs

- `docs/plans/workflow-source-setup-phase-1.md`
- `docs/plans/workrail-platform-vision.md`
- `docs/ideas/third-party-workflow-setup-design-thinking.md`
- `docs/configuration.md`

`workflow-source-setup-phase-1.md` remains the canonical reference for phase 1. This file is the preferred durable reference for the **next** phase of the initiative.
