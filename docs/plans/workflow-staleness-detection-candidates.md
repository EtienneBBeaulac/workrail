# Workflow Staleness Detection — Design Candidates

## Problem Understanding

**Tensions:**
1. Explicit stamp vs inferred signal — stamps are precise but require migration; git-date inference works immediately but isn't deterministic
2. Noise vs sensitivity — low threshold creates flag fatigue; high threshold misses real staleness
3. Where staleness lives — in the workflow file vs computed by the engine vs in a separate manifest
4. Agent-side vs user-side surfacing — same signal, different presentation contracts

**Likely seam:** `V2WorkflowListItemSchema` in `src/mcp/output-schemas.ts` — add a `staleness` field here. The computation feeds from either a stamp in the workflow JSON or a git-date comparison.

**What makes it hard:** Bootstrapping. The right long-term signal requires stamps that don't exist on any current workflow. Any solution must degrade gracefully for unstamped workflows without producing permanent noise.

## Philosophy Constraints

- **Determinism over cleverness** — git-date comparison is not deterministic (CI can retouch files). Spec-version stamp is deterministic.
- **Make illegal states unrepresentable** — `staleness: boolean` is wrong. `staleness: { level: 'none' | 'possible' | 'likely', reason: string, specVersionAtLastReview?: number }` is correct.
- **Explicit domain types** — the staleness level is a meaningful enum, not a string.
- **Architectural fixes over patches** — the stamp is the fix; git-date inference is a patch.

## Impact Surface

- `spec/workflow.schema.json` — new optional field
- `wr.workflow-for-workflows.v2.json` — new stamp step in Phase 7
- `src/mcp/output-schemas.ts` — new field in `V2WorkflowListItemSchema` and `V2WorkflowInspectOutputSchema`
- `src/mcp/handlers/v2-workflow.ts` — staleness computation at list/inspect time
- Console workflow list — new staleness indicator (follow `migration`/`staleRoots` visual pattern)
- `spec/authoring-spec.json` — the source of truth for current spec version (currently `version: 3`)

## Candidates

### Candidate A: Engine-computed staleness from spec git-date

**Summary:** At `list_workflows` time, compare `git log -1 %at` for `spec/authoring-spec.json` vs the workflow file. If spec is newer, surface `staleness: { level: 'possible', reason: 'Authoring spec updated since workflow was last committed' }`.

- **Tensions resolved:** works on all existing workflows immediately, zero migration
- **Tensions accepted:** not deterministic, can't distinguish meaningful spec change from typo fix, no way to clear except committing the workflow file
- **Boundary:** `v2-workflow.ts` + `V2WorkflowListItemSchema` only
- **Failure mode:** CI pipeline touches `authoring-spec.json` during a release, flagging every workflow simultaneously
- **Repo pattern:** follows `staleRoots` pattern — computed at list time
- **Gains:** zero migration, immediate coverage
- **Losses:** precision, determinism, actionable reason string
- **Scope:** best-fit for a temporary bridge, too narrow as a final solution
- **Philosophy:** honors YAGNI; conflicts with Determinism

---

### Candidate B: Spec-version stamp in workflow JSON ✓ RECOMMENDED

**Summary:** Add optional `validatedAgainstSpecVersion: number` to the workflow JSON schema. `wr.workflow-for-workflows` stamps this in Phase 7. Engine reads the field and compares against `spec/authoring-spec.json` version. Three-tier signal: `none` (stamp matches current), `likely` (stamp < current), `possible` (no stamp).

- **Tensions resolved:** deterministic, precise three-tier signal, actionable reason string, running wr.workflow-for-workflows naturally clears the flag
- **Tensions accepted:** bootstrapping — existing workflows start as `possible` until reviewed
- **Boundary:** schema + wr.workflow-for-workflows + output-schemas + handler
- **Failure mode:** teams run wr.workflow-for-workflows locally but forget to commit the JSON
- **Repo pattern:** adapts `workflowHash` pattern (content-derived identity) to spec-version identity
- **Gains:** deterministic, self-documenting, architectural fix, clears naturally with wr.workflow-for-workflows
- **Losses:** migration cost (organic, not forced), adds schema field most workflows won't have immediately
- **Scope:** best-fit long-term
- **Philosophy:** honors Determinism, Make illegal states unrepresentable, Explicit domain types. Minor YAGNI tension.

**Implementation steps:**
1. `spec/workflow.schema.json`: add `validatedAgainstSpecVersion?: number` (optional, no existing workflow breaks)
2. `wr.workflow-for-workflows.v2.json`: Phase 7 stamps `validatedAgainstSpecVersion` to current spec version before handoff
3. `src/mcp/output-schemas.ts`: add `staleness?: { level: 'none' | 'possible' | 'likely', reason: string, specVersionAtLastReview?: number }` to `V2WorkflowListItemSchema` and `V2WorkflowInspectOutputSchema`
4. `src/mcp/handlers/v2-workflow.ts`: read `validatedAgainstSpecVersion` from compiled workflow; compare against `spec/authoring-spec.json` version; compute staleness
5. Console: show staleness indicator in workflow list
6. `spec/authoring-spec.json`: keep `version` field updated when meaningful rules change

---

### Candidate C: Hybrid — stamp when available, git-date fallback

**Summary:** Use stamp-based comparison when `validatedAgainstSpecVersion` is present; fall back to git-date comparison for unstamped workflows.

- **Tensions resolved:** zero migration + precision where stamps exist
- **Tensions accepted:** git-date fallback inherits A's determinism problem; two code paths
- **Failure mode:** `possible` from the fallback becomes permanent wallpaper for workflows never run through wr.workflow-for-workflows
- **Scope:** slightly too broad for a first version, correct long-term shape
- **Philosophy:** deterministic where stamps exist; conflicts with Determinism in the fallback path

## Comparison and Recommendation

**Recommendation: Candidate B**

The stamp is the architecturally correct fix. It's deterministic, self-documenting, and cleared by the existing wr.workflow-for-workflows tool. The bootstrap problem is real but manageable: unstamped workflows show `possible` (not `likely`), and teams clear it organically by running wr.workflow-for-workflows. No mass migration needed.

**Why A loses:** The CI-noise failure mode is hard to avoid and produces permanent noise. No actionable reason string.

**Why C loses:** The hybrid adds complexity, and the git-date fallback is still the same wallpaper problem — just deferred. The right approach is to accept the bootstrap cost of B and let organic adoption clear it.

## Self-Critique

**Strongest counter-argument:** Spec version is too coarse — v3 may have added rules that don't apply to a given workflow's archetype, making `likely stale` misleading. Mitigation: add a `changedRules` summary to the reason string when the spec version changes.

**Pivot condition:** If teams rarely run wr.workflow-for-workflows and `possible` becomes permanent noise for 80%+ of workflows, add a CI step that reads the spec version and stamps workflows automatically (no human needed, just a `git commit --amend` or separate commit in CI).

## Open Questions for Main Agent

1. Should `wr.workflow-for-workflows` stamp before or after the quality gate loop? (After seems right — only stamp if the workflow passes.)
2. Should `validatedAgainstSpecVersion` be a required field for new workflows going forward, or permanently optional?
3. Does the console need a new visual treatment, or can it reuse the `migration` badge pattern that already exists?
4. Should `inspect_workflow` in `metadata` mode also return the staleness field, or only in `preview` mode?
