# MR Review Workflow Redesign

## Status

This is a working design document for redesigning `workflows/mr-review-workflow.agentic.v2.json`.

It is intentionally ahead of the current workflow JSON. The goal is to converge on the right workflow shape here first, then update the bundled workflow once the design feels solid.

## Problem Statement

The current MR review workflow is meaningfully better than the older review flows, but it is still not in its best shape.

It is strong on:

- reviewer-family parallelism
- contradiction-aware synthesis
- notes-first durability
- final validation and human-facing handoff

It is weaker than elite human review practice in the areas that determine whether the review is even operating on the right target and the right context:

- identifying the actual MR / PR rather than just a diff
- finding the true review boundary and merge base
- handling stacked branches and inherited changes
- reconstructing author intent from tickets and docs
- filtering noise and low-signal churn before deep review begins
- degrading gracefully when discovery surfaces are unavailable
- explaining to the user what the workflow could and could not access

## Design Goal

Redesign the workflow so that it behaves more like a top-tier human reviewer:

1. find the real review target
2. find the real review boundary
3. gather all realistically available context
4. adapt review rigor to the shape of the change
5. disclose confidence, uncertainty, and environment limitations clearly

## Product Decisions

This section records the current recommended product direction for the redesign. These are stronger than brainstorming notes, but still revisable if later review reveals a better shape.

### The workflow should try to find the actual MR, not just inspect local changes

The workflow should explicitly prefer discovering the actual MR / PR when possible.

Why:

- the PR often contains intent, scope, linked issues, reviewer discussion, and branch context that a raw diff does not
- PR metadata can help identify the correct review boundary
- strong human reviewers usually review the authored change in its review context, not just the visible patch

Recommended behavior:

- if the user already provides a PR URL or identifier, use that as the first-class review target
- if the user provides only a branch, patch, or vague review request, attempt to discover the corresponding MR / PR
- if no MR / PR can be found, continue with diff-based review rather than block
- if the review remains diff-only, lower context confidence and disclose the limitation in final handoff

### The workflow should try to discover ticket and document context

The workflow should attempt to recover ticket and supporting-document context when available.

Priority sources include:

- linked issues or tickets from the PR or commit messages
- repo-local docs such as BRDs, RFCs, specs, rollout docs, migration docs, and product notes
- external systems reachable through installed CLI tools or MCPs
- web-retrieved docs when browsing is available and genuinely useful

Why:

- code review quality depends heavily on whether the implementation matches intended behavior, non-goals, constraints, and rollout expectations
- strong reviewers compare code against intent, not just against syntax and local correctness

Recommended behavior:

- attempt discovery opportunistically and non-blockingly
- extract intent, acceptance criteria, non-goals, risks, and rollout expectations into durable workflow context
- if ticket/doc context is missing, continue the review but lower context confidence

### Missing enrichment sources should not block by default

The workflow should degrade gracefully when discovery surfaces are missing or insufficient.

Recommended behavior:

- do not block merely because `gh`, ticket MCPs, or web browsing are unavailable
- only block when the review target itself is missing or when the workflow cannot inspect enough material to review anything meaningful
- record what was accessible, what failed, what was not attempted, and why
- surface improvement suggestions in the final handoff, not as noisy mid-workflow nags unless the missing source is critical

### The workflow should be never-stop by default for enrichment and confidence gaps

The redesign should make "continue with degraded confidence" the default behavior.

That means the workflow should not stop merely because it cannot:

- find the PR/MR
- find the ticket
- find supporting docs
- use `gh`
- use web browsing
- use ticket-system MCPs
- confidently establish the merge base on the first attempt

It should stop only when:

- there is no meaningful review target
- there is no inspectable material to review
- the user must provide a missing artifact that cannot be recovered any other way

This should be treated as a core product requirement, not a soft preference.

### The final handoff should include an explicit environment-status section

The workflow should end with a user-visible summary of review environment quality.

That section should explain:

- what the workflow successfully accessed
- what it attempted but could not access
- what it never attempted
- how those gaps affected boundary confidence, context confidence, or final recommendation confidence
- what tooling or workflow habits would improve future reviews

This is important because graceful degradation only helps the user if they can actually see what degraded.

### Ancestor and merge-base handling must become first-class

The redesign should explicitly treat review-boundary detection as a core responsibility, not a hidden subtask.

Recommended behavior:

- determine candidate base branch or parent branch
- attempt to find the true merge base / ancestor
- detect stacked branches, stale branches, and divergent branches
- separate branch-specific changes from inherited or upstream changes
- produce an explicit boundary-confidence assessment

If confidence remains low:

- continue with best effort
- lower recommendation confidence when boundary uncertainty materially affects findings
- disclose the uncertainty clearly in final handoff

### The workflow should adapt by change type, not just size

The redesign should keep QUICK / STANDARD / THOROUGH, but add structured change-shape adaptation.

This should influence:

- reviewer-family selection
- validation depth
- whether simulation or rollout analysis is needed
- how much false-positive suppression is required
- how much boundary follow-up is warranted

### The workflow should account for repo rules, user preferences, and coding philosophy

The redesign should treat review-policy context as first-class review input.

That includes:

- repo conventions
- user-specified rules and preferences
- architecture guidance
- coding philosophy
- review-specific instructions
- any explicit team or project constraints discoverable from docs, workflow guidance, or user-provided rules

Why:

- a technically sharp review can still be wrong for the repo if it ignores the user’s rules and architectural preferences
- strong human reviewers adapt their evaluation to the standards of the codebase they are reviewing

Recommended behavior:

- attempt to discover policy context alongside ticket/doc context
- extract durable summaries of rules, conventions, and constraints into workflow context
- use this policy context to calibrate findings, recommendations, and false-positive suppression

### This redesign is necessary, but not sufficient for elite human parity

This redesign would make the workflow materially stronger and much more trustworthy.

However, even after these changes, it will likely still lag the best human reviewers in:

- severity calibration
- historical reasoning
- large-review partitioning
- subtle product judgment under weak evidence

That means this redesign should be treated as a major step toward high-quality review, not the final endpoint.

## Non-Goals

- changing engine behavior
- adding new MCP tool implementations in this pass
- forcing the workflow to block whenever enrichment sources are missing
- making the human-facing review doc canonical workflow state
- fully solving severity calibration, historical reasoning, or large-MR partitioning in the same pass

## WorkRail-Native Authoring Opportunities We Should Use

The redesign should take fuller advantage of WorkRail's current v2 surface area instead of expressing everything as plain prompt prose.

### Features with config, not just simple toggles

The workflow should likely use:

- `wr.features.mode_guidance`
- `wr.features.durable_recap_guidance`
- `wr.features.capabilities`
- `wr.features.output_contracts`

And it should consider using the configurable form where helpful, especially for:

- collapsed capability probes
- artifact-backed capability observations
- consistent enforcement of output contracts across blocking and never-stop modes

### Template-anchored capability probes

Where the workflow needs to learn whether `delegation` or `web_browsing` is actually usable, it should prefer explicit template-anchored probing over handwritten duplicated probe prose.

The clearest existing fit is:

- `wr.templates.capability_probe`

paired with:

- `wr.contracts.capability_observation`

This is especially relevant for the early enrichment phase.

### Prompt refs instead of duplicated guidance

The redesign should plan to use `wr.refs.*` snippets for repeated canonical guidance rather than copying the same durable-state or synthesis instructions into many steps.

High-value likely uses include:

- notes-first durability guidance
- synthesis-under-disagreement guidance
- parallelize-cognition / serialize-synthesis guidance
- adversarial challenge guidance

### PromptBlocks as the default step shape

The workflow should favor `promptBlocks` over large single-string prompts for major phases.

That makes it easier to:

- keep the prompts deterministic
- expose clear `goal`, `constraints`, `procedure`, `outputRequired`, and `verify` structure
- attach reusable references and future feature injections cleanly

### Conditions and loop contracts as first-class control flow

The redesign already wants loop-based contradiction and follow-up handling. It should lean into current v2 patterns more explicitly by:

- defining named conditions where that improves clarity
- using `wr.contracts.loop_control` consistently for loop decisions
- treating loop continuation as data, not prose

### Decision-trace and never-stop semantics awareness

The workflow should be written with WorkRail's durable `blocked` / `gap_recorded` semantics in mind.

That means:

- blocking vs never-stop should be intentional per capability/input requirement
- missing preferred capabilities should degrade with durable disclosure
- important confidence-relevant misses should be representable as explicit gaps, not only narrative caveats

### Auditor-style delegation, not only executor-style delegation

The subagent design docs strongly support the auditor model.

The MR review redesign should make fuller use of that by treating many delegations as:

- audits of the main agent's gathered context
- challenges to the main agent's current hypothesis
- verification of the current recommendation

rather than always delegating broad independent ownership of a phase.

This is especially valuable for:

- context completeness / depth audits
- boundary-confidence audits
- philosophy-alignment audits
- final recommendation validation

### Routine reuse should be explicit

The redesign currently references a few routines conceptually, but it should make clearer use of the current routine catalog.

High-value candidates include:

- `routine-context-gathering`
- `routine-hypothesis-challenge`
- `routine-execution-simulation`
- `routine-philosophy-alignment`
- `routine-final-verification`

These should be treated as current reusable building blocks, not future ideas.

### Direct execution vs delegation vs injection should be chosen deliberately

The routines guide gives three valid consumption modes:

- delegation to a WorkRail Executor
- direct execution by the current agent
- compile-time injection via routine templates

The redesign should decide per use case:

- delegate when independent cognitive perspective is valuable
- execute directly when overhead is unnecessary
- inject when step visibility, confirmation behavior, and session traceability matter

### Extension points can improve customization without weakening orchestration

The redesign previously deferred extension points for readability. That was reasonable, but the current WorkRail extension-point model is strong enough that we should explicitly plan where bounded customization would add value.

The best candidates appear to be:

- reviewer-family bundle policy
- philosophy-alignment review
- final verification

The parent workflow should still own sequencing, loop control, and canonical synthesis.

### AgentRole is underused

The redesign should consider a stronger workflow-level `agentRole` and selective step-level overrides for:

- boundary detective mode
- evidence-first synthesizer mode
- adversarial validator mode
- philosophy auditor mode

This is lower leverage than control flow and routines, but still worth using intentionally.

## Structure-Balance Framework

The redesign should optimize for structured freedom rather than either extreme:

- not a loose "trust the model" review flow
- not a rigid form-filling bureaucracy

The workflow should be rigid where determinism, safety, or honesty matter, and adaptive where LLM reasoning quality matters most.

### Keep rigid

These are the parts that should stay explicitly structured and hard to skip:

- phase boundaries
- minimum required outputs before advancing
- confidence reporting
- loop / follow-up triggers
- blocked vs never-stop semantics
- final handoff sections
- explicit disclosure of gaps and unknowns
- the rule that reviewer/subagent output is evidence, not canonical truth

These are the workflow invariants. They prevent omission, hidden drift, and fake certainty.

### Keep semi-structured

These should have strong guidance and matrices, but not exhaustive decision automation:

- shape/type routing
- confidence combination rules
- severity calibration
- artifact vs context split
- when to delegate vs inject vs execute directly
- when policy-context should materially affect findings

These are the parts where structured heuristics help, but judgment still matters.

### Keep adaptive

These should deliberately leave room for model creativity and non-obvious reasoning:

- exploration order
- which evidence sources seem most promising first
- how to connect clues across PR, code, docs, history, and repo patterns
- how to synthesize multiple weak signals into a coherent concern
- how to phrase findings for maximum clarity and usefulness
- when an unusual MR deserves extra scrutiny beyond the default routing heuristics

These are the parts where LLMs can outperform rigid scripts.

### Matrix and field admission rule

A matrix, field, or ledger element earns its place only if it does at least one of these:

- prevents a real recurring failure mode
- improves deterministic control flow or resumability
- improves user-visible honesty or explainability
- changes routing or review depth in a meaningful way

If it does none of those, it should be removed or downgraded to advisory guidance.

### Preferred design bias

When in doubt:

- constrain outcomes, not cognition
- require explicit state, not rigid thought order
- keep taxonomies small
- prefer a few high-value matrices over many low-value classifications
- use structure to prevent omission, not to suppress intelligent exploration

### Practical consequence for this redesign

This means:

- keep the confidence matrix
- keep the gap / non-blocking matrix
- keep the shape/type routing matrix
- keep the artifact vs context split
- avoid exploding shape/type categories beyond what actually changes behavior
- avoid adding ledgers or flags that do not affect routing, honesty, or final quality

## Current Workflow Gaps

### Review boundary correctness

The current workflow does not make review-boundary detection a first-class responsibility.

Missing or under-specified behavior:

- determine the actual PR/MR when possible
- identify candidate base branches
- find the true merge base / ancestor
- detect stacked branches
- detect stale or divergent branches
- separate branch-specific changes from inherited changes
- explain confidence in the chosen review surface

This is the highest-priority gap because a review can be thorough and still be wrong if it reviews the wrong surface.

### Source discovery and context enrichment

The current workflow asks for MR purpose and ticket context, but it does not strongly instruct the agent to discover them from all available sources.

Missing or under-specified behavior:

- discover the actual PR body and metadata when available
- discover linked ticket / issue context
- discover repo-local specs, RFCs, design docs, rollout docs, and acceptance criteria
- search commit messages, branch names, and nearby docs for intent clues
- use web or other external sources only when available and useful

### Capability-aware graceful degradation

The current workflow assumes tool-driven discovery in spirit, but it does not explicitly model discovery-surface availability or insufficiency.

Missing or under-specified behavior:

- probe whether GitHub CLI access is available
- probe whether ticket-system access exists
- probe whether web browsing is available
- probe whether repo-local docs exist and are discoverable
- record unavailable or insufficient sources without failing the whole review

### Review-surface hygiene

The current workflow moves from context gathering to review too quickly.

Missing or under-specified behavior:

- classify generated files
- classify mechanical churn
- classify rename-only or move-only changes
- classify likely inherited upstream changes
- classify out-of-scope or low-signal material
- focus the fact packet on the true review surface rather than all visible changes equally

### Adaptation by change shape

The current workflow adapts mostly by review size and risk.

Missing or under-specified behavior:

- adapt reviewer-family selection by change type
- distinguish API changes from migrations, refactors, config edits, test-only changes, docs-only changes, security-sensitive changes, and performance-sensitive changes
- increase boundary rigor when ancestry is ambiguous
- reduce over-review for clearly mechanical or low-risk changes

### Final disclosure

The current final handoff does not strongly require the workflow to explain:

- what it successfully accessed
- what it attempted but could not access
- what it never attempted
- how those limits affected review quality
- what environment improvements would make future reviews stronger

## Target Design Principles

### Correctness before depth

A shallow review on the right boundary is better than a deep review on the wrong boundary.

### Discover first, ask second

The workflow should aggressively use available tools and sources before asking the user for missing information.

### Degrade gracefully

Missing enrichment sources should lower confidence and be disclosed, not automatically block the workflow.

### Evidence over assumptions

The workflow should explicitly distinguish:

- directly observed facts
- inferred context
- missing evidence
- contradictory evidence

### Human-readable truth, workflow-owned truth

Human-facing artifacts are useful, but durable workflow truth remains in notes and explicit context fields.

### Review the change that matters

The workflow should separate core review surface from noise before deep analysis begins.

### Honest confidence over false certainty

The workflow should prefer saying "I could not confidently establish the boundary" over quietly pretending it found the right ancestor.

## Proposed Workflow Shape

## Phase 0: Locate, Bound, Enrich, and Classify

This phase replaces the current front-half flow.

It should execute five structured sub-steps.

### 0.1 Locate the review target

Determine, when possible:

- PR/MR URL or number
- branch name
- HEAD SHA
- diff source type
- whether the user provided:
  - PR URL
  - branch
  - patch
  - local diff
  - only a vague review request

Recommended decision:

- if a discoverable PR/MR exists, treat it as the primary review target
- if no PR/MR exists or can be found, fall back to branch or diff review without blocking

### 0.2 Find the true review boundary

Attempt to determine:

- candidate base branch
- merge base / ancestor
- whether the branch is stacked
- whether the branch is stale or divergent
- exact commits under review
- exact files under review
- inherited changes to exclude
- why the workflow believes this is the correct review surface

If the workflow cannot establish this confidently, it should:

- continue with best effort
- lower boundary confidence
- record warnings
- disclose the uncertainty in final handoff

This phase should be considered incomplete if it does not at least attempt merge-base / ancestor reasoning.

### 0.3 Discover enrichments

Attempt to discover:

- PR metadata and body
- ticket / issue context
- repo-local product or design docs
- repo-local rules, conventions, and project guidance
- RFCs and specs
- rollout or migration docs
- acceptance criteria
- product risks and non-goals

The workflow should explicitly prefer recovering this context itself before asking the user for it.

Preferred discovery order:

1. direct CLI / MCP surfaces
2. repo-local docs and links
3. branch names and commit messages
4. PR body and issue links
5. nearby documentation by naming convention
6. web or browser access when available

The workflow should treat missing enrichments as confidence-relevant, not as automatic failure conditions.

It should treat policy-context discovery as part of enrichment, not as a separate optional nicety.

### 0.4 Probe capability availability lazily

Without blocking unless correctness requires it, attempt to determine availability or insufficiency of:

- `delegation`
- `web_browsing`
- GitHub / PR CLI access
- ticket-system access
- repo-local docs access
- relevant attached artifacts

For workflow-global capabilities such as `delegation` and `web_browsing`, this should align with the v2 capability-observation model rather than inventing a custom side channel. Where useful, this likely means using existing patterns such as `wr.templates.capability_probe` and `wr.contracts.capability_observation`.

Discovery surfaces beyond first-class workflow capabilities, such as GitHub CLI, ticket systems, repo-local docs, or attached artifacts, should still be recorded durably as structured observations even if they are not modeled as top-level capability enums.

Each probed source should be recorded structurally as one of:

- `available`
- `unavailable`
- `not_attempted`
- `attempted_but_insufficient`

Where the final workflow authoring remains readable, the preferred implementation path is:

- `wr.features.capabilities` with collapsed probe visibility
- `wr.templates.capability_probe` for first-class capability checks
- artifact-backed recording via `wr.contracts.capability_observation`

### 0.5 Classify

Classify based on:

- change size
- change shape
- change type
- risk level
- context completeness
- boundary confidence
- review-surface cleanliness

Set:

- `reviewMode`
- `shapeProfile`
- `riskLevel`
- `changeTypeProfile`
- `boundaryConfidence`
- `contextConfidence`
- `maxParallelism`
- `needsReviewerBundle`
- `needsSimulation`
- `needsBoundaryFollowup`
- `needsContextFollowup`
- `needsAuditorPass`

## Phase 1: State Initial Review Hypothesis

This phase stays, but it should now be informed by:

- review boundary certainty
- source ledger findings
- discovered intent and acceptance criteria
- discovered policy context
- change-shape classification
- change-type classification

The agent should state:

- current recommendation direction
- primary concern area
- what evidence would most likely overturn the current view
- whether the largest risk is code correctness, review-boundary uncertainty, or missing context

## Phase 2: Build Fact Packet and Review-Surface Ledger

The current fact-packet idea remains useful, but it should be expanded.

The workflow should build both:

- `reviewFactPacket`
- `reviewSurfaceLedger`

### `reviewFactPacket`

Should include:

- MR title and purpose
- intended behavior change
- non-goals if discoverable
- ticket and doc-derived constraints
- repo and user policy constraints
- acceptance criteria
- affected modules, contracts, invariants, and consumers
- tests, rollout expectations, and migration expectations
- unresolved unknowns

### `reviewSurfaceLedger`

Should include:

- exact review boundary description
- included commits
- excluded inherited commits
- core review surface files
- generated files
- mechanical churn
- rename-only / move-only files
- low-signal or out-of-scope files
- review-scope warnings

This step should also initialize a stronger coverage model and decide reviewer families using both change size and change type.

It should additionally record whether the review is operating with:

- strong boundary confidence
- weak boundary confidence
- strong intent/context confidence
- weak intent/context confidence

so later phases can adapt accordingly.

It should also persist whether policy-context confidence is:

- strong enough to evaluate against repo/user expectations
- weak enough that findings should be presented more cautiously

This phase is also a good place for an auditor-style context quality pass:

- a completeness-focused audit
- a depth-focused audit

If the workflow delegates these, they should audit the main agent's gathered packet rather than own the whole understanding phase.

## Phase 3: Adaptive Reviewer-Family Bundle

Reviewer-family delegation should be selected using:

- `reviewMode`
- `riskLevel`
- `shapeProfile`
- `changeTypeProfile`
- `boundaryConfidence`
- `contextConfidence`

Examples:

- test-only change: lighter architecture scrutiny, stronger false-positive suppression
- migration change: stronger rollout, compatibility, and data-integrity scrutiny
- security-sensitive change: stronger runtime and adversarial review
- ambiguous boundary: stronger boundary-validation or context follow-up
- large mixed-shape change: stronger partitioning instincts and more cautious confidence
- mechanically noisy change: stronger noise suppression and lower appetite for style-only findings

Reviewer families should still be evidence producers, not decision makers.

The redesign should also distinguish between:

- reviewer-family execution work
- auditor-style critique of the current synthesis

Both are useful, but they are not the same cognitive unit.

The workflow should further strengthen:

- explicit pre-delegation hypothesis
- explicit post-delegation synthesis
- explicit rejection of weak or overreaching findings
- explicit handling of missed-issue and false-positive signals

This phase should explicitly consider use of:

- `routine-hypothesis-challenge` for adversarial reviewer challenge
- `routine-execution-simulation` when runtime behavior or branch-sensitive behavior is material
- `routine-philosophy-alignment` when policy-context is important enough to affect recommendation quality

## Phase 4: Contradiction, Gap, and Boundary Resolution Loop

This should broaden the current contradiction loop into a more general resolution loop.

It should continue when there is material unresolved:

- reviewer disagreement
- coverage uncertainty
- false-positive risk
- boundary uncertainty
- context insufficiency

Targeted follow-up should be minimal and focused. The workflow should avoid re-running broad discovery unless it learns that the original boundary or context assumptions were wrong.

This loop is also where the workflow should reopen:

- merge-base reasoning when ancestry assumptions were weak
- ticket/doc discovery when missing context materially affects recommendation quality

## Phase 5: Final Validation

The current final validation idea remains useful, but it should explicitly validate:

- recommendation strength
- severity calibration
- evidence quality
- operational / rollout concerns
- compatibility / migration risk
- whether unresolved context or boundary issues materially weaken the recommendation

Final validation should also ensure the handoff reflects uncertainty honestly instead of over-stating confidence.

The current WorkRail routine catalog suggests the redesign should strongly consider `routine-final-verification` as either:

- a delegated verifier
- an injected routine template
- or a direct-execution structure borrowed into the final validation phase

## Phase 6: Final Handoff and Environment Status

The final handoff should include both the review result and an explicit status report about the review environment.

### Review result

Include:

- recommendation
- confidence band
- top findings
- rationale
- remaining uncertainties
- summary of review surface and excluded noise
- validation outcomes

### Review environment status

Include:

- what the workflow accessed successfully
- what it attempted but could not access
- what it never attempted
- impact on review quality
- suggested environment improvements for future reviews

This should be informative, not accusatory and not blocking.

It should also explicitly state:

- whether the workflow found the actual PR/MR
- whether the workflow found ticket context
- whether the workflow found supporting docs
- whether the workflow is confident it reviewed the correct ancestor-relative surface

## New Core Concepts

## Review Source Ledger

The workflow should maintain a structured ledger describing where review context came from.

Suggested fields:

- `reviewTargetSource`
- `boundarySource`
- `mrMetadataSource`
- `ticketSource`
- `docSourcesFound`
- `docSourcesMissing`
- `policySourcesFound`
- `policySourcesMissing`
- `capabilityObservations`
- `contextGaps`

This ledger exists to improve both reasoning quality and final transparency.

It is still open whether this should be represented primarily as:

- explicit context keys
- a dedicated structured artifact
- or both, with context carrying only the routing-critical subset

If a dedicated artifact is used, the workflow should still keep routing-critical fields in context so conditions, loops, and later phases remain deterministic and lightweight.

## Boundary Confidence Model

The workflow should model review-boundary certainty explicitly rather than burying it in prose.

Suggested fields:

- `baseCandidate`
- `mergeBaseConfidence`
- `stackedBranchSuspected`
- `reviewBoundaryConfidence`
- `boundaryResolutionMethod`
- `reviewScopeWarnings`
- `baseResolutionFailed`

This is likely one of the strongest predictors of whether the workflow will rival strong human review.

## Change Type Profile

The workflow should classify the change into a structured profile rather than using only size/risk heuristics.

Suggested categories:

- `api_contract_change`
- `data_model_or_migration`
- `refactor`
- `infra_or_config`
- `test_only`
- `docs_only`
- `security_sensitive`
- `performance_sensitive`
- `ui_only`
- `mechanical_or_generated`

This profile should influence reviewer-family selection, simulation choices, and validation depth.

## Shape Profile

The workflow should classify MR shape separately from MR type.

Suggested categories:

- `tiny_isolated_change`
- `medium_localized_change`
- `broad_crosscutting_change`
- `stacked_branch_change`
- `mechanically_noisy_change`
- `mixed_signal_change`
- `migration_heavy_change`

This profile should influence:

- review partitioning strategy
- boundary follow-up depth
- reviewer-family breadth
- confidence calibration
- false-positive suppression

## Review Surface Hygiene Model

The workflow should explicitly separate:

- `core_review_surface`
- `generated_files`
- `mechanical_churn`
- `rename_or_move_only`
- `likely_inherited_changes`
- `out_of_scope_or_noise`

Without this, large reviews will continue to waste attention and overproduce low-value findings.

## Capability Observation Model

Capability probing should produce durable observations rather than vague narrative.

Suggested recorded dimensions:

- source name
- status
- attempt method
- limitation reason
- whether the limitation materially reduced review quality

For first-class workflow capabilities, the redesign should prefer the existing v2 capability-observation path rather than inventing a bespoke mechanism.

For non-capability discovery surfaces, the main requirement is still durable structured observation, but the exact storage form remains an open authoring decision.

## Suggested Top-Level Capability Direction

At the workflow level, the redesign likely wants:

```json
{
  "capabilities": {
    "delegation": "preferred",
    "web_browsing": "preferred"
  }
}
```

The workflow should still treat GitHub CLI, ticket systems, and repo-local docs as discovery surfaces to probe rather than first-class capability enums.

The final workflow should likely also use feature config intentionally, not just capability declarations alone.

Example direction:

- `wr.features.capabilities` to standardize probing behavior
- `wr.features.output_contracts` to standardize enforcement and disclosure behavior

## Acceptance Criteria for the Redesign

The redesign should be considered successful if the future workflow:

1. attempts to discover the actual MR/PR when possible
2. attempts to determine the true review boundary and exposes confidence in that boundary
3. records discovery-source availability and insufficiency durably
4. separates core review surface from noise before deep review
5. adapts reviewer selection using change shape as well as size/risk
6. uses final handoff to disclose access limits and their effect on confidence
7. remains non-blocking unless correctness truly requires user input or unavailable artifacts
8. keeps notes/context as workflow truth rather than making a review doc canonical
9. attempts merge-base / ancestor resolution even for stale or stacked branches
10. explicitly says when it is not confident it reviewed the correct surface
11. attempts to recover repo/user rules, conventions, and coding philosophy when available
12. uses policy-context confidence to calibrate how strongly it frames findings and recommendations

## Risks and Tensions

### Risk: overloaded Phase 0

This redesign puts a lot into the first phase.

Mitigation:

- keep the phase internally structured
- use explicit sub-steps
- require durable structured outputs, not just longer prose
- use routines, templates, and auditors selectively so structure does not collapse into one giant handwritten prompt

### Risk: environment-probing noise

Capability and source probing can become verbose or distracting.

Mitigation:

- probe lazily
- record compactly
- summarize cleanly in the final handoff
- prefer collapsed capability probes and reusable probe templates where authoring stays readable

### Risk: false precision in boundary confidence

The workflow may pretend certainty it does not actually have.

Mitigation:

- require explicit reasoning for boundary confidence
- record warnings when ancestry remains ambiguous
- allow confidence downgrade without blocking

### Risk: review-quality theater

The workflow could produce a polished review that looks rigorous while still lacking enough context to justify its confidence.

Mitigation:

- tie recommendation confidence to boundary confidence and context confidence
- require the final handoff to name important unavailable sources
- prefer explicit uncertainty over polished but misleading certainty

### Risk: policy-context mismatch

The workflow could produce findings that are locally reasonable but misaligned with the user’s rules, repo conventions, or architectural philosophy.

Mitigation:

- discover policy context explicitly
- record missing policy sources as confidence-relevant gaps
- present findings more cautiously when policy context is weak

### Risk: underusing WorkRail-native structure

The redesign could be conceptually strong but still author the final workflow as mostly handwritten prompts, leaving reuse, determinism, and customization power on the table.

Mitigation:

- prefer promptBlocks over long freeform prompts
- use refs for repeated canonical guidance
- use routines deliberately
- use extension points only for bounded high-value seams

## Assessment of the Proposed Shape

### Is this the best shape?

This is the best next shape I would currently recommend, but probably not the final best possible shape.

It addresses the most important structural weaknesses in the current workflow:

- wrong-surface review risk
- weak intent reconstruction
- insufficient graceful degradation
- under-specified environment transparency

### Will the review be thorough and useful?

Yes, this redesign should produce much more thorough and useful reviews than the current workflow, especially when the environment has enough discovery surfaces to enrich the review.

### Will it rival the best human engineers?

Not reliably yet.

It should get much closer, but the best human reviewers still outperform in:

- nuanced severity judgment
- historical and organizational context reconstruction
- large-change decomposition
- subtle product and rollout reasoning under ambiguity

### Is it adaptable to the size of the changes?

Yes, and more importantly, the redesign makes it adaptable to both size and change shape.

That is a meaningful improvement over the current design, which is still too size/risk-centric.

### Does it properly identify the correct ancestor?

Not yet in the current workflow.

In the redesigned workflow, ancestor and merge-base handling must become a required attempted behavior, with explicit confidence reporting when the result is uncertain.

### Risk: overfitting reviewer families to categories

Too much change-type routing could make the workflow brittle.

Mitigation:

- keep a small change-type taxonomy
- use it to influence, not fully determine, reviewer choice

## Open Questions

### Workflow-authoring questions

- Should capability observations use `wr.templates.capability_probe` / `wr.contracts.capability_observation` directly in the final workflow, or should some probes stay handwritten for readability?
- Should non-capability source observations share the same artifact style, or live in a separate review-source ledger?
- Should the review-source ledger be a dedicated artifact, explicit context fields, or both?
- Should boundary-confidence handling live entirely inside Phase 0, or also have a reusable template/routine?

### Product questions

- Should missing PR metadata reduce confidence mildly or strongly?
- Should a very low boundary-confidence result reopen discovery automatically, or only surface a warning?
- How strong should the end-of-workflow tooling recommendations be before they feel noisy rather than helpful?

### Scope questions

- Should large-MR partitioning be part of this redesign, or explicitly deferred?
- Should historical reasoning from prior commits or nearby blame/history be added now, or later?
- Should severity-calibration improvements be bundled with this redesign, or follow after the boundary/context work lands?

## Recommended Next Step

Use this document as the working source of truth until the design stabilizes.

Once the open questions are narrowed, the next step should be a second-pass revision of this document that:

- decides which fields are required durable context
- decides which fields should be artifact-backed
- defines the exact reviewer-family routing logic by change type
- defines what Phase 0 must output before the workflow can advance

Only after that should `mr-review-workflow.agentic.v2.json` be updated.
