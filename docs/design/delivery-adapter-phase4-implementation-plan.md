# Delivery Adapter Phase 4 -- Implementation Plan

**Scope:** GitHubDraftReviewAdapter + YAML delivery: sub-fields + route() dispatch + deprecation warning.

---

## Problem Statement

Operators cannot configure GitHub draft review delivery via the `delivery:` YAML block -- they must use the legacy `reviewerIdentity` field. There is no path to switch review delivery to a different channel (Slack, GitLab) without editing workflow definitions.

## Acceptance Criteria

1. A trigger with `delivery: { kind: github_draft_review, token: $TOKEN, login: user }` posts a GitHub PENDING draft review after a successful mr-review session, with no `reviewerIdentity` field required.
2. The existing `reviewerIdentity` path continues to work unchanged for triggers that haven't migrated.
3. When both `reviewerIdentity` and an explicit `deliveryConfig` are set on `WorkflowTrigger`, a deprecation warning is emitted per session (not at startup).
4. `tsc --noEmit` passes clean.
5. All existing trigger-router and trigger-store tests pass.

## Non-Goals

- GitCommitAdapter (Phase 5)
- Generalized pending-delivery-*.json sidecar format (Phase 5)
- Slack/GitLab adapters (Phase 5+)
- dispatch() path delivery (Phase 5)
- Removing maybeRunPostWorkflowActions() (Phase 5)
- Removing reviewerIdentity from WorkflowTrigger (Phase 5)

## Philosophy-Driven Constraints

- Sidecar MUST be written before adapter.deliver() is called -- crash recovery depends on it
- GitHubDraftReviewAdapter wraps GitHubReviewApprovalAdapter -- no reimplementation of posting logic
- deliver() must never throw -- errors flow as DeliveryReceipt { kind: 'error' }
- prContext comes from workflowTrigger.context (itemNumber/itemUrl), not TriggerDefinition
- Migration not replacement -- explicit source guard gates activation

## Invariants

- writePendingDraftSidecar() called before GitHubDraftReviewAdapter.deliver() returns 'pending'
- maybeRunPostWorkflowActions() is skipped for triggers with deliveryConfig.source === 'explicit' AND kind is github_draft_review (mutually exclusive)
- validateTriggerStrict() sync invariant: any new hard errors in validateAndResolveTrigger() must be mirrored
- All existing pending-draft-*.json sidecars continue to be recovered by recoverPendingDraftPollers()

---

## Selected Approach

**Slice 1:** `GitHubDraftReviewAdapter` in `src/trigger/delivery-adapter.ts`
- Wraps `GitHubReviewApprovalAdapter`
- `deliver()` returns `{ kind: 'pending'; pollHandle }` after writing sidecar + starting poller
- `pollHandle.state` = `{ daemonSessionId, prNumber, prRepo, login, token, workrailSessionId? }`
- Requires `prContext` in `DeliveryPayload` -- add optional `prContext?: { prNumber: number; prRepo: string; prUrl: string }`

**Slice 2:** Extend YAML `delivery:` block parser in `trigger-store.ts`
- Add `token?` and `login?` sub-fields to `ParsedTriggerRaw.delivery`
- Assembly in `validateAndResolveTrigger()`: resolve `$SECRET_NAME` for token, validate required fields for github_draft_review kind, build full `AdapterConfig`

**Slice 3:** route() dispatch in `trigger-router.ts`
- After the existing cli_inbox dispatch block, add github_draft_review case
- Populate `prContext` from `workflowTrigger.context.itemNumber` + `itemUrl`
- Call `writePendingDraftSidecar()` THEN `this._githubDraftAdapter.deliver(payload, config)`
- Skip `maybeRunPostWorkflowActions()` when `deliveryConfig.source === 'explicit'`
- Inject `GitHubDraftReviewAdapter` into `TriggerRouterOptions`

**Slice 4:** Deprecation warning
- In route() queue callback: if `workflowTrigger.reviewerIdentity !== undefined && workflowTrigger.deliveryConfig?.source === 'explicit'`, emit `console.warn` once per session

---

## Vertical Slices

### Slice 1: GitHubDraftReviewAdapter

Files: `src/trigger/delivery-adapter.ts`

- Add `prContext?: { prNumber: number; prRepo: string; prUrl: string }` to `DeliveryPayload`
- Add `GitHubDraftReviewAdapter implements DeliveryAdapter<'github_draft_review'>`:
  - Constructor: `(adapter: ReviewApprovalAdapter, sessionsDir: string, ctx: V2ToolContext)`
  - `deliver()`: extracts prNumber/prRepo/login/token from config + prContext, calls `createDraftReview()`, writes sidecar, starts poller, returns `{ kind: 'pending', pollHandle }`
  - On missing prContext: returns `{ kind: 'error', message: 'github_draft_review requires prContext', retryable: false }`

Done when: unit test verifies `GitHubDraftReviewAdapter.deliver()` writes sidecar + returns pending receipt; absent prContext returns error receipt.

### Slice 2: YAML delivery: sub-fields

Files: `src/trigger/trigger-store.ts`

- Extend `ParsedTriggerRaw.delivery` to `{ kind?: string; token?: string; login?: string }`
- Extend YAML block parser to capture `token:` and `login:` sub-keys (same indent-tracking pattern as reviewerIdentity)
- Assembly: if `kind === 'github_draft_review'`, require token + login, resolve `$SECRET_NAME` for token, build `{ kind: 'github_draft_review', token, login }` AdapterConfig
- Validation error if kind is `github_draft_review` and token/login missing

Done when: trigger-store test verifies `delivery: { kind: github_draft_review, token: $TOKEN, login: user }` assembles correctly; missing token/login triggers parse error.

### Slice 3: route() dispatch

Files: `src/trigger/trigger-router.ts`, `src/trigger/trigger-router-options.ts` (or inline in trigger-router.ts)

- Add `githubDraftAdapter?: GitHubDraftReviewAdapter` to `TriggerRouterOptions`; populate in trigger-listener.ts
- In route() queue callback, after cli_inbox block, add:
  ```
  if (deliveryConfig.source === 'explicit') {
    for (const adapterConfig of deliveryConfig.adapters) {
      if (adapterConfig.kind === 'github_draft_review' && this._githubDraftAdapter) {
        const prContext = extractPrContext(workflowTrigger.context);
        const payload = { ..., prContext };
        // WRITE SIDECAR FIRST (crash safety)
        await writePendingDraftSidecar(...);
        // THEN deliver
        await this._githubDraftAdapter.deliver(payload, adapterConfig);
        skipPostWorkflowActions = true;
      }
    }
  }
  if (!skipPostWorkflowActions) {
    await maybeRunPostWorkflowActions(...);
  }
  ```

Done when: integration test verifies explicit github_draft_review config skips maybeRunPostWorkflowActions; existing reviewerIdentity triggers still call maybeRunPostWorkflowActions.

### Slice 4: Deprecation warning

Files: `src/trigger/trigger-router.ts`

- In route() callback: if both `workflowTrigger.reviewerIdentity` and `workflowTrigger.deliveryConfig?.source === 'explicit'` are set, emit `console.warn('[TriggerRouter] reviewerIdentity is deprecated when explicit delivery: block is configured...')` once per session.

Done when: test verifies warning is emitted with both set; not emitted with only one.

---

## Test Design

| Test | File | What it verifies |
|---|---|---|
| GitHubDraftReviewAdapter.deliver() writes sidecar + returns pending | tests/unit/delivery-adapter.test.ts | Sidecar write-before-deliver invariant |
| GitHubDraftReviewAdapter.deliver() with absent prContext returns error | tests/unit/delivery-adapter.test.ts | Error as data |
| delivery: { kind: github_draft_review, token, login } parses correctly | tests/unit/trigger-store.test.ts | YAML sub-field parser |
| delivery: { kind: github_draft_review } without token returns parse error | tests/unit/trigger-store.test.ts | Validation |
| route(): explicit github_draft_review skips maybeRunPostWorkflowActions | tests/unit/trigger-router.test.ts | Mutual exclusion invariant |
| route(): reviewerIdentity-only trigger still calls maybeRunPostWorkflowActions | tests/unit/trigger-router.test.ts | Backward compatibility |
| Deprecation warning emitted when both reviewerIdentity and explicit deliveryConfig set | tests/unit/trigger-router.test.ts | Warning behavior |

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Sidecar written after deliver() call | HIGH (design invariant) | Code structure: sidecar write is synchronous, precedes deliver() call |
| prContext absent for non-mr-review workflows | MEDIUM | Adapter returns error receipt; route() logs and continues |
| YAML parser token resolution fails for missing $SECRET_NAME | LOW | Existing resolveSecret() returns err; trigger is skipped with warning |

---

## PR Packaging

SinglePR on branch `feat/etienneb/delivery-adapter-phase4`. 4 slices, one commit per slice for reviewability.

---

## Philosophy Alignment

| Principle | Status | Why |
|---|---|---|
| Errors as data | Satisfied | deliver() returns DeliveryReceipt error variant, never throws |
| Thin wrappers | Satisfied | GitHubDraftReviewAdapter delegates entirely to GitHubReviewApprovalAdapter |
| Write-before-deliver invariant | Satisfied | Sidecar write precedes deliver() call in slice 3 |
| Migration not big-bang | Satisfied | Mutual exclusion guard preserves existing reviewerIdentity path |
| YAGNI | Satisfied | GitCommitAdapter, generalized sidecar, dispatch() delivery all deferred |
