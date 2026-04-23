# Workflow Staleness Detection

## Context / Ask

How to automatically detect when a WorkRail workflow has become stale — out of sync with the authoring spec, schema, or routines it depends on — and surface this transparently to both users (UI/console) and agents (MCP tools).

## Recommendation: Spec-Version Stamp (Candidate B)

**Confidence: High.** Grounded in codebase evidence, adversarially challenged, design-reviewed. No direction changes required.

### How it works

1. `spec/authoring-spec.json` has a `version` field (currently `3`). This is the staleness anchor.
2. `wr.workflow-for-workflows` stamps `validatedAgainstSpecVersion: <N>` into the workflow JSON at Phase 7 handoff (after the quality gate passes).
3. At `list_workflows` and `inspect_workflow` time, the engine reads the stamp and compares it against the current spec version.
4. The output schema gains a `staleness` field: `{ level: 'none' | 'possible' | 'likely', reason: string, specVersionAtLastReview?: number }`.

### Three-tier signal

| Level | Condition | Meaning |
|---|---|---|
| `none` | `validatedAgainstSpecVersion` matches current spec version | Workflow was reviewed against current guidance |
| `likely` | `validatedAgainstSpecVersion` < current spec version | Spec updated since last review — workflow may need attention |
| `possible` | No stamp present | Workflow was not created/reviewed via wr.workflow-for-workflows |

### Surfacing

- **Agents**: `staleness` field in `list_workflows` and `inspect_workflow` MCP output. Agents can warn users before starting a workflow.
- **Users**: staleness indicator in console workflow list. `likely` should be visually more prominent than `possible`. Follow the existing `migration`/`staleRoots` visual pattern.

### What clears the flag

Running `wr.workflow-for-workflows` on the workflow and committing the result. The Phase 7 step stamps the current spec version. No other action required.

## Implementation Scope

| File | Change |
|---|---|
| `spec/workflow.schema.json` | Add optional `validatedAgainstSpecVersion?: number` field |
| `spec/authoring-spec.json` | Add explicit bump trigger to `changeProtocol`; add `changelog` array |
| `wr.workflow-for-workflows.v2.json` | Phase 7: stamp `validatedAgainstSpecVersion` after quality gate passes; note stamp must be committed |
| `src/mcp/output-schemas.ts` | Add `staleness?` to `V2WorkflowListItemSchema` and `V2WorkflowInspectOutputSchema` |
| `src/mcp/handlers/v2-workflow.ts` | Compute staleness from stamp vs current spec version at list/inspect time |
| Console | Staleness indicator in workflow list; `likely` > `possible` visual hierarchy |

## Constraints / Anti-goals

- Must not block workflow execution
- Must not require per-workflow manual maintenance
- No auto-fixing (that's wr.workflow-for-workflows territory)
- No mass migration — bootstrap via organic adoption

## Required Companion Changes (must ship with the feature)

1. **`authoring-spec.json` `changeProtocol`**: add "Increment `version` when any required-level rule is added, removed, or materially changed."
2. **`authoring-spec.json` `changelog`**: add a `changelog` array so the `reason` string in staleness output can reference what changed.
3. **`wr.workflow-for-workflows` Phase 7**: add note — "The `validatedAgainstSpecVersion` field was written to the workflow file — commit it for the staleness signal to take effect."

## Accepted Tradeoffs

- Existing unstamped workflows show `possible` permanently until reviewed — acceptable, `possible` is the correct coarse signal for unreviewed workflows
- External workflows not using wr.workflow-for-workflows may never get stamped — acceptable, same reason
- Spec version granularity: a spec update touching one archetype flags all workflows — mitigated by changelog + specific reason string

## Residual Risks

- If spec version is not bumped when meaningful rules change (no clear owner), the `likely` signal never fires. Mitigated by adding explicit trigger to `changeProtocol`.
- Routine changes (delegation to updated routines) not tracked by spec version. Out of scope for v1.

## Switch Trigger

If teams rarely run wr.workflow-for-workflows and `possible` becomes permanent noise for 80%+ of workflows, add a CI step that stamps workflows automatically.

## Decision Log

- **Candidate A (git-date inference) rejected**: CI-noise failure mode disqualifying; no actionable reason string; not deterministic.
- **Candidate C (hybrid) rejected**: complexity; git-date fallback inherits A's wallpaper problem.
- **Candidate B selected**: deterministic, architectural fix, self-clearing via wr.workflow-for-workflows, follows `workflowHash` pattern.
- **Challenge**: spec version too coarse. Mitigated by changelog + reason string. Position held.
- **Review**: no direction change. Three companion changes required pre-ship.
