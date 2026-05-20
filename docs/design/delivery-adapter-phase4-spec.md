# Delivery Adapter Phase 4 -- Spec

## Feature Summary

Operators can configure GitHub draft review delivery via the `delivery:` YAML block in `triggers.yml`, using `delivery: { kind: github_draft_review, token: $TOKEN, login: mylogin }`. When this explicit config is present, it replaces the legacy `reviewerIdentity` field for review posting. The legacy path continues to work for triggers that have not migrated.

## Acceptance Criteria

1. A trigger with `delivery: { kind: github_draft_review, token: $TOKEN, login: user }` posts a GitHub PENDING draft review after a successful `wr.mr-review` session without `reviewerIdentity` configured.

2. The existing `reviewerIdentity` delivery path works unchanged for triggers that have not added a `delivery:` block.

3. When a trigger has both `reviewerIdentity` and an explicit `delivery:` block configured on the same `WorkflowTrigger`, a deprecation warning is emitted per session to stderr.

4. A trigger with `delivery: { kind: github_draft_review }` but missing `token:` or `login:` is rejected at config load time with a parse error and skipped.

5. `tsc --noEmit` passes clean and all existing tests pass.

## Non-Goals

- Git commit delivery via `delivery:` block (Phase 5)
- Slack webhook delivery (Phase 5+)
- GitLab MR note delivery (Phase 5+)
- Removing `reviewerIdentity` from `WorkflowTrigger` (Phase 5)
- Delivery for sessions started via `dispatch()` (Phase 5)

## External Interface

New `triggers.yml` syntax:
```yaml
triggers:
  - id: mr-review
    provider: github_prs_poll
    workflowId: wr.mr-review
    branchStrategy: read-only
    delivery:
      kind: github_draft_review
      token: $GITHUB_REVIEWER_TOKEN
      login: mylogin
```

`$TOKEN` syntax resolves from the daemon environment (same as `reviewerIdentity.token`).

## Edge Cases and Failure Modes

- `delivery: { kind: github_draft_review }` without `token:` or `login:` → parse error at config load, trigger skipped
- Explicit delivery but `workflowTrigger.context` lacks `itemNumber` / `itemUrl` (non-PR workflow) → `deliver()` returns `{ kind: 'error' }`, warning logged, session completes normally
- Daemon crashes between sidecar write and poller start → startup recovery restarts the poller from the sidecar (same as existing `reviewerIdentity` behavior)
- Both `reviewerIdentity` and `delivery:` configured → explicit `delivery:` wins; deprecation warning emitted per session

## Verification

| AC | Verification method |
|---|---|
| 1 | Integration test: TriggerRouter with explicit github_draft_review config creates draft review (fake ReviewApprovalAdapter) |
| 2 | All existing reviewerIdentity trigger-router tests pass unchanged |
| 3 | Unit test: router emits warning when both fields set; no warning when only one |
| 4 | trigger-store test: parse error on missing token/login |
| 5 | `tsc --noEmit` + `npx vitest run` |
