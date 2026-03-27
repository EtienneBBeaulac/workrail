# Next Up

These are the **groomed near-term tickets**. They are the clearest current candidates for actual execution.

## Ticket 1: Complete v2 sign-off and cleanup

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

## ~~Ticket 2: Workflow-source setup phase 1~~ (done)

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

## Ticket 3: Expand lifecycle validation coverage

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

## Ticket 4: Design console execution-trace explainability

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

## ~~Ticket 5: Finish prompt vs supplement boundary alignment~~ (done)

All acceptance criteria met -- the boundary is documented consistently:

- `authoring.md` lock rules enforce separation (keep-boundary-owned-guidance-out-of-step-prompts, one-time-supplements-are-policy-not-durable-state)
- `authoring-v2.md` has clear "when to use" / "when not to use" guidance with how-to instructions
- `workflow-execution-contract.md` describes the 3-tier content structure (prompt, references, supplements)
- `spec/authoring-spec.json` mirrors the lock rules
- `agentic-orchestration-roadmap.md` treats authorable supplements as a future backlog item, not current behavior
- Runtime code (`response-supplements.ts`, `step-content-envelope.ts`) is clean and matches the docs
