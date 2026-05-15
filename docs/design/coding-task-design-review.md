# Design Review Findings: Reviewer-Assigned MR Review Implementation

## Tradeoff Review

| Tradeoff | Acceptable? | Failure condition | Hidden assumption |
|----------|-------------|-------------------|-------------------|
| Polling latency 30-60s for draft submission detection | Yes | PR merged within 60s of draft submission; review silently unrecorded | GitHub REST reflects state transitions within one poll interval |
| No GitLab support in v1 | Yes (explicit upstream out-of-scope) | GitLab-first deployment target | GitHub is primary platform |
| PendingDraftReviewPoller outside KeyedAsyncQueue | Yes | Rate limit competition if same PAT used for both polling and review API | reviewerIdentity.githubToken is a separate PAT from source.token |
| branchStrategy:read-only uses --detach (no local branch) | Yes | Fork PRs: fork branch not in origin's reflist; worktree add fails | All reviewed PRs originate from origin, not forks |
| No crash-recovery for PendingDraftReviewPoller state | **Partially** -- sidecar write mitigates this in PR3 | Daemon restart loses poller state; orphaned draft review on GitHub | Operator notices and manually submits draft if WorkTrain doesn't detect it |

## Failure Mode Review

| Failure mode | Handled? | Missing mitigation | Risk |
|-------------|----------|--------------------|------|
| GitHub API eventual consistency on requested_reviewers | Yes -- next poll cycle catches it | None needed | Low |
| Concurrent sessions creating two PENDING drafts on same PR | Partial -- 30s dedup helps within window | Pre-creation check: GET /reviews for existing PENDING draft by this login before POST | Medium |
| Daemon restart loses PendingDraftReviewPoller state | **Mitigated in PR3** -- write `pending-draft-<sessionId>.json` sidecar before starting poller; scan on startup recovery | Without sidecar: silent orphan | **HIGH without mitigation** |
| Fork PRs fail at worktree creation (--detach on fork branch) | No -- follow-up ticket | Fetch from fork remote before worktree add | Medium |
| GitHub PENDING draft API is session-level not account-level | No -- pre-implementation verification required | Verify before PR3; fallback to Candidate 5 (branch-merge) | **HIGHEST -- architectural** |
| Same PAT for polling and review (rate limit competition) | Partial -- documentation | Validation warning in validateTriggerStrict() if tokens match | Low |

## Runner-Up / Simpler Alternative Review

**From Candidate 5 (Branch-Merge), worth borrowing:**
- Permanent audit trail: when PendingDraftReviewPoller detects submission, append `review_draft_submitted` event to session event log (same as `delivery_recorded` from `recordCommitShasStage`). ~20 lines, included in PR3 scope.

**Simpler variant:** Skip the PendingDraftReviewPoller entirely for v1 -- create draft review + send macOS notification, no detection. Still satisfies C2 (draft is invisible until published), loses only the session event write-back. Valid scope reduction if GitHub API verification fails.

**Hybrid adopted:** Sidecar-before-poller (FM3 mitigation) + audit trail write-back (from runner-up) both included in PR3 scope. No structural change.

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Functional core / imperative shell | Satisfied -- agent produces artifact; post-workflow action posts it |
| Scripts-first coordinator | Satisfied -- agent never calls GitHub API |
| Zero LLM turns for routing | Satisfied -- draft creation gate is pure TypeScript check |
| Dependency injection for boundaries | Satisfied -- ReviewApprovalAdapter and fetchFn are injectable |
| Errors are data | Satisfied -- Result<T, E> throughout, no throws |
| Make illegal states unrepresentable | Satisfied -- `reviewerIdentity` presence IS the flag; no separate boolean |
| Validate at boundaries, trust inside | Satisfied -- resolveSecret() at parse time; plain string inside |

No risky tensions.

## Findings

### RED (must address before any code ships)

**R1: Verify GitHub PENDING draft REST API is account-level before writing PR3.**
The entire approval channel design depends on a PENDING draft review created via `POST .../reviews?event=PENDING` being visible in the operator's browser "Finish your review" panel. If GitHub ties draft reviews to API sessions rather than accounts, the approval UX breaks entirely. One test API call (`POST .../reviews` with `event: PENDING` on a real PR, then check the authenticated user's browser) resolves this before any code is written for PR3.

**R2: PendingDraftReviewPoller must write a sidecar before starting background polling.**
Without a `pending-draft-<sessionId>.json` sidecar written to `~/.workrail/daemon-sessions/` before the background poller starts, a daemon crash between draft creation and submission detection silently orphans the draft. This sidecar enables crash recovery (`runStartupRecovery()` scans for and restarts polling for orphaned entries). Must be in PR3 scope, not deferred.

### ORANGE (should address before shipping)

**O1: Pre-creation dedup check for concurrent review sessions on same PR.**
Two review sessions for the same PR (within or outside the 30s dedup window) will each call `POST .../reviews` creating two PENDING drafts under the same identity. GitHub's behavior for multiple pending drafts by the same user on the same PR is undocumented. Add a pre-creation check: `GET /pulls/:number/reviews` for an existing PENDING review by `reviewerLogin` before `POST`. If one exists, skip creation and start polling the existing draft instead.

**O2: Fork PR limitation must be documented at trigger validation time.**
`branchStrategy: 'read-only'` uses `git worktree add --detach origin/<prBranch>` which fails for PRs from forks (fork branch not in origin's reflist). Add a validation warning in `validateTriggerStrict()` noting the fork limitation. The failure mode is `invalid_field_value`-level: trigger should still load, but a `TriggerValidationIssue` with severity `'warning'` should surface in `worktrain trigger validate`.

### YELLOW (track, address in follow-up)

**Y1: Rate limit validation warning if reviewerIdentity.githubToken matches source.token.**
Same PAT for both polling and review API calls splits the 5000 req/hour budget unpredictably. Add a `TriggerValidationRule: 'reviewer-identity-token-same-as-source'` warning.

**Y2: Startup recovery for orphaned pending draft reviews.**
On daemon start, scan `~/.workrail/daemon-sessions/` for `pending-draft-*.json` sidecars and restart polling for any that exist and have not yet been submitted. Depends on R2 (sidecar exists).

**Y3: GitLab ReviewApprovalAdapter variant.**
Blocked on GitLab having no direct PENDING draft equivalent. Console approval panel or branch-merge as the GitLab path, routed via `ReviewApprovalAdapter` interface. Post-v1.

## Recommended Revisions

1. **R1 must be done before PR3 is written.** If the API verification fails, the fallback is Candidate 5 (branch-merge as approval signal) -- same PR1 and PR2, different PR3.
2. **R2 is in PR3 scope, not a follow-up.** The sidecar write is ~20 lines and the crash-recovery scan hook is another ~30 lines in `runStartupRecovery()`.
3. **O1 (pre-creation dedup check) is in PR3 scope.** The check is a single `GET /reviews` call before the `POST` -- ~15 lines in `ReviewApprovalAdapter.createDraftReview()`.
4. **The audit trail write-back (session event on submission) is in PR3 scope.** Borrowed from the runner-up, ~20 lines.
5. **`autoPostDraftReview` boolean flag is NOT added.** The presence of `reviewerIdentity` is the feature flag. This eliminates one potential illegal state combination.

## Residual Concerns

- The YAML parser's hand-rolled sub-object parsing for `reviewerIdentity` must follow the `agentConfig` pattern exactly (indented-block scanning). A deviation silently drops the field without error. The implementation must be tested with `trigger-store.test.ts` patterns.
- `assertNever(result)` exhaustiveness in both `route()` and `dispatch()` must be verified after any changes to `WorkflowRunResult` -- no new variants are added in this feature, but the switch blocks must be audited to confirm the new `maybeRunPostWorkflowActions()` call site is in the right position relative to `assertNever`.
- `cleanupWorktreeStage` and `deleteSidecarStage` guards widened to `|| branchStrategy === 'read-only'` -- must be audited in both places or read-only session cleanup never runs.
