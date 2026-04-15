## Subject Overview

The subject is **workflow-source setup phase 2** as a planning/design concept for WorkRail.

It exists to extend the shipped phase-1 rooted-sharing and visibility foundation into a broader, still-explainable source-management layer.

The core purpose is to make it possible to:

- connect a repo or folder without env-first setup
- inspect all effective workflow sources in one coherent model
- make legacy/env/runtime-configured sources visible during migration
- add trust/conflict review before enabling new external managed sources

Representative use cases:

1. connect a local folder as a workflow source without hand-editing env vars
2. connect a remote repo with a WorkRail-owned onboarding path
3. inspect effective sources and understand which are rooted, legacy, installed, or external
4. migrate from env-configured source setup to a WorkRail-owned managed path
5. preview precedence/conflict effects before enabling a new source

## Core Components/Elements

Main in-scope conceptual parts:

- **Phase 2A / Phase 2B split**
  - 2A is the foundation
  - 2B is lifecycle/breadth expansion
- **Canonical effective source catalog**
  - the inspectable truth surface for effective sources
- **Internal entry families**
  - derived effective entries
  - managed source entries
- **Onboarding intents**
  - `use folder`
  - `use repo`
  - `share repo workflows`
- **Migration layer**
  - visibility plus migration proposals for legacy/env-first sources
- **Trust/conflict layer**
  - trust review
  - conflict rehearsal

How they relate:

- phase 1 already delivered rooted-sharing trust and visibility
- phase 2A adds a catalog and narrow onboarding on top of that foundation
- phase 2B expands lifecycle, breadth, and richer surfaces after the model is stable

## Key Behaviors and Mechanisms

1. **Catalog as truth surface**
   - The effective source catalog should answer what sources effectively exist, where they came from, what scope they affect, what mode they are in, and what migration/trust/conflict implications apply.

2. **Hybrid internal model**
   - Some catalog entries are **derived** from current runtime-observable behavior.
   - Others are **managed** because WorkRail explicitly attached or installed them.
   - This keeps the catalog honest about legacy/runtime sources without requiring every source to be reified immediately.

3. **Repo/folder-first onboarding**
   - The first onboarding slice should optimize for folders and repos, not every possible source kind.

4. **Managed local sync as default for new remote onboarding**
   - Remote repos remain acquisition/update origins.
   - WorkRail uses a local effective copy for discovery, validation, and explainability.
   - This is a default for new onboarding, not a rewrite of all existing live/runtime-configured sources.

5. **Migration by visibility plus proposals**
   - Phase 2A should not just label legacy sources.
   - It should expose what they are and what migration path WorkRail recommends.

6. **Trust and conflict review before enable**
   - Before enabling a managed source, WorkRail should surface origin/mode/scope and run conflict rehearsal for shadowing, precedence, and portability risks.

## Integration Points

Dependencies referenced at interface level only:

- **`docs/plans/workflow-source-setup-phase-1.md`**
  - phase-1 rooted-sharing/visibility baseline
- **`docs/plans/workrail-platform-vision.md`**
  - broader multi-root / grouped-listing direction
- **`docs/ideas/third-party-workflow-setup-design-thinking.md`**
  - broader option space and rationale
- **`docs/configuration.md`**
  - current env-first setup surface that phase 2 must coexist with
- **current runtime source system**
  - heterogeneous effective sources (`bundled`, `user`, `project`, `custom`, `git`, `remote`, `plugin`)
- **current phase-1 trust layer**
  - request-scoped rooted discovery, remembered roots, visibility payloads
- **current local durable-state pattern**
  - small JSON-backed state under `~/.workrail/data/...`

Key contract-level conclusions:

- phase 2 should align with phase 1 rather than replace it
- phase 2 should not require immediate resolution of final `.workrail/config.json` ownership
- the effective catalog does not need to be identical to the persistence format

## Examples and Usage Patterns

1. **Use folder**
   - user points WorkRail at a local folder
   - WorkRail catalogs it and applies trust/conflict checks before enable

2. **Use repo**
   - user points WorkRail at a local or remote repo
   - WorkRail chooses the appropriate managed mode and catalogs the resulting source

3. **Share repo workflows**
   - user continues using rooted-sharing conventions while phase 2 catalogs and explains them alongside other sources

4. **Inspect effective sources**
   - user can view rooted, legacy, managed, and external sources in one coherent model

5. **Migrate env-configured Git source**
   - WorkRail surfaces that the source is legacy/env-first and proposes a managed replacement path

6. **Conflict rehearsal**
   - user sees that enabling a source would shadow a legacy project workflow or create overlapping workflow IDs

## Design Decisions and Tradeoffs

- **Catalog-first enough to stay honest**
  - Avoid a wizard over fragmented truth.

- **Onboarding immediately on top**
  - Avoid a purely internal catalog with no user payoff.

- **Hybrid internal model**
  - Derived entries preserve honesty about current runtime behavior.
  - Managed entries support WorkRail-owned setup and lifecycle metadata.

- **Repo/folder-first scope**
  - Keeps 2A narrow and practical.
  - Defers registry/plugin breadth until the model is proven.

- **Managed local sync default for new remote onboarding**
  - Balances trust, inspectability, and convenience.
  - Avoids making live remote the default.

- **Do not block on final config split**
  - Use the existing durable-state pattern first.
  - Preserve flexibility around `.workrail/*` ownership.

## Scope Boundary Log

Items encountered but not analyzed in detail because they are out of scope:

- exact API shapes for future phase-2 handlers
- exact managed-source record schema
- exact storage/file layout for managed-source records
- ticket breakdown / implementation slices
- detailed registry/plugin/community distribution design
- phase-3 console/control-tower internals

Temptations stopped:

- almost turned the doc into a ticket plan instead of a phase plan
- almost over-specified persistence schema details that are intentionally unresolved
- almost expanded into full lifecycle/update/receipt design that belongs in 2B, not 2A

## Self-Critique

**1. Did I stay within scope boundaries?**
→ **YES**
→ The analysis stayed at the initiative planning/design layer and did not dive into detailed implementation APIs or ticketing.

**2. Did I analyze any out-of-scope dependencies in detail?**
→ **NO**
→ Temptations logged:
  - exact persistence schema
  - ticket breakdown
  - broader phase-3 control-tower detail

**3. What tempted me to go off-track?**
→ The main temptations were to over-specify implementation details and to broaden the doc into a larger platform roadmap. I stopped by keeping the output focused on 2A/2B boundaries, model, and deferrals.

**4. Is my understanding depth appropriate for the scope?**
→ **Right level**
→ Evidence:
  - enough detail to define 2A/2B and the catalog/onboarding model
  - not so much detail that the document becomes code-shadowing or ticket-level design

**5. Did I gather sufficient evidence for claims I'll make in documentation?**
→ **YES**
→ Examples collected: 6 representative planning/use scenarios
→ Behaviors verified:
  - phase-1 rooted-sharing baseline exists and is already canonized
  - env-first configuration is still the current legacy surface
  - broader design-thinking material supports managed sync, conflict rehearsal, and catalog direction

**6. What am I still uncertain about (within scope)?**
→ Exact managed-source record schema and exact storage path remain intentionally unresolved.
→ That uncertainty does **not** block the phase-2 planning doc because the doc is supposed to preserve that flexibility.

**7. Understanding confidence rating: 9/10**
→ The scope is well understood and sufficiently evidenced for durable planning documentation.

**8. Any scope violations or major uncertainties discovered?**
→ **NO**
→ No blocking uncertainty was discovered that prevents documentation.
