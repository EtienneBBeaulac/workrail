# GitHub Polling Adapter: Implementation Plan

**Date:** 2026-04-15
**Branch:** `feat/github-polling-adapter` (based on `feat-polling-triggers`)
**Status:** Ready for implementation

---

## 1. Problem Statement

WorkRail can poll GitLab MRs for new/updated merge requests (PR #404, in-flight). There is no equivalent for GitHub. Users with GitHub repos must configure webhooks (requiring admin access + public URL) or forgo event-driven automation entirely. This plan implements GitHub Issues and GitHub PRs polling adapters that mirror the GitLab pattern exactly: poll on a schedule, deduplicate via `PolledEventStore`, dispatch via `TriggerRouter.dispatch()`.

---

## 2. Acceptance Criteria

1. A trigger with `provider: github_issues_poll` polls `GET /repos/:owner/:repo/issues?state=open&since=<ISO8601>&sort=updated` on the configured interval.
2. A trigger with `provider: github_prs_poll` polls `GET /repos/:owner/:repo/pulls?state=open&sort=updated&direction=desc` and filters `updated_at > lastPollAt` client-side.
3. Events authored by users in `excludeAuthors` are never dispatched.
4. `notLabels` excludes items with matching labels (client-side filter).
5. `labelFilter` is passed as `labels=` query parameter to the issues/pulls endpoint.
6. When `X-RateLimit-Remaining < 100`, the poll cycle is skipped and a warning is logged with the reset timestamp.
7. Items already processed (by ID) are not re-dispatched across daemon restarts (deduplication via `PolledEventStore`).
8. `trigger-store.ts` parses `github_issues_poll` and `github_prs_poll` triggers from `triggers.yml` with all required fields validated.
9. `TriggerDefinition.pollingSource` is typed as a tagged `PollingSource` discriminated union.
10. All existing GitLab tests continue to pass unchanged.
11. `github-poller.test.ts` covers: success, empty response, HTTP 401/500, network error, invalid JSON, non-array response, malformed items, event filter, `excludeAuthors`, `notLabels`, rate limit skip, URL construction.

---

## 3. Non-Goals

- Pagination beyond 100 items per page
- GitHub webhooks
- GitHub App token or fine-grained PAT support
- Glob pattern matching for `excludeAuthors`
- Response caching or request coalescing
- Monitoring or alerting beyond log messages
- Configuring `notLabels` as a server-side filter (API does not support it)

---

## 4. Philosophy-Driven Constraints

- All public functions return `Result<T, E>`. No throws at adapter boundaries.
- All types are `readonly` on every field.
- `fetchFn` is injectable in both adapter functions (required for tests).
- Tests use `vi.fn().mockResolvedValue()` (fakes, not mocks of full HTTP layer).
- Rate limit skip is a log-and-return, not an error result (per stated requirement).
- `excludeAuthors` is exact string match only. Glob support filed as TODO.
- At-least-once ordering: `dispatch()` BEFORE `store.record()`.

---

## 5. Invariants

1. **At-least-once delivery**: dispatch is called BEFORE `PolledEventStore.record()`. If process crashes between dispatch and record, events re-fire. Silent miss is worse than duplicate.
2. **Fresh-start invariant**: `PolledEventStore` initializes `lastPollAt=now` on missing/corrupt file. Never re-fires historical events on daemon restart.
3. **Skip-cycle guard**: if a poll cycle is still running when the next interval fires, skip the new cycle. Never run two concurrent polls for the same trigger.
4. **`excludeAuthors` filter runs BEFORE dispatch**. Never dispatch an event for a filtered author.
5. **Rate limit skip**: if `X-RateLimit-Remaining < 100`, return early from the adapter (log warning). Do NOT call dispatch.
6. **No silent schema rejection**: type guards (`isGitHubIssueShape`, `isGitHubPRShape`) skip malformed items and return valid ones; they do not return errors.
7. **`github_issues_poll` and `github_prs_poll` must be in `SUPPORTED_PROVIDERS`** in `trigger-store.ts` or config parsing silently rejects them with `unknown_provider`.

---

## 6. Selected Approach + Rationale + Runner-Up

**Selected: Candidate B -- tagged `PollingSource` discriminated union**

```ts
export type PollingSource =
  | (GitLabPollingSource & { readonly provider: 'gitlab_poll' })
  | (GitHubPollingSource & { readonly provider: 'github_issues_poll' })
  | (GitHubPollingSource & { readonly provider: 'github_prs_poll' });
```

`TriggerDefinition.pollingSource` is typed as `PollingSource | undefined`. The assembler in `trigger-store.ts` adds the `provider` tag. The scheduler uses `switch(trigger.pollingSource.provider)` for exhaustive dispatch.

**Rationale:** `types.ts` already has the comment "TODO: migrate to discriminated union at adapter #2." This is adapter #2. The migration is bounded to 3 files with no external consumers of `pollingSource`.

**Runner-up: Candidate A** -- bare union without tag. Lost because TypeScript cannot narrow `GitLabPollingSource | GitHubPollingSource` inside a `switch(trigger.provider)` arm without unsafe casts. The tag is necessary for compiler-enforced safety.

---

## 7. Vertical Slices

### Slice 1: Types -- `GitHubPollingSource` and `PollingSource` union

**Files:** `src/trigger/types.ts`

**Changes:**
- Add `GitHubPollingSource` interface (fields: `baseUrl`, `repo`, `token`, `events`, `pollIntervalSeconds`, `excludeAuthors`, `notLabels`, `labelFilter`)
- Add `PollingSource` discriminated union type
- Change `TriggerDefinition.pollingSource?: GitLabPollingSource` to `pollingSource?: PollingSource`

**Done when:** TypeScript compiles with no errors after the type change. All existing GitLab code that reads `pollingSource` still compiles (it will need narrowing updates in Slice 4).

---

### Slice 2: Trigger store -- parse `github_issues_poll` and `github_prs_poll`

**Files:** `src/trigger/trigger-store.ts`

**Changes:**
- Add `'github_issues_poll'` and `'github_prs_poll'` to `SUPPORTED_PROVIDERS`
- Add `repo`, `excludeAuthors`, `notLabels`, `labelFilter` to `ParsedTriggerRaw.source` optional fields
- Add assembly branch in `validateAndResolveTrigger` for GitHub providers: validate `repo` required, validate `token` required, parse `excludeAuthors` space-separated, parse `notLabels` space-separated, parse `labelFilter` space-separated, produce tagged `PollingSource`
- Add `provider` tag to the assembled GitLab source too (so `pollingSource.provider === 'gitlab_poll'` works)
- Warn on unrecognized `source` fields for non-polling providers (existing behavior -- no change)

**Done when:** `triggers.yml` with `provider: github_issues_poll` and a valid `source:` block parses without error. Missing `repo` returns `missing_field` error. `trigger-store.test.ts` updated tests pass.

---

### Slice 3: GitHub poller adapter

**Files:** `src/trigger/adapters/github-poller.ts` (new)

**Exports:**
- `interface GitHubIssue` -- fields: `id`, `number`, `title`, `html_url`, `updated_at`, `state`, `user`, `labels`
- `interface GitHubPR` -- fields: `id`, `number`, `title`, `html_url`, `updated_at`, `state`, `user`, `draft`
- `type GitHubPollError` -- kinds: `http_error`, `network_error`, `parse_error`
- `async function pollGitHubIssues(source, since, fetchFn?): Promise<Result<GitHubIssue[], GitHubPollError>>`
- `async function pollGitHubPRs(source, since, fetchFn?): Promise<Result<GitHubPR[], GitHubPollError>>`

**Issues endpoint:** `GET https://api.github.com/repos/:owner/:repo/issues?state=open&since=<since>&sort=updated&direction=desc&per_page=100&labels=<labelFilter>`

**PRs endpoint:** `GET https://api.github.com/repos/:owner/:repo/pulls?state=open&sort=updated&direction=desc&per_page=100`

**Both functions:**
1. Build URL
2. Fetch with `Authorization: Bearer <token>` header
3. Check `X-RateLimit-Remaining` -- if < 100, log warning with reset timestamp, return `ok([])`
4. On non-2xx: return `err({ kind: 'http_error', status, message })`
5. Parse JSON array
6. Apply `isGitHubIssueShape` / `isGitHubPRShape` type guard
7. Filter `item.user?.login` against `source.excludeAuthors` (exact string match)
8. For PRs only: filter `item.updated_at > since` (client-side)
9. Apply `notLabels` filter: drop items where any label name is in `source.notLabels`
10. Return `ok(items)`

**Rate limit check implementation:**
```ts
const remaining = parseInt(response.headers.get('X-RateLimit-Remaining') ?? '9999', 10);
const resetTs = parseInt(response.headers.get('X-RateLimit-Reset') ?? '0', 10);
if (remaining < 100) {
  console.warn(`[GitHubPoller] Rate limit low: remaining=${remaining}, resets at ${new Date(resetTs * 1000).toISOString()}. Skipping cycle.`);
  return ok([]);
}
```

**Done when:** `github-poller.test.ts` passes all cases (success, errors, filters, rate limit skip).

---

### Slice 4: Polling scheduler -- extend for GitHub

**Files:** `src/trigger/polling-scheduler.ts`

**Changes:**
- `isPollingTrigger` -- unchanged (still checks `pollingSource !== undefined`; type is now `PollingSource`)
- `doPoll` -- change dispatch routing to `switch(trigger.pollingSource.provider)` with cases for `gitlab_poll`, `github_issues_poll`, `github_prs_poll`. No `default` case that silently drops -- use exhaustive check with a logged warning.
- `buildWorkflowTrigger` -- split into:
  - `buildGitLabWorkflowTrigger(trigger, mr: GitLabMR): WorkflowTrigger`
  - `buildGitHubWorkflowTrigger(trigger, item: GitHubIssue | GitHubPR): WorkflowTrigger`

**GitHub context variables injected:**
```ts
{
  itemId: item.id,
  itemNumber: item.number,
  itemTitle: item.title,
  itemUrl: item.html_url,
  itemUpdatedAt: item.updated_at,
  itemAuthorLogin: item.user?.login,
}
```

**Done when:** A `github_issues_poll` trigger in a test fires `dispatch()` with the correct `WorkflowTrigger`. Existing `polling-scheduler.test.ts` GitLab cases still pass.

---

### Slice 5: Tests

**Files:**
- `tests/unit/github-poller.test.ts` (new)
- `tests/unit/trigger-store.test.ts` (extend)
- `tests/unit/polling-scheduler.test.ts` (extend)

**`github-poller.test.ts` cases:**
- Success: 2 issues returned from fake fetch
- Empty: API returns empty array
- HTTP 401: returns `http_error`
- HTTP 500: returns `http_error`
- Network error: returns `network_error`
- Invalid JSON: returns `parse_error`
- Non-array response: returns `parse_error`
- Malformed items: skipped, valid items returned
- `excludeAuthors` filter: bot-authored item excluded
- `notLabels` filter: labeled item excluded
- Rate limit skip: `X-RateLimit-Remaining=50` returns `ok([])` with log
- PR `updated_at` filter: item older than `since` excluded
- Issues URL construction: correct params including `since` and `labels`
- PRs URL construction: no `since` param, sort by updated
- Auth header: `Authorization: Bearer <token>`

**Done when:** All new tests pass, all existing trigger-related tests pass.

---

### Slice 6: Exports and documentation

**Files:**
- `src/trigger/index.ts` -- export `GitHubPollingSource` and `PollingSource` if needed
- `docs/design/github-polling-adapter-design-candidates.md` (already written)
- `docs/design/github-polling-adapter-design-review-findings.md` (already written)

**Done when:** Module exports are consistent. No breaking changes to existing exports.

---

## 8. Test Design

**Framework:** Vitest (same as existing trigger tests)

**Pattern:** Inject `fetchFn: FetchFn` as a `vi.fn()` fake returning controlled responses. Never use real HTTP.

**Template:** Mirror `tests/unit/gitlab-poller.test.ts` structure exactly:
- Helper functions: `makeSource()`, `makeIssue()`, `makePR()`, `makeFetch()`
- Describe blocks per behavior group
- Explicit `result.kind === 'ok'` / `result.kind === 'err'` narrowing before assertions

**Coverage target:** All branches in both adapter functions. All filter logic (excludeAuthors, notLabels, updated_at).

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Self-loop from unconfigured `excludeAuthors` | Medium | HIGH | Mandatory warning in config comment; document in triggers.yml example |
| Rate limit exhaustion on high-volume repos | Low | Medium | `X-RateLimit-Remaining < 100` skip + reset timestamp in log |
| `github_issues_poll` catches open PRs accidentally | Low | Low | Document in adapter comment: "includes open PRs (they are also issues)" |
| >100 PRs updated per poll interval silently missed | Low | Low | Document in `pollIntervalSeconds` comment |
| `feat-polling-triggers` PR changes conflict | Low | Low | Branch this work on `feat-polling-triggers`; rebase after #404 merges |

---

## 10. PR Packaging Strategy

**Single PR** on branch `feat/github-polling-adapter`, based on `feat-polling-triggers`.

All 6 slices in one PR because:
- The discriminated union type change and the adapter implementation are tightly coupled
- Tests validate the full integration path
- The PR is digestible in size (est. 400-600 lines new/changed)

---

## 11. Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| 1 (types) | Make illegal states unrepresentable | Satisfied -- tagged union |
| 1 (types) | Immutability by default | Satisfied -- all fields readonly |
| 2 (trigger-store) | Validate at boundaries | Satisfied -- assembler validates all fields |
| 2 (trigger-store) | Errors are data | Satisfied -- missing_field, invalid_field_value errors |
| 3 (adapter) | Dependency injection | Satisfied -- fetchFn injectable |
| 3 (adapter) | Errors are data | Satisfied -- Result<T,E> return |
| 3 (adapter) | Determinism over cleverness | Satisfied -- exact string match for excludeAuthors |
| 4 (scheduler) | Exhaustiveness everywhere | Satisfied -- switch on provider with no silent default |
| 4 (scheduler) | Compose with small, pure functions | Satisfied -- split buildWorkflowTrigger |
| 5 (tests) | Prefer fakes over mocks | Satisfied -- vi.fn() fake fetchFn |
| 5 (tests) | Document why not what | Satisfied -- test case names describe behavior, not implementation |

---

## Plan Confidence

- `planConfidenceBand`: High
- `unresolvedUnknownCount`: 1 (whether `excludeAuthors` exact match is truly sufficient for the WorkTrain bot account naming convention -- acceptable for MVP)
- `estimatedPRCount`: 1
- `followUpTickets`: ["Add glob support to excludeAuthors", "Implement pagination for high-volume repos", "Add X-RateLimit-Reset-based backoff", "Auto-detect WorkTrain bot account login for default excludeAuthors"]
