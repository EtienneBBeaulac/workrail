# Workflow Source Setup Phase 1

This is the **canonical durable plan/design doc** for the near-term workflow-source setup initiative.

Use it for:

- the preferred phase-1 setup path
- the core design boundaries that should remain true during implementation
- migration and coexistence rules for legacy source setup
- acceptance criteria for when phase 1 is done enough to build on

Do **not** use this doc as a code-shadow full of exact APIs or step-by-step implementation recipes. Those should live in tickets, code, and tests.

## Goal

Make the common team-sharing path for workflows feel like **product setup**, not infrastructure wiring.

Phase 1 should make it easy for a user to understand:

- where team-shared workflows should live
- how WorkRail discovers them
- why they are visible
- how this new path coexists with older setup paths during migration

## Phase-1 product shape

Phase 1 is:

- **`Rooted Team Sharing`**
- plus a **minimal `Source Control Tower`**

That means:

- explicit `workspacePath` on discovery-sensitive behavior
- remembered workspace roots at user scope
- recursive discovery of `.workrail/workflows/` under remembered roots
- grouped source visibility
- minimal provenance and precedence explanation
- migration-aware guidance while legacy setup paths still exist

## Why this is phase 1

This path is the best near-term fit because it:

- aligns with the platform vision already documented in `docs/plans/workrail-platform-vision.md`
- reuses source metadata and discovery concepts already present in the codebase
- improves the highest-frequency team-sharing path without requiring broad setup automation first
- keeps the architecture explainable while the long-term source model is still being clarified

## Non-goals for phase 1

Phase 1 is **not**:

- a generalized guided install flow for arbitrary third-party sources
- the full canonical source catalog
- a complete console/control-plane experience
- final automation for remote/self-hosted auth setup
- the final permanent ownership split for every `.workrail/*` file

Those may follow later, but they are not required to make phase 1 useful and coherent.

## Core user model

The preferred team-sharing story should be simple enough to explain in plain language:

- “Team workflows live in `.workrail/workflows/` in the repo.”
- “This repo is registered as a workflow root once.”
- “WorkRail discovers workflows from registered roots.”
- “WorkRail can show which source made a workflow visible.”

If the user still has to think in raw source kinds, env-var names, or storage internals for the common path, phase 1 is not simple enough.

## Canonical phase-1 behavior

### Team-shared workflows

The preferred near-term convention is:

- store team-shared workflows in repo-local `.workrail/workflows/`
- allow nested/module-local `.workrail/workflows/` within remembered roots
- rely on root registration instead of per-workflow source hookup

### Workspace identity

Discovery-sensitive tools should use **explicit `workspacePath`** as the trusted anchor.

This initiative should continue the existing movement away from implicit server-process cwd behavior for workflow discovery and related operations.

### Remembered roots

WorkRail should remember repo/workspace roots at **user scope**.

For phase 1, this remembered-root state is allowed to live in user-level `.workrail/` configuration, but the exact long-term ownership split of `.workrail/config.json` versus other `.workrail/*` artifacts remains intentionally unresolved.

### Source visibility

Users must be able to see enough information to trust the result:

- which workflows are built-in
- which came from remembered roots
- which group/root made them visible
- when multiple setup paths overlap, what precedence explanation applies

Grouped visibility is part of the product, not polish.

## Config ownership decisions for phase 1

### Decided now

- WorkRail should own the preferred rooted-sharing setup path under the `.workrail/` namespace.
- User-level remembered roots are a valid phase-1 concept.
- Repo-local `.workrail/workflows/` is the preferred team-sharing convention.
- The system should avoid forcing users back to raw env configuration for the common path.

### Intentionally not finalized yet

- whether all user-level remembered-root state belongs in `~/.workrail/config.json`
- whether repo-local metadata should live in repo `.workrail/config.json` or a separate artifact
- how environment/capability cache state should be separated from source-setup state long-term

Implementation should preserve this flexibility instead of baking in an overloaded single-file assumption.

## Migration and coexistence rules

Phase 1 must coexist with current setup behavior instead of pretending it does not exist.

The doc and product should acknowledge these existing paths:

- `./workflows`
- `~/.workrail/workflows`
- env-based source configuration such as custom storage paths, Git repos, registries, and plugins

### Migration stance

- keep existing paths working during transition
- make the preferred rooted-sharing path unmistakable
- use dual-read compatibility where needed
- explain overlap rather than silently hiding it

### Required explanation during migration

When legacy sources and rooted-sharing both apply, the user should be able to understand:

- which path is preferred going forward
- which source currently made a workflow visible
- what precedence rule resolved any overlap

If WorkRail cannot explain this clearly, automation should not expand further.

## Acceptance criteria

Phase 1 is successful when all of the following are true:

### User-facing outcomes

- A user can set up team-shared workflows in **1–3 guided actions**.
- A user can explain the model in plain language without naming env vars.
- A user can tell the difference between built-in, personal, and repo-derived workflows.
- A user can understand how the preferred rooted-sharing path relates to older setup paths.

### Product/design outcomes

- `workspacePath` is required anywhere discovery semantics materially depend on workspace identity.
- Rooted discovery under remembered roots is available and reliable.
- Source visibility is grouped enough to answer “where did this come from?”
- Minimal precedence explanation exists for overlapping legacy and rooted sources.

### Maintenance outcomes

- Another maintainer can use this doc as the initiative entrypoint without needing the exploration notes first.
- Follow-on tickets can be written from this doc without reopening the entire option space.

## Recommended implementation slices

These are the likely implementation slices for phase 1, in rough order:

1. **Workspace anchoring**
   - require and propagate `workspacePath` where discovery behavior depends on it
2. **Remembered roots**
   - persist user-level root registration in WorkRail-owned config
3. **Rooted discovery**
   - recursively discover `.workrail/workflows/` under remembered roots
4. **Grouped visibility**
   - expose source-aware workflow listing and inspection
5. **Precedence and migration explanation**
   - explain overlap with legacy setup paths

This order matters more than exact file shapes.

## Risks to guard against

- **Config overload**: turning `.workrail/config.json` into a catch-all without a clear ownership model
- **Hybrid-model confusion**: leaving old and new setup paths equally canonical for too long
- **Invisible precedence**: making discovery broader without explaining why a workflow is visible
- **Over-automation**: trying to automate cross-client setup before WorkRail can explain its own effective source state

## Future phases

This doc is still the canonical reference for **phase 1**, but the initiative should also be understandable beyond the first slice.

### Phase 2 direction

If phase 1 succeeds, the most likely next step is:

- **`Guided Install + Canonical Source Catalog`**

The goal of phase 2 is to make broader workflow hookup simpler across more source types without regressing explainability.

Phase 2 likely includes:

- a more explicit canonical source catalog owned by WorkRail
- guided install flows for common third-party source types
- clearer source health, update mode, and provenance reporting
- a better-defined ownership split across user-global and repo-local `.workrail/*` configuration

Phase 2 should **not** begin by bypassing the phase-1 visibility model. It should build on a trusted, explainable source model rather than trying to invent one in the installer itself.

### Phase 3 and beyond

Later phases may expand into:

- richer control-tower / console visibility
- portable workflow-pack or packaging conventions
- broader install/distribution flows for community and cross-repo sharing
- more opinionated management of remote and self-hosted source lifecycle

These should be treated as follow-on opportunities, not implicit commitments.

### Sequencing rule

Future phases should continue to respect this order:

1. make the effective source model visible and trustworthy
2. make the common setup path simple
3. expand automation and distribution breadth only after the model stays explainable

If a later-phase idea weakens provenance, precedence clarity, or config ownership discipline, it should be considered out of sequence.

## Companion docs

- `docs/plans/workrail-platform-vision.md`
- `docs/ideas/third-party-workflow-setup-design-thinking.md`
- `docs/configuration.md`

The design-thinking doc remains useful as exploration history, but this file is the preferred durable reference for the initiative’s near-term direction.
