# Open Work Inventory

This is the **normalized inventory** of work that is still open after consolidating the older roadmap and planning docs.

It separates:

- **active partials** — already started or partially shipped, but not really done
- **planned but unimplemented** — real initiatives that have not landed yet
- **ideas / parked directions** — worth keeping visible, but not current delivery commitments

Use this as the main source of truth when grooming roadmap items into tickets.

For explicit status on the major older planning docs themselves, see `docs/roadmap/legacy-planning-status.md`.

## Active partials

### 1. Clean response formatting and supplement hardening

- **Status**: partial
- **Why it is here**: the clean format and supplement system now exist, but the broader product boundary is still being clarified
- **Still open**:
  - finish clarifying the boundary between workflow-authored prompts and response-boundary supplements
  - align runtime, docs, tooling, and authoring guidance around that boundary
  - decide how far this remains runtime-owned versus becoming authorable later
- **Source docs**:
  - `docs/roadmap/now-next-later.md`
  - `docs/plans/agentic-orchestration-roadmap.md`

### 2. V2 production readiness and sign-off

- **Status**: partial
- **Why it is here**: v2 is stable enough to be default-on, but the follow-up plan still has unfinished readiness work
- **Still open**:
  - complete manual validation/sign-off for the relevant v2 scenarios
  - decide whether the remaining v2 feature-flag cleanup should happen now or later
  - normalize stale docs that still describe older rollout assumptions
- **Source docs**:
  - `docs/plans/workflow-v2-roadmap.md`
  - `docs/plans/workflow-v2-design.md`
  - `docs/plans/v2-followup-enhancements.md`

### 3. God-tier validation lifecycle coverage

- **Status**: partial
- **Why it is here**: the validation pipeline and registry validation are largely shipped, but the lifecycle-harness ambition is not fully closed
- **Still open**:
  - broaden lifecycle coverage beyond the small current set of lifecycle tests
  - decide the realistic target for bundled workflow lifecycle coverage
  - archive or simplify stale operator docs from the god-tier planning stack
- **Source docs**:
  - `docs/plans/workflow-validation-roadmap.md`
  - `docs/plans/workflow-validation-design.md`

### 4. Planning system adoption

- **Status**: partial
- **Why it is here**: the planning taxonomy now exists, but old initiative docs still dominate the repo and the new system has not been fully adopted yet
- **Still open**:
  - move live work into `ideas`, `roadmap`, and `tickets`
  - stop using stale plan docs as active truth
  - keep the next priorities easy to find
- **Source docs**:
  - `docs/planning/README.md`

## Planned but unimplemented

### Composition and middleware engine

- **Status**: unimplemented
- **What is missing**:
  - workflow composition field / assembler
  - auto-injection based on workflow metadata
  - fragment/routine composition as a first-class runtime mechanism
- **Source doc**: `docs/plans/agentic-orchestration-roadmap.md`

### Adapter intelligence

- **Status**: unimplemented
- **What is missing**:
  - adapter layer for capability-aware behavior
  - schema/runtime variants for delegate vs proxy paths
  - smarter environment/capability-driven instruction selection
- **Source doc**: `docs/plans/agentic-orchestration-roadmap.md`

### Progress notifications

- **Status**: unimplemented
- **What is missing**:
  - request/handler notification plumbing
  - progress token semantics
  - design resolution for notification sending and node counting
- **Source doc**: `docs/plans/v2-followup-enhancements.md`

### Enforceable verification contracts

- **Status**: unimplemented
- **What is missing**:
  - structured, enforceable verification outputs rather than instruction-only verification prose
  - stronger evidence-oriented contract surfaces
- **Source doc**: `docs/plans/v2-followup-enhancements.md`

### Evidence validation contracts

- **Status**: unimplemented
- **What is missing**:
  - replacing prose-heavy validation criteria with stronger typed evidence artifacts where appropriate
- **Source doc**: `docs/plans/v2-followup-enhancements.md`

### Parallel `forEach` execution

- **Status**: unimplemented
- **What is missing**:
  - concurrent iteration execution model
  - semantics for result collection, ordering, and failure handling
- **Source doc**: `docs/plans/v2-followup-enhancements.md`

### Subagent composition chains

- **Status**: unimplemented
- **What is missing**:
  - chained subagent result flows such as researcher → challenger → analyzer
  - explicit composition model for delegated routines
- **Source doc**: `docs/plans/v2-followup-enhancements.md`

### Content coherence and linked references

- **Status**: implemented (core slices 1–4, 6 complete; slice 5 project-attached refs deferred)
- **What was delivered**:
  - `StepContentEnvelope` typed intermediate representation for agent-visible content categories
  - `WorkflowReference` declarations on `WorkflowDefinition` + `workflow.schema.json`
  - structural validation, compile-time hash inclusion, start-time async I/O resolution with injectable port
  - reference delivery as a dedicated MCP content item (start=full, rehydrate=compact, advance=none)
  - metaGuidance clarification (JSDoc + schema distinguishing it from references)
  - shared `resolveRefsAndBuildEnvelope` helper, parallel resolution, discriminated union types
- **What remains**:
  - project-attached references via `.workrail/references.json` with drift detection (future)
  - no workflow currently declares `references` (needs end-to-end validation with a real workflow)
- **Source doc**: `docs/plans/content-coherence-and-references.md`

### Authorable response supplements

- **Status**: unimplemented
- **What is missing**:
  - workflow schema surface
  - validation rules
  - contributor-facing authoring guidance
  - strong guardrails against authority dilution
- **Source docs**:
  - `docs/plans/agentic-orchestration-roadmap.md`
  - `docs/ideas/backlog.md`

### Multi-tenancy

- **Status**: unimplemented
- **What is missing**:
  - tenant/workspace isolation model beyond current local/workspace scoping
- **Source doc**: `docs/implementation/03-development-phases.md`

### Running-workflow upgrades

- **Status**: unimplemented
- **What is missing**:
  - workflow migration story for running sessions across schema/definition changes
- **Source doc**: `docs/implementation/03-development-phases.md`

## Ideas / parked directions

### Marketplace and workflow sharing

- **Status**: parked idea, partially subsumed by platform vision
- **Why parked**:
  - parts of external workflow repositories / plugin-style loading exist
  - a true marketplace product does not
  - the nearer-term sharing problems (team setup, cross-repo discovery, portable references) are now addressed in the platform vision
  - a true marketplace remains a later-stage concern
- **Source docs**:
  - `docs/implementation/03-development-phases.md`
  - `docs/features/external-workflow-repositories.md`
  - `docs/plans/workrail-platform-vision.md`

### Cloud adapter / cloud execution

- **Status**: parked idea
- **Why parked**:
  - mentioned as future adapter direction, but not currently close to delivery
- **Source doc**: `docs/plans/agentic-orchestration-roadmap.md`

### Derived / overlay workflows for bundled workflow specialization

- **Status**: parked idea, related to platform vision (future phase)
- **Why parked**:
  - linked references solved workflow-local document pointers, but consumers still cannot specialize a bundled workflow by attaching project-specific docs or guidance without forking it
  - there is likely a real future feature here around "task dev, but with my project’s implementation docs attached" or lightweight derived workflows
  - the shape is still unresolved: this could remain a narrow project-attached references feature or grow into a more general workflow overlay mechanism
- **What would need design**:
  - whether the additive surface is references only or a broader overlay/derivation model
  - how derived workflow identity, hashing, inspect output, and pinning work without losing determinism
  - how much override power should exist before the feature becomes a hidden forking system
- **Source docs**:
  - `docs/ideas/backlog.md`
  - `docs/plans/content-coherence-and-references.md`
  - `docs/features/external-workflow-repositories.md`
  - `docs/plans/workrail-platform-vision.md`

## Recommended grooming order

### Next to groom into tickets

1. **Complete v2 sign-off and cleanup**
2. **Expand lifecycle validation coverage**
3. **Finish prompt/supplement boundary alignment**

### After that

1. ~~**Content coherence and linked references**~~ (done — project-attached refs can be groomed separately)
2. **Composition and middleware engine**
3. **Progress notifications**
4. **Authorable response supplements** (design first, not direct implementation)

### Keep later

1. **Platform evolution** (discovery, sharing, portable references, MCP resources/prompts) -- see `docs/plans/workrail-platform-vision.md`
2. **Multi-tenancy**
3. **Running-workflow upgrades**
