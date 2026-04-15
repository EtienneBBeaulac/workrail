# Workflow Categories Design Review Findings

## Tradeoff Review

| Tradeoff | Verdict | Condition of failure |
|---|---|---|
| Two-file maintenance | Acceptable | If validate:registry check removed — uncategorized workflows silently absent |
| Two-call pattern | Acceptable | Summary is DEFAULT — no agent behavior change needed for token savings |
| Overlay drift | Acceptable | With CI enforcement (validate:registry must treat uncategorized non-hidden as error) |

## Failure Mode Review

| Failure Mode | Risk | Coverage | Fix |
|---|---|---|---|
| New workflow not categorized | Medium | validate:registry warning | Upgrade to error for non-hidden workflows |
| Agent passes unknown category | Low | Returns empty list | Add hint listing valid categories in response |
| **Existing callers break** | **High** | **Not yet addressed** | **`categorySummary` must be ADDITIVE — keep `workflows` in response** |

**Most dangerous**: existing callers that iterate `workflows` will get an empty array if we change the default to summary-only. Fix: when no `category` is passed, return `categorySummary` (new field) PLUS `workflows: []` (existing field, now empty). Callers that check `workflows` see empty and know to browse by category.

## Runner-Up / Simpler Alternative Review

No runner-up worth borrowing from. Simpler variant (no validate:registry check) rejected — silent data loss is worse than maintenance burden.

## Philosophy Alignment

All principles satisfied: determinism (explicit overlay), validate-at-boundaries (CI check), YAGNI (no compiler changes), explicit domain types (typed enum).

Minor acceptable tension: empty `workflows` array in summary response is technically correct but slightly awkward UX.

## Findings

**Orange — backward compatibility not fully specified**
The current design description doesn't explicitly address what `workflows` contains when no `category` is passed. If it returns all workflows (current behavior), the token savings are lost. If it returns empty, existing callers break. Must explicitly specify: `workflows: []` when in summary mode, `categorySummary` is the new primary field.

**Yellow — validate:registry check must be error, not warning**
An uncategorized non-hidden workflow that shows as a warning doesn't block CI. Should be an error so new workflows can't ship without a category.

**Yellow — tool description in tools.ts needs updating**
The `list_workflows` tool description says it returns workflow details. It needs to explain the new summary default and the `category` parameter.

## Recommended Revisions

1. Specify response contract explicitly: when `category` absent → `{ workflows: [], categorySummary: [...] }`; when `category` present → `{ workflows: [...full list...], categorySummary: undefined }`
2. validate:registry: treat uncategorized non-hidden workflows as an **error** (not warning) in CI
3. Update `list_workflows` tool description to explain category browsing

## Residual Concerns

- Per-workspace custom categories not addressed (v2 concern, not v1)
- Should routines be hidden from summary by default? They're internal plumbing, not user-invoked. Recommend: routines visible in summary but clearly labeled, agents can filter by category=routines when needed
