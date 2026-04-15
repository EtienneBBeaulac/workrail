# Design Review Findings: WorkRail Workflow Discovery Extension Points

**Scope:** Investigation findings for the implementing engineer. No fix proposed.
**Selected direction (for reference):** A+C - schema tags field + includeAll/universal list mode.

## Tradeoff Review

| Tradeoff | Verdict | Condition where it fails |
|----------|---------|--------------------------|
| Schema change for `tags` field (optional, no forced migration) | Acceptable | Becomes costly if tags are later made required |
| Closed 9-value enum for tag vocabulary | Acceptable | Fails if >5% of external workflows don't fit any category |
| New `includeAll` or modified `includeSources` mode | Acceptable | Agents don't use the custom bucket if `_nextStep` doesn't guide them |

## Failure Mode Review

**RED - tagSummary count drift (blocking):**
If `buildTagSummary` counts from `workflow-tags.json` only but `filterByTags` returns results from
both sources (static file + schema-declared tags), the count in the tagSummary first call will
understate the number of workflows returned by the tags filter second call. This breaks the
agent's expectation that count = filtered result count.

Mitigation required: `buildTagSummary` must count from both sources simultaneously.
Location: `src/mcp/handlers/v2-workflow.ts:86`.

**ORANGE - divergence between workflow.schema.json tags and workflow-tags.json for bundled workflows:**
If bundled workflows declare tags in both their JSON files (via new `tags` field) and in
`workflow-tags.json`, there are two authoritative sources. Merge precedence must be defined.
Recommendation: `workflow-tags.json` wins for bundled source kind; schema field wins for all
other source kinds. This avoids any migration of existing bundled workflow files.

**YELLOW - custom bucket semantics:**
A synthetic `custom`/`untagged` bucket in tagSummary would include external workflows but
might also include bundled workflows accidentally omitted from `workflow-tags.json`.
Mitigation: filter synthetic bucket to exclude `visibility.category === 'built_in'` workflows.
Already computable from the per-workflow `visibility` object.

## Runner-Up / Simpler Alternative Review

**Simplest viable fix for Gap 2:** Add `tagSummary` to the existing `includeSources=true` response
(currently it's absent, `v2-workflow.ts:259`). No new parameter, ~10-line change. Backward
compatible (tagSummary was absent, adding it is additive). Downside: conflates source inspection
with browsing in one mode.

**Runner-up B (overlay files) strength worth borrowing:** For teams distributing many workflows
from one directory, a per-directory `.workrail/workflow-tags.json` overlay is lower friction than
editing N individual workflow JSON files. A hybrid of A+B could support both patterns.

## Philosophy Alignment

All key principles satisfied:
- 'Validate at boundaries': Zod schema validation unchanged; new `tags` field validated same as `examples`
- 'Make illegal states unrepresentable': Closed enum prevents invalid tag values
- 'Architectural fix over patch': Addresses root cause (missing metadata)
- 'Immutability by default': No mutation of module-level const needed; `buildTagSummary` signature change only

No blocking philosophy conflicts.

## Findings Summary

| Severity | Finding | Location |
|----------|---------|---------|
| RED | `buildTagSummary` count must be updated to count from both tag sources simultaneously | `v2-workflow.ts:86` |
| ORANGE | Merge precedence must be defined for bundled workflows that appear in both `workflow-tags.json` and have schema `tags` field | `v2-workflow.ts:86-103` |
| ORANGE | `_nextStep` hint text at `v2-workflow.ts:269` hardcodes tag names; must be updated if new tags or modes are added | `v2-workflow.ts:269` |
| YELLOW | `checkUntaggedWorkflows` in `validate-workflows-registry.ts:364` only scans bundled workflows; won't catch untagged external workflows | `scripts/validate-workflows-registry.ts:364` |
| YELLOW | `tools.ts:28` tag enum description hardcoded; must be updated if tags change | `src/mcp/v2/tools.ts:28` |

## Recommended Revisions

1. Define merge precedence explicitly: `workflow-tags.json` authoritative for `bundled` source;
   schema `tags` field authoritative for all other source kinds.
2. Update `buildTagSummary` to accept workflow objects (not just IDs) and read schema tags when
   workflow-tags.json has no entry for that ID.
3. Update `_nextStep` hint to mention external workflow bucket when external sources are present.
4. Add a CI check that validates `buildTagSummary` count equals `filterByTags` result count
   across both sources.

## Residual Concerns

- The 9-value tag enum may be too narrow for production use at scale. Consider making the tag
  vocabulary extensible (e.g. open string with validation against a registered set) from the start.
- No caching is defined for schema-declared tags reads. If `loadAllWorkflows` already loads the
  full workflow object, no extra I/O is needed - tags come from the already-loaded objects. This
  should be confirmed during implementation.
- The walk cache (5-min TTL at `request-workflow-reader.ts:48`) covers rooted-sharing discovery.
  Per-source tag overlay files (if Candidate B is adopted) would need separate caching or could
  piggyback on the same walk pass.
