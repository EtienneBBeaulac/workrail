# GitHub Polling Adapter: Design Candidates

**Date:** 2026-04-15
**Type:** Design Candidates
**Status:** Draft -- for review

---

## Problem Understanding

### The Ask

Add GitHub Issues and GitHub PRs polling adapters that mirror the GitLab adapter pattern. Poll GitHub APIs on a configurable schedule, deduplicate via `PolledEventStore`, dispatch workflows via `TriggerRouter.dispatch()`. Must include `excludeAuthors` filter to prevent self-review loops.

### Infrastructure Context

The GitLab adapter infrastructure lives in the `feat-polling-triggers` worktree (PR #404, in-flight). It is NOT merged to `main` yet. The GitHub adapter work must be built on top of that branch. Files in scope:

- `src/trigger/adapters/gitlab-poller.ts` -- the direct template
- `src/trigger/polling-scheduler.ts` -- orchestration; calls adapters and dispatches
- `src/trigger/polled-event-store.ts` -- per-trigger deduplication state on disk
- `src/trigger/types.ts` -- `GitLabPollingSource`, `TriggerDefinition.pollingSource`
- `src/trigger/trigger-store.ts` -- YAML parser, `SUPPORTED_PROVIDERS` set

### Core Tensions

**1. Shared `source:` YAML block vs. type-safe discriminated union.**
The YAML parser uses one `source:` block with shared field names. GitLab uses `projectId`; GitHub uses `repo`. If reusing the same block, the raw parsed type is a union of optional fields -- structurally looser than the assembled typed model. The discriminated union only kicks in after assembly; the raw parser type cannot be discriminated cleanly.

**2. `pollingSource` field migration vs. backward compatibility.**
The current `TriggerDefinition.pollingSource?: GitLabPollingSource` field has a code comment requesting migration to a discriminated union at adapter #2 (this change). All existing narrowing in `polling-scheduler.ts` and `trigger-store.ts` must be updated. The impact surface is small but must be handled atomically.

**3. GitHub PR `updated_at` vs. GitLab `updated_after` API semantics.**
GitLab issues endpoint accepts `updated_after=<ISO8601>` as a server-side filter. GitHub PRs endpoint does NOT accept a `since` parameter -- must fetch all open PRs sorted by `updated` desc, then filter client-side where `updated_at > lastPollAt`. This means more items are fetched per cycle and the deduplication load shifts to the client.

**4. `notLabels` client-side filter vs. pagination.**
GitHub API supports `labels=foo,bar` (include filter) but has no native exclude. The `notLabels` filter runs client-side. But with only 100 items per page and no pagination, filtering out many items means some new items may be missed. Accepted limitation -- same as the GitLab adapter's pagination limitation.

### What Makes This Hard

A junior developer would:
1. Skip the discriminated union migration and leave `pollingSource` as a bare `GitLabPollingSource | GitHubPollingSource` union -- the compiler cannot enforce which source type accompanies which provider string
2. Forget to add `github_issues_poll` and `github_prs_poll` to `SUPPORTED_PROVIDERS` in `trigger-store.ts` -- triggers would silently fail with `unknown_provider` at config load
3. Use `lastPollAt` as a GitHub PRs `since` parameter (the API ignores it -- no such parameter exists for PRs)
4. Miss the rate limit header check -- at 5000 req/hour the math is fine for normal use, but a burst or misconfiguration could exhaust it without warning
5. Place the `excludeAuthors` filter AFTER the dispatch call, creating the self-loop it was meant to prevent

### Likely Seam

`polling-scheduler.ts` is the coordination point. It must route to the correct adapter based on `trigger.provider`. The current code calls `pollGitLabMRs` directly -- this must become provider-aware dispatch.

---

## Philosophy Constraints

From `CLAUDE.md` (hard rules):

- **Errors are data** -- all public functions return `Result<T, E>`, never throw
- **Immutability by default** -- all types `readonly`, all interfaces use `readonly` fields
- **Make illegal states unrepresentable** -- the TODO in `types.ts` for discriminated union is exactly this principle; the union migration fulfills it
- **Validate at boundaries, trust inside** -- `trigger-store.ts` validates all fields at parse time; adapters receive already-validated config
- **Type safety as first line of defense** -- branded `TriggerId`, explicit `Result` types, type guards
- **Dependency injection for boundaries** -- `fetchFn` is injectable in `gitlab-poller.ts`; required for the GitHub adapter too
- **Prefer fakes over mocks** -- tests use `vi.fn().mockResolvedValue()` for fetch; maintain this pattern
- **YAGNI with discipline** -- no registry pattern (premature for 2 providers)

**Philosophy conflict:** The backlog example uses `excludeAuthors: "worktrain-*"` suggesting glob matching. The `CLAUDE.md` principle of determinism and the YAML parser's lack of glob support argue for exact string matching only. **Resolution:** exact string match for MVP; glob support is a documented TODO.

---

## Impact Surface

Files that must remain consistent:

- `src/trigger/types.ts` -- type shape changes here cascade to the assembler and scheduler
- `src/trigger/trigger-store.ts` -- `SUPPORTED_PROVIDERS`, `ParsedTriggerRaw.source`, assembly code
- `src/trigger/polling-scheduler.ts` -- `isPollingTrigger`, `buildWorkflowTrigger`, `doPoll` routing
- `tests/unit/trigger-store.test.ts` -- tests for `github_issues_poll` and `github_prs_poll` providers
- `tests/unit/gitlab-poller.test.ts` -- template; existing tests must continue to pass

No other files outside `src/trigger/` read `pollingSource` today.

---

## Candidates

### Candidate A: Minimal extension -- bare union type, if/else in scheduler

**Summary:** Add `GitHubPollingSource` to `types.ts` as a bare union (`pollingSource?: GitLabPollingSource | GitHubPollingSource`), add new providers to `SUPPORTED_PROVIDERS`, extend the `source:` parser, add `if/else` branches in `PollingScheduler.doPoll`.

**Tensions resolved:** Zero migration cost. No changes to existing narrowing code.

**Tensions accepted:** The discriminated union TODO is ignored. TypeScript cannot prevent a `GitLabPollingSource` being used with a `github_issues_poll` trigger at the assembled type level. Illegal states remain representable.

**Boundary solved at:** `polling-scheduler.ts` routing -- additive `if/else` only.

**Why this boundary:** Minimum change surface.

**Failure mode:** A future refactor could accidentally call `pollGitLabMRs` with a `GitHubPollingSource` because the compiler cannot distinguish them without the tag. Silent wrong behavior, not a compile error.

**Repo-pattern relationship:** Adapts existing pattern but ignores the explicit codebase TODO for discriminated union.

**Gains:** Zero migration cost, zero risk of breaking existing code.

**Losses:** Correctness guarantee at the type level. The codebase's own comment requests this migration.

**Impact surface:** `polling-scheduler.ts` only (additive). `types.ts` additive.

**Scope judgment:** Correct scope, but incomplete honoring of stated invariants.

**Philosophy fit:** Honors YAGNI. Violates "Make illegal states unrepresentable".

---

### Candidate B: Tagged union migration (RECOMMENDED)

**Summary:** Migrate `TriggerDefinition.pollingSource` to a discriminated union tagged by `provider`:

```ts
export type PollingSource =
  | (GitLabPollingSource & { readonly provider: 'gitlab_poll' })
  | (GitHubPollingSource & { readonly provider: 'github_issues_poll' })
  | (GitHubPollingSource & { readonly provider: 'github_prs_poll' });
```

`trigger-store.ts` assembler produces the tagged object (adds `provider` field to the assembled source). `polling-scheduler.ts` uses `switch(trigger.pollingSource.provider)` or typed `if/else` on `provider` to narrow. `github-poller.ts` is a pure function matching the GitLab adapter signature.

**Tensions resolved:** Discriminated union TODO fulfilled. Illegal states unrepresentable at the assembled type level. `switch` on `provider` is compiler-enforced exhaustive.

**Tensions accepted:** Small migration: ~20 lines of changes in existing files. The raw `ParsedTriggerRaw.source` type in `trigger-store.ts` is still an untagged bag of optional fields (the discrimination only applies after assembly, not during parsing).

**Boundary solved at:** `types.ts` (new union), `trigger-store.ts` (tagged assembly), `polling-scheduler.ts` (switch routing).

**Why this boundary is best fit:** The `types.ts` comment explicitly requests this migration at adapter #2. This IS adapter #2. Not doing it defers a known debt item.

**Failure mode:** If a future consumer outside `src/trigger/` reads `pollingSource` and was not updated during migration. Verified: no such consumer exists today.

**Repo-pattern relationship:** Directly follows what the codebase's own TODO comment requests. Mirrors `TriggerId` branded string: same philosophy of making types carry guarantees.

**Gains:** Compile-time guarantee that GitLab source never reaches the GitHub adapter. Exhaustive `switch` on provider. Clean type-level documentation of which sources exist.

**Losses:** ~20 lines of existing code must be updated. The `pollingSource` field shape changes.

**Impact surface:** `trigger-store.ts` assembler, `polling-scheduler.ts` narrowing, `types.ts`. No external consumers.

**Scope judgment:** Best-fit -- the TODO explicitly scopes this to adapter #2.

**Philosophy fit:** Honors "Make illegal states unrepresentable", "Type safety as first line of defense", "Exhaustiveness everywhere". Minor YAGNI tension (resolved by the existing TODO).

---

### Candidate C: Generic `PollingAdapter` interface with registry

**Summary:** Define `interface PollingAdapter<TItem, TSource>` with `poll(source: TSource, since: string, fetchFn?) => Result<TItem[], error>`. A registry `Map<string, PollingAdapter<unknown, unknown>>` holds all adapters. The scheduler looks up by `trigger.provider`. Adding a new provider = registering a new adapter; no scheduler changes.

**Tensions resolved:** Open/closed: adding providers requires zero scheduler changes. Perfect separation of concerns.

**Tensions accepted:** The registry carries `unknown` typed adapters. The scheduler must cast when building `WorkflowTrigger` context -- type safety lost at the registry boundary. Runtime invariant, not compile-time.

**Boundary solved at:** New `adapter-registry.ts`. Scheduler depends on registry, not specific adapters.

**Why this boundary:** Maximum extensibility for future providers.

**Failure mode:** A misregistered adapter (wrong source type registered under wrong provider key) silently produces wrong context at dispatch time. No compile-time catch.

**Repo-pattern relationship:** Departs from existing patterns. Codebase has no registry or DI container for adapters. Introduces a new abstraction not justified by existing use.

**Gains:** Maximum extensibility (Jira, Linear, Sentry adapters add zero scheduler code).

**Losses:** Type safety at the registry boundary. Complexity for 2 providers. Violates YAGNI and the explicit CLAUDE.md warning against speculative abstractions.

**Impact surface:** New `adapter-registry.ts`, changes to `polling-scheduler.ts`, new abstract type in `types.ts`.

**Scope judgment:** Too broad -- 2 providers do not justify a registry.

**Philosophy fit:** Violates YAGNI, violates "Type safety as first line of defense". Honors open/closed but prematurely.

---

## Comparison and Recommendation

**Recommendation: Candidate B (tagged union migration)**

| Dimension | A (minimal) | B (tagged union) | C (registry) |
|---|---|---|---|
| Illegal states representable | Yes (bug risk) | No (compile-time) | Partially (cast gap) |
| Migration cost | Zero | ~20 lines | High |
| Exhaustive narrowing | No | Yes | No |
| YAGNI | Honors | Minor (TODO overrides) | Violates |
| Consistent with TODO | No | Yes | No |
| Future extensibility | If/else grows | Union grows | Registry extends |

Candidate B is the correct choice for three reasons:

1. **The TODO is a commitment.** `types.ts` already says "TODO(follow-up): migrate to discriminated union at adapter #2." This is adapter #2. Skipping this is explicitly deferring committed technical debt.
2. **The migration cost is bounded.** `pollingSource` is only read inside `src/trigger/`. No external consumers. The ~20 lines of changes are confined to three files.
3. **The gain is real.** The `switch(pollingSource.provider)` pattern gives the TypeScript compiler full narrowing -- it is impossible to call `pollGitLabMRs` with a `GitHubPollingSource` after this change. Candidate A has no equivalent safety.

---

## Self-Critique

**Strongest argument against B:** The raw `ParsedTriggerRaw.source` type in `trigger-store.ts` is still an untagged bag of optional fields -- both `projectId` (GitLab) and `repo` (GitHub) fields exist in the same raw type. The discriminated union only applies after assembly. So the "illegal states unrepresentable" benefit does NOT apply during YAML parsing -- only after. Candidate A has identical parse-time behavior. The union migration adds safety only at dispatch time.

Counter-counter: dispatch time is where safety matters. The assembler is the parser boundary. After the assembler, the system should be able to trust the types -- that's where the discriminated union matters.

**Narrower option that almost works:** Candidate A with a runtime assertion in the scheduler: `assert(trigger.provider === 'gitlab_poll')` before calling `pollGitLabMRs`. But TypeScript structural typing means both source types share enough optional fields that the assert is not enforced by the compiler -- it's a runtime check, not a compile-time one.

**Broader option that might be justified:** Candidate C (registry), but only if 4+ providers are added within 6 months. At 2 providers, the registry is premature. Evidence required: 3+ new adapter types confirmed in the near-term roadmap.

**Pivot conditions:**
- If `pollingSource` is used outside `src/trigger/` in a future PR (expands migration scope)
- If the `excludeAuthors` exact-string match is insufficient for the WorkTrain bot naming convention (requires glob support)
- If the GitHub rate limit at 5000 req/hour proves insufficient for high-volume repos (requires backoff strategy)

---

## Open Questions for the Main Agent

1. **`excludeAuthors` matching**: Should it be exact string match (e.g., `worktrain-bot`) or glob pattern (e.g., `worktrain-*`)? The backlog example uses `worktrain-*`. Exact match is simpler and safer for MVP.

2. **`repo` field format**: Should it be `owner/repo` (single string, split at `/`) or two separate fields `owner` and `repo`? Single string `owner/repo` is consistent with how GitHub URLs work and matches the GitLab `projectId: namespace/project` pattern.

3. **Rate limit skip**: When `X-RateLimit-Remaining < 100`, should this be a `GitHubPollError` kind or a silent skip (log only)? The prompt says "skip the current cycle and log a warning" -- so log only, no error return. Confirm this matches desired behavior.

4. **`notLabels` documentation**: The pagination limitation means `notLabels` can silently miss items on busy repos. Should this be documented in the config schema comment, or is it acceptable as an implicit limitation?
