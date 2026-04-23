# Workflow Staleness Detection — Design Review Findings

## Tradeoff Review

| Tradeoff | Verdict | Hidden Assumption | Fails If |
|---|---|---|---|
| Bootstrap: existing workflows show `possible` | Acceptable | Teams will eventually run wr.workflow-for-workflows on important workflows | `possible` shown as equally urgent as `likely` |
| External workflows never get stamped | Acceptable | Stamp is optional, no workflow breaks | Same as above |
| Spec granularity: one update flags all workflows | Acceptable with mitigation | Spec has a changelog per version increment | Spec version bumps silently with no explanation |

**T3 reveals a required companion piece: the authoring spec needs a per-version changelog.** Not a blocker, but must ship alongside the staleness feature to keep the reason string actionable.

## Failure Mode Review

| Failure Mode | Risk | Coverage | Missing Mitigation |
|---|---|---|---|
| Spec version not bumped when rules change | **High** | Not in code — process fix needed | Add explicit trigger to `authoring-spec.json` `changeProtocol` |
| Stamp committed locally but not pushed | Medium | Phase 7 handoff note needed | Note in wr.workflow-for-workflows Phase 7: "stamp must be committed" |
| `possible` becomes wallpaper | Medium | Three-tier design helps | Ensure `possible` and `likely` are visually distinct in console |

**Highest-risk failure mode: spec version not bumped.** This would make the entire system unreliable. Process fix required.

## Runner-Up / Simpler Alternative Review

- Candidate A (git-date): nothing worth borrowing. CI-noise failure mode is disqualifying.
- Simpler variant (embed spec in version string): rejected — conflates human-maintained semver with compliance state.
- Sidecar file stamp: rejected — state would drift from the workflow file, violating determinism.

**Conclusion:** Candidate B as designed is already the minimal correct shape.

## Philosophy Alignment

- **Satisfied:** Determinism, Make illegal states unrepresentable, Explicit domain types, Validate at boundaries, Errors are data
- **Acceptable tensions:** YAGNI (optional field on existing workflows), Architectural fixes over patches (graceful `possible` degradation)
- **No risky tensions**

## Findings

**Orange — Spec version bump process undefined**
`authoring-spec.json` `changeProtocol` has no explicit trigger for incrementing `version`. If this isn't defined before the staleness feature ships, the `validatedAgainstSpecVersion` comparison is unreliable in either direction. Must be fixed.

**Yellow — No per-version changelog in authoring spec**
The `reason` string in the staleness output must reference what changed between spec versions for the signal to be actionable. Currently there's no changelog. Must be added when version increments.

**Yellow — wr.workflow-for-workflows Phase 7 doesn't mention the stamp**
The Phase 7 handoff step should explicitly tell the agent: "the `validatedAgainstSpecVersion` stamp was written to the workflow file — commit it for the staleness signal to take effect." Without this, teams may miss it.

## Recommended Revisions

1. Add to `authoring-spec.json` `changeProtocol`: "Increment `version` when any required-level rule is added, removed, or materially changed. Add a `changelog` entry for the new version."
2. Add `changelog` array to `authoring-spec.json` schema structure — each entry: `{ version, date, summary, affectedRules }`.
3. Add stamp reminder to wr.workflow-for-workflows Phase 7 handoff step.
4. Ensure console renders `likely` more prominently than `possible` (not just two shades of the same badge).

## Residual Concerns

- Routine changes (workflows delegating to routines that were updated) are not tracked by spec version. Accepted as out of scope for v1.
- If the spec version doesn't increment often (historically it's been at v3 for a while), the `likely` tier may rarely appear. That's okay — it means most workflows will be `none` or `possible`, which is the right coarse signal.
