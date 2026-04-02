# Open Work Inventory

This is the **normalized inventory** of work that is still open after consolidating the older roadmap and planning docs.

It separates:

- **active partials** — already started or partially shipped, but not really done
- **planned but unimplemented** — real initiatives that have not landed yet
- **ideas / parked directions** — worth keeping visible, but not current delivery commitments

Use this as the main source of truth when grooming roadmap items into tickets.

For explicit status on the major older planning docs themselves, see `docs/roadmap/legacy-planning-status.md`.

## Active partials

### 1. Retrieval budget and recovery-surface strengthening

- **Status**: active
- **Why it is here**: the old budget system was too conservative for agent usefulness, especially on `rehydrate` and `resume_session`
- **What was delivered so far**:
  - explicit retrieval contracts for rehydrate and resume preview surfaces
  - deterministic tiering with `core` vs `tail` retention behavior
  - larger bounded budgets for recovery packs and resume previews
  - stronger behavior tests covering tier dropping, bounded rendering, and usefulness-oriented scenarios
- **Still open**:
  - decide whether the current tier model needs refinement after more real usage
  - finish broader doc/spec cleanup wherever the old budget story still leaks through
  - decide whether checkpoint-related retrieval should stay as-is or follow the same contract pattern later
- **Source docs**:
  - `docs/design/v2-core-design-locks.md`
  - `docs/reference/workflow-execution-contract.md`

### ~~2. Clean response formatting and supplement hardening~~ (done)

- **Status**: complete
- **What was done**: the boundary between workflow-authored prompts and runtime-owned response supplements is documented consistently across authoring locks (`authoring.md`), the execution contract (`workflow-execution-contract.md`), and the authoring guide (`authoring-v2.md`). Supplements are runtime-owned today; authorable supplements are tracked as a future typed feature in the Next bucket.
- **Source docs**:
  - `docs/authoring.md` (lock rules: `keep-boundary-owned-guidance-out-of-step-prompts`, `one-time-supplements-are-policy-not-durable-state`)
  - `docs/authoring-v2.md` (response supplements section)
  - `docs/reference/workflow-execution-contract.md` (response content structure)
  - `docs/plans/agentic-orchestration-roadmap.md` (authorable supplements as future backlog)

### ~~3. V2 production readiness and sign-off~~ (done)

- **Status**: complete
- **What was done**: v2 is default-on (`v2Tools` flag defaults to `true` since 0.9.0). Stale docs referencing `WORKRAIL_ENABLE_V2_TOOLS` as a prerequisite have been updated with historical notes. Planning/roadmap docs no longer assume v2 needs unflagging.
- **Source docs**:
  - `docs/plans/workflow-v2-roadmap.md`
  - `docs/plans/workflow-v2-design.md`
  - `docs/plans/v2-followup-enhancements.md`

### 4. God-tier validation lifecycle coverage

- **Status**: partial
- **Why it is here**: the validation pipeline and registry validation are largely shipped, but the lifecycle-harness ambition is not fully closed
- **Still open**:
  - broaden lifecycle coverage beyond the small current set of lifecycle tests
  - decide the realistic target for bundled workflow lifecycle coverage
  - archive or simplify stale operator docs from the god-tier planning stack
- **Source docs**:
  - `docs/plans/workflow-validation-roadmap.md`
  - `docs/plans/workflow-validation-design.md`

### 5. Planning system adoption

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

### Console execution trace and engine explainability

- **Status**: unimplemented
- **What is missing**:
  - console DTOs that expose engine-level decisions alongside DAG nodes/edges
  - a run-level trace/explanation surface for `selected_next_step`, condition evaluation, loop entry/exit, and important run context
  - UX that distinguishes authoring phases from actual created execution nodes so fast paths do not look like missing steps
  - a clear console story for why the engine skipped, branched, or fast-pathed instead of only what node was created next
- **Why it is here**:
  - the engine already records decision and context events, but the console currently projects mostly node/edge state
  - this creates real user confusion when legitimate workflow behavior looks like a broken DAG
  - recent console work proved that a node-only view is not sufficient for understanding execution
- **Source docs**:
  - `docs/ideas/backlog.md`
  - `docs/plans/workrail-platform-vision.md`
  - `docs/reference/workflow-execution-contract.md`
  - `docs/design/v2-core-design-locks.md`

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
  - validate more real bundled workflows with `references`, beyond the newly added `production-readiness-audit.json` rubric reference
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

### Assessment-gate follow-up consequences

- **Status**: partial
- **What was delivered**:
  - workflow-level assessment declarations and step-level assessment refs / consequence declarations
  - boundary validation and canonical normalization for assessment artifacts on the existing output path
  - durable `assessment_recorded` and `assessment_consequence_applied` events plus projections
  - retryable same-step follow-up blocking with engine-owned framing and semantic guidance
  - one real bundled workflow pilot in `workflows/bug-investigation.agentic.v2.json`
- **What remains**:
  - broader adoption in a higher-value workflow, with `workflows/mr-review-workflow.agentic.v2.json` as the clearest next target
  - product UX calibration around follow-up wording and consequence visibility in a more widely used workflow
  - later-tier follow-up behavior beyond the narrow v1 same-step retry model
- **Why it is here**:
  - the engine feature is now real, but adoption is still intentionally narrow
  - the next decision is about rollout and workflow fit, not core engine feasibility
- **Source docs**:
  - `docs/ideas/backlog.md`
  - `docs/plans/mr-review-workflow-redesign.md`

### Legacy workflow modernization

- **Status**: partial / in progress
- **Recently shipped**:
  - `workflows/workflow-for-workflows.v2.json` now supports both creating a new workflow and modernizing an existing one (`#152`, from issue `#151`)
  - `workflows/workflow-for-workflows.v2.json` has now also been redesigned into a deeper workflow-quality gate with explicit effectiveness targeting, quality architecture, state-economy audit, execution simulation, adversarial review, redesign looping, and final trust handoff
  - `workflows/production-readiness-audit.json` was added and then tightened into an evidence-driven readiness review with readiness hypothesis, neutral fact packet, reviewer families, contradiction handling, blind-spot confidence capping, and explicit `security_performance` coverage
- **Active focus now**:
  - validate the redesigned quality gate and readiness audit on real tasks, then tune `STANDARD` vs `THOROUGH` depth and ceremony from evidence
  - next highest-value modernization candidate remains `workflows/exploration-workflow.json`
- **Why it is here**:
  - several bundled workflows are still authored in older styles
  - many are not `.v2` or `.lean.v2` variants
  - several do not yet use the newer authoring features and patterns now treated as the modern baseline in `docs/authoring.md`
- **Modern baseline to migrate toward**:
  - current v2/lean structure where appropriate
  - `metaGuidance` and `recommendedPreferences`
  - `references` for authoritative companion material where useful
  - `templateCall` / routine injection instead of repeating large prompt blocks
  - `promptFragments` for conditional branches instead of near-duplicate prompts
  - tighter loop-control wording and newer evidence-oriented review / verification structure
- **Highest-priority bundled workflows to revamp**:
  - `workflows/exploration-workflow.json`
  - `workflows/adaptive-ticket-creation.json`
  - `workflows/mr-review-workflow.json`
  - `workflows/mr-review-workflow.agentic.json`
  - `workflows/bug-investigation.json`
  - `workflows/bug-investigation.agentic.json`
  - `workflows/design-thinking-workflow.json`
  - `workflows/design-thinking-workflow-autonomous.agentic.json`
  - `workflows/documentation-update-workflow.json`
  - `workflows/document-creation-workflow.json`
- **Additional older bundled workflows to review for modernization**:
  - `workflows/intelligent-test-case-generation.json`
  - `workflows/learner-centered-course-workflow.json`
  - `workflows/presentation-creation.json`
  - `workflows/personal-learning-materials-creation-branched.json`
  - `workflows/scoped-documentation-workflow.json`
  - `workflows/relocation-workflow-us.json`
  - `workflows/workflow-diagnose-environment.json`
- **Lower priority / already more modern**:
  - `workflows/coding-task-workflow-agentic.v2.json` — superseded by the lean v2 variant as the current modern example
  - `workflows/workflow-for-workflows.json` — older large-form version; `workflow-for-workflows.v2.json` is now the deeper quality-gate path
  - `workflows/cross-platform-code-conversion.v2.json` — already v2 and already uses several modern authoring features
  - `workflows/bug-investigation.agentic.v2.json`
  - `workflows/mr-review-workflow.agentic.v2.json`
- **What “modernization” should mean here**:
  - do not mechanically rename files to `.v2` or `.lean`
  - instead, review each workflow for real migration value against the current authoring guide and engine capabilities
  - prefer high-value conversions first: workflows that are widely used, prompt-heavy, repetitive, or still missing modern review / routine / reference structure
- **Source docs**:
  - `docs/authoring.md`
  - `docs/ideas/backlog.md`

### Workflow-source setup phase 1

- **Status**: implemented (phase-1 rooted-sharing slice delivered across `#160`–`#164`)
- **What now exists**:
  - discovery-sensitive workflow surfaces require and use explicit `workspacePath`
  - WorkRail remembers repo/workspace roots at user scope
  - request-scoped workflow discovery recursively loads repo/module `.workrail/workflows/` under remembered roots
  - `list_workflows` / `inspect_workflow` expose source-aware visibility for built-in, personal, legacy project, rooted-sharing, and external workflows
  - legacy `./workflows` overlap with rooted-sharing now carries minimal precedence / migration explanation
- **What is intentionally deferred**:
  - generalized guided install for arbitrary third-party sources
  - full canonical source catalog work
  - final long-term `.workrail/*` config ownership split
- **Verification / evidence**:
  - focused workflow-source setup tests cover request-rooted discovery, remembered roots persistence, visibility outputs, and MCP schema contracts
  - current local verification passed with `npm run build` plus focused vitest coverage
- **Source docs**:
  - `docs/plans/workflow-source-setup-phase-1.md`
  - `docs/plans/workrail-platform-vision.md`

### Multi-tenancy

- **Status**: unimplemented
- **What is missing**:
  - tenant/workspace isolation model beyond current local/workspace scoping
### Running-workflow upgrades

- **Status**: unimplemented
- **What is missing**:
  - workflow migration story for running sessions across schema/definition changes

## Ideas / parked directions

### Marketplace and workflow sharing

- **Status**: parked idea, partially subsumed by platform vision
- **Why parked**:
  - parts of external workflow repositories / plugin-style loading exist
  - a true marketplace product does not
  - the nearer-term sharing problems (team setup, cross-repo discovery, portable references) are now addressed in the platform vision
  - a true marketplace remains a later-stage concern
- **Source docs**:
  - `docs/reference/external-workflow-repositories.md`
  - `docs/plans/workrail-platform-vision.md`

### Cloud adapter / cloud execution

- **Status**: parked idea
- **Why parked**:
  - mentioned as future adapter direction, but not currently close to delivery
- **Source doc**: `docs/plans/agentic-orchestration-roadmap.md`

### Dashboard artifacts (replace file-based docs with session-scoped outputs)

- **Status**: designed, unimplemented
- **Summary**: instead of having agents write markdown files into the repo, agents would submit structured artifacts through `continue_workflow` output payloads. These artifacts are stored per-session and rendered in the console/dashboard. Default: per-step `notesMarkdown` rendering. Explicit: workflow-defined output contracts via `wr.contracts.*` packs with server-side reducers.
- **What exists**:
  - full design in `workflow-execution-contract.md` (section "Replacing File-Based Docs with Dashboard Artifacts")
  - illustrative examples for `mr-review-workflow` (triage, changed files table, findings, MR comments)
  - output contract enforcement model in v2 (contract packs, blocked node validation)
  - `notesMarkdown` already flows through `continue_workflow`
- **What is missing**:
  - console/dashboard UI to render artifacts (no UI exists yet)
  - server-side artifact storage and reducers
  - contract pack definitions beyond `wr.contracts.loop_control`
  - migration path for existing workflows that write markdown files
- **Source doc**: `docs/reference/workflow-execution-contract.md`

### Console engine-trace visibility and phase UX

- **Status**: active idea / not yet designed into a ticket
- **Why parked here**:
  - the console currently emphasizes created nodes but hides the engine choices that explain sparse or surprising DAG shapes
  - workflows still use phase-oriented authoring language, and the console currently does not explain skipped phases or fast-path branches
  - there is likely a real UX redesign here around “execution DAG vs engine trace” rather than a single missing component
- **What would need design**:
  - whether phases stay visible in the console primary UI or become secondary authoring metadata
  - what run-context variables and decision-trace entries should be elevated into first-class console DTOs
  - how to present trace events without making the run surface noisy
  - whether to use a timeline, annotations, combined run narrative, or separate explainability mode
- **Source docs**:
  - `docs/ideas/backlog.md`
  - `docs/plans/workrail-platform-vision.md`

### Standup Status Generator workflow

- **Status**: idea
- **Summary**: a workflow that generates daily standup status by aggregating activity across the user's tools (git history, GitLab MRs, Jira tickets, etc.) since the last standup date
- **What would need design**:
  - tool-agnostic integration discovery (detect available MCP tools at runtime)
  - lightweight persistence for last-standup timestamp
  - output categorization (did / doing / blockers) and configurable format
- **Source doc**: `docs/ideas/backlog.md`

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
  - `docs/reference/external-workflow-repositories.md`
  - `docs/plans/workrail-platform-vision.md`

## Recommended grooming order

### Next to groom into tickets

1. **Workflow-source setup phase 1**
2. **Assessment-gate adoption in MR review**
3. **Composition and middleware engine**
4. **Progress notifications**
5. **Authorable response supplements** (design first, not direct implementation)

### Recently completed

- ~~**Complete v2 sign-off and cleanup**~~ (done)
- ~~**Expand lifecycle validation coverage**~~ (done -- auto-walk smoke test)
- ~~**Finish prompt/supplement boundary alignment**~~ (done)
- ~~**Content coherence and linked references**~~ (done)

### Keep later

1. **Platform evolution** (discovery, sharing, portable references, MCP resources/prompts) -- see `docs/plans/workrail-platform-vision.md`
2. **Multi-tenancy**
3. **Running-workflow upgrades**
