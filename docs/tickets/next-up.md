# Next Up

These are the **groomed near-term tickets**. They are the clearest current candidates for actual execution.

## Ticket 1: Complete v2 sign-off and cleanup

### Problem

WorkRail v2 is stable enough to be default-on, but readiness and rollout cleanup are still split across stale docs and incomplete sign-off.

### Goal

Finish the remaining validation/sign-off work and decide what rollout cleanup should happen now versus later.

### Acceptance criteria

- The remaining relevant manual v2 scenarios are reviewed and their outcome is recorded
- The decision on v2 rollout cleanup is explicit
- Stale rollout/status docs no longer pretend older rollout assumptions are current truth

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

## Ticket 3: Finish prompt vs supplement boundary alignment

### Problem

The runtime now supports clean response formatting and supplements, but the product/documentation boundary between authored prompts and delivery-owned guidance is still being normalized.

### Goal

Make the boundary explicit enough that future tooling and workflow authoring do not drift.

### Acceptance criteria

- Runtime behavior, docs, and planning docs describe the same ownership model
- Response supplements are clearly documented as runtime-owned today
- The path toward authorable supplements is treated as a future typed feature, not implied current behavior

### Non-goals

- Making supplements authorable immediately
- Adding new workflow schema without a dedicated design pass

### Related files/docs

- `src/mcp/response-supplements.ts`
- `docs/authoring-v2.md`
- `spec/authoring-spec.json`
