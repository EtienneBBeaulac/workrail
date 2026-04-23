# Workflow Categories Design Candidates

## Problem Understanding

**Core tensions:**
1. Hash stability: category metadata cannot go in workflow JSON without breaking workflowHash when recategorized
2. Default behavior: making summary the default changes the implicit contract of list_workflows (agents expecting full list must adapt)
3. Overlay freshness: a separate categories file can drift from the actual workflow registry

**Likely seam**: `handleV2ListWorkflows` in `src/mcp/handlers/v2-workflow.ts` + `V2ListWorkflowsInput` in `src/mcp/v2/tools.ts` + `V2WorkflowListOutputSchema` in `src/mcp/output-schemas.ts`

**What makes it hard**: The overlay must be authoritative metadata about the registry without being part of the compilation pipeline. Junior devs would put it in workflow JSON or infer it dynamically — both approaches break for different reasons.

## Philosophy Constraints

- **Determinism**: category assignment must be explicit, not inferred
- **Make illegal states unrepresentable**: uncategorized workflows should be a validation warning, not silent
- **YAGNI**: don't add compiler complexity for C when A solves it more simply
- **Explicit domain types**: category should be a typed enum, not a free string

## Impact Surface

- `spec/workflow-categories.json` (new file)
- `V2ListWorkflowsInput` (new optional `category` field)
- `V2WorkflowListOutputSchema` (new optional `categorySummary` field)
- `handleV2ListWorkflows` (response branching logic)
- `validate-workflows-registry.ts` (new uncategorized workflow warning)
- `wr.workflow-for-workflows.v2.json` Phase 7 (should stamp category when authoring)

## Candidates

### A: Spec overlay file + `category` filter param ✓ RECOMMENDED

**Summary**: `spec/workflow-categories.json` maps workflow IDs to domain categories. `list_workflows` without `category` returns compact `categorySummary`. With `category`, returns full filtered list.

- **Tensions resolved**: hash stability, backwards compatibility, token reduction
- **Tensions accepted**: overlay can drift (mitigated by validate:registry check)
- **Boundary**: spec/ directory + V2ListWorkflowsInput + output schema + handler
- **Failure mode**: new workflow added but not categorized — shows as uncategorized, validator warns
- **Repo pattern**: adapts `includeSources` pattern directly
- **Gains**: clean separation, CI-checkable, zero workflow file changes
- **Losses**: extra file to maintain
- **Scope**: best-fit
- **Philosophy**: honors determinism, make-illegal-states-unrepresentable

### B: Naming convention inference (no overlay)

**Summary**: Infer category from workflow ID prefix at runtime. `routine-*` → routines, `test-*` → testing, everything else guessed from description keywords.

- **Failure mode**: ~70% of workflows mis-categorized (only routine-* and test-* have reliable prefixes)
- **Repo pattern**: departs
- **Scope**: too narrow — doesn't work for most of the catalog
- **Philosophy**: conflicts with determinism

### C: `category` field in workflow JSON with hash isolation

**Summary**: Add `category` to workflow JSON but strip it from the compiled snapshot before hashing.

- **Failure mode**: compiler regression accidentally includes `category` in hash, silently invalidating sessions
- **Repo pattern**: departs — no existing field excluded from compilation this way
- **Scope**: too broad — adds significant compiler complexity
- **Philosophy**: violates YAGNI

## Comparison and Recommendation

**A wins on every axis**: hash stability, backwards compatibility, clean boundary, CI-checkable, follows includeSources pattern, minimal code change.

B covers ~30% of workflows. C adds compiler complexity for a problem A already solves.

**Implementation shape for A:**
1. `spec/workflow-categories.json` — `{ categories: [...], workflows: { workflowId: { category, hidden? } } }`
2. `V2ListWorkflowsInput`: add `category?: string`
3. `V2WorkflowListOutputSchema`: add `categorySummary?: { category, displayName, count, representatives }[]`
4. `handleV2ListWorkflows`: when no `category`, return `categorySummary`; when `category` present, return filtered full list
5. `validate:registry`: warn on uncategorized non-hidden workflows
6. Token budget: summary ~500 tokens; per-category full list ~800 tokens for 3-5 workflows

**Natural taxonomy (10 categories):**

| Category | Count | Examples |
|---|---|---|
| coding | 3 | coding-task, wr.cross-platform-code-conversion |
| review_audit | 3 | mr-review, wr.production-readiness-audit, wr.architecture-scalability-audit |
| investigation | 2 | bug-investigation, workflow-diagnose |
| design | 2 | ui-ux-design, wr.discovery |
| documentation | 3 | document-creation, scoped-documentation, documentation-update |
| tickets | 4 | wr.adaptive-ticket-creation, ticket-grooming, wr.intelligent-test-case-generation |
| learning | 4 | personal-learning-*, wr.presentation-creation, relocation |
| routines | ~10 | all routine-* |
| authoring | 1-2 | wr.workflow-for-workflows |
| testing | 3 | test-* (hidden from default summary) |

## Self-Critique

**Strongest counter-argument**: two-file maintenance burden (workflow JSON + overlay). Mitigated by: validate:registry warning on uncategorized workflows makes omission loud; wr.workflow-for-workflows can be updated to prompt for category at authoring time.

**Pivot condition**: if teams want per-workspace custom categories, A needs extension (workspace-level categories.json overlay). Defer to v2.

## Open Questions for Main Agent

1. Should `testing` workflows be `hidden: true` (excluded from summary) or shown in their own testing category?
2. Should routines be surfaced in summary mode at all, or hidden by default (they're internal, not user-invoked)?
3. Should the `categorySummary` include a short description per category (e.g., "Review code changes, audit systems") or just names + counts?
4. What's the right `displayName` for `review_audit`? "Review & Audit"?
5. Should `wr.workflow-for-workflows` Phase 7 be updated to stamp the category, or is that a separate ticket?
