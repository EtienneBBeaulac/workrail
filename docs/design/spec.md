# Spec: Reviewer-Assigned MR Review with GitHub Draft Review Approval

## Feature summary

When a GitHub PR is assigned to the configured reviewer login, WorkTrain automatically runs a review session, creates a PENDING draft review under the operator's GitHub identity (invisible to the PR author until published), and sends a notification. The operator opens GitHub, edits or deletes individual findings in the native "Finish your review" panel, and publishes. Zero findings post without explicit operator action. WorkTrain records the submission in the session event log.

## Acceptance criteria

**AC1.** A `github_prs_poll` trigger with `reviewerIdentity` and `reviewerLogin` set dispatches a `wr.mr-review` session only for PRs where `requested_reviewers` contains the configured `reviewerLogin`. PRs without that login are not dispatched.

**AC2.** When the review session completes successfully and `lastStepArtifacts` contains a valid `wr.review_verdict`, WorkTrain calls `POST /repos/:owner/:repo/pulls/:number/reviews` with `event: PENDING` using `reviewerIdentity.githubToken`. The resulting draft review is invisible to the PR author.

**AC3.** Before creating the draft review, WorkTrain checks for an existing PENDING draft by the same login via `GET .../reviews`. If one exists, it uses that draft's `review_id` instead of creating a new one.

**AC4.** After draft review creation, a `pending-draft-<sessionId>.json` sidecar is written to `~/.workrail/daemon-sessions/` before any background polling begins.

**AC5.** A `PendingDraftReviewPoller` detects when the draft review transitions out of PENDING state within ≤60 seconds. On detection, a `review_draft_submitted` event is appended to the session event log and the pending-draft sidecar is deleted.

**AC6.** On daemon restart, `runStartupRecovery()` scans for `pending-draft-*.json` sidecars and restarts polling for any found.

**AC7.** A macOS notification fires immediately after draft review creation: "WorkTrain review draft ready on PR #N -- open in GitHub to review findings."

**AC8.** `reviewerIdentity.githubToken` is resolved from an environment variable (same `$ENV_VAR` syntax as `hmacSecret`) and is a separate field from `source.token`.

**AC9.** `branchStrategy: 'read-only'` in triggers.yml creates an isolated git worktree with the PR branch checked out (`--detach`) at `~/.workrail/worktrees/<sessionId>`, without creating a new branch. The session operates in this worktree.

**AC10.** After a `branchStrategy: 'read-only'` session completes (any outcome), `cleanupWorktreeStage` removes the worktree and `deleteSidecarStage` deletes the session sidecar -- same cleanup as `branchStrategy: 'worktree'`.

**AC11.** All new `TriggerDefinition` fields are parsed from triggers.yml. Unknown values for `branchStrategy` produce a clear parse error and the trigger is skipped (not silently ignored).

**AC12.** `npx vitest run` passes with no new test failures.

## Non-goals

- GitLab support (no PENDING draft review equivalent -- separate follow-on)
- Slack approval channel (requires external Slack app -- separate follow-on)
- wr.mr-review quality improvements (separate backlog item)
- GitHub App webhook for push-based submission detection (polling is sufficient)
- Fork PR support for `branchStrategy: 'read-only'` (follow-up ticket)

## External interface contract

**New `TriggerDefinition` fields (triggers.yml):**
```yaml
reviewerIdentity:
  githubToken: $GITHUB_TOKEN    # env-resolved
  githubLogin: etienneb

github_prs_poll:
  ...
  reviewerLogin: etienneb       # filter PRs by requested_reviewers

branchStrategy: read-only       # new value alongside 'worktree' | 'none'
```

**`WorkflowRunSuccess.lastStepArtifacts`** is already present -- no schema change.

**New `pending-draft-<sessionId>.json` sidecar shape:**
```json
{ "reviewId": "...", "prNumber": 42, "prRepo": "owner/repo", "sessionId": "...", "createdAt": "ISO8601" }
```

**New session event kind:** `review_draft_submitted` appended to the session event log on poller detection.

## Edge cases and failure modes

| Case | Expected behavior |
|------|------------------|
| PR has no `requested_reviewers` field | Filter drops the PR; no session dispatched |
| `POST /reviews` returns 422 (invalid position) | `createDraftReview` returns `err`; notification not sent; error logged |
| Existing PENDING draft found (AC3 dedup) | Existing `review_id` reused; no new POST; poller starts for existing draft |
| Daemon restarts after draft creation but before submission | Startup recovery reads sidecar, restarts poller |
| Draft is dismissed (not submitted) by the operator | Poller detects non-PENDING state; logs dismissal; deletes sidecar |
| `branchStrategy: 'read-only'` with fork PR | `git worktree add --detach` fails (fork branch not in origin); session fails with error result; trigger validation warning shown at load time |
| Session completes with `gate_parked` | `maybeRunPostWorkflowActions()` does NOT fire (gates on `result._tag === 'success'`) |
| `reviewerIdentity` absent from trigger | `maybeRunPostWorkflowActions()` does NOT fire; no draft created |

## Verification method per AC

| AC | Verification |
|----|-------------|
| AC1 | Unit test: github-poller `applyPRFilters()` drops PRs without matching login; passes PRs with matching login; passes all when `reviewerLogin` absent |
| AC2 | Unit test: trigger-router `maybeRunPostWorkflowActions()` calls `ReviewApprovalAdapter.createDraftReview()` on success+reviewerIdentity+wr.review_verdict; does NOT call on error/timeout/stuck/gate_parked |
| AC3 | Unit test: `GitHubReviewApprovalAdapter.createDraftReview()` returns existing `reviewId` when GET finds existing PENDING draft |
| AC4 | Unit test: `pending-draft-<sessionId>.json` written before poller `start()` is called |
| AC5 | Unit test: `PendingDraftReviewPoller` appends `review_draft_submitted` event and deletes sidecar when mock GET response shows submitted review |
| AC6 | Unit test: `runStartupRecovery()` with a pending-draft sidecar present restarts polling |
| AC7 | Unit test: `NotificationService.notify()` (or equivalent) called with draft-ready message after `createDraftReview()` succeeds |
| AC8 | Unit test: trigger-store parses `reviewerIdentity.githubToken: $MY_TOKEN` and resolves from injected env map |
| AC9 | Integration: `branchStrategy: 'read-only'` parsed from YAML without error; unknown value produces `invalid_field_value` error |
| AC10 | Unit test: `cleanupWorktreeStage` runs for `branchStrategy === 'read-only'`; `deleteSidecarStage` runs for `branchStrategy === 'read-only'` |
| AC11 | Unit test: `loadTriggerConfig` with `reviewerIdentity` and `reviewerLogin` fields parses correctly; `branchStrategy: unknown` produces error |
| AC12 | `npx vitest run` passes |
