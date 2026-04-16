# GitHub Polling Adapter: Design Review Findings

**Date:** 2026-04-15
**Design reviewed:** Candidate B -- tagged `PollingSource` discriminated union
**Status:** Complete

---

## Tradeoff Review

### Tradeoff 1: Parse-time raw type is still untagged (accepted)

The `ParsedTriggerRaw.source` bag holds both `projectId` (GitLab) and `repo` (GitHub) as optional fields. Discrimination only applies after assembly. This is valid: the assembler validates required fields with explicit `missing_field` errors. A `github_issues_poll` trigger with `projectId` instead of `repo` will fail at assembly with a clear error.

**Hidden assumption verified:** The assembler must explicitly validate `repo` as required for `github_issues_poll`/`github_prs_poll` (not inherited from GitLab path). Must be in the implementation.

### Tradeoff 2: `excludeAuthors` exact string match (accepted)

Valid for a single controlled bot account. Breaks if the bot naming convention uses unpredictable suffixes. Mitigated by: prominent warning in `GitHubPollingSource` comment, TODO for glob support.

### Tradeoff 3: 100 items per page, no pagination (accepted)

Issues API has native `since` filter -- pagination almost never needed. PRs API lacks `since` -- all open PRs fetched and filtered client-side. Burst risk (>100 PRs in one interval) is low for typical repos. Must be documented.

### Tradeoff 4: GitHub PRs client-side `updated_at` filter (accepted)

Higher API cost per cycle (fetch up to 100 PRs vs. only updated ones). Within rate limit budget at normal poll intervals (42 req/hour for PRs at 5-min interval). Rate limit check guards the threshold.

---

## Failure Mode Review

### RED: Self-loop if `excludeAuthors` not configured

**Risk level:** HIGH. An unconfigured `excludeAuthors` creates an infinite loop: WorkTrain PR -> poll picks it up -> workflow dispatched -> another PR -> repeat. Cascading effects: rate limit exhaustion, unbounded sessions, potential cost impact.

**Current mitigation:** None (it's optional config). User must explicitly set it.

**Required mitigation:**
- `GitHubPollingSource.excludeAuthors` comment must contain: "IMPORTANT: include your WorkTrain bot account login here to prevent infinite self-review loops."
- `polling-scheduler.ts` dispatch path comment must repeat the warning.
- A default auto-detection TODO (WorkTrain could know its own GitHub login) should be filed.

### ORANGE: Rate limit skip has no alerting beyond log line

**Risk level:** Medium. When `X-RateLimit-Remaining < 100`, the cycle is silently skipped with only a console warning. Users who don't monitor logs may not notice the adapter has stopped polling.

**Current mitigation:** Log warning per skipped cycle.

**Recommended mitigation:** No code change needed for MVP, but the log message should include the `X-RateLimit-Reset` timestamp so users know when polling will resume.

### YELLOW: >100 PRs in one poll interval causes silent miss

**Risk level:** Low for typical repos, medium for dependency-bot-heavy repos.

**Mitigation:** Document in `GitHubPollingSource.pollIntervalSeconds` comment. No code change.

### YELLOW: `excludeAuthors` exact match may be insufficient for numbered bot accounts

**Risk level:** Low -- most bot accounts have stable names.

**Mitigation:** TODO comment for glob support. No code change.

---

## Runner-Up / Simpler Alternative Review

**Candidate A (bare union + if/else):** Identified one borrow -- using `trigger.provider` for the dispatch switch is valid, but inside the switch arm TypeScript still needs the tag on `pollingSource` to narrow from `GitLabPollingSource | GitHubPollingSource` to the specific type. The hybrid (trigger.provider switch + untagged union) would require unsafe casts. Not worth pursuing.

**Merged `github_poll` provider:** Rejected. Issues and PRs have different endpoints, different shapes, different filter semantics. Merging adds conditional logic to the adapter. Two single-purpose adapters are cleaner.

**Simpler tagged union (add tag to source, but skip updating `isPollingTrigger` guard):** Already analyzed -- `isPollingTrigger` works unchanged when `pollingSource` becomes `PollingSource`. No simplification available.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Errors are data | Satisfied -- Result<T,E> everywhere |
| Immutability by default | Satisfied -- all fields readonly |
| Make illegal states unrepresentable | Satisfied -- tagged union |
| Type safety as first line of defense | Satisfied -- type guards at boundary |
| Validate at boundaries, trust inside | Satisfied -- assembler validates |
| Dependency injection for boundaries | Satisfied -- fetchFn injectable |
| Prefer fakes over mocks | Satisfied -- vi.fn() fake pattern |
| Document why not what | Satisfied -- invariant comments required |
| YAGNI | Minor tension -- overridden by existing TODO |
| Determinism over cleverness | Minor tension -- excludeAuthors exact match acceptable |

---

## Findings

### RED

**Self-loop risk is not mitigated by default.** `excludeAuthors` is optional config with no default. A WorkTrain PR polling trigger with no `excludeAuthors` creates an infinite loop. The design must include prominent warnings in the `GitHubPollingSource` type comment and in the `polling-scheduler.ts` dispatch path comment.

### ORANGE

**Rate limit skip log message should include reset time.** When `X-RateLimit-Remaining < 100`, include `X-RateLimit-Reset` (Unix timestamp) in the log message so users know when polling resumes without digging into GitHub's documentation.

### YELLOW

**Both pagination and client-side filtering limitations must be documented in the type comment.** Not in code comments only -- in the `GitHubPollingSource` interface comment where users read it when configuring triggers.

### YELLOW

**`excludeAuthors` exact-match limitation must have a TODO for glob support.** The backlog example uses `worktrain-*` which implies glob. The implementation note should clarify that this is exact match and reference the backlog entry.

---

## Recommended Revisions

1. **Add self-loop warning to `GitHubPollingSource.excludeAuthors` field comment** (required, not optional). Example text: "IMPORTANT: always include your WorkTrain bot account login here (e.g., `worktrain-bot`). Omitting this causes an infinite self-review loop where WorkTrain reviews its own PRs."

2. **Include `X-RateLimit-Reset` in the rate limit skip log message.** Change: `console.warn('[GH] Rate limit low: remaining=${remaining}')` to `console.warn('[GH] Rate limit low: remaining=${remaining}, resets at ${new Date(resetTs * 1000).toISOString()}')`.

3. **Document pagination limitation and client-side filter in `GitHubPollingSource` comments** -- one sentence each.

4. **Add TODO for glob support in `excludeAuthors` comment** -- "TODO: exact string match only. Glob support (e.g., worktrain-*) planned but not implemented."

---

## Residual Concerns

- **`github_prs_poll` redundancy with `github_issues_poll`:** GitHub Issues API returns PRs as well (a PR is also an issue). Using `github_issues_poll` with `labelFilter: my-label` could accidentally pick up PRs. Users should be aware that `state=open` on the issues endpoint includes open PRs. The `github_prs_poll` adapter uses the separate `/repos/:owner/:repo/pulls` endpoint which is PR-only. Both adapters should document this distinction.

- **Authentication:** Only personal access tokens are supported (same as GitLab). GitHub App tokens and fine-grained PATs are not addressed. This is an accepted MVP limitation.

- **`filter.notLabels` naming:** The backlog uses `filter.notLabels` as a nested object. The implementation uses `notLabels` as a top-level field on `GitHubPollingSource` for simplicity (consistent with how `events` and `labelFilter` are flat fields). No structural concern but naming should be consistent with any future filter fields.
