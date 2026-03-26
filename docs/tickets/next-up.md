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

## Ticket 2: Expand lifecycle validation coverage

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

## ~~Ticket 3: Finish prompt vs supplement boundary alignment~~ (done)

All acceptance criteria met -- the boundary is documented consistently:

- `authoring.md` lock rules enforce separation (keep-boundary-owned-guidance-out-of-step-prompts, one-time-supplements-are-policy-not-durable-state)
- `authoring-v2.md` has clear "when to use" / "when not to use" guidance with how-to instructions
- `workflow-execution-contract.md` describes the 3-tier content structure (prompt, references, supplements)
- `spec/authoring-spec.json` mirrors the lock rules
- `agentic-orchestration-roadmap.md` treats authorable supplements as a future backlog item, not current behavior
- Runtime code (`response-supplements.ts`, `step-content-envelope.ts`) is clean and matches the docs
