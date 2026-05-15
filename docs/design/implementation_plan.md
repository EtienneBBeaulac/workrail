# Implementation Plan: Reviewer-Assigned MR Review with GitHub Draft Review Approval

**Last revised:** Post-audit pass (blocking gaps addressed)

## 1. Problem statement

When assigned as reviewer on a GitHub PR, an engineer must context-switch to review it manually. WorkTrain should detect the assignment, run a deep review autonomously, create a PENDING GitHub draft review under the operator's identity (invisible to the PR author), notify the operator, and let them publish/edit/delete findings via GitHub's native "Finish your review" UI. Zero findings post without explicit operator action.

## 2. Acceptance criteria

See `spec.md` (canonical). Summary:
- AC1: reviewer-assignment filter in `github_prs_poll`
- AC2: draft review created on success + reviewerIdentity + wr.review_verdict
- AC3: pre-creation dedup check (GET before POST + in-process mutex)
- AC4: pending-draft sidecar written before poller starts
- AC5: poller detects submission, appends session event, deletes sidecar
- AC6: startup recovery restarts polling (requires triggerId in sidecar + trigger index passed to recovery)
- AC7: macOS notification after draft creation
- AC8: githubToken env-resolved from $ENV_VAR
- AC9: branchStrategy:read-only creates isolated worktree --detach
- AC10: cleanup stages run for branchStrategy:read-only
- AC11: new TriggerDefinition fields parse correctly
- AC12: `npx vitest run` passes

## 3. Non-goals

- GitLab support (separate follow-on)
- Slack approval channel (separate follow-on)
- wr.mr-review v3 quality overhaul (separate backlog item)
- Model-tier dispatch in spawn_agent (separate backlog item)
- Fork PR support for branchStrategy:read-only (follow-up ticket)

## 4. Philosophy-driven constraints

- **[PHILOSOPHY]** `maybeRunPostWorkflowActions()` is separate from `maybeRunDelivery()` -- different gate conditions, different code path
- **[PHILOSOPHY]** GitHub draft creation is deterministic infrastructure -- agent never calls GitHub API
- **[PHILOSOPHY]** `reviewerIdentity` presence is the feature flag -- no separate boolean
- **[PHILOSOPHY]** `PendingDraftReviewPoller.start()` is called fire-and-forget (not awaited) in the queue callback -- same pattern as gate evaluation in the existing `gate_parked` branch
- **[CONVENTION]** New `TriggerDefinition` fields: all 4 parser locations (ParsedTriggerRaw, main loop `if (key === ...)` branch with bespoke sub-object scanner, validateAndResolveTrigger assembly, TriggerDefinition interface). NOT in `setTriggerField()` -- sub-objects are handled by `if (key ===)` branches, not the scalar switch.
- **[CONVENTION]** `branchStrategy: 'read-only'` requires widening in: `TriggerDefinition`, `WorkflowTrigger`, parser allowed-value check (~line 1043), `autocommit-needs-worktree` validation rule, cleanup guards in delivery-pipeline.ts. New `TriggerValidationRule`: `'read-only-with-autocommit'`.
- **[CONVENTION]** `pending-draft-*.json` sidecars must be explicitly excluded in `readAllDaemonSessions()` filter (same pattern as `queue-issue-` exclusion at line 114).
- **[CONVENTION]** `review_draft_submitted` event kind requires: new entry in `EVENT_KIND` (constants.ts), new schema in `DomainEventV1Schema` (schemas/session/events.ts), design lock update per lock comment.
- **[CONVENTION]** `maybeRunPostWorkflowActions()` receives `originalResult` (pre-delivery_failed reassignment), same as `maybeRunDelivery()`. Must be called in BOTH `route()` AND `dispatch()` -- polling triggers use `dispatch()`.
- **[TEAM_RULE]** `assertNever(result)` in both `route()` and `dispatch()` must be audited.

## 5. Invariants

1. Zero findings post without explicit operator approval
2. `lastStepArtifacts` already on `WorkflowRunSuccess` -- no schema change
3. `reviewerIdentity.githubToken` must be a separate PAT from `source.token`
4. Sidecar written BEFORE poller starts, deleted after submission
5. Pre-creation check: GET + in-process mutex between GET and POST to close race window
6. All `ReviewApprovalAdapter` methods return `Result<T,E>` -- no throws
7. `branchStrategy: 'read-only'` sessions: cleanup runs in `finalizeSession()` via worktree removal (not via delivery pipeline stages), because no delivery pipeline runs for non-autoCommit sessions

## 6. Selected approach

Same as before. Three PRs. GitHub PENDING draft review as approval channel.

**Pre-implementation verification (before PR3):** Verify `POST /reviews` with `event: PENDING` appears in the operator's browser. One API call.

**Startup recovery approach (revised after audit):**
Add `triggerId: string` to the pending-draft sidecar. Pass the loaded trigger index to `runStartupRecovery()` as a new optional parameter (pattern: same as other optional injectable parameters). On startup, for each pending-draft sidecar, look up the trigger by `triggerId` to get `reviewerIdentity.githubToken`, then restart the poller. If the trigger no longer exists in the index (trigger was removed), log a warning and delete the sidecar.

**`review_draft_submitted` event (revised after audit):**
This is a v2 domain event. Must add to `EVENT_KIND`, define a schema (`{ sessionId: string; reviewId: string; prUrl: string; submittedAt: string }`), and add to `DomainEventV1Schema` union. This work belongs in PR3 scope.

**Alternative if the domain event is too heavy:** Store submission state in the pending-draft sidecar only (update `submittedAt` field instead of deleting) and skip the session event log write. Simpler but loses console visibility. Decision: use the domain event (consistency with delivery_recorded pattern).

## 7. Vertical slices

### Slice 1 (PR1): Post-workflow action pathway + reviewerIdentity infrastructure

**Files changed:**
- NEW `src/trigger/review-approval-adapter.ts`:
  - `ReviewApprovalAdapter` interface: `createDraftReview(opts): Promise<Result<{reviewId: string}, ReviewApprovalError>>` and `pollForSubmission(opts): Promise<Result<ReviewSubmitted, ReviewApprovalError>>`
  - `GitHubReviewApprovalAdapter` implementation (injectable `fetchFn`)
  - `creatingReviewPRs = new Set<string>()` for in-process mutex (keyed by `${repo}#${prNumber}`)
- `src/trigger/types.ts`: add `reviewerIdentity?: { readonly githubToken: string; readonly githubLogin: string }` to `TriggerDefinition`; add new `TriggerValidationRule` IDs
- `src/trigger/trigger-store.ts`: add `if (key === 'reviewerIdentity')` branch in main parse loop with bespoke 2-key sub-object scanner; `resolveSecret()` for `githubToken`; all 4 parser locations
- `src/trigger/trigger-router.ts`: new `maybeRunPostWorkflowActions()` function; call from BOTH `route()` AND `dispatch()` callbacks after result switch; receives `originalResult`; calls `createDraftReview()` (awaited), then fires `PendingDraftReviewPoller.start()` as fire-and-forget (void); explicit `console.warn` when `wr.review_verdict` absent from artifacts

**Key spec for `maybeRunPostWorkflowActions()`:**
- Gates: `originalResult._tag === 'success'` AND `trigger.reviewerIdentity !== undefined` AND `parseReviewVerdictArtifact(originalResult.lastStepArtifacts)` returns non-null
- Explicit `console.warn` when artifacts present but `wr.review_verdict` absent (separate from warn when `lastStepArtifacts` undefined)
- In `dispatch()`: `TriggerDefinition` is not available (dispatch receives `WorkflowTrigger`), so `WorkflowTrigger` needs a `reviewerIdentity` field mirroring the one on `TriggerDefinition`. Trigger-router passes it through when constructing the `WorkflowTrigger` from the `TriggerDefinition`.

**Done when:** trigger-store unit tests parse `reviewerIdentity` correctly; trigger-router unit tests confirm fires on success+reviewerIdentity+verdict, does NOT fire on error/timeout/stuck/gate_parked; `npx vitest run` passes.

---

### Slice 2 (PR2): Reviewer assignment detection + prBranch threading + branchStrategy:read-only

**Files changed:**
- `src/trigger/adapters/github-poller.ts`:
  - Add `readonly head: { readonly ref: string }` to `GitHubPR` type
  - Update `isGitHubPRShape()` type guard to include `head.ref`
  - Add `reviewerLogin` filter in `applyPRFilters()`
- `src/trigger/polling-scheduler.ts`:
  - Add `prBranch: string` to the context injected by `buildGitHubWorkflowTrigger()` (sourced from `pr.head.ref`)
- `src/trigger/types.ts`:
  - Add `reviewerLogin?: string` to `GitHubPollingSource`
  - Add `'read-only'` to `branchStrategy` union on `TriggerDefinition`
  - Add `TriggerValidationRule: 'read-only-with-autocommit'`
- `src/trigger/trigger-store.ts`:
  - Parse `source.reviewerLogin` scalar
  - Add `'read-only'` to allowed `branchStrategy` values (line ~1043)
  - Add `'read-only-with-autocommit'` validation rule in `validateTriggerStrict()`
- `src/daemon/types.ts`:
  - Add `'read-only'` to `WorkflowTrigger.branchStrategy` union
- `src/daemon/runner/pre-agent-session.ts`:
  - New `'read-only'` branch: `git worktree add <path> --detach origin/<prBranch>` where `prBranch` comes from `trigger.context.prBranch`
  - Cleanup for `'read-only'`: call `git worktree remove --force` in `finalizeSession()` for both `'worktree'` and `'read-only'` strategies, regardless of result (no delivery pipeline runs for `'read-only'`)
- `src/trigger/delivery-pipeline.ts`:
  - Widen `cleanupWorktreeStage` guard to include `'read-only'` (belt-and-suspenders -- actual cleanup for read-only is in finalizeSession, but delivery pipeline cleanup should also fire)
  - Widen `deleteSidecarStage` guard similarly
- `src/daemon/startup-recovery.ts`:
  - Exclude `pending-draft-*.json` from `readAllDaemonSessions()` filter (line 114 pattern)

**Note on `sidecardLifecycleFor`:** For `'read-only'` strategy with `success`, the sidecar lifecycle should be `delete_now` (not `retain_for_delivery`). Confirm the existing logic `branchStrategy === 'worktree' ? 'retain_for_delivery' : 'delete_now'` correctly produces `delete_now` for the new `'read-only'` value (it should, since the condition is strict equality), but audit this explicitly.

**Done when:** github-poller tests confirm reviewerLogin filter; trigger-store tests parse `source.reviewerLogin`; `branchStrategy: 'read-only'` parses without error; `unknown-value` produces error; worktree cleanup tests for `'read-only'` sessions; `npx vitest run` passes.

---

### Slice 3 (PR3): PendingDraftReviewPoller + domain event + startup recovery

**Pre-condition:** GitHub PENDING draft REST API verified as account-level.

**Files changed:**
- NEW `src/trigger/pending-draft-review-poller.ts`:
  - `PendingDraftReviewPoller` class following `PollingScheduler` pattern
  - `start()`: polls `GET /repos/:owner/:repo/pulls/:number/reviews` every 30-60s for `reviewId` out of PENDING state; on detection appends domain event; deletes sidecar; calls `stop()`
  - `stop()`: calls `clearInterval()`; safe to call before `start()` (no-op)
- `src/v2/durable-core/constants.ts`: add `REVIEW_DRAFT_SUBMITTED: 'review_draft_submitted'` to `EVENT_KIND`
- `src/v2/durable-core/schemas/session/events.ts`: add `ReviewDraftSubmittedEventSchema` to `DomainEventV1Schema` union
- `src/daemon/startup-recovery.ts`:
  - Add optional `triggerIndex?: ReadonlyMap<string, TriggerDefinition>` parameter
  - Add `clearPendingDraftSidecars()` scan function (analogous to `clearQueueIssueSidecars`)
  - For each `pending-draft-*.json` sidecar: look up `triggerId` in `triggerIndex`; if found, restart poller with token from trigger; if not found, log warning and delete sidecar
- `src/trigger/trigger-listener.ts`: pass trigger index to `runStartupRecovery()` when calling it at daemon start
- **Sidecar shape (revised):** `{ reviewId: string; prNumber: number; prRepo: string; sessionId: string; createdAt: string; triggerId: string }`

**Done when:** `PendingDraftReviewPoller` unit tests cover polling loop, submission detection, sidecar lifecycle, session event write-back; startup recovery test confirms orphaned pending-draft sidecars restart polling; domain event appends and loads correctly from session store; `npx vitest run` passes.

## 8. Test design

**New test files:**
- `tests/unit/review-approval-adapter.test.ts`
- `tests/unit/pending-draft-review-poller.test.ts`

**Extend:**
- `tests/unit/trigger-store.test.ts` -- reviewerIdentity parsing; source.reviewerLogin; branchStrategy:read-only; unknown branchStrategy error
- `tests/unit/github-poller.test.ts` -- reviewerLogin filter; head.ref presence in context
- `tests/unit/trigger-router.test.ts` -- maybeRunPostWorkflowActions fires/not-fires; originalResult used; present in both route() and dispatch() callbacks
- `tests/unit/delivery-pipeline*.test.ts` -- cleanup guards for 'read-only'

## 9. Risk register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| GitHub PENDING draft API session-level not account-level | CRITICAL | Pre-implementation API verification. Fallback: Candidate 5. |
| Startup recovery token unavailable if triggerId not in sidecar | HIGH | Add triggerId to sidecar; pass trigger index to runStartupRecovery(). In PR3 scope. |
| GET-then-POST race for concurrent same-PR sessions | MEDIUM | In-process mutex (`creatingReviewPRs` Set) in GitHubReviewApprovalAdapter. In PR3 scope. |
| Fork PRs fail at branchStrategy:read-only | MEDIUM | Validation warning at load time; follow-up ticket. |
| `review_draft_submitted` event breaks session log if schema not updated | HIGH | Add to DomainEventV1Schema. In PR3 scope. |
| prBranch not available to pre-agent-session.ts | HIGH | Thread via context from polling adapter. In PR2 scope. |

## 10. PR packaging strategy

**PR1:** ReviewApprovalAdapter + reviewerIdentity + maybeRunPostWorkflowActions
**PR2:** Reviewer assignment detection + prBranch threading + branchStrategy:read-only + cleanup
**PR3 (after API verification):** PendingDraftReviewPoller + domain event + startup recovery

## 11. Follow-up tickets

1. Verify GitHub PENDING draft REST API account-level behavior (pre-PR3 blocker)
2. Fork PR support for branchStrategy:read-only
3. Rate limit validation warning if reviewerIdentity token matches source token
4. GitLab ReviewApprovalAdapter variant

## Plan confidence: Medium

One unresolved unknown remains: GitHub PENDING draft REST API behavior. PR1 and PR2 are unaffected.
