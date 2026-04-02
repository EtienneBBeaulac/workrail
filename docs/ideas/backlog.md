# Ideas Backlog

Workflow and feature ideas that are worth capturing but not yet planned or designed.

## Workflow ideas

### Standup Status Generator

- **Status**: idea
- **Summary**: A workflow that automatically generates a daily standup status by aggregating activity across the user's tools since the last standup.
- **Data sources** (adaptive based on what the user has available):
  - Git history (commits, branches, PRs/MRs)
  - GitLab (merge requests, comments, reviews)
  - Jira (ticket transitions, comments, new assignments)
  - Other issue trackers or project management tools the user configures
- **Key behavior**:
  - Detect the last standup date (stored in session or inferred from history)
  - Aggregate activity since that date across all configured sources
  - Categorize into "what I did", "what I'm doing today", and "blockers"
  - Generate a concise, human-readable standup message
- **Design considerations**:
  - Should be tool-agnostic: detect available integrations and adapt
  - Could leverage MCP tool discovery to find available data sources at runtime
  - Needs a lightweight persistence mechanism for last-standup timestamp
  - Output format should be configurable (Slack message, plain text, structured JSON)

## Feature ideas

### Remote references (URLs, GDocs, Confluence, etc.)

- **Status**: idea
- **Summary**: Extend the workflow `references` system to support remote sources (HTTP URLs, Google Docs, Confluence pages, etc.) in addition to local file paths. WorkRail remains a pointer system — it resolves and delivers reference metadata, and the agent does the actual fetching using whatever tools it has available. Auth is entirely delegated to the agent.
- **Core design principle**: same model as today, extended to remote sources. WorkRail validates that a reference declaration is well-formed, delivers the pointer to the agent at workflow start, and the agent fetches the content with its own HTTP or integration tools. If the agent lacks access, it surfaces that to the user — which is the right failure mode. WorkRail does not need to store credentials or act as a fetch proxy.
- **Why this matters**: teams keep their authoritative docs (architecture decisions, coding standards, runbooks, API contracts) in external systems. Remote refs let workflows point at those docs directly without requiring anyone to maintain a local copy.
- **Incremental path**:
  - Phase 1: public HTTP URLs. `resolveFrom: "url"`. WorkRail delivers the URL as a reference pointer. Agent fetches using HTTP tools. No auth surface in WorkRail.
  - Phase 2: workspace-configured bearer tokens in `.workrail/config.json` keyed by domain. Covers most internal tools (Confluence API tokens, private wikis, etc.) without native integrations.
  - Phase 3: named integrations (GDocs, Confluence, Notion) as first-class configured sources — the full platform play, only if Phase 1/2 prove insufficient.
- **Reachability validation**: soft check or skippable at start time. A URL being reachable during validation doesn't guarantee the agent can authenticate at runtime, and a failed ping shouldn't block the workflow from starting.
- **Design questions**:
  - Should WorkRail attempt a reachability check at start time, or skip entirely for remote refs?
  - How should remote refs appear in `workflowHash`? The declaration is stable but content is not — may need content-hashing at fetch time or explicit versioned URLs for determinism.
  - Should the `references` schema add a `kind` field (`local` vs `remote`) or infer from the `source` value?
- **Risks / tradeoffs**:
  - Agent-side fetching means the workflow only works if the agent has appropriate tools — acceptable tradeoff, explicitly the user's responsibility
  - Remote content can change between runs, weakening the determinism guarantee that local refs provide

### Declarative workflow composition engine

- **Status**: idea
- **Summary**: Instead of authoring full workflow JSON for every use case, users or agents fill out a declarative spec (dimensions, scope, rigor level, etc.) and the WorkRail engine assembles a workflow automatically from a library of pre-validated routines and step templates. The agent is a form-filler, not an architect - the composition logic lives in the engine.
- **Why this is different from agent-generated workflows**:
  - Agent-generated workflows have no quality gate - you're trusting the agent's judgment on structure, which is exactly what workflow-for-workflows exists to prevent
  - Engine-composed workflows are assembled from pre-reviewed building blocks using deterministic rules - same spec always produces the same workflow shape
  - Trustworthy because composition logic is owned by WorkRail, not improvised at runtime
- **How it would work**:
  - A composable routine library with well-defined inputs, outputs, and composition contracts
  - A spec format that captures user intent declaratively (e.g. workflow type, dimensions to cover, scope, rigor mode)
  - A composition engine that selects and wires the right routines based on the spec
  - The assembled workflow is fully inspectable before execution - no black box
- **Relationship to current authoring**:
  - Full workflow JSON authoring remains the escape hatch for workflows that need custom shapes the composition engine can't express
  - Composition covers the common cases; manual authoring covers the edge cases
  - Routines built for composition also remain usable as standalone delegatable units in manually authored workflows
- **Good early use cases**:
  - Audit-style workflows (scalability audit, readiness audit, tech debt audit) - user picks dimensions, engine assembles the right auditor steps
  - Review workflows - user picks scope and rigor, engine assembles reviewer family + synthesis
  - Investigation workflows - user picks investigation type, engine assembles the right hypothesis + evidence + validation path
- **Design questions**:
  - What is the right spec format? Enums + variables + a workflow type identifier? A richer DSL?
  - How does the engine handle dependencies between composed steps (context flow, artifact ownership)?
  - Should composition happen at session-start time (assembled once, then executed) or be fully static (compiled to workflow JSON)?
  - How does the console/dashboard show a composed workflow's structure vs a manually authored one?
  - What is the governance model for the composable routine library - who can add to it, and what quality bar do new routines need to meet?
- **Risks / tradeoffs**:
  - A composition engine is a significant investment - the routine library needs enough coverage before composition is useful
  - Composition rules can become their own form of complexity if not kept simple
  - Need a clear story for when manual authoring is the right choice vs composition, so authors don't fight the system

### Dashboard artifacts (replace file-based docs)

- **Status**: designed, not yet implemented
- **Summary**: Instead of having agents write markdown files into the working repo, agents would submit structured artifacts through `continue_workflow` output payloads. Artifacts are stored per-session and rendered in the console/dashboard. Eliminates repo pollution and gives users a single place to see all workflow outputs.
- **Key dependencies**: console/dashboard UI (does not exist yet), server-side artifact storage
- **Design doc**: `docs/reference/workflow-execution-contract.md` (section "Replacing File-Based Docs with Dashboard Artifacts")

### Derived / overlay workflows for bundled workflow specialization

- **Status**: parked idea
- **Note**: see `docs/roadmap/open-work-inventory.md` for details

### Workflow categories and category-first discovery

- **Status**: idea
- **Summary**: Improve workflow discovery by organizing bundled workflows into categories and teaching `list_workflows` to support a category-first exploration path instead of always returning one large flat list.
- **Why this seems useful**:
  - the workflow catalog is getting large enough that flat discovery is becoming noisy
  - agents often do not know the exact workflow ID they want, but they may know the task family (coding, review, docs, investigation, planning, learning)
  - category-first discovery could reduce prompt overload and make workflow selection feel more guided
- **Possible phase 1 shape**:
  - add workflow categories as metadata on workflow definitions or a registry-side mapping
  - extend `list_workflows` with an optional category-style input
  - if no category is passed, return:
    - category names
    - workflow count per category
    - a few representative workflow titles per category
    - guidance telling the agent to call `list_workflows` again with the category it wants
  - if a category is passed, return the full workflows for that category with names, descriptions, IDs, and hashes
- **Possible phase 2 shape**:
  - support multiple discovery views such as grouped-by-category, grouped-by-source, or full flat list
  - add filtering by category + source + maybe keywords
  - align category discovery with future platform / multi-root discovery work
- **Design questions**:
  - should categories live in workflow JSON, in a registry overlay, or be inferred from directory / naming conventions?
  - should `list_workflows` become polymorphic, or should category discovery be a separate read-only tool / mode?
  - how much summary content should the uncategorized response include before it becomes too verbose again?
  - how do categories interact with routines, examples, project workflows, and external workflow repositories?
- **Risks / tradeoffs**:
  - changing `list_workflows` is a real tool contract and output-schema change, not just a UI tweak
  - overloading one tool with too many discovery modes could make the contract less predictable
  - static categories can drift unless there is a clear ownership model
- **Related docs / context**:
  - `docs/plans/workrail-platform-vision.md` (already discusses grouped discovery by source)
  - `docs/roadmap/open-work-inventory.md` (legacy workflow modernization increases the need for better discovery)
  - current implementation: `src/mcp/handlers/v2-workflow.ts`, `src/mcp/v2/tools.ts`, `src/mcp/output-schemas.ts`

### Multi-root workflow discovery and setup UX

- **Status**: designing
- **Summary**: Simplify third-party and team workflow hookup by requiring explicit `workspacePath`, silently remembering repo roots in user-level `~/.workrail/config.json`, recursively discovering team/module `.workrail/workflows/` folders under remembered roots, and improving grouped source visibility / precedence explanations. Use workspace-aware ranking, cross-repo surfacing, and later console integration as the control plane for inspecting remembered roots, discovered workflow sources, and precedence. For remote repositories, prefer **managed sync by default** so users experience remote workflow repos as connected and kept current while WorkRail still reasons over a local effective state. Avoid trusting MCP roots and avoid requiring workflow config to live at the main repo root.
- **Current recommendation**:
  - phase 1: `Rooted Team Sharing + minimal Source Control Tower`
  - require explicit workspace identity
  - silently persist repo roots at the user level
  - support cross-repo workflows from remembered roots
  - make remote repos default to managed-sync mode rather than pinned snapshots or live-remote behavior
  - treat Slack/chat/file/zip sharing as an ingestion path that classifies into repo, file, pack, or snippet flows
  - design the backend so the console can eventually manage and explain the remembered/discovered source model
- **Additional idea**:
  - explore enterprise auth / SSO integration for private repo access, such as Okta-backed flows for GitHub Enterprise, GitLab, or other self-hosted providers
  - likely shape: WorkRail detects that a private repo uses org-managed auth and guides the user through the right browser/device-code/credential flow instead of assuming raw personal-access-token setup
  - main question: should WorkRail integrate directly with identity providers like Okta, or should it integrate one layer lower with Git hosts / credential helpers that are already SSO-aware?
- **Design doc**: `docs/ideas/third-party-workflow-setup-design-thinking.md`

### Workflow rewind / re-scope support

- **Status**: idea
- **Summary**: Allow an in-progress workflow session to go back to an earlier point when new information changes scope understanding, invalidates assumptions, or reveals that the current execution path is wrong.
- **Why this seems useful**:
  - agents and users often learn important scope information only after work has already started
  - current step-by-step enforcement is strong, but it can feel rigid if the original framing turns out to be wrong
  - a first-class rewind / re-scope mechanism could make workflows feel safer and more adaptable without abandoning structure
- **Possible phase 1 shape**:
  - allow rewind to a prior checkpoint or earlier decision node with an explicit reason
  - record a short “why we rewound” note in session history
  - make the resumed path visible in the console/session timeline
- **Possible phase 2 shape**:
  - support scope-change prompts like:
    - “our understanding changed”
    - “the task is broader/narrower than we thought”
    - “we need to revisit planning before implementation”
  - let workflows declare safe rewind points or re-scope checkpoints explicitly
  - support branch-aware comparison between abandoned and current paths
- **Design questions**:
  - should rewind be limited to explicit checkpoints, or should WorkRail support arbitrary node-level rewind?
  - how should the system preserve durable notes and outputs from abandoned paths?
  - should some workflow steps be marked as non-rewindable once external side effects have happened?
  - how should the agent explain to the user what changed and why a rewind is appropriate?
- **Risks / tradeoffs**:
  - rewind power could make workflows feel less deterministic if used too casually
  - durable session history gets more complex when abandoned paths and resumed paths coexist
  - workflows with real-world side effects may need stricter rollback / compensation rules

### Assessment-gate follow-up tiers beyond v1

- **Status**: idea
- **Summary**: Capture the likely progression of assessment-triggered redo / follow-up behavior so the engine can grow beyond the narrow v1 same-step follow-up model without losing the conceptual roadmap.
- **Why this seems useful**:
  - assessment-triggered follow-up is likely to want richer behavior over time
  - the v1 consequence model is intentionally narrow, but the design pressure already points toward stronger redo semantics
  - writing the tiers down now reduces the chance that future work jumps straight to a subflow design without acknowledging the intermediate options
- **Tier 1: same-step follow-up retry**
  - consequence keeps the same step pending
  - engine returns semantic follow-up guidance
  - agent retries the same step after improving its work / evidence
  - this is the current intended v1 behavior
- **Tier 2: structured redo recipe on the same step**
  - same step still remains the logical unit of work
  - engine can surface a bounded checklist or structured follow-up actions
  - no new DAG nodes or true subflow yet
  - likely useful if “retry” is too vague but full subflow control flow would be too heavy
- **Tier 3: assessment-triggered redo subflow**
  - matched assessment consequence routes into an explicit sequence of follow-up steps
  - subflow has its own durable progress and then returns to the original step or onward path
  - this is a significantly larger feature because it introduces assessment-driven control-flow behavior rather than just a blocked follow-up requirement
- **Design questions**:
  - when does Tier 2 become necessary instead of plain semantic retry guidance?
  - what durable model would Tier 3 need for entering, progressing through, and returning from a redo subflow?
  - how should the engine distinguish “redo the same step better” from “enter a dedicated recovery path”?
  - can Tier 3 reuse existing workflow / routine primitives, or would it need dedicated assessment-triggered topology support?
- **Risks / tradeoffs**:
  - jumping straight from Tier 1 to Tier 3 could create a hidden mini control-flow DSL
  - Tier 2 may be enough for many real cases and should not be skipped without evidence
  - Tier 3 likely changes authoring, durability, replay, and console explainability at the same time

### Console engine-trace visibility and phase UX

- **Status**: idea
- **Summary**: Evolve the console from a node-only DAG viewer into an execution-aware surface that shows both created nodes and the engine decisions that explain how the run got there. This should make fast paths, skipped phases, condition evaluation, loop entry/exit, and branch selection legible instead of looking like missing DAG nodes or broken rendering.
- **Why this seems useful**:
  - users currently see only `node_created` / `edge_created`, which makes legitimate engine behavior look like missing workflow phases
  - workflows use authoring concepts like phases, fast paths, run conditions, and loop gates, but the console does not show those decisions today
  - sessions like small-task fast paths can appear to “jump” from phase 0 to phase 5 even when the engine is behaving correctly
- **Current gap**:
  - engine event log records `decision_trace_appended`, `context_set`, and related runtime decisions
  - console DTOs expose only run status plus DAG nodes/edges and node detail
  - there is no first-class UI for “why the engine chose this path”
- **Recommended direction**:
  - keep phases as authoring / workflow-organization concepts
  - stop treating the rendered DAG as the whole execution story
  - add an engine-trace / decision layer that can show:
    - selected next step
    - evaluated conditions
    - entered/exited loops
    - important run context variables such as `taskComplexity`
    - skipped / bypassed planning paths such as small-task fast paths
- **Possible phase 1 shape**:
  - extend console service / DTOs with a run-scoped execution-trace summary
  - show a compact “engine decisions” strip or timeline above the DAG
  - annotate jumps such as “small-task fast path selected” so sparse DAGs do not look broken
- **Possible phase 2 shape**:
  - richer explainability timeline with branches, skipped authoring phases, and condition results
  - allow toggling between “execution DAG” and “engine trace” views, or combine them in one unified run narrative
  - surface effective run context and selected branch/loop decisions in node detail or run detail
- **Design questions**:
  - should the console continue using phase-oriented labels in the primary UI, or should it prefer step titles / execution narrative labels?
  - should trace events appear as first-class timeline items, DAG annotations, or a separate run-explanation panel?
  - what subset of run context variables is useful enough to surface without becoming noisy?
  - how do we distinguish authoring structure from runtime execution structure cleanly in the UX?
- **Risks / tradeoffs**:
  - exposing too much raw engine state could make the console noisier and harder to scan
  - mixing authoring structure and runtime trace without clear separation could create more confusion, not less
  - DTO growth needs care so the console does not become tightly coupled to every low-level event detail
- **Related docs / context**:
  - `docs/reference/workflow-execution-contract.md`
  - `docs/design/v2-core-design-locks.md`
  - `docs/plans/workrail-platform-vision.md`
  - current implementation: `src/v2/usecases/console-service.ts`, `src/v2/projections/run-context.ts`, `console/src/api/types.ts`

### Workflow previewer for compiled and runtime behavior

- **Status**: idea
- **Summary**: Add a workflow previewer for the `workflows/` directory that shows what a workflow actually compiles to and how the engine can traverse it at runtime.
- **Why this seems useful**:
  - authors currently have to mentally reconstruct branching, loops, blocked-node behavior, and other runtime structure from authored JSON plus tests
  - advanced workflow authoring gets much easier when the compiled DAG and runtime edges are visible
  - it would help explain engine behavior to both contributors and workflow authors
- **What it should show**:
  - the compiled step graph / DAG
  - branch points and condition-driven paths
  - loop structure and loop-control edges
  - blocked / resumed / checkpoint-related node shapes where applicable
  - template/routine expansion boundaries or provenance
  - the gap between authored JSON structure and runtime execution structure
- **Initial scope**:
  - start as a read-only preview for bundled workflows
  - optimize for accuracy over polish
  - do not require full execution simulation in phase 1
- **Design questions**:
  - should this live in the existing Console, as a dev-only page, or as a local authoring utility?
  - should it show only the compiled DAG, or also annotate likely runtime transitions such as blocked attempts, rewinds, and loop continuations?
  - how much provenance should it expose for injected routines/templates?

### Native assessment / decision gates for workflows

- **Status**: idea
- **Summary**: Add a first-class workflow primitive for structured assessments that can drive routing. The agent would assess a small set of named dimensions, give short rationales, and let the engine use explicit aggregation / gate rules to influence continuation, follow-up, branching, or final confidence.
- **Why this seems useful**:
  - some workflow decisions are clearer and more auditable as small assessment matrices than as long prompt prose
  - confidence computation is a strong example: workflows may want to derive final confidence from dimensions like boundary, intent, evidence, coverage, and disagreement
  - explicit assessment gates would let the engine drive loops/branches without relying entirely on prose interpretation
- **Near-term shape**:
  - keep the reasoning with the agent, but let the workflow declare named assessment dimensions and allowed levels such as `High | Medium | Low`
  - let the agent provide one short rationale per dimension
  - let the engine compute caps / next actions / routing outcomes from explicit gate rules
- **Ownership split**:
  - the **agent** assesses each dimension and gives the short rationale
  - the **engine** applies declared gate rules such as caps, routing outcomes, or follow-up triggers
- **Longer-term shape**:
  - add a first-class authoring primitive such as `assessmentGate`, `assessmentRef`, or similar
  - optionally allow reusable built-in or repo-owned assessment schemas/matrices
  - optionally validate assessment shape against WorkRail-owned schemas
- **Good early use cases**:
  - MR review confidence assessment
  - planning readiness / confidence gates
  - debugging confidence and next-step routing
  - block-vs-continue / revisit-earlier-step decisions
- **Design questions**:
  - should this be a narrow `assessmentGate` primitive or a more generic structured decision-table feature?
  - should reusable matrices be inline first, or backed by repo-owned refs from the start?
  - how much aggregation logic should the engine support directly versus leaving to workflow-defined rules?
  - how should assessment provenance and rationales appear in compiled/runtime traces?

### Engine-injected note scaffolding

- **Status**: related follow-on idea
- **Summary**: Add an opt-in execution-contract or note-structure feature that helps agents produce compact notes useful to both humans and future resume agents.
- **Why it may matter**:
  - some workflows want notes to consistently capture current understanding, key findings, decisions, uncertainties, and next-step implications
  - this is related to assessment-driven routing, but it is a different product concern
- **Open question**:
  - should note scaffolding live as a separate execution-contract feature, or share any underlying primitives with assessment gates?
