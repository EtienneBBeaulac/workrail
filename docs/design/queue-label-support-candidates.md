# Design Candidates: Label-Based Queue Filter for github_queue_poll

## Problem Understanding

### Tensions
1. **Trigger YAML config vs runtime config.json**: `queueType`/`queueLabel` appear in triggers.yml (per-trigger), but `GitHubQueueConfig` is loaded from `~/.workrail/config.json` (global daemon-level config). Both need to converge on the same data at poll time. The test surface validates at the poller level, which takes a `GitHubQueueConfig` directly - meaning the poller just needs to handle label type correctly, regardless of which source built the config.

2. **Additive field vs type-safe discriminated union**: Adding `queueLabel?: string` (optional) to `GitHubQueueConfig` makes the illegal state (`type==='label'` without `queueLabel`) detectable only at load time. A discriminated union would catch it at compile time. The 3-file scope constraint makes the discriminated union approach infeasible.

3. **Existing `name?` field vs new `queueLabel?` field**: `GitHubQueueConfig` already has `name?: string` (read from `q['name']` in `loadQueueConfig()`). Adding `queueLabel?` alongside it creates two optional label fields. This is a naming inconsistency from an earlier design iteration.

### Likely Seam
`pollGitHubQueueIssues()` in `github-queue-poller.ts` - the URL construction is where the actual behavior diverges between filter types.

### What Makes This Hard
- The existing test at line 126 (`returns not_implemented for non-assignee queue type`) tests that label returns `not_implemented`. After this change, label with `queueLabel` succeeds. This test must be replaced, not kept alongside new tests.
- `polling-scheduler.ts` has a guard at line 393 that still checks `queueConfig.type !== 'assignee'` - this file is out of scope. The scheduler will remain blocking for label type from config.json after our changes. Tests at the poller unit level bypass the scheduler.

## Philosophy Constraints

From `CLAUDE.md` and repo patterns:
- **Result types, no throws**: all boundary functions return `Result<T, E>`. `err({ kind: 'not_implemented', ... })` is the established pattern for unimplemented branches.
- **Validate at boundaries**: `loadQueueConfig()` must return `err` if `type === 'label'` and `queueLabel` is absent.
- **Immutability by default**: new fields must be `readonly`.
- **YAGNI**: no mention/query stubs, no new abstractions.
- **Make illegal states unrepresentable**: satisfied at load time by validation; compile-time enforcement would require discriminated union (out of scope).

No philosophy conflicts in this case.

## Impact Surface

- `polling-scheduler.ts` line 393: guard `queueConfig.type !== 'assignee'` remains. Out of scope. Label type from config.json will still be blocked by the scheduler even after our changes. This is an intentional stepping stone.
- `tests/unit/github-queue-poller.test.ts` line 126: existing test must be replaced/updated (not just added to).
- `src/trigger/types.ts`: `GitHubQueuePollingSource` needs `queueType?`/`queueLabel?` fields to store trigger YAML values. Not restricted by scope.

## Candidates

### Candidate 1: Additive optional field + load-time validation + poller branch (SELECTED)

**Summary**: Add `readonly queueLabel?: string` to `GitHubQueueConfig`, validate it in `loadQueueConfig()` (err if `type==='label'` and `queueLabel` absent), add `labels=` branch in `pollGitHubQueueIssues()`, parse `queueType`/`queueLabel` in trigger-store, extend `GitHubQueuePollingSource` in types.ts.

**Tensions resolved**: Label config is validated at load time; assignee path unchanged; no new abstractions.
**Tension accepted**: `name?` field remains alongside `queueLabel?` (minor naming inconsistency).
**Boundary**: `pollGitHubQueueIssues()` for URL construction; `loadQueueConfig()` for validation.
**Failure mode**: Forgetting to update the existing `not_implemented` test for label type. The test at line 126 will fail if not replaced.
**Repo pattern**: Follows exactly - mirrors how `user?` is handled for assignee type.
**Gain**: Minimal change surface, no breaking changes.
**Give up**: `name?` naming inconsistency stays.
**Scope**: best-fit.
**Philosophy fit**: Honors validate-at-boundaries, immutability, YAGNI, Result types.

### Candidate 2: Discriminated union for GitHubQueueConfig (type-safe)

**Summary**: Refactor `GitHubQueueConfig` into `AssigneeQueueConfig | LabelQueueConfig | MentionQueueConfig | QueryQueueConfig` so `queueLabel` is `string` (not optional) in `LabelQueueConfig`.

**Tensions resolved**: Makes illegal states unrepresentable at compile time.
**Tension accepted**: Breaks all existing callers; touches files outside scope.
**Boundary**: Entire `GitHubQueueConfig` interface plus all callers.
**Failure mode**: Cascading type errors in polling-scheduler.ts and tests.
**Repo pattern**: Departs - no discriminated union for config types in this codebase.
**Gain**: Compile-time safety.
**Give up**: Simplicity, scope compliance.
**Scope**: too broad.
**Philosophy fit**: Honors make-illegal-states-unrepresentable but conflicts with YAGNI and scope constraint.

## Comparison and Recommendation

**Selected: Candidate 1.**

All acceptance criteria are satisfied at minimum change surface. Load-time validation in `loadQueueConfig()` catches the illegal state (`type==='label'` without `queueLabel`) before any poll cycle runs. The `pollGitHubQueueIssues()` change is purely additive - the assignee branch is unchanged.

## Self-Critique

**Strongest counter-argument**: The `name?` field in `GitHubQueueConfig` was the original design for label support. Adding `queueLabel?` alongside it creates two ways to express the same concept. The cleaner fix would remove `name?` and replace it, but that's a breaking change to anyone who already uses `config.name` in code paths we're not touching (polling-scheduler at line 471 uses `queueConfig.type` but not `queueConfig.name`).

**Pivot conditions**: If end-to-end testing (not just unit tests) is required, we'd need to update `polling-scheduler.ts` too. That's out of scope per the task description.

**Invalidating assumption**: If `polling-scheduler.ts` is required for the feature to work at all, then the scope restriction is wrong. But the task explicitly says to verify with unit tests at the poller level.

## Open Questions for the Main Agent

1. Should the `name?` field be deprecated or removed? The task says add `queueLabel?` - leaving `name?` creates naming confusion. Recommend leaving it as-is and not removing it (YAGNI, out of scope).
2. Should `GitHubQueuePollingSource` in `types.ts` gain `queueType?`/`queueLabel?` fields? Yes - trigger-store.ts parses them from YAML and needs somewhere to store them.
