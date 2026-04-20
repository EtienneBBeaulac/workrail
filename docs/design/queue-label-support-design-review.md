# Design Review: Label-Based Queue Filter for github_queue_poll

## Tradeoff Review

**T1: `name?` stays alongside `queueLabel?`**
- Acceptable. Load-time validation in `loadQueueConfig()` requires `queueLabel` when `type==='label'`. A user who writes `"name": "my-label"` in config.json gets an error at load time (queueLabel absent), not a silent failure.
- Fails if: user somehow bypasses `loadQueueConfig()` and constructs `GitHubQueueConfig` directly with `name` but not `queueLabel`. Poller returns `not_implemented` (else branch). Acceptable - direct construction is a test-only pattern.

**T2: `polling-scheduler.ts` guard remains blocking**
- Acceptable within task scope. Unit tests validate at the poller level. End-to-end production use requires a follow-up PR to update the scheduler guard. Document in PR description.
- Fails if: task author requires end-to-end production functionality. Risk level: medium for production, zero for acceptance criteria.

**T3: Optional `queueLabel?` (not required at type level)**
- Acceptable. Mitigated by load-time validation. The `pollGitHubQueueIssues` else branch returns `not_implemented` if `queueLabel` is absent, which is correct defensive behavior.

## Failure Mode Review

**FM1 (highest risk): Existing test at line 126 must be replaced**
- Test currently expects `not_implemented` for `{type: 'label', name: 'my-label'}`.
- After change: test will fail. Must replace with: (a) label success test, (b) label missing-queueLabel error test, (c) assignee regression test.
- Mitigation: explicit action in implementation plan.

**FM2: URL encoding**
- Handled automatically by `URLSearchParams.set()` (established pattern in codebase).

**FM3: GitHub API filter behavior**
- Not our responsibility. Tests verify the URL contains the correct `labels=` param.

**FM4: Scheduler guard**
- Filed as known limitation (T2 above). Document in PR.

## Runner-Up / Simpler Alternative Review

- Discriminated union: more type-safe but requires files outside scope. Nothing worth borrowing.
- Skipping trigger-store changes: fails acceptance criteria. Not viable.
- Skipping types.ts extension: TypeScript would flag unused parsed values. Necessary.

## Philosophy Alignment

- Result types: satisfied throughout
- Validate at boundaries: satisfied - `loadQueueConfig()` validates label requires `queueLabel`
- Immutability: satisfied - all new fields are `readonly`
- YAGNI: satisfied - no new abstractions
- Make illegal states unrepresentable: partially satisfied (load-time, not compile-time). Accepted tension.

## Findings

**YELLOW - polling-scheduler.ts guard**: Feature works at unit test level but not in production. The scheduler guard at line 393 (`queueConfig.type !== 'assignee'`) will still block label-type configs. This is a known, accepted, out-of-scope issue. Document in PR.

**YELLOW - test replacement**: The test at line 126 uses `{type: 'label', name: 'my-label'}` and expects `not_implemented`. This test MUST be replaced or it will fail after the change. High likelihood of causing CI failure if missed.

No RED findings.

## Recommended Revisions

1. In implementation: replace test at line 126 with three new tests (label success, label missing queueLabel, assignee regression).
2. In PR description: note that `polling-scheduler.ts` guard is a follow-up item.

## Residual Concerns

- `name?` field in `GitHubQueueConfig` is now superseded by `queueLabel?`. Future cleanup: remove `name?` and update any remaining references. Out of scope for this PR.
- No other residual concerns.
