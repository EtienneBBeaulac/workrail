# Next Up

These are the **groomed near-term tickets**. They are the clearest current candidates for actual execution.

## Ticket 1: Strengthen retrieval budgets and recovery surfaces

### Problem

The old budget system was too conservative on the agent-facing recovery path. `rehydrate` and `resume_session` were bounded, but the bounded surfaces were too small and too weakly structured to preserve enough useful context.

### Goal

Strengthen retrieval by using deterministic typed recovery contracts, larger but still bounded budgets, and verification that proves useful context survives before low-value tail material.

### Acceptance criteria

- `rehydrate` uses an explicit deterministic retrieval contract with ordered tiers and bounded rendering
- `resume_session` preview rendering uses an explicit bounded preview contract rather than ad hoc snippet logic
- recovery and preview budgets are increased to more useful values while remaining deterministic and schema-bounded
- worst-case tests cover tier dropping, bounded rendering, and usefulness-oriented scenarios
- runtime constants, MCP schemas, and design-lock docs agree on the new budget values

### Verification

- `npx vitest run`
- `npm run typecheck`

### Non-goals

- Making retrieval literally unbounded
- Introducing a new durable memory substrate in the first move
- Redesigning checkpoint semantics as part of this slice

### Related files/docs

- `src/v2/durable-core/domain/retrieval-contract.ts`
- `src/v2/durable-core/domain/prompt-renderer.ts`
- `src/v2/projections/resume-ranking.ts`
- `src/mcp/output-schemas.ts`
- `docs/design/v2-core-design-locks.md`

## Ticket 2: Complete v2 sign-off and cleanup

### Problem

WorkRail v2 is default-on and the feature flag gate has been removed, but stale docs and remaining cleanup work have not been fully closed out.

### Goal

Finish the remaining doc cleanup and confirm all validation scenarios are recorded.

### Acceptance criteria

- Stale rollout/status docs no longer reference `WORKRAIL_ENABLE_V2_TOOLS` or pretend older rollout assumptions are current truth
- The remaining relevant manual v2 scenarios are reviewed and their outcome is recorded

### Non-goals

- Building major new v2 features
- Rewriting the whole v2 doc set from scratch

### Related files/docs

- `docs/plans/v2-followup-enhancements.md`
- `docs/roadmap/open-work-inventory.md`

## ~~Ticket 3: Workflow-source setup phase 1~~ (done)

### Problem

WorkRail now has a canonical phase-1 plan for workflow-source setup, but the preferred team-sharing path is still not reflected in shipped discovery/setup behavior. Users still have to reason about legacy paths, env-first setup, and weak source visibility instead of a clear rooted-sharing model.

All acceptance criteria met across the child execution stack:

- `#160` — workspace anchoring for workflow-source setup
- `#161` — remembered roots for workflow-source setup
- `#162` — rooted discovery for repo and module workflows
- `#163` — grouped source visibility for workflow discovery
- `#164` — precedence and migration explanation for workflow sources

Delivered outcomes:

- discovery-sensitive workflow surfaces now require and use `workspacePath`
- WorkRail remembers repo/workspace roots at user scope
- request-scoped rooted `.workrail/workflows/` discovery works under remembered roots
- `list_workflows` / `inspect_workflow` now expose source-aware visibility
- legacy-over-rooted overlap now has minimal migration/preference explanation

Verification:

- focused workflow-source setup tests pass
- current local `npm run build` passes
- planning docs now reflect the delivered phase-1 state

## Ticket 4: Expand lifecycle validation coverage

### Problem

The validation pipeline is much stronger than before, but lifecycle coverage still appears much narrower than the older plan language suggests.

### Goal

Define a realistic lifecycle coverage target and expand tests toward it.

### Acceptance criteria

- A clear target for bundled workflow lifecycle coverage is documented
- Lifecycle coverage is expanded beyond the current minimal set
- Stale claims that imply full closure are corrected or retired

### Non-goals

- Rebuilding the whole validation system
- Overcommitting to unrealistic 100% promises without a practical strategy

### Related files/docs

- `docs/plans/workflow-validation-roadmap.md`
- `docs/plans/workflow-validation-design.md`
- `docs/roadmap/open-work-inventory.md`

## Ticket 5: Design console execution-trace explainability

### Problem

The console currently shows the execution DAG as if it were the full runtime story, but the engine records important decisions outside `node_created` / `edge_created`. Fast paths, evaluated conditions, selected next steps, and other engine choices can make a legitimate run look broken or incomplete in the UI.

### Goal

Design the DTO and UX changes needed so the console explains why the engine took a path, not just which node was created next.

### Acceptance criteria

- A concrete console design exists for showing engine decisions alongside the DAG
- The design explicitly distinguishes authoring phases from actual execution nodes
- The proposed DTO shape identifies which engine events and run-context fields must be projected to the console
- The design includes at least one clear UX for fast paths / skipped phases that currently look like broken graphs

### Non-goals

- Implementing the full console redesign
- Exposing every raw event type directly in the UI
- Removing phases from workflow authoring

### Related files/docs

- `docs/ideas/backlog.md`
- `docs/roadmap/open-work-inventory.md`
- `docs/plans/workrail-platform-vision.md`
- `docs/reference/workflow-execution-contract.md`
- `src/v2/usecases/console-service.ts`
- `console/src/api/types.ts`

## Ticket 6: Trial the workflow quality gate and readiness audit on real tasks

### Problem

`workflow-for-workflows.v2.json` and `production-readiness-audit.json` are now structurally much stronger, but they have mostly been tuned through authoring-time reasoning and validator passes rather than repeated real-world use. The remaining risk is no longer legality; it is whether `STANDARD` vs `THOROUGH` produces the right depth, issue-finding power, and amount of ceremony on actual tasks.

### Goal

Run both workflows on several realistic tasks and tune them from evidence so the quality gate stays convergent and the readiness audit stays satisfying, skeptical, and useful.

### Acceptance criteria

- `workflow-for-workflows.v2.json` is exercised on multiple distinct authoring tasks spanning at least two archetypes
- `production-readiness-audit.json` is exercised on multiple realistic audit targets with different scope/risk shapes
- Observed weaknesses are classified into authoring-integrity, outcome-effectiveness, or ceremony/depth tuning buckets
- Any resulting workflow edits are revalidated with `npm run validate:registry` and `npm run validate:workflow-discovery`
- Planning docs capture the tuned follow-up state rather than leaving trialing implicit

### Non-goals

- Rewriting the workflows from scratch again without evidence from runs
- Expanding the engine/runtime surface itself as part of this ticket
- Broad modernization of unrelated bundled workflows

### Related files/docs

- `workflows/workflow-for-workflows.v2.json`
- `workflows/production-readiness-audit.json`
- `docs/roadmap/open-work-inventory.md`
- `docs/roadmap/now-next-later.md`

## ~~Ticket 7: Finish prompt vs supplement boundary alignment~~ (done)

All acceptance criteria met -- the boundary is documented consistently:

- `authoring.md` lock rules enforce separation (keep-boundary-owned-guidance-out-of-step-prompts, one-time-supplements-are-policy-not-durable-state)
- `authoring-v2.md` has clear "when to use" / "when not to use" guidance with how-to instructions
- `workflow-execution-contract.md` describes the 3-tier content structure (prompt, references, supplements)
- `spec/authoring-spec.json` mirrors the lock rules
- `agentic-orchestration-roadmap.md` treats authorable supplements as a future backlog item, not current behavior
- Runtime code (`response-supplements.ts`, `step-content-envelope.ts`) is clean and matches the docs
