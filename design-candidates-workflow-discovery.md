# Design Candidates: WorkRail Workflow Discovery Extension Points

**Note:** This document was produced as part of an investigation workflow. The user's task is
investigation only - no fix is being proposed. These candidates are recorded as reference
material for the engineer who will implement a fix.

## Problem Understanding

### Core Tensions

1. **Token efficiency vs completeness:** The tagSummary first-call pattern keeps the default
   `list_workflows` response to ~500 tokens. Any "show me everything" mode increases token cost.
   This tradeoff is deliberate and must be preserved.

2. **Static bundled tags vs dynamic external tags:** `spec/workflow-tags.json` is a module-level
   const loaded once at server init (`v2-workflow.ts:80`). It is immutable by design. Extending
   tag coverage to external workflows requires either a new code path or making this lazy-loaded
   and extensible.

3. **Schema self-description vs zero-migration:** Adding a `tags` field to `workflow.schema.json`
   makes workflows self-describing but requires a schema change. `additionalProperties: false`
   currently rejects any undeclared field.

4. **Backward compatibility of list_workflows response shape:** The `tagSummary` is absent when
   `tags=[...]` is provided. Adding external workflows to tag-filtered results changes existing
   behavior for callers.

### Likely Seam

`buildTagSummary` and `filterByTags` in `src/mcp/handlers/v2-workflow.ts` (lines 86 and 108).
Both receive `compiledWorkflowIds` (from all sources) but `tagsFile` is always the static bundled
file. The seam is: what does `tagsFile` contain, and can it be augmented at runtime?

### What Makes This Hard

- `workflow.schema.json` has `additionalProperties: false` - any undeclared field fails validation
- `workflow-tags.json` is a module-level const - not injectable without architectural change
- External-only tags would produce empty results for unknown tag values, confusing agents
- The tag filter is also used in `buildTagSummary` counts - inconsistency between count and result
  would be confusing

## Philosophy Constraints

From the codebase (confirmed by reading `src/`):
- **Validate at boundaries, trust inside:** Any dynamic tags source must be zod-validated at load
- **Exhaustiveness:** `assertNever` guards on `WorkflowSource.kind` - adding source kinds requires
  updating all switches (`v2-workflow.ts:656`)
- **Errors as data:** `Result`/`ResultAsync` throughout; any new loading path should follow this
- **Make illegal states unrepresentable:** A closed enum for tags honors this; open strings do not
- **YAGNI with discipline:** Minimum viable change unless scope evidence warrants more

**Philosophy conflict:** "Architectural fixes over patches" conflicts with Candidate C (adds a
workaround mode rather than fixing root cause metadata absence).

## Impact Surface

Files that must stay consistent with any fix:

| File | Dependency |
|------|-----------|
| `src/mcp/handlers/v2-workflow.ts:80` | `WORKFLOW_TAGS` const load point |
| `src/mcp/handlers/v2-workflow.ts:86` | `buildTagSummary` - exported, tested |
| `src/mcp/handlers/v2-workflow.ts:108` | `filterByTags` |
| `src/mcp/v2/tools.ts:28` | Hardcoded valid tag names in description |
| `spec/workflow.schema.json` | `additionalProperties: false` |
| `spec/workflow-tags.json` | Static bundled tags lookup |
| `scripts/validate-workflows-registry.ts:364` | `checkUntaggedWorkflows` reads tags file |
| All `workflows/*.json` files | If schema gains `tags` field |

## Candidates

### Candidate A: Self-declaring tags via workflow.schema.json extension

**Summary:** Add `tags` field (closed `string[]` enum of 9 values) to `workflow.schema.json`.
Update `buildTagSummary` and `filterByTags` to merge tag declarations from loaded workflow
objects with the static `workflow-tags.json` fallback.

- **Tensions resolved:** External workflow visibility in tag browsing; self-describing files
- **Tensions accepted:** Schema change required; 9-value enum is closed (no custom categories)
- **Boundary:** `workflow.schema.json` + `buildTagSummary`/`filterByTags` in `v2-workflow.ts`
- **Failure mode:** Bundled workflows stop using `workflow-tags.json` but fallback file still wins,
  creating divergence between schema-declared and file-declared tags
- **Repo pattern:** Adapts `examples` field precedent (`workflow.schema.json:192`, used at
  `v2-workflow.ts:473`)
- **Gain/give up:** Self-describing external workflow files. Cost: schema migration, workflow.json
  files need updating
- **Scope:** Best-fit
- **Philosophy:** Honors 'validate at boundaries', 'make illegal states unrepresentable' (closed
  enum), 'architectural fix over patch'

### Candidate B: Per-source tags overlay file (no schema change)

**Summary:** Convention: any workflow source directory may contain `.workrail/workflow-tags.json`
with the same shape as `spec/workflow-tags.json`. The handler reads overlay files and merges their
`workflows` entries into the runtime tag map. Bundled file remains authoritative for bundled IDs.

- **Tensions resolved:** No schema change; opt-in per source; no migration of existing workflows
- **Tensions accepted:** New undocumented file convention; overlay files need their own schema and
  validation; merge precedence rules needed for ID conflicts
- **Boundary:** `handleV2ListWorkflows` or a new function called from it; `WORKFLOW_TAGS` const
  must become lazy-loaded and merged
- **Failure mode:** Two sources declare conflicting tags for same workflow ID; undefined merge order
- **Repo pattern:** Follows graceful degradation and multi-source merge patterns throughout
  `enhanced-multi-source-workflow-storage.ts`
- **Gain/give up:** Zero per-workflow migration. Cost: new convention, two places to maintain tags
  for bundled workflows
- **Scope:** Best-fit (slightly broad due to new convention surface)
- **Philosophy:** Honors 'validate at boundaries' if overlay validated; 'YAGNI' (only load if
  present)

### Candidate C: `includeAll` parameter for universal list mode

**Summary:** Add `includeAll: boolean` to `V2ListWorkflowsInput`. When true, return all loaded
workflows AND compute tagSummary (with a synthetic `custom` tag bucket for workflows not in
`workflow-tags.json`). Drop sources catalog from this mode. Addresses Gap 2 only.

- **Tensions resolved:** Universal list mode without conflating source inspection with browsing
- **Tensions accepted:** External workflows remain second-class (generic bucket, not semantic tags);
  API surface grows; `includeAll` and `includeSources` are similar but distinct
- **Boundary:** Response assembly logic in `handleV2ListWorkflows` (lines 248-319)
- **Failure mode:** `custom`/`untagged` bucket conflates team workflows with accidentally-unregistered
  bundled workflows
- **Repo pattern:** Adapts `includeSources` parameter pattern
- **Gain/give up:** Fast Gap 2 fix, no schema change. Cost: external workflows stay second-class;
  doesn't fix root cause
- **Scope:** Narrow (Gap 2 only)
- **Philosophy:** Conflicts with 'architectural fixes over patches'; YAGNI minimum viable change

## Comparison and Recommendation

For Gap 1 (invisible external workflows): Candidate A and B are both viable. A is architecturally
cleaner (self-describing files) but requires schema migration. B is zero-migration but adds a
new file convention.

For Gap 2 (no show-me-everything): Candidate C addresses this directly. It is a narrow fix.

**Combined paths:**
- A + C: Schema tags for Gap 1 root cause fix + includeAll mode for Gap 2. Cleaner long-term.
- B + C: Overlay files for Gap 1 + includeAll for Gap 2. More moving parts but zero migration.

## Self-Critique

**Strongest counter-argument to A:** The 9-value closed enum may not cover all external team
needs. If teams want domain-specific tags (e.g. `mobile`, `android`, `ios`), the enum is wrong
and the schema would need updating again.

**Narrower option that could still work:** Candidate C alone fixes Gap 2. Gap 1 could be
deferred - engineers can use `includeSources=true` to find external workflows today.

**Broader option:** Allow arbitrary string tags (not a closed enum) with a separate tag registry
per organization. This is substantial scope increase with no current evidence it's needed.

**Assumption that would invalidate A+C:** If the primary use case is not "agent browsing by
category" but "engineer listing all available workflows once" - then `includeSources=true` already
solves the real problem and no fix is needed.

## Open Questions for the Main Agent

1. Should external workflow authors be expected to know the 9-value tag enum, or should the
   system auto-classify external workflows into a generic category?
2. Is there a performance concern with reading per-source tags overlay files on every
   `list_workflows` call? (Walk cache TTL is 5 min; overlay files would need similar caching)
3. Should the `checkUntaggedWorkflows` CI check be extended to external source paths, or is it
   explicitly scoped to bundled workflows?
