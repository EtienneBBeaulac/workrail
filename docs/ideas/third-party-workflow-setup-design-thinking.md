# Third-Party Workflow Setup Design Thinking

> This is the **design-thinking / exploration doc** for this topic.
>
> For the **canonical near-term plan/design**, prefer `docs/plans/workflow-source-setup-phase-1.md`.

## Context / Problem

### Current state

- WorkRail can load workflows from multiple source kinds:
  - bundled workflows
  - user workflows in `~/.workrail/workflows/`
  - project workflows in `./workflows/`
  - custom directories via `WORKFLOW_STORAGE_PATH`
  - Git repositories via `WORKFLOW_GIT_REPOS` / `WORKFLOW_GIT_REPO_URL`
  - remote registries via `WORKFLOW_REGISTRY_URL`
  - plugin paths through plugin storage configuration
- The current user-facing setup experience is still fragmented and env-first.
- The current source model is stronger than the UX:
  - `EnhancedMultiSourceWorkflowStorage` already unifies multiple source kinds internally
  - graceful degradation and source precedence already exist
  - auth resolution for Git hosts already exists
- Current v2 MCP workflow tools already accept `workspacePath`, but `list_workflows` and `inspect_workflow` do not currently require it.
- Current workspace resolution still falls back through:
  - explicit `workspacePath`
  - then MCP roots
  - then server process cwd
- There is a mismatch between the current shipped setup UX and the future direction already described in `docs/plans/workrail-platform-vision.md`, which proposes:
  - `.workrail/config.json`
  - configured workspace roots
  - auto-discovery of `.workrail/workflows/`
  - setup prompts instead of manual env authoring
- The exact ownership of `.workrail/config.json` is still under-specified:
  - planning docs use it as the likely home for remembered roots / source setup
  - other repo artifacts already use it as a local environment / capability cache
  - phase-1 design should avoid turning it into an overloaded catch-all without a clearer file-ownership model

### User problem

- Hooking up third-party workflows currently feels like infrastructure wiring rather than product setup.
- The user has to understand multiple env vars, source kinds, auth conventions, and source precedence.
- Some current names are misleading:
  - `WORKFLOW_GIT_REPOS` also accepts local paths and `file://` URLs
  - source configuration is split across multiple variables that all conceptually mean "where should WorkRail find workflows?"
- The CLI helps only partially:
  - `workrail init` initializes `~/.workrail/workflows/`
  - `sources` only surfaces bundled, user, project, and custom path sources
  - Git, remote registry, and plugin sources are not surfaced coherently in the current CLI UX
- MCP roots are not trustworthy enough to be the primary source of workspace identity for workflow discovery decisions.

### Opportunity

- Make third-party workflow hookup feel like:
  - installing a package
  - adding a repo once
  - importing a workflow from a URL or path
  - or doing nothing because the right workflows are auto-discovered
- Let WorkRail help users set this up instead of forcing them to hand-edit MCP env config in their IDE.
- Let WorkRail silently remember relevant repos in user-level config so cross-repo workflows improve over time without requiring repo changes.

## Persona

- **Primary persona**: developer or team lead who found a useful workflow collection and wants WorkRail to use it with minimal setup friction
- **Job-to-be-done**: "I found workflows I want. Make them available in WorkRail quickly, safely, and in a way that will keep working."
- **Secondary persona**: team maintaining shared workflows across repos or modules who wants teammates to get the workflows with near-zero manual setup

## Persona card (primary)

- **Name**: Alex, the workflow adopter
- **Context**: Alex is using WorkRail through an MCP client / agentic IDE and has found a useful workflow repo, directory, or package that they want to make available quickly.
- **Goals**:
  - get third-party workflows working with minimal setup
  - avoid learning multiple configuration surfaces
  - understand whether the setup is personal, team-shared, or repo-local
  - trust that the resulting setup will keep working across sessions and teammates
- **Pains**:
  - setup is fragmented across multiple env vars and concepts
  - source kinds are exposed as implementation details
  - some field names do not match actual behavior
  - current tooling does not fully explain active sources or failures
- **Constraints**:
  - may be using a hosted or local IDE with limited willingness to edit MCP config by hand
  - may need to connect to private or self-hosted Git
  - may need a setup that is either personal-only or team-shareable
- **Quotes/observations (from evidence we have)**:
  - Observation: current source configuration is split across `WORKFLOW_STORAGE_PATH`, `WORKFLOW_GIT_REPOS`, `WORKFLOW_GIT_REPO_URL`, `WORKFLOW_REGISTRY_URL`, include flags, and auth env vars.
  - Observation: `WORKFLOW_GIT_REPOS` accepts local paths and `file://` URLs in addition to true Git remotes.
  - Observation: `workrail init` only initializes `~/.workrail/workflows/` with a sample workflow and does not help attach third-party sources.
  - Observation: `sources.ts` only reports bundled, user, project, and custom sources, even though runtime storage supports git, remote, and plugin sources.
  - Observation: `docs/plans/workrail-platform-vision.md` already proposes `.workrail/config.json`, configured workspace roots, recursive `.workrail/workflows/` discovery, and a setup prompt.

## POV + HMW

### Point of view

- Users want WorkRail to feel like it understands workflow sources as a product concern, not as a low-level server configuration problem.
- WorkRail already has enough storage architecture to support a much better experience, but the configuration surface and setup path lag behind that capability.

### How might we

- How might we make connecting third-party workflows feel nearly automatic?
- How might we let WorkRail own the setup journey instead of outsourcing it to manual `firebender.json` edits?
- How might we support local folders, repos, self-hosted Git, registries, and shared team workflows without making users learn each source type separately?
- How might we preserve explicitness, safety, and debuggability while making the common path dramatically simpler?

## POV (Point of View)

- **Alex, the workflow adopter** needs a way to share and connect workflows through a simple, guided, and inspectable setup flow because the current env-first model exposes storage and auth details too early and does not make the resulting source provenance easy enough to verify.

## Problem statement (2–4 lines)

- WorkRail already supports multiple workflow source kinds, but the setup experience is fragmented, implementation-shaped, and too dependent on manual MCP/env configuration.
- This makes connecting third-party workflows feel like server wiring instead of a product capability.
- The result is unnecessary cognitive load for individuals and a weak sharing story for teams.

## Alternative framings (2)

- **Alternative framing 1**: The real problem may be less about configuration shape and more about the absence of a first-class install/setup flow. In that framing, even messy underlying config could be acceptable if WorkRail reliably hides it behind guided setup.
- **Alternative framing 2**: The real problem may be workflow discovery and provenance, not connection itself. In that framing, users may tolerate setup complexity if WorkRail clearly shows what is available, where it came from, and why it is or is not working.

## How might we… (3–7)

- How might we make "connect this workflow source" a single user intent regardless of whether the source is a local folder, Git repo, or registry?
- How might we move canonical workflow-source configuration into `.workrail/` so it feels like WorkRail configuration rather than MCP wiring?
- How might we let WorkRail guide setup for private and self-hosted Git without forcing users to learn hostname-derived token rules?
- How might we maximize team sharing through repo-local conventions and root registration rather than per-user MCP edits?
- How might we preserve explicit source provenance, precedence, and diagnostics while simplifying the common path?
- How might we make verification of “where these workflows came from” simple enough that users trust the result immediately after setup?
- How might we keep weaker models and mixed old/new docs on the preferred setup path instead of drifting back to legacy env-first advice?

## Success criteria (measurable where possible)

- A user can connect a common third-party workflow source in **one primary flow** without reading env-var reference docs.
- Common cases fit within **1–3 deliberate user actions** after the user has the source URL/path.
- WorkRail can explain **all active workflow sources** with type, scope, provenance, and health.
- A repo-local team sharing pattern exists that does **not** require each teammate to hand-author multiple source env vars.
- When rooted-sharing and legacy env-based sources coexist, WorkRail can explain precedence clearly enough that users understand why a workflow is visible.
- `workspacePath` is always explicit and required for workflow discovery-sensitive tools, so WorkRail never silently anchors discovery to untrusted MCP roots or server cwd.
- Cross-repo workflows can surface from user-remembered repo roots without requiring the current repo to vendor or merge shared workflows.
- Self-hosted Git setup works through either:
  - guided HTTPS auth setup, or
  - SSH setup with no token ceremony
- Existing env-var configurations continue to work during migration.

## Key tensions / tradeoffs

- **Convention vs explicit registration**: auto-discovery reduces setup but can make source provenance less obvious if overused.
- **Install/import vs live mount**: importing into `.workrail/` may simplify runtime behavior, while live sources preserve freshness and reduce duplication.
- **Project-local vs user-global config**: project config helps sharing; user config helps personal portability.
- **Automation vs portability**: WorkRail-managed setup can be great, but MCP client config is outside WorkRail’s full control in some environments.
- **Simplicity vs debuggability**: hiding complexity helps the happy path, but users still need a trustworthy mental model when something breaks.

## Assumptions

- Users would prefer a WorkRail-owned setup flow over manual MCP env editing.
- The `.workrail/` namespace is an acceptable home for workflow-source configuration, but the exact split between user-global root memory, repo-local metadata, and other `.workrail/*` files still needs to be designed explicitly.
- Team-sharing is important enough to prioritize over a purely personal setup model.
- The existing internal source abstraction is sufficient foundation for a cleaner UX without a major storage rewrite.
- A guided setup flow can handle self-hosted/private Git well enough to materially reduce user confusion.

## Riskiest assumption (pick one)

- **Riskiest assumption**: users want WorkRail itself to own setup and configuration of workflow sources, rather than preferring explicit manual control through their MCP client config.

## What would change our mind?

- Evidence that most users already succeed with the current env-first setup and that their real pain is choosing, finding, or trusting workflows rather than connecting them.
- Evidence that users or teams strongly prefer explicit MCP-managed configuration and are uncomfortable with WorkRail-managed config under `.workrail/`.
- Technical constraints showing that WorkRail cannot provide a reliable cross-client guided setup experience without brittle IDE-specific behavior.

## Out-of-scope

- Redesigning the workflow execution protocol itself
- Changing durable session/storage architecture unrelated to workflow source setup
- Solving trust/signing for all third-party workflow distribution in this pass
- Reworking the full workflow discovery taxonomy beyond what is necessary for setup and source visibility

### Definition reflection

- **What would change our mind about the problem framing?**
  - strong evidence that the main pain is discovery/trust rather than hookup
  - strong evidence that users prefer explicit MCP-level control over WorkRail-managed setup
- **What is the riskiest assumption?**
  - that WorkRail-owned setup is more desirable than explicit external configuration

## Success criteria

- A new user can connect a third-party workflow source without reading detailed env-var documentation.
- Common setup paths are discoverable from within WorkRail itself.
- Team-sharing works through conventions and stable project-local config, not only personal IDE config.
- Self-hosted Git and auth remain possible without forcing users to understand hostname-to-env-var rules up front.
- The system keeps a clear, inspectable model of where workflows came from and why they are available.
- Existing env-var based setups remain backward compatible.
- Failure states are diagnosable and expressed in user language.

## Journey map (lightweight)

- **Step**: Find a workflow source
  - **Pain**: user has a URL/path/repo but no obvious "install" or "connect" entry point
  - **Opportunity**: support a single user intent such as "install this workflow source"
- **Step**: Decide where config belongs
  - **Pain**: unclear whether setup should live in IDE MCP config, repo config, user config, or env vars
  - **Opportunity**: establish a canonical `.workrail/` config model with clear personal vs project scopes
- **Step**: Authenticate if private/self-hosted
  - **Pain**: auth conventions are real but implicit; hostname-derived env var rules are not user-friendly
  - **Opportunity**: let WorkRail infer auth needs and guide the user through the minimum required secret wiring
- **Step**: Verify discovery
  - **Pain**: current source inspection is incomplete and does not reflect all runtime source kinds
  - **Opportunity**: expose a full source inventory with provenance, health, and precedence
- **Step**: Share with team
  - **Pain**: current model makes personal MCP config too central for something that often wants repo-level sharing
  - **Opportunity**: favor repo-local `.workrail/` conventions and one-time root registration

## Observations (5)

- **O1**: `EnhancedMultiSourceWorkflowStorage` already supports local directories, Git repositories, remote registries, and plugin sources behind one internal abstraction.
- **O2**: The public configuration surface is fragmented across multiple env vars, rather than one canonical source model.
- **O3**: `WORKFLOW_GIT_REPOS` is semantically overloaded; it accepts remote Git URLs, SSH Git URLs, `file://` URLs, and absolute local paths.
- **O4**: `workrail init` is currently narrow; it creates `~/.workrail/workflows/` and a sample workflow, but does not help connect external sources.
- **O5**: The repo’s platform vision already describes a simpler future centered on `.workrail/config.json`, workspace roots, recursive `.workrail/workflows/` discovery, and a setup prompt.

## Insights (5)

- **I1**: The hardest part of setup is likely not missing storage capability but missing productized setup UX.  
  - **Evidence**: O1, O2, O4
- **I2**: The current configuration vocabulary leaks implementation details and creates unnecessary cognitive load.  
  - **Evidence**: O2, O3
- **I3**: WorkRail already contains the architectural seeds of a better experience, so the right move is probably evolutionary rather than inventing a net-new system.  
  - **Evidence**: O1, O5
- **I4**: Team workflow sharing likely wants repo-local convention and discovery more than personal IDE configuration.  
  - **Evidence**: O5, quote/observation about team-sharing desire in the Persona section
- **I5**: Source visibility and diagnostics are part of the setup experience, not a separate afterthought. If users cannot inspect active sources clearly, setup will still feel fragile even if connection succeeds.  
  - **Evidence**: O4, quote/observation about incomplete `sources.ts`, O2

## Evidence

- **Facts we have**:
  - runtime source kinds are first-class in `src/types/workflow-source.ts`
  - current setup is env-first in `docs/configuration.md`
  - runtime loading is unified in `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts`
  - self-hosted Git auth resolution already exists in hostname-derived form
  - current CLI setup and source inspection are narrower than runtime capabilities
  - planning docs already point toward `.workrail/config.json` and auto-discovery
- **Evidence gaps**:
  - we do not yet have direct user research or usage telemetry showing which setup paths are most common
  - we do not yet know whether users prefer "install/import" semantics or "register source" semantics
  - we do not yet know how much MCP client automation is realistically possible across IDEs without becoming brittle
  - we do not yet know which failure modes are most frequent in practice

## Constraints (environment/tooling/model)

- Must remain backward compatible with existing env-var based configuration.
- Must preserve current validation, security checks, and source precedence semantics unless intentionally changed.
- Must support local paths, repo-local sharing, remote Git, and self-hosted Git.
- Should not trust MCP roots enough to use them as the authoritative workspace identity for workflow discovery.
- Should not assume WorkRail can safely mutate every MCP client configuration automatically.
- Should align with existing `.workrail/` concepts already present in the repo, especially `.workrail/bindings.json` and planned `.workrail/config.json`.
- Should avoid overloading `.workrail/config.json` with unrelated responsibilities if user-level remembered roots and environment/capability state both need durable storage.
- The WorkRail process is not inherently tied to one repo, so repo context must come from explicit caller input and user-level remembered roots.

## Observed pain themes (5–10)

- fragmented configuration surface
- source-type leakage into user setup
- misleading names for overloaded fields
- incomplete source inspection UX
- setup is personal-config centric instead of team-sharing centric
- auth rules are technically sound but ergonomically hidden
- current install/setup flow is too manual
- current UX makes users reason about storage internals too early

## Unknowns (explicit list)

- Should the canonical user action be "install this workflow" or "add this workflow source"?
- Should remote Git remain a live runtime source, or should it primarily be an import/install mechanism into `.workrail/`?
- Should `.workrail/config.json` be user-global, project-local, or layered?
- Should user-level remembered roots and repo-local metadata live in the same config file or in separate `.workrail/*` files?
- How much auto-discovery is desirable before source provenance becomes confusing?
- Should public/community workflows be installed into user storage, mounted as sources, or both?
- What should the trust model be for auto-installing or auto-discovering third-party sources?
- What is the smallest migration bridge that keeps current `./workflows`, `~/.workrail/workflows/`, and env-based sources understandable while the preferred rooted-sharing path is introduced?

## Interpretation risks (3)

- We may be over-reading env-var complexity as the main pain when the deeper pain could actually be lack of an install/setup flow.
- We may be over-generalizing from the platform vision docs, which could reflect desired future direction rather than validated user need.
- Some of what appears to be poor UX may be deliberate separation of concerns between MCP client config and WorkRail runtime config.

### Reflection

- **Which pain themes are likely symptoms vs root causes?**
  - likely symptoms:
    - fragmented env vars
    - incomplete source inspection
    - hidden auth conventions
  - likely root causes:
    - no canonical setup model
    - no productized install/setup flow
    - config ownership split awkwardly between MCP client config and WorkRail runtime concerns
- **What would we need to observe to disprove our top 1–2 interpretations?**
  - If users mostly succeed once they have docs and rarely ask for setup help, then setup complexity may be acceptable and the real issue may be discovery, not configuration.
  - If teams strongly prefer explicit MCP env control and distrust WorkRail-managed config, then a `.workrail/config.json`-first solution may be less desirable than it appears.

## Idea Backlog (append-only)

- DT-001: Replace fragmented env vars with a single canonical source model in `.workrail/config.json`.
- DT-002: Add setup/install flows so users can say "install this workflow source" and WorkRail handles the config.
- DT-003: Prefer convention and auto-discovery over explicit registration where possible.
- DT-004: Separate "install/import" from "runtime source resolution" if that reduces complexity.
- DT-005: Improve source introspection UX so users can see all active sources, their type, health, and precedence.

### Idea Backlog (Round 1)

- **DT-001 — Canonical `.workrail/config.json`**
  - **Category**: configuration model
  - **Sketch**: Introduce a canonical layered config model under `.workrail/`, with user-level remembered roots / source state and any repo-local metadata split deliberately enough that env vars can become legacy overrides without `.workrail/config.json` turning into an overloaded catch-all.
  - **Why it might help**: moves workflow-source configuration into WorkRail’s own domain and out of ad hoc MCP env wiring while leaving room for clearer file ownership.
  - **Open question**: which data belongs in `~/.workrail/config.json`, which belongs in repo-local `.workrail/*`, and which should remain separate from environment / capability state?

- **DT-002 — `workrail install <url-or-path>`**
  - **Category**: installation UX
  - **Sketch**: Add a CLI / MCP-facing install action that accepts a URL or path and chooses the right setup path automatically.
  - **Why it might help**: turns many source types into one user intent.
  - **Open question**: should install create a live source or import files into a managed location?

- **DT-003 — Setup workflow for source hookup**
  - **Category**: installation UX
  - **Sketch**: Ship a dedicated WorkRail workflow that interviews the user, detects source type, explains scope options, and configures the source.
  - **Why it might help**: WorkRail would demonstrate its own product philosophy while hiding setup complexity.
  - **Open question**: how much can it automate across different MCP clients vs only guiding the user?

- **DT-004 — Auto-detect repo-local `.workrail/workflows/`**
  - **Category**: discovery / convention
  - **Sketch**: Auto-discover `.workrail/workflows/` inside configured workspace roots and ancestor repos.
  - **Why it might help**: makes team sharing convention-based and almost zero-config after root registration.
  - **Open question**: how aggressive should recursive scanning be?

- **DT-005 — One-time root registration**
  - **Category**: sharing model
  - **Sketch**: Let users register a repo or monorepo as a workspace root once, then discover `.workrail/workflows/` within it automatically.
  - **Why it might help**: shifts from per-source setup to per-root setup.
  - **Open question**: should WorkRail infer likely roots from the current workspace automatically?

- **DT-006 — Source doctor / diagnostics command**
  - **Category**: diagnostics
  - **Sketch**: Add `workrail sources --doctor` or equivalent MCP flow that validates every source, auth path, cache, and discovery decision.
  - **Why it might help**: setup only feels simple if failures are easy to understand.
  - **Open question**: what should the output contract be for agentic consumption?

- **DT-007 — Guided self-hosted Git auth helper**
  - **Category**: auth UX
  - **Sketch**: Ask for a self-hosted Git URL, derive the expected token env var name, and guide the user through HTTPS token or SSH setup.
  - **Why it might help**: removes the need to memorize hostname-to-env-var rules.
  - **Open question**: should WorkRail ever write secrets, or only tell the user exactly where to put them?

- **DT-008 — Live source vs imported copy mode**
  - **Category**: installation model
  - **Sketch**: Every install flow offers two modes:
    - `mount`: keep a live external source
    - `import`: copy or clone into managed `.workrail/` storage
  - **Why it might help**: makes the tradeoff explicit and matches different trust/freshness needs.
  - **Open question**: which mode should be default for which source types?

- **DT-009 — Source manifest per installed source**
  - **Category**: provenance
  - **Sketch**: Represent each connected source as a manifest file in `.workrail/sources/` with type, scope, origin, health, and install metadata.
  - **Why it might help**: gives inspectable durable truth and avoids a single opaque mega-config.
  - **Open question**: is one file per source better than a single aggregated config?

- **DT-010 — Human-friendly source names**
  - **Category**: UX polish
  - **Sketch**: Allow source aliases like `team-workflows`, `payments-module`, or `alex-private-library`.
  - **Why it might help**: reduces raw URL/path exposure in day-to-day usage.
  - **Open question**: how should aliases interact with source precedence and ambiguity?

- **DT-011 — Install from repository URL with smart defaults**
  - **Category**: installation UX
  - **Sketch**: If the user gives a Git URL, WorkRail infers branch `main`, chooses cache location, validates structure, and proposes the right scope.
  - **Why it might help**: removes most Git-specific setup ceremony.
  - **Open question**: how should fallback behavior work when `main` is missing?

- **DT-012 — Install from a workflow directory artifact**
  - **Category**: packaging / distribution
  - **Sketch**: Treat a workflow directory with co-located refs as a first-class install unit, not just single `.json` files.
  - **Why it might help**: aligns with the platform vision’s portability story.
  - **Open question**: how should references be validated and preserved on install?

- **DT-013 — Recommend likely sources in current workspace**
  - **Category**: auto-detection
  - **Sketch**: On first run or on demand, WorkRail scans the workspace for likely workflow folders or repos and offers to attach them.
  - **Why it might help**: makes setup proactive instead of doc-driven.
  - **Open question**: how do we avoid noisy or creepy-feeling suggestions?

- **DT-014 — Source visibility inside `list_workflows`**
  - **Category**: discovery UX
  - **Sketch**: Present workflows grouped by source and scope, with clear labels for built-in, user, repo-local, installed, imported, and external.
  - **Why it might help**: users understand the outcome of setup immediately.
  - **Open question**: how much source detail should be exposed without overwhelming agents?

- **DT-015 — Health states for sources**
  - **Category**: diagnostics
  - **Sketch**: Assign explicit states like `active`, `stale`, `auth-needed`, `missing`, `invalid`, `shadowed`.
  - **Why it might help**: makes source issues explainable and scriptable.
  - **Open question**: which states should block discovery vs degrade gracefully?

- **DT-016 — Project-scoped shareable config + user overrides**
  - **Category**: config layering
  - **Sketch**: Put team-default sources in repo `.workrail/config.json`, with user-private overrides in `~/.workrail/config.json`.
  - **Why it might help**: balances team sharing and personal customization cleanly.
  - **Open question**: what should the merge / precedence rules be?

- **DT-017 — “Make this repo a workflow library” helper**
  - **Category**: sharing / authoring
  - **Sketch**: Add a setup helper that prepares a repo for sharing workflows by creating `.workrail/workflows/`, optional refs layout, and config stubs.
  - **Why it might help**: simplifies the producer side as well as the consumer side.
  - **Open question**: should this be CLI-only, workflow-driven, or both?

- **DT-018 — Explicit trust / review gate for third-party installs**
  - **Category**: trust model
  - **Sketch**: Before enabling a third-party source, show its origin, files, permissions implications, and whether it is being mounted or imported.
  - **Why it might help**: keeps simplification from becoming opaque or unsafe.
  - **Open question**: how lightweight can the trust review be without becoming annoying?

- **DT-019 — Source lockfile / snapshot pinning**
  - **Category**: reproducibility
  - **Sketch**: Allow users or teams to pin external workflow sources to a commit, tag, or snapshot.
  - **Why it might help**: makes team behavior stable and debuggable even when using external Git.
  - **Open question**: should this be source-level or workflow-level?

- **DT-020 — “Just use this folder” ultra-simple mode**
  - **Category**: simplest path
  - **Sketch**: Support a dead-simple path where the user points WorkRail at a folder once and everything there is treated as a local workflow library.
  - **Why it might help**: covers the most basic case with minimal ceremony.
  - **Open question**: should this live as a shortcut on top of the richer source model or as a separate entry point?

### Idea Backlog (Round 2)

- **DT-021 — Workflow source inbox**
  - **Category**: analogy / logistics
  - **Sketch**: Treat third-party workflow hookup like an inbox. Users drop URLs, paths, or artifacts into a queue, and WorkRail classifies, validates, and offers installation actions.
  - **Why it might help**: separates “I found something” from “I know exactly how it should be wired.”
  - **Open question**: should the inbox be explicit (`.workrail/inbox/`) or conversational only?

- **DT-022 — Package manager style channels**
  - **Category**: analogy / package management
  - **Sketch**: Users subscribe to channels like `built-in`, `team`, `community`, `private`, each with distinct trust and update defaults.
  - **Why it might help**: simplifies mental models by grouping sources around intent rather than storage kind.
  - **Open question**: how much source flexibility is lost if channels become the main UX?

- **DT-023 — Compiler-style source graph**
  - **Category**: analogy / compilers
  - **Sketch**: Model workflow sources as a resolved graph with layers, shadowing, diagnostics, and normalized provenance similar to an import/module graph.
  - **Why it might help**: gives a precise, debuggable internal and user-facing model.
  - **Open question**: can that power be exposed simply enough for users?

- **DT-024 — Aviation preflight checklist for source enablement**
  - **Category**: analogy / aviation
  - **Sketch**: Every new source goes through a short preflight: reachable, valid structure, auth OK, trust OK, precedence clear, refs resolvable.
  - **Why it might help**: turns hidden failure modes into a consistent verification ritual.
  - **Open question**: how do we keep the preflight lightweight for local/simple cases?

- **DT-025 — Healthcare intake form for setup**
  - **Category**: analogy / healthcare
  - **Sketch**: Ask a small number of triage questions first:
    - where is the source?
    - who should see it?
    - how should it update?
    - is it private?
  - **Why it might help**: leads users to the right model without exposing implementation vocabulary.
  - **Open question**: which questions are essential vs annoying?

- **DT-026 — Financial portfolio view for sources**
  - **Category**: analogy / finance
  - **Sketch**: Show a portfolio of workflow sources with risk/trust, freshness, scope, and contribution to the available workflow catalog.
  - **Why it might help**: encourages an inspectable, managed relationship with sources rather than invisible background state.
  - **Open question**: is this overkill for most users?

- **DT-027 — Root-only world (constraint: assume only files)**
  - **Category**: constraint inversion
  - **Sketch**: Assume there are no remote live sources at runtime. Everything must be files in discovered `.workrail/workflows/` directories under known roots.
  - **How the constraint changes the solution**: pushes WorkRail to focus on import/install and root registration instead of runtime source heterogeneity.
  - **Why it might help**: radically simplifies runtime behavior and provenance.
  - **Open question**: does giving up live remote sources hurt freshness too much?

- **DT-028 — No JSON config (constraint: assume no JSON)**
  - **Category**: constraint inversion
  - **Sketch**: Assume there is no `.workrail/config.json`. Setup must be represented only by directory conventions, source manifests, or simple single-purpose files.
  - **How the constraint changes the solution**: favors convention and per-source artifacts over centralized configuration.
  - **Why it might help**: reduces config syntax burden and merge-conflict pain.
  - **Open question**: when does convention become too implicit?

- **DT-029 — Stateless setup assistant (constraint: assume no state)**
  - **Category**: constraint inversion
  - **Sketch**: Assume WorkRail cannot retain setup wizard state between turns. The setup flow must be idempotent and infer everything from current files, roots, and user input each time.
  - **How the constraint changes the solution**: favors deterministic re-scans and explicit manifests over hidden session state.
  - **Why it might help**: improves resilience and debuggability.
  - **Open question**: how much user convenience is lost without remembered partial setup state?

- **DT-030 — Event-only source setup (constraint: assume only events)**
  - **Category**: constraint inversion
  - **Sketch**: Treat source configuration changes as append-only setup events that project into the current effective source set.
  - **How the constraint changes the solution**: creates a history of why a source was added, changed, disabled, or removed.
  - **Why it might help**: setup becomes auditable and reversible.
  - **Open question**: is this too heavy for user-facing configuration?

- **DT-031 — File-only setup terminal (constraint: assume only files)**
  - **Category**: constraint inversion
  - **Sketch**: Assume the only durable interface is file drops. Users connect sources by creating files in `.workrail/sources/` such as `team.repo`, `community.link`, `payments.local`.
  - **How the constraint changes the solution**: each source becomes a tangible artifact instead of a field inside a config blob.
  - **Why it might help**: makes source lifecycle inspectable and composable.
  - **Open question**: what file format keeps this simple without inventing mini-languages?

- **DT-032 — Opposite of auto-detect: explicit attach only**
  - **Category**: inversion
  - **Sketch**: Assume auto-discovery is harmful. Users must explicitly attach every source, but WorkRail makes attachment highly guided and safe.
  - **Why it might help**: maximum clarity and provenance.
  - **Open question**: could very strong guided attach UX outperform noisier discovery-heavy systems?

- **DT-033 — Opposite of live sources: install snapshots only**
  - **Category**: inversion
  - **Sketch**: Never mount live external sources at runtime. Every install resolves to a local snapshot with explicit update actions.
  - **Why it might help**: source behavior becomes reproducible and trust review becomes clearer.
  - **Open question**: can manual updates stay light enough for users?

- **DT-034 — Game-style unlock progression**
  - **Category**: analogy / game design
  - **Sketch**: Expose setup in progressive layers:
    - basic local folder
    - repo sharing
    - remote Git
    - private/self-hosted
    - advanced registries/plugins
  - **Why it might help**: beginners aren’t overwhelmed by the full capability surface.
  - **Open question**: how do we avoid making advanced users feel patronized?

- **DT-035 — Source recipes**
  - **Category**: abstraction
  - **Sketch**: Define a small set of user-facing recipes such as:
    - `use this folder`
    - `use this repo`
    - `share workflows in this repo`
    - `install this workflow pack`
  - **Why it might help**: recipes may be the right user abstraction above raw source types.
  - **Open question**: can recipes cover edge cases without re-exposing the underlying complexity?

- **DT-036 — Repo badge / self-describing workflow library**
  - **Category**: producer UX
  - **Sketch**: A repo declares itself as a workflow library with a tiny `.workrail/library.json` or marker file so consumers get better install hints.
  - **Why it might help**: allows smarter detection and clearer trust/provenance.
  - **Open question**: what is the minimum metadata needed?

- **DT-037 — Source compatibility report**
  - **Category**: diagnostics / trust
  - **Sketch**: Before or after install, WorkRail generates a compatibility report covering:
    - schema validity
    - references portability
    - source freshness strategy
    - likely client limitations
  - **Why it might help**: avoids half-working setups.
  - **Open question**: should this be a blocking gate or advisory?

- **DT-038 — Multi-root as the primary abstraction**
  - **Category**: config model
  - **Sketch**: Make workspace roots the main thing users configure; most other source paths become consequences of root membership and conventions.
  - **Why it might help**: reduces the number of concepts users need to understand.
  - **Open question**: how should purely personal, non-workspace sources fit into a root-first model?

- **DT-039 — Source sandbox tiers**
  - **Category**: trust / safety
  - **Sketch**: Assign tiers such as `trusted-team`, `personal`, `external-reviewed`, `external-unreviewed`, and vary defaults for update behavior and visibility.
  - **Why it might help**: trust becomes first-class without requiring deep security knowledge.
  - **Open question**: how much policy should WorkRail impose vs expose?

- **DT-040 — Setup as generated patch proposal**
  - **Category**: agent collaboration
  - **Sketch**: Rather than mutating config directly, WorkRail proposes concrete changes to `.workrail/` files and optionally MCP config, then asks the user to approve.
  - **Why it might help**: balances automation with explicit user control.
  - **Open question**: which files should WorkRail be allowed to patch automatically vs propose only?

### Derived ideas (Round 3)

- **DT-041 — Source catalog primitive**
  - **Category**: product primitive
  - **Built from**: DT-009, DT-014, DT-015, DT-023
  - **Sketch**: Introduce a canonical source catalog abstraction that normalizes every effective source into one inspectable record with provenance, scope, precedence, health, and effective workflows.
  - **Why it might help**: many of the best ideas need a shared primitive that separates raw config from the effective runtime model.
  - **Open question**: should the catalog be derived on demand or persisted?

- **DT-042 — Setup intent router**
  - **Category**: product primitive
  - **Built from**: DT-002, DT-003, DT-025, DT-035
  - **Sketch**: Create a router that maps a small set of user intents (`use folder`, `use repo`, `share repo workflows`, `install pack`) into concrete setup plans.
  - **Why it might help**: provides a stable user-facing language above heterogeneous source types.
  - **Open question**: is the router a CLI command, MCP workflow, library primitive, or all three?

- **DT-043 — Root-first + repo-convention package**
  - **Category**: combined concept
  - **Built from**: DT-004, DT-005, DT-016, DT-038
  - **Sketch**: Make root registration the main action and `.workrail/workflows/` the main convention for team sharing, with layered user overrides.
  - **Why it might help**: could eliminate a large fraction of explicit source setup for real teams.
  - **Open question**: what should happen when a repo contains multiple workflow subdomains?

- **DT-044 — Install flow with mode selection**
  - **Category**: combined concept
  - **Built from**: DT-002, DT-008, DT-011, DT-033
  - **Sketch**: `install` becomes a first-class flow that resolves a source, preflights it, then asks the user to choose between `live source` and `local snapshot` when applicable.
  - **Why it might help**: reduces ambiguity while preserving flexibility.
  - **Open question**: when should WorkRail skip asking and choose a default confidently?

- **DT-045 — Guided trust-and-auth handshake**
  - **Category**: missing enabling piece
  - **Built from**: DT-007, DT-018, DT-024, DT-039
  - **Sketch**: Add a reusable handshake primitive for any private or external source:
    - identify trust tier
    - select auth path
    - verify access
    - summarize implications
  - **Why it might help**: several promising setup ideas fail without a good trust/auth moment.
  - **Open question**: can this remain generic across Git, registries, and future source types?

- **DT-046 — Source change plan**
  - **Category**: missing enabling piece
  - **Built from**: DT-019, DT-030, DT-040
  - **Sketch**: Represent source add/update/remove actions as explicit change plans before applying them.
  - **Why it might help**: makes setup safer, reviewable, and potentially auditable.
  - **Open question**: do users need history, or just preview + apply?

- **DT-047 — Install receipts**
  - **Category**: missing enabling piece
  - **Built from**: DT-009, DT-018, DT-033
  - **Sketch**: After any install, create a durable receipt describing what was installed, from where, in what mode, at what revision, under what trust tier.
  - **Why it might help**: bridges setup UX, provenance, diagnostics, and reproducibility.
  - **Open question**: should receipts live with source manifests or separately?

- **DT-048 — Source capability descriptors**
  - **Category**: product primitive
  - **Built from**: DT-012, DT-036, DT-037
  - **Sketch**: Let a source declare or derive a capability descriptor such as:
    - portable refs
    - requires auth
    - supports live refresh
    - trusted producer metadata
  - **Why it might help**: setup decisions become data-driven instead of hard-coded by source kind.
  - **Open question**: how much should be declared vs inferred?

- **DT-049 — Source package format**
  - **Category**: combined concept
  - **Built from**: DT-012, DT-021, DT-036
  - **Sketch**: Define a loose “workflow pack” concept as a portable directory or archive with workflows, refs, and optional metadata markers.
  - **Why it might help**: simplifies public/community distribution and install flows.
  - **Open question**: does WorkRail need a formal package spec now, or just conventions?

- **DT-050 — Full-spectrum source inspector**
  - **Category**: combined concept
  - **Built from**: DT-006, DT-014, DT-015, DT-026, DT-041
  - **Sketch**: Replace the current partial `sources` view with a complete inspector driven by the source catalog primitive.
  - **Why it might help**: setup and debugging become one coherent experience.
  - **Open question**: should inspection be read-only or offer repair actions inline?

- **DT-051 — Attach by proposal**
  - **Category**: combined concept
  - **Built from**: DT-003, DT-013, DT-040, DT-042
  - **Sketch**: WorkRail detects likely sources or accepts user-provided ones, then generates a setup proposal the user can approve.
  - **Why it might help**: gives proactive assistance without surprising mutation.
  - **Open question**: how often should WorkRail initiate proposals vs wait for explicit user intent?

- **DT-052 — Minimal path: repo markers only**
  - **Category**: simplicity shortcut
  - **Built from**: DT-004, DT-017, DT-036
  - **Sketch**: The simplest team-sharing path is just:
    - add `.workrail/workflows/`
    - optionally add repo marker metadata
    - register the root once
  - **Why it might help**: this may cover a very large percentage of team use cases with almost no product complexity.
  - **Open question**: is this enough without an install command for cross-repo cases?

- **DT-053 — Source policy profiles**
  - **Category**: missing enabling piece
  - **Built from**: DT-019, DT-039, DT-045
  - **Sketch**: Bundle trust, refresh, and reproducibility defaults into named profiles like `team-shared`, `personal-experimental`, `external-reviewed`, `snapshot-only`.
  - **Why it might help**: reduces the number of knobs users must set.
  - **Open question**: how many profiles are enough without becoming a second complexity layer?

- **DT-054 — Runtime-local resolution boundary**
  - **Category**: architectural simplification
  - **Built from**: DT-027, DT-033, DT-041
  - **Sketch**: Introduce a clearer boundary where WorkRail runtime only resolves local effective sources; remote fetching becomes an install/sync concern.
  - **Why it might help**: could simplify core discovery, validation, and provenance.
  - **Open question**: what existing capabilities or expectations would this regress?

- **DT-055 — Setup readiness score**
  - **Category**: diagnostics
  - **Built from**: DT-024, DT-037, DT-050
  - **Sketch**: Give candidate sources a readiness summary such as `ready`, `needs auth`, `needs import`, `not portable`, `conflicting IDs`.
  - **Why it might help**: helps the user pick the right next action quickly.
  - **Open question**: does scoring aid decisions or oversimplify nuanced conditions?

### Additional ideas (Round 4)

- **DT-056 — Capability negotiation for source handlers**
  - **Category**: capability negotiation
  - **Sketch**: Each source handler exposes capabilities such as `supports-live-refresh`, `supports-auth-discovery`, `supports-portable-refs`, `supports-snapshot-pin`, and setup flows adapt accordingly.
  - **Why it might help**: avoids hard-coding UX assumptions by source kind and creates a future-proof extension seam.
  - **Open question**: how much capability complexity is worth exposing publicly?

- **DT-057 — Setup resumability**
  - **Category**: resumption
  - **Sketch**: Long or interrupted setup flows can be resumed safely with an explicit setup draft / pending proposal record.
  - **Why it might help**: private/self-hosted setup often spans multiple steps and may need user-side secret work before completion.
  - **Open question**: should resumability be session-scoped only, or durable across chats?

- **DT-058 — Authoring-side export for sharing**
  - **Category**: authoring UX
  - **Sketch**: Add a producer-oriented command/workflow that packages current workflows and refs into a shareable “workflow pack” or repo-ready structure.
  - **Why it might help**: easier producer UX often improves consumer setup indirectly.
  - **Open question**: should this target repo layouts, archives, or both?

- **DT-059 — Install-time validation tiers**
  - **Category**: validation
  - **Sketch**: Split validation into `structural`, `portability`, `compatibility`, and `policy` checks during setup.
  - **Why it might help**: helps users understand whether a source is merely valid JSON vs truly usable in their environment.
  - **Open question**: which tiers should block install vs warn only?

- **DT-060 — Dashboard/source observability panel**
  - **Category**: dashboard / observability
  - **Sketch**: Surface source inventory, health, last sync, trust tier, conflicts, and recent setup actions in the console/dashboard.
  - **Why it might help**: gives WorkRail a durable home for source visibility beyond CLI or chat replies.
  - **Open question**: should dashboard observability be phase 1 or follow once the source catalog exists?

- **DT-061 — Model-adaptive setup UX**
  - **Category**: model variability
  - **Sketch**: Tune setup prompts and defaults based on model capability / context budget so weaker models rely more on structured recipes and stronger models can handle richer diagnosis.
  - **Why it might help**: keeps setup reliable across model variability instead of assuming all agents can improvise equally well.
  - **Open question**: how do we keep the behavior predictable across clients?

- **DT-062 — Compatibility and migration assistant**
  - **Category**: migration / compatibility
  - **Sketch**: Detect current env-var configuration and propose migration into canonical `.workrail/` config or source manifests without breaking existing behavior.
  - **Why it might help**: adoption will be much easier if current users can migrate incrementally.
  - **Open question**: what migration format preserves comments, intent, and trust settings best?

- **DT-063 — Source testing harness**
  - **Category**: testing strategy
  - **Sketch**: Add a test harness for setup flows and source handlers using scenario fixtures (GitHub, self-hosted GitLab, broken auth, local folders, shadow conflicts, portable/non-portable refs).
  - **Why it might help**: setup UX will be brittle without a strong scenario-driven test matrix.
  - **Open question**: what should be unit-tested vs end-to-end?

- **DT-064 — Policy packs**
  - **Category**: security / policy
  - **Sketch**: Allow organizations to define allowed source origins, trust defaults, and install policies through shareable policy packs.
  - **Why it might help**: teams may want simplicity without giving up governance.
  - **Open question**: how much policy surface is needed before it becomes enterprise-only complexity?

- **DT-065 — Performance-aware source strategy**
  - **Category**: performance
  - **Sketch**: Setup chooses or recommends source modes based on likely scale:
    - many repos → prefer roots + local discovery
    - large remote sources → prefer snapshots or scheduled sync
    - tiny local packs → direct import
  - **Why it might help**: avoids a UX that looks simple but performs poorly at scale.
  - **Open question**: how should WorkRail detect when to shift strategies?

- **DT-066 — Conflict rehearsal before attach**
  - **Category**: compatibility / validation
  - **Sketch**: Before enabling a source, simulate how its workflows would merge into the current catalog, including shadowing, ID conflicts, and bundled-protection rules.
  - **Why it might help**: prevents confusing post-install surprises.
  - **Open question**: what level of detail is most useful in the rehearsal output?

- **DT-067 — Reference portability contract**
  - **Category**: packaging / validation
  - **Sketch**: Add explicit setup-time analysis of whether workflows depend on `workspace`, `package`, or `workflow`-relative references and recommend fixes or install modes accordingly.
  - **Why it might help**: many third-party workflows are only truly sharable if refs are portable.
  - **Open question**: should non-portable refs block community installs by default?

- **DT-068 — Progressive setup fallback ladder**
  - **Category**: resilience
  - **Sketch**: If the ideal setup path fails, WorkRail falls back deliberately:
    - live mount
    - snapshot install
    - local import
    - manual instructions
  - **Why it might help**: turns failure into graceful degradation instead of dead ends.
  - **Open question**: how can fallback stay understandable rather than feeling magical?

- **DT-069 — Setup transcript artifact**
  - **Category**: observability / learnability
  - **Sketch**: Persist a structured transcript of setup decisions, evidence, chosen mode, and unresolved warnings so users and agents can revisit why the system is configured the way it is.
  - **Why it might help**: improves learnability, debugging, and handoff across sessions.
  - **Open question**: should this be file-based initially or a dashboard/session artifact?

## Coverage map

- **Protocol / resumption** | medium | DT-030, DT-046, DT-057
- **Authoring UX** | medium | DT-017, DT-036, DT-058
- **Validation** | high | DT-024, DT-037, DT-059, DT-066, DT-067
- **Dashboard / observability** | medium | DT-026, DT-050, DT-060, DT-069
- **Model variability** | low | DT-061
- **External workflow packaging** | medium | DT-012, DT-049, DT-058, DT-067
- **Loops correctness / workflow semantics safety** | low | DT-059, DT-067 (indirect only)
- **Capability negotiation** | medium | DT-048, DT-056
- **Security / policy** | medium | DT-018, DT-039, DT-064
- **Performance** | low | DT-065
- **Compatibility / migration** | medium | DT-019, DT-062, DT-066
- **Testing strategy** | low | DT-063
- **Persona / journey quality** | high | Persona card, Journey map, Observations, Insights
- **POV clarity** | high | POV, Problem statement, HMW, Success criteria
- **Prototype learnability** | medium | Prototype Spec, DT-042, DT-051, DT-069
- **Falsifiability / testability** | medium | Evidence gaps, What would change our mind, Test Plan, DT-063

## Smart signals and leverage points

### High-value signals to exploit

- **Explicit `workspacePath`**
  - authoritative per-request workspace identity
  - replaces trust in MCP roots for discovery-sensitive decisions
- **Resolved git repo root from `workspacePath`**
  - gives a stable cross-session unit for silent persistence and cross-repo grouping
- **Current path locality inside the repo**
  - allows nearest-module / nearest-team discovery and ranking
- **Remembered repo roots in `~/.workrail/config.json`**
  - enables cross-repo surfacing without requiring repo changes
- **Workflow usage history**
  - enables “suggested here”, recency, and frequent-use ranking later
- **Source health / validation state**
  - enables ranking healthy sources higher and making broken sources legible
- **Portable reference analysis**
  - enables more intelligent guidance for shared vs import/install workflows

### Product principle for smart behavior

- Use signals to **rank, suggest, explain, and remember**
- Avoid using signals to create opaque, silent behavior the user cannot later inspect

## Remote repository UX direction

### Core product stance

- For remote repositories, WorkRail should optimize for:
  - one user intent
  - managed local effective state
  - minimal guided auth when needed
  - clear provenance after install

### Recommended default

- **Managed sync should be the default remote-repo mode**
- Remote repositories are the **acquisition and update source**
- WorkRail should still operate over a **local effective copy** for discovery, validation, and execution-time reasoning

### Why managed sync by default

- keeps remote repos feeling low-friction and continuously useful
- avoids making users manually refresh every shared workflow repo
- still preserves a local effective state that is easier to debug than purely live remote resolution
- fits better with cross-repo remembered sources and future console management

### Install / connection modes

- **Managed sync (default)**
  - WorkRail clones or materializes a local effective copy
  - WorkRail refreshes it on a managed cadence or on demand
  - user experiences the source as “connected and kept current”
- **Pinned snapshot**
  - for stronger reproducibility or lower-trust scenarios
  - user updates explicitly
- **Live remote**
  - not recommended as a default
  - if ever supported, should be advanced-only

### Mental model

- Users should think:
  - “I’m adding a workflow repo”
- Not:
  - “I’m choosing among Git storage modes”
- WorkRail decides the operational details and explains them simply:
  - source repo
  - local effective copy
  - sync status
  - last updated time

### Public remote repos

- user provides a remote repo URL
- WorkRail:
  - detects host/type
  - connects it in managed-sync mode by default
  - validates workflows
  - remembers it in user config
  - exposes it in grouped workflow discovery

### Private / self-hosted remote repos

- user provides a remote repo URL
- WorkRail:
  - detects likely auth path
  - offers minimal auth guidance:
    - SSH
    - or HTTPS token
  - connects it in managed-sync mode by default
  - remembers it in user config
  - exposes sync/provenance state clearly

### Cross-repo behavior

- Remembered remote repos should surface alongside local remembered roots
- `list_workflows(workspacePath=...)` should still rank by relevance:
  - nearby team/module workflows
  - same repo workflows
  - other remembered local roots
  - remembered remote-synced repos
  - built-in workflows

### Console implications for remote repos

- console should eventually show:
  - remote source URL
  - sync mode
  - last sync time
  - sync health
  - local effective state path / identity
  - refresh / forget actions

## Shared artifact / inbox UX direction

### Core product stance

- Slack, email, chat, copy/paste, and similar channels should be treated as **delivery channels**, not durable source types
- WorkRail should classify what the user actually received, then route it into the correct setup path

### Why this matters

- many workflows will be shared as:
  - repo URLs pasted into chat
  - single JSON files
  - zipped workflow packs
  - snippets pasted into Slack or an IDE
- these delivery paths create extra user pain around provenance, completeness, portability, and updates

### Additional user difficulties

- **Provenance**
  - users may not know who created the workflow or where it originally came from
- **Completeness**
  - a shared JSON file may omit referenced prompts, schemas, or supporting assets
- **Portability**
  - the workflow may assume the sender's repo layout or local files
- **Compatibility**
  - the workflow may depend on newer WorkRail features or authoring contracts
- **Update path**
  - file-based sharing often has no obvious refresh/sync story
- **Trust**
  - users may not know whether the shared artifact is reviewed or safe
- **Conflict risk**
  - imported workflows may collide with existing workflow IDs or names

### Recommended UX

- expose a unified user intent such as:
  - `use this workflow`
  - `import this shared workflow`
- then classify the payload into one of:
  - remote repo URL
  - local repo / directory
  - single workflow file
  - workflow pack / zip
  - pasted JSON snippet

### Routing model

- **Repo URL shared in Slack/chat**
  - route into the normal remote-repo flow
  - default to managed sync
- **Single workflow JSON file**
  - import as a personal/local workflow unless the user chooses a broader scope
  - run portability and completeness checks first
- **Workflow pack / zip**
  - unpack into managed local storage
  - validate contents and refs before enabling
- **Pasted JSON snippet**
  - validate and classify first
  - if incomplete or malformed, explain what is missing before import

### Smart behavior needed

- classification of the shared artifact
- preflight readiness checks:
  - structural validity
  - portability
  - compatibility
  - trust/provenance
  - conflict rehearsal
- install-mode recommendation
- receipt/history explaining:
  - where it came from
  - how it was ingested
  - what scope it was installed into

### Mental model

- users should not have to think:
  - “Is Slack a source type?”
- users should think:
  - “I received a workflow or workflow repo”
  - “WorkRail can figure out how to ingest it”

### Console implications for shared artifacts

- console should eventually show:
  - imported/shared workflows and their origin channel
  - missing-assets or portability warnings
  - whether an imported artifact has an update path
  - receipts/history for imports from chat, Slack, email, or pasted content

## Phased smart features

### Phase 1 smarts

- require explicit `workspacePath`
- silently remember repo roots in user-level `~/.workrail/config.json`
- recursively discover team/module `.workrail/workflows/` under remembered roots
- rank workflows by proximity:
  - current module/team
  - same repo
  - other remembered repos
  - built-in
- show grouped source visibility and simple provenance explanations
- explain precedence clearly when rooted-sharing and legacy sources coexist

### Phase 2 smarts

- recency/frequency-based ranking
- “suggested for this workspace” workflows
- root suggestions based on repeated usage
- health-aware ranking
- conflict rehearsal before attach / enable
- migration helper from env-based source setup

### Phase 3 smarts

- cross-repo recommendations based on historical usage
- trusted source tiers / policy profiles
- portable workflow-pack install flows
- install receipts / setup transcripts
- richer org/team heuristics
- more advanced guided install for remote and self-hosted sources

## Console integration direction

### Role of the console

- MCP/tools remain the **runtime entry point**
- the console becomes the **control plane** for visibility, management, and trust

### Why console matters

- silent persistence is good UX only if users can later inspect and manage what WorkRail remembered
- grouped discovery becomes more trustworthy when users can inspect roots, sources, health, and precedence outside of chat/tool output

### Console phase 1

- remembered roots view
- discovered workflow folders by repo/module/team
- grouped visible workflows
- simple provenance:
  - why this workflow is visible
  - which remembered root or built-in source it came from
- basic actions:
  - forget root
  - reindex root
  - inspect source grouping

### Console phase 2

- source health dashboard
- precedence inspector
- cross-repo browser
- recent / recommended workflows
- migration visibility for old env-based setups vs remembered-root setups

### Console phase 3

- install / attach UI
- trust and policy management
- ownership views by team/module
- workflow pack management
- usage analytics for discovery tuning

### Architectural implication

- backend design should not assume chat-only consumption
- phase-1 backend data should already be shaped so the console can later render:
  - remembered roots
  - discovered team/module workflow folders
  - grouped visible workflows
  - source provenance
  - precedence / health summaries

### Ideation reflection (Round 4)

- **Where would we most likely regret not exploring further?**
  - migration / compatibility and setup testing strategy, because the best UX ideas could still fail badly in rollout without them
- **What category did we avoid because it felt uncomfortable or "too big"?**
  - deeper policy/governance and cross-client automation boundaries
- **What assumption seems to be driving most of our ideas?**
  - that WorkRail should graduate from a workflow runtime with env-based configuration into a more productized workflow platform with owned setup UX

## Candidate concept packages (5)

- **Package name**: Rooted Team Sharing | **member DT-IDs**: DT-004, DT-005, DT-016, DT-043, DT-052 | **what it enables**: a near-zero-config team sharing path centered on repo-local conventions plus one-time root registration
- **Package name**: Guided Install | **member DT-IDs**: DT-002, DT-003, DT-011, DT-044, DT-045, DT-051 | **what it enables**: a WorkRail-owned setup journey from URL/path to connected source with approval, auth help, and mode selection
- **Package name**: Source Control Tower | **member DT-IDs**: DT-006, DT-014, DT-015, DT-041, DT-050, DT-055 | **what it enables**: full visibility into active and candidate sources, their health, precedence, and next actions
- **Package name**: Portable Workflow Packs | **member DT-IDs**: DT-012, DT-021, DT-036, DT-049 | **what it enables**: a more distributable and installable unit for public/community or cross-repo workflow sharing
- **Package name**: Local-First Runtime Boundary | **member DT-IDs**: DT-008, DT-033, DT-047, DT-053, DT-054 | **what it enables**: a simpler runtime that reasons over local effective sources while keeping source provenance, trust, and reproducibility explicit

### Ideation reflection (Round 3)

- **What critical primitive seems to be missing for the best packages to work?**
  - a canonical **source catalog** / effective-source model that all setup, inspection, and diagnostics can target
- **What is the simplest idea we are dismissing too quickly?**
  - rooted team sharing via `.workrail/workflows/` plus one-time root registration
- **What assumption seems to be driving most of our ideas?**
  - that the best UX comes from shifting setup into WorkRail-owned flows and `.workrail/` artifacts rather than leaving MCP env config as the primary user-facing surface

## Interesting analogies (3 bullets)

- **Compiler/module graph**: source hookup may benefit from being modeled like import resolution with shadowing, provenance, and diagnostics.
- **Logistics inbox/intake**: users often know they found “something useful” before they know what kind of source it is or how it should be attached.
- **Aviation preflight**: consistent, lightweight verification could turn setup from mysterious trial-and-error into a predictable safety check.

### Ideation reflection (Round 2)

- **Which analogy created the most non-obvious leverage?**
  - the compiler/module graph analogy, because it suggests a strong internal and user-facing model for precedence, shadowing, provenance, and diagnostics
- **What is the simplest idea we are dismissing too quickly?**
  - install snapshots only, because it may dramatically simplify user trust and runtime behavior
- **What assumption seems to be driving most of our ideas?**
  - that the biggest UX win comes from WorkRail becoming the setup orchestrator rather than just documenting lower-level config

## Emerging patterns (5 bullets)

- Many ideas converge on **WorkRail-owned setup flows** rather than better env-var docs.
- `.workrail/` appears repeatedly as the right place for canonical config, manifests, and shared conventions.
- A strong theme is **install/import vs live source** as a first-order design choice, not an implementation detail.
- Discovery, provenance, and diagnostics keep showing up as inseparable from setup simplicity.
- Team sharing likely benefits more from **root registration + repo-local conventions** than from per-user source registration.

### Ideation reflection

- **Which idea categories are underrepresented so far?**
  - registry/package-specific ideas are lighter than Git and local-folder ideas
  - migration / backward-compatibility UX could use more attention later
- **What is the simplest idea we are dismissing too quickly?**
  - “just use this folder” may solve a surprisingly large share of real cases
- **What assumption seems to be driving most of our ideas?**
  - that users want WorkRail to own the setup journey instead of MCP client config being the main setup surface

## Clusters (synthesized)

- **Cluster 1 — Canonical source model**
  - **Theme**: Move from fragmented env vars to a single WorkRail-owned source model
  - **Problem it addresses**: configuration sprawl and implementation-shaped setup
  - **Representative DT-IDs**: DT-001, DT-009, DT-016, DT-041, DT-048
  - **Tension**: central config vs per-source manifests

- **Cluster 2 — Guided setup / install**
  - **Theme**: Turn hookup into a product flow rather than documentation work
  - **Problem it addresses**: too many concepts exposed too early
  - **Representative DT-IDs**: DT-002, DT-003, DT-011, DT-042, DT-044, DT-051
  - **Tension**: automation vs user control

- **Cluster 3 — Rooted team sharing**
  - **Theme**: Use repo-local conventions and root registration as the main team-sharing path
  - **Problem it addresses**: today’s setup is too personal-config centric
  - **Representative DT-IDs**: DT-004, DT-005, DT-017, DT-043, DT-052
  - **Tension**: simplicity for teams vs completeness for public/external distribution

- **Cluster 4 — Trust, auth, and policy**
  - **Theme**: Make private/self-hosted/external setup understandable and governable
  - **Problem it addresses**: hidden auth rules and opaque trust boundaries
  - **Representative DT-IDs**: DT-007, DT-018, DT-039, DT-045, DT-064
  - **Tension**: easy onboarding vs explicit trust review

- **Cluster 5 — Source visibility and diagnostics**
  - **Theme**: Treat inspection and repair as part of setup, not afterthoughts
  - **Problem it addresses**: fragile-feeling setup and incomplete source introspection
  - **Representative DT-IDs**: DT-006, DT-014, DT-015, DT-041, DT-050, DT-055
  - **Tension**: rich visibility vs information overload

- **Cluster 6 — Packaging and portability**
  - **Theme**: Make workflows easier to share as portable units with refs and metadata
  - **Problem it addresses**: cross-repo/community setup and reference portability
  - **Representative DT-IDs**: DT-012, DT-036, DT-049, DT-058, DT-067
  - **Tension**: loose conventions vs formal packaging spec

- **Cluster 7 — Runtime boundary and sync model**
  - **Theme**: Decide whether runtime should mount heterogeneous external sources or mostly resolve local effective sources
  - **Problem it addresses**: complexity, reproducibility, and provenance drift
  - **Representative DT-IDs**: DT-008, DT-019, DT-033, DT-047, DT-053, DT-054, DT-068
  - **Tension**: freshness vs runtime simplicity

- **Cluster 8 — Migration, observability, and rollout safety**
  - **Theme**: Ensure a cleaner model can actually ship without breaking users
  - **Problem it addresses**: adoption risk, hidden regressions, and weak validation of setup UX
  - **Representative DT-IDs**: DT-057, DT-059, DT-060, DT-062, DT-063, DT-066, DT-069
  - **Tension**: future-first product cleanup vs migration smoothness

## Candidate directions (top 5)

- **Direction 1 — Guided Install on top of a canonical source catalog**
  - **North Star (1–2 sentences)**: A user can say “use this repo/folder/pack” and WorkRail turns that into a guided, inspectable setup flow backed by a canonical effective-source catalog. The user no longer has to think in env vars or source-specific plumbing.
  - **Summary**: This best addresses the core JTBD now because it directly targets setup friction while preserving explicit provenance, diagnostics, and future extensibility. Main risks are migration complexity and overreaching into cross-client configuration territory. Migration cost is moderate because env vars can remain as compatibility inputs while new `.workrail/` artifacts become canonical.
  - **Scoring (1–5 with 1-line why)**:
    - **Impact: 5**: directly improves the common “I found a source, make it work” flow
    - **Confidence: 4**: strongly supported by current architecture and backlog synthesis, though not by direct user research yet
    - **Migration cost: 3**: requires new config/catalog/UX layers but can coexist with legacy env vars
    - **Model-robustness: 4**: recipe/routed setup can be made reliable across models if structured well
    - **Time-to-value: 4**: can likely deliver incremental wins before the full platform vision lands

- **Direction 2 — Rooted Team Sharing as the default collaboration model**
  - **North Star (1–2 sentences)**: Teams share workflows by putting them in team-owned or module-owned `.workrail/workflows/` directories under remembered repo roots, and WorkRail discovers them recursively. Most team workflow hookup disappears into convention, discovery, and grouped visibility rather than per-source configuration.
  - **Summary**: This is probably the cleanest internal-team story and aligns strongly with the repo’s platform vision, with one important refinement: it should not depend on MCP roots or on placing `.workrail/` at the main repo root. It is lower risk and simpler than solving all third-party installation at once, but it does less for public/community and ad hoc cross-repo adoption. Migration cost is relatively low because it adds a convention-based path rather than replacing everything.
  - **Scoring (1–5 with 1-line why)**:
    - **Impact: 4**: high for team/repo use cases, weaker for arbitrary public sources
    - **Confidence: 4**: strongly aligned with existing docs and current `.workrail/` direction
    - **Migration cost: 2**: mostly additive with limited disruption
    - **Model-robustness: 5**: conventions and root registration are simple for weaker models to follow
    - **Time-to-value: 5**: likely the fastest path to meaningful simplification

- **Direction 3 — Local-first runtime boundary with install/snapshot flows**
  - **North Star (1–2 sentences)**: Remote or heterogeneous sources are installed or synced into local effective sources, and runtime discovery operates mostly on local files. Setup becomes an import/sync problem; execution becomes a local resolution problem.
  - **Summary**: This is the cleanest architectural story for provenance, reproducibility, and debugging. It may reduce surprising runtime behavior and improve trust, but it risks losing the convenience of live sources and may feel heavier unless update flows are excellent. Migration cost is higher if current expectations lean toward live mounting.
  - **Scoring (1–5 with 1-line why)**:
    - **Impact: 4**: strong architectural and UX simplification if accepted
    - **Confidence: 3**: promising but more assumption-heavy and further from current user expectations
    - **Migration cost: 4**: could force behavioral changes for existing source setups
    - **Model-robustness: 4**: local-only runtime is easier for agents to reason about
    - **Time-to-value: 2**: more foundational work before users feel the benefit

- **Direction 4 — Source Control Tower first**
  - **North Star (1–2 sentences)**: Before fully reinventing setup, make source visibility, health, conflicts, and provenance crystal clear through a unified source inspector and diagnostics layer. Users and agents can see exactly what is happening today.
  - **Summary**: This is a safer, lower-regret direction if we believe discovery/provenance may be the real pain rather than hookup. It improves debuggability and can support later setup flows, but by itself it does not fully solve the “make this source work” JTBD. Migration cost is low because it mostly adds inspection capabilities.
  - **Scoring (1–5 with 1-line why)**:
    - **Impact: 3**: meaningful but less transformational than setup-first directions
    - **Confidence: 5**: strongly grounded in current gaps and low-risk to add
    - **Migration cost: 1**: mostly additive
    - **Model-robustness: 5**: inspection tools are easier to use reliably than mutating setup tools
    - **Time-to-value: 5**: likely fast to ship and immediately useful

- **Direction 5 — Portable Workflow Packs**
  - **North Star (1–2 sentences)**: Make the portable workflow directory or pack the main sharing unit for public/community and cross-repo distribution. WorkRail installs and validates packs with clear reference portability guarantees.
  - **Summary**: This direction is attractive for ecosystem growth and cleaner distribution, especially once `resolveFrom: workflow` style portability is mature. It is less directly useful for immediate internal-team simplicity and may require more packaging/formalization than the product needs right now. Migration cost is moderate and value is more medium-term.
  - **Scoring (1–5 with 1-line why)**:
    - **Impact: 3**: valuable, but narrower than setup and sharing fundamentals
    - **Confidence: 3**: conceptually strong, but packaging appetite is still uncertain
    - **Migration cost: 3**: additive, but could create new conventions/spec work
    - **Model-robustness: 4**: portable packs are easier to reason about than arbitrary repos
    - **Time-to-value: 2**: needs groundwork before it feels polished

## Shortlist (3)

- **Shortlist 1 — Guided Install + Canonical Source Catalog**
  - best overall fit for the stated goal of making hookup as simple as possible across source types
- **Shortlist 2 — Rooted Team Sharing**
  - strongest low-risk, high-time-to-value path for same-repo and internal team workflows
- **Shortlist 3 — Source Control Tower**
  - best supporting direction and likely prerequisite for trustable setup UX, even if not the main product story

### Updated shortlist emphasis after lightweight test

- **Operational phase-1 favorite — Rooted Team Sharing + minimal Source Control Tower**
  - refined interpretation: the phase-1 product is not just rooted sharing, but rooted sharing plus enough source visibility to verify and trust the result
  - iteration-2 refinement: migration clarity, precedence visibility, and weaker-model-safe guidance are part of phase-1, not rollout polish
  - latest refinement: phase 1 should require explicit `workspacePath`, silently remember repo roots in user config, recursively discover team/module workflow folders under those remembered roots, and make the preferred team path unmistakable while legacy setup paths still exist
- **Longer-term north star — Guided Install + Canonical Source Catalog**
  - unchanged as the broader destination, but deprioritized as immediate phase-1 implementation work

### Synthesis reflection

- **What would falsify the top direction?**
  - strong evidence that users are not blocked by setup itself, but instead by discovery/trust/visibility, in which case Source Control Tower or Rooted Team Sharing may be the higher-leverage first move
- **What is the most dangerous second-order effect?**
  - WorkRail could become responsible for too much cross-client configuration behavior, creating brittle automation and new failure modes that are harder to debug than the current explicit env approach

### Adversarial challenge

- **Argue that the top direction is wrong. What would a skeptic say?**
  - A skeptic would say Guided Install is too ambitious too early. It risks building a fancy setup wizard around unresolved questions about ownership, migration, and trust while obscuring a simple underlying truth: most team use cases could be solved by root registration plus repo-local `.workrail/workflows/` conventions. They would argue the product should first make current behavior visible and conventional before trying to automate everything.
- **What is the strongest alternative direction and why might it win?**
  - **Rooted Team Sharing** is the strongest alternative. It aligns tightly with existing platform vision, is simpler to reason about, avoids deep MCP client automation, and likely delivers the fastest meaningful simplification for real teams with the least migration risk.

### Decision Gate

- **Decision needed**: choose which direction to optimize first:
  - `Guided Install + Canonical Source Catalog`
  - `Rooted Team Sharing`
  - `Source Control Tower`
- My current recommendation: **start with `Rooted Team Sharing` as phase 1 and design `Guided Install + Canonical Source Catalog` as the broader phase 2 path**. That sequence keeps the architecture honest, delivers value quickly, and avoids overcommitting to automation before the source model and visibility layer are mature.

### Next Input checklist

- Confirm which direction you want to take forward.
- Optional preference: whether phase 1 should prioritize:
  - **team/repo sharing**
  - **personal third-party install**
  - **observability/diagnostics foundation**

## Synthesis Quality Gate

- ✅ **POV statement is present**
- ✅ **3–7 HMW questions are present**
- ✅ **Success criteria are present (measurable where possible)**
- ✅ **Key tensions/tradeoffs are present**
- ✅ **Idea Backlog has meaningful breadth (covers protocol/resumption/authoring/observability/reliability/tooling/packaging at least once each, if applicable)**
- ✅ **Shortlist (2–3) exists with risks and migration cost noted**
- ✅ **The top direction has at least one falsifiable learning question**

## Pre-mortem & Falsification

### Pre-mortem (top 5)

- **Failure mode**: Guided install becomes a thin wizard over the same fragmented config model | **Why it happens**: the UX layer ships before a real canonical source catalog / config boundary exists | **Mitigation**: make the source catalog and canonical `.workrail/` representation first-class before adding too much setup flow polish
- **Failure mode**: Cross-client automation becomes brittle and causes confusing partial setup states | **Why it happens**: WorkRail tries to own MCP client configuration it cannot reliably control across environments | **Mitigation**: keep WorkRail-owned config in `.workrail/`, prefer proposal/approval flows, and treat external client mutation as optional guidance rather than a hard dependency
- **Failure mode**: The system over-optimizes for generic third-party install while under-serving the highest-frequency team-sharing path | **Why it happens**: the product chases the broadest abstraction first instead of the simplest dominant use case | **Mitigation**: phase the work with `Rooted Team Sharing` first and validate actual demand for broader install flows
- **Failure mode**: Users lose trust because setup hides important provenance/trust choices | **Why it happens**: simplification removes too much visibility around source origin, auth, update mode, and conflicts | **Mitigation**: ship the source inspector / control-tower layer alongside or before broad setup automation
- **Failure mode**: Migration is painful and existing env-based users feel forced into a new model prematurely | **Why it happens**: canonical `.workrail/` config is introduced without a good migration assistant and compatibility bridge | **Mitigation**: support dual-read migration, generate explicit migration proposals, and keep env vars working throughout transition
- **Failure mode**: `.workrail/config.json` becomes an overloaded catch-all and weakens the simplicity story | **Why it happens**: user-level remembered roots, repo-local metadata, and unrelated environment/capability state are all pushed into one file without a crisp ownership model | **Mitigation**: define config-file responsibilities explicitly before implementation planning and be willing to split concerns across multiple `.workrail/*` artifacts

### Falsification criteria (1–3)

- **If** dogfood users still need to understand raw source kinds, env vars, or auth naming rules in the common setup path, **we will change direction** toward stronger recipe-based/root-based flows because the guided install layer would not be abstracting the real complexity.
- **If** team users continue to prefer or succeed more often with simple repo-local convention plus root registration than with broader guided install flows, **we will pivot sequencing** to prioritize `Rooted Team Sharing` as the mainline path because the broader install story would be over-designed for the near-term problem.
- **If** the source inspector and diagnostics layer cannot clearly explain effective sources, conflicts, update mode, and failure reasons after setup, **we will stop expanding automation** because a setup system that cannot explain itself will create more confusion than it removes.

### Reflection

- **What is the most dangerous second-order effect?**
  - WorkRail could become a partially reliable configuration orchestrator that obscures state across `.workrail/`, MCP client config, caches, and external auth, making support and debugging harder than the current explicit approach.
- **What would we regret not testing?**
  - Whether the simplest team-sharing path (`.workrail/workflows/` + root registration) actually solves most real needs before investing heavily in a generalized install platform.

### Proceed to Prototype

- **Prototype gate**: ready to proceed, but the recommended sequence remains:
  1. validate `Rooted Team Sharing` as the fast path
  2. design/introduce the canonical source catalog
  3. expand into broader guided install once visibility and migration are credible

## Decision Log (append-only)

- DT-DEC-001: Use this document as the canonical design-thinking artifact for the session.
- DT-DEC-002: Treat current code and docs as both evidence and design constraints; do not assume the public docs fully reflect runtime behavior.

## Prototype Spec

### Prototype goal

- Define the simplest believable end-to-end user experience for making third-party workflows available in WorkRail.

### Candidate prototype areas

- user-level remembered roots under `.workrail/`
- repo-local metadata under `.workrail/`
- setup/install workflow invoked through WorkRail itself
- auto-discovery of `.workrail/workflows/` under configured roots
- unified source inspection and diagnostics

### Prototype focus

- **Chosen learning question**: Does the simplest `Rooted Team Sharing` flow solve most real team-sharing hookup pain without requiring users to understand env vars or source kinds?
- **Chosen prototype artifact**: Concierge script (manual end-to-end flow)
- **Why this artifact**: it is the fastest low-fidelity way to test whether the proposed user journey is actually simpler before committing to schema or UI implementation.

### Prototype scope

- In scope:
  - repo-local `.workrail/workflows/` convention
  - one-time root registration
  - basic source visibility after setup
  - explicit distinction between team-shared and personal scope
  - migration-aware explanation of how this relates to current env-first and `./workflows` behavior
  - basic explanation of source precedence when rooted-sharing and legacy sources overlap
- Out of scope:
  - broad third-party install from arbitrary remote sources
  - full source catalog implementation
  - dashboard implementation
  - auto-auth for private/self-hosted sources
  - final decision on the long-term canonical `.workrail/config.json` ownership model

### Falsification criteria (copied verbatim, then refined)

- **If** dogfood users still need to understand raw source kinds, env vars, or auth naming rules in the common setup path, **we will change direction** toward stronger recipe-based/root-based flows because the guided install layer would not be abstracting the real complexity.
- **If** team users continue to prefer or succeed more often with simple repo-local convention plus root registration than with broader guided install flows, **we will pivot sequencing** to prioritize `Rooted Team Sharing` as the mainline path because the broader install story would be over-designed for the near-term problem.
- **If** the source inspector and diagnostics layer cannot clearly explain effective sources, conflicts, update mode, and failure reasons after setup, **we will stop expanding automation** because a setup system that cannot explain itself will create more confusion than it removes.

### Refined prototype-specific falsification

- If a user still needs explanation of more than two new concepts beyond “put workflows here” and “register this root,” the prototype is not simple enough.
- If the post-setup explanation cannot show where workflows came from in one short source summary, the prototype is not trustable enough.

### Success signal for this prototype

- A user can complete the team-sharing setup in 1–3 guided actions.
- The user can explain the resulting model in plain language:
  - “these workflows live in the repo”
  - “this root is registered”
  - “WorkRail discovered them from there”
- The user can also explain, in one short sentence, how the preferred rooted-sharing path coexists with older setup paths during migration.

### Prototype artifact

#### Concierge script — Rooted Team Sharing

- **Panel 1 — trigger**
  - User says: “I want my team to share these workflows in this repo.”
  - WorkRail says: “The simplest path is to store team workflows in `.workrail/workflows/` inside the repo and register the repo as a workflow root once. I can guide that setup.”

- **Panel 2 — classify the scope**
  - WorkRail asks:
    - “Should these workflows be team-shared in the repo, or personal-only for you?”
  - Expected answer:
    - “Team-shared in the repo.”
  - Learning goal:
    - confirm that scope framing is understandable without mentioning source kinds

- **Panel 3 — establish the convention**
  - WorkRail says:
    - “Great. Team-shared workflows live in `.workrail/workflows/` in the repo.”
    - “If that folder doesn’t exist, create it. Put the workflow JSON files there.”
    - “Optional: add repo metadata later, but it isn’t required for the basic path.”
  - Learning goal:
    - test whether convention is enough without extra config

- **Panel 4 — register the root**
  - WorkRail says:
    - “Next, register this repo as a workflow root in your WorkRail config so it will scan `.workrail/workflows/` here.”
    - “This is a one-time action per repo.”
  - Low-fi assumed config shape:

```json
{
  "workspaceRoots": [
    "/path/to/this/repo"
  ]
}
```

  - Learning goal:
    - test whether “register the repo once” feels simpler than attaching sources one-by-one

- **Panel 5 — verify the result**
  - WorkRail says:
    - “Now let’s verify what WorkRail sees.”
    - “Expected result: your workflows appear under this repo’s source group.”
  - Low-fi expected output:

```text
Available Workflows

## workrail (built-in)
- coding-task-workflow-agentic

## personal/workrail (repo root)
- team-code-review
- team-feature-implementation
```

  - Learning goal:
    - test whether grouped source visibility gives enough trust and clarity

- **Panel 6 — explain the mental model**
  - WorkRail summarizes:
    - “These workflows are team-shared because they live in the repo.”
    - “This repo is registered as a workflow root.”
    - “WorkRail discovers `.workrail/workflows/` inside registered roots.”
    - “You don’t need to configure each workflow source individually.”
  - Learning goal:
    - test whether the user can restate the model in plain language

### Smallest shippable slice

- explicit required `workspacePath` on discovery-sensitive workflow tools
- repo-root memory stored in user-level `~/.workrail/config.json`
- recursive discovery of team/module `.workrail/workflows/` under remembered repo roots
- grouped listing / source visibility that shows repo-derived workflows distinctly
- minimal precedence explanation when rooted-sharing and legacy sources overlap
- migration-aware guidance that makes the preferred team path clear even while legacy setup paths still exist
- no generalized install flow yet

### Highest-risk assumption

- That the majority of near-term team-sharing pain can be eliminated with repo-local convention plus root registration, without needing a richer canonical source catalog immediately.

### If falsification triggers

- **Next-best direction from the shortlist**: `Source Control Tower`
- Reason: if rooted sharing is not clear or trustable enough, better visibility and diagnostics are the safest next move before broader automation

### Prototype adjustment after lightweight test

- Treat **verification** as part of the prototype, not just a final check.
- The prototype is now considered incomplete unless it shows:
  - where workflows were discovered from
  - what root made them visible
  - how the user can distinguish repo-shared workflows from built-in ones

### Prototype adjustment after second lightweight test

- Treat **migration and precedence messaging** as part of the prototype narrative, not as documentation follow-up.
- The prototype is now considered incomplete unless it also shows:
  - how the preferred rooted-sharing path coexists with legacy env-based sources
  - how precedence is explained when multiple sources can provide workflows
  - wording simple enough that weaker models are likely to stay on the intended path
  - how repo roots are remembered silently at the user level without requiring current-repo changes

## Test Plan

- Validate the proposed UX against these scenarios:
  - add a local workflow folder
  - connect a GitHub repo
  - connect a self-hosted GitLab repo over HTTPS
  - connect a self-hosted GitLab repo over SSH
  - share workflows through a repo-local `.workrail/workflows/`
  - diagnose a broken or unauthorized source
- For each scenario, measure:
  - number of manual steps
  - number of concepts the user must understand
  - whether WorkRail can guide or automate the setup
  - whether source provenance remains clear afterward

### Prototype test plan

#### Test objective

- Determine whether the `Rooted Team Sharing` prototype is simple, understandable, and robust enough to serve as the first productized setup path for team-shared workflows.

#### Primary learning question

- Can users and agents complete team-sharing setup with repo-local convention plus one-time root registration, without needing to reason about env vars or heterogeneous source types?

#### Hypotheses

- **H1**: In the common team-sharing path, users can complete setup in 1–3 guided actions.
- **H2**: After setup, users can explain the resulting model in plain language without mentioning source kinds or env-var details.
- **H3**: The flow remains understandable across both stronger and weaker agents/models.

#### Prototype under test

- Artifact: `Rooted Team Sharing` concierge script in the Prototype Spec above
- Core concepts under test:
  - repo-local `.workrail/workflows/`
  - one-time root registration
  - grouped workflow visibility after setup

#### Agents / models / IDEs to test

- **Claude** in an MCP-enabled IDE
- **GPT** or **Gemini** in an MCP-enabled IDE as the weaker / less reliable comparison path
- Optional stretch:
  - **Grok** if available in a comparable setup
- IDE environments to sample:
  - Firebender
  - one non-Firebender MCP client if practical

#### Test participants / operators

- Primary: project owner or maintainer dogfooding the flow
- Secondary: one collaborator who did not author the design, if available
- Operator mode:
  - concierge/manual facilitation first
  - then replay with lighter facilitation to see whether the script still holds

#### Scenarios

- **Scenario 1 — happy path team repo**
  - repo already exists
  - user wants to share workflows with teammates
  - workflows are placed into `.workrail/workflows/`
  - root is registered once

- **Scenario 2 — existing repo, no `.workrail/` yet**
  - user starts from scratch
  - must understand where workflows belong
  - must understand what root registration means

- **Scenario 3 — user confuses personal vs team scope**
  - test whether the flow clarifies the distinction early enough

- **Scenario 4 — verification / trust moment**
  - after setup, ask the user to explain where the workflows came from and why they are visible

- **Scenario 5 — weaker-model replay**
  - run the same flow with a weaker model to see whether structured prompts are sufficient

#### Success metrics

- **Task completion**:
  - setup completed successfully: yes/no
- **Action count**:
  - target: 1–3 deliberate user actions
- **Concept count**:
  - target: user must internalize no more than 2 core concepts:
    - team workflows live in `.workrail/workflows/`
    - the repo is registered as a workflow root
- **Explanation quality**:
  - target: user can accurately explain the model in plain language after setup
- **Inspector clarity**:
  - target: user can identify the source group where the workflows came from
- **Agent robustness**:
  - target: stronger and weaker model both keep the user on the same conceptual path

#### Observations to capture

- points of confusion
- places where the facilitator had to translate implementation details
- whether the user asks about env vars, source kinds, or auth during the rooted-sharing flow
- whether the user expects per-workflow registration
- whether verification output feels sufficient to trust the result

#### Failure conditions

- user needs explanation of env vars or source-type internals during the happy path
- user cannot explain the resulting model after setup
- weaker model drifts into old env-var/source-specific guidance
- verification output does not make source provenance clear

#### Instrumentation / evidence collection

- record the exact prompt/script used
- capture the assistant/model responses
- note number of user actions
- note every clarification needed from the facilitator
- save resulting config/file layout and observed `list_workflows` / source output

#### Decision rules

- **If the test clearly succeeds**:
  - continue with `Rooted Team Sharing` as phase 1 and turn it into a concrete design / implementation plan
- **If the test partially succeeds but needs stronger visibility**:
  - iterate by pulling `Source Control Tower` elements earlier into phase 1
- **If the test fails because the model keeps leaking implementation details or users remain confused**:
  - pivot toward a stronger recipe-driven or inspector-first direction before broader setup automation

#### Risks in the test itself

- concierge facilitation may make the flow look better than a productized version would feel
- stronger models may hide UX flaws that weaker models will expose
- a repo/folder setup path may underrepresent later private/self-hosted Git complexity

#### Exit criteria

- We have enough evidence to answer:
  - whether rooted team sharing is a credible phase-1 simplification
  - whether source visibility must be built earlier
  - whether weaker models can follow the concept reliably

### Test reflection

- **If the test fails, what would we do next (iterate, pivot, or stop)?**
  - likely **iterate first** if the failure is around explanation/visibility
  - **pivot** toward `Source Control Tower` if the failure is mainly trust and provenance clarity
  - **stop** only if the rooted-sharing concept proves fundamentally less useful than expected relative to broader install needs

## Feedback Capture

### Test mode

- **Type**: lightweight dogfood thought experiment + adversarial critique
- **Prototype tested**: `Rooted Team Sharing` concierge script
- **Lens used**:
  - current codebase reality
  - likely user interpretation
  - weaker-model robustness

### What we simulated

- A user with an existing repo wants to share workflows with teammates.
- The user is guided toward:
  - putting workflow JSON files in `.workrail/workflows/`
  - registering the repo as a workflow root
  - verifying that grouped workflow listing reflects the source
- We then asked what would likely break or become confusing given the current WorkRail implementation and docs.

### Observed positives

- The **team-sharing story is much easier to explain** than the current env-first setup.
- The two core concepts are compact and memorable:
  - workflows live in `.workrail/workflows/`
  - the repo is registered as a root
- This path aligns well with existing planning docs and broader `.workrail/` direction already present in the repo.
- The flow avoids exposing source-type jargon early.
- It feels compatible with a later generalized install system rather than competing with it.

### Observed friction / concerns

- **Current implementation gap**: the shipped runtime still centers on `./workflows/`, `~/.workrail/workflows/`, custom paths, and env-driven Git/registry configuration. The prototype assumes a root-based `.workrail/workflows/` discovery model that is described in planning docs but not yet the primary current behavior.
- **Visibility gap**: current source inspection UX is not strong enough yet to make the final “verify and trust” step fully convincing.
- **Potential concept leak**: “register the repo as a root” is simpler than source-by-source config, but it is still a new concept that needs to be explained carefully.
- **Cross-client gap**: it is unclear how much the root-registration action itself can be automated vs simply written into `.workrail/` config.
- **Edge-case gap**: this flow says little about how purely personal, cross-repo, or private remote sources should relate to rooted sharing.

### Adversarial critique

- A skeptical stakeholder might say:
  - “This is cleaner, but it only works because you narrowed to the team-sharing case.”
  - “You still haven’t removed configuration; you just renamed it to root registration.”
  - “Without a source inspector and migration bridge, users will still get confused when the behavior differs from current docs and current runtime.”
  - “This could create another partially-implemented setup story if `.workrail/config.json` and root discovery are not made truly canonical.”

### What likely works well

- same-repo team sharing
- monorepo / internal collaboration use cases
- weaker models that benefit from a small number of concrete rules

### What likely works less well

- arbitrary third-party source install from URLs
- private/self-hosted Git onboarding
- users who expect immediate automation rather than convention + one-time registration

### Feedback summary

- **Overall verdict**: promising for phase 1, but only if paired with:
  - a credible root-registration mechanism
  - grouped source visibility / verification
  - a migration-aware explanation of how this relates to current env-based behavior

### Decision impact

- This lightweight test **strengthens** the recommendation to use `Rooted Team Sharing` as phase 1.
- It also **strengthens** the need to pull some `Source Control Tower` capabilities earlier, especially source visibility and verification.
- It does **not** remove the need for `Guided Install + Canonical Source Catalog`; it just reinforces that those should probably come after the simpler rooted-sharing path is validated.

### Recommended adjustments after lightweight test

- Narrow phase 1 further:
  - repo-local `.workrail/workflows/`
  - one-time root registration
  - grouped listing / source visibility
- Explicitly defer:
  - generalized remote install
  - self-hosted auth automation
  - full canonical source catalog implementation
- Add migration messaging early so current users understand how rooted sharing coexists with existing behavior

### Next learning questions

- Can root registration be made simple enough to feel like a one-time setup rather than “new configuration burden”?
- What is the minimum source inspector capability needed for users to trust the result?
- Does this path still feel simplest when tested with a weaker model that cannot improvise as well?

## Feedback Capture — Iteration 2

### Test mode

- **Type**: lightweight stakeholder Q&A simulation + weaker-model thought experiment
- **Prototype tested**: updated phase-1 concept:
  - `Rooted Team Sharing + minimal Source Control Tower`
- **Focus of this pass**:
  - rollout/migration concerns
  - weaker-model robustness
  - skeptical stakeholder objections

### What we simulated

- A skeptical maintainer asks:
  - “How is this different from just moving complexity around?”
  - “What happens while current env-first behavior still exists?”
  - “Will weaker models fall back to the old setup story and confuse users?”
- A weaker-model replay is imagined where the assistant is more literal and less able to synthesize docs, code reality, and future direction.

### Observed positives

- The updated phase-1 framing is stronger than the original rooted-sharing-only framing because it now explicitly includes verification/visibility.
- The proposal remains relatively rollout-friendly because it can be additive:
  - repo-local convention can coexist with existing env-based sources
  - grouped visibility can help explain mixed old/new setups
- The weaker-model path likely improves when the concept is reduced to:
  - put workflows in `.workrail/workflows/`
  - register the root
  - check grouped source output

### Observed friction / concerns

- **Migration ambiguity remains a major risk**:
  - if old and new setup paths coexist, users may not know which one “won”
  - grouped visibility helps, but only if the source labeling is very clear
- **Weaker-model drift is still plausible**:
  - a weaker agent might read current docs/code and tell the user to use `./workflows` or env vars instead of the new rooted-sharing path unless the product strongly privileges the new path
- **Root registration still needs a crisp home**:
  - if it lives in a new config but the rest of current behavior still feels elsewhere, users may experience the system as split-brain
- **Stakeholder skepticism is still valid**:
  - this does not yet remove configuration entirely
  - it removes per-source configuration in the common team case, which is a narrower but more honest claim

### Stakeholder-style objections

- “This only works if the documentation and product language stop advertising the older setup as the default team path.”
- “If current `./workflows` discovery and env-driven sources remain prominent, users will get two parallel mental models.”
- “Without a migration assistant or explicit precedence explanations, support burden may go up before it goes down.”

### Weaker-model robustness assessment

- **Likely to work if**:
  - the prompt/script is highly structured
  - the product names the phase-1 path clearly
  - source verification output is concrete and grouped
- **Likely to fail if**:
  - the model is left to infer the preferred path from mixed old/new docs
  - the verification output is ambiguous
  - root registration is underexplained or spread across multiple config locations

### Feedback summary

- **Overall verdict**: still promising, but rollout discipline now looks almost as important as the UX concept itself.
- The second-pass test increases confidence in the **shape** of the phase-1 idea, while reducing confidence that it will land well without:
  - explicit migration guidance
  - strong precedence/source labeling
  - product/docs alignment around the preferred team path

### Decision impact

- Keep the updated recommendation:
  - `Rooted Team Sharing + minimal Source Control Tower`
- Raise migration and precedence clarity from “important” to **phase-1 launch requirements**
- Treat weaker-model robustness as a design constraint, not just a test detail

### Recommended adjustments after second lightweight test

- Make the preferred team path unmistakable in user-facing guidance
- Add migration/compatibility messaging directly into the phase-1 design
- Require grouped source output to make precedence and source origin obvious
- Avoid shipping rooted sharing without at least minimal “why these workflows are visible” explanations

### Next learning questions

- What is the minimal migration assistant needed so old and new paths can coexist safely?
- How should precedence be displayed when repo-root workflows, built-ins, and legacy env-based sources overlap?
- What exact wording keeps weaker models on the preferred rooted-sharing path instead of falling back to legacy advice?

## Iteration 1: Updates

### Changes made

- **POV**:
  - updated to emphasize not just setup simplicity, but also immediate source provenance verification after setup
- **HMW**:
  - added a new HMW question focused explicitly on post-setup verification and trust:
    - “How might we make verification of ‘where these workflows came from’ simple enough that users trust the result immediately after setup?”
- **Shortlist**:
  - kept the same three shortlist items
  - updated the emphasis so the phase-1 favorite is now:
    - `Rooted Team Sharing + minimal Source Control Tower`
  - kept `Guided Install + Canonical Source Catalog` as the longer-term north star
- **Prototype spec/artifact**:
  - updated the smallest shippable slice to require grouped listing / source visibility
  - added a prototype adjustment stating that verification is part of the prototype, not an optional final step

### Rationale

- The lightweight test suggested that the team-sharing concept is promising, but it does not stand on its own unless users can verify what happened afterward.
- These changes tighten the phase-1 recommendation so it is less likely to under-deliver trust and clarity.
- They also reduce the risk of building a setup path that feels simpler during guidance but confusing after completion.

### Iteration reflection

- **What did we learn that surprised us?**
  - The simplest team-sharing path looked stronger than expected, but the need for source visibility turned out to be more central than initially framed.
- **What did we previously believe that is now false?**
  - We previously treated source visibility as a supporting concern that could follow setup later; it now looks like a phase-1 requirement for trustable rooted sharing.

## Iteration 2: Updates

### Changes made

- **POV**:
  - no structural rewrite, but the surrounding artifacts now treat migration and precedence clarity as part of delivering the promised simple setup experience
- **HMW**:
  - added a new HMW question focused on keeping weaker models and mixed old/new documentation on the preferred setup path instead of drifting back to legacy env-first advice
- **Shortlist**:
  - kept the same updated phase-1 favorite
  - strengthened the wording so `Rooted Team Sharing + minimal Source Control Tower` now explicitly includes:
    - migration clarity
    - precedence visibility
    - weaker-model-safe guidance
- **Prototype spec/artifact**:
  - expanded the smallest shippable slice to include minimal precedence explanation
  - added a second prototype adjustment requiring migration and precedence messaging in the prototype narrative

### Rationale

- The second lightweight test showed that the concept itself is still strong, but rollout and model-drift risks are more central than previously assumed.
- These updates make the phase-1 recommendation more honest and more likely to survive real rollout conditions.
- They also reduce the chance of shipping a conceptually elegant path that collapses when old and new setup models coexist.

### Iteration reflection

- **What did we learn that surprised us?**
  - rollout clarity and model guidance rose to near-equal importance with the core interaction design
- **What did we previously believe that is now false?**
  - we previously treated migration and precedence messaging as adjacent concerns; they now look like core phase-1 requirements

## Iteration 3: Explicit workspace identity and remembered roots

### Changes made

- **POV**:
  - no core rewrite, but the surrounding design now assumes explicit workspace identity rather than inferred MCP roots
- **HMW**:
  - no new HMW added in this pass
- **Shortlist**:
  - kept the same phase-1 favorite
  - refined it further to include:
    - required explicit `workspacePath`
    - silent remembering of repo roots in `~/.workrail/config.json`
    - recursive discovery of team/module `.workrail/workflows/` under remembered roots
- **Prototype spec/artifact**:
  - updated the smallest shippable slice so root memory is user-level and recursive module/team discovery is first-class
  - required the prototype narrative to show silent user-level remembering of repo roots

### Rationale

- New feedback made two things explicit:
  - MCP roots are not trustworthy enough to anchor discovery
  - silent user-level persistence is desirable for cross-repo UX
- These changes let WorkRail stay repo-aware without being tied to one repo, and without forcing `.workrail/` into the main repo root.

### Iteration reflection

- **What did we learn that surprised us?**
  - user-level remembered roots appear to be a better cross-repo primitive than trying to make repo-local setup do all the work
- **What did we previously believe that is now false?**
  - we previously treated MCP roots as a plausible fallback for workspace identity; that is no longer acceptable for this design

## Iteration Notes

- Initial framing completed from direct inspection of current code and planning docs.
- Strongest design seam discovered so far:
  - current shipping model is env-first
  - platform vision already points to `.workrail/config.json` plus auto-discovery and setup prompts
- Empathy phase grounded primarily in code/document evidence rather than user interviews, so several behavioral interpretations remain assumptions to validate later.

## Counters (DT IDs)

- Next DT ID: DT-070
