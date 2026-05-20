# Delivery Adapter Phase 4 -- Design Review Findings

**Revised scope (after design review):** GitHubDraftReviewAdapter only. GitCommitAdapter descoped to Phase 5.

---

## Tradeoff Review

| Tradeoff | Verdict | Failure condition |
|---|---|---|
| DeliveryPayload extension with worktreeContext | Eliminated by descoping GitCommitAdapter | N/A |
| Old pending-draft-*.json coexists with new format | Simplified: GitHubDraftReviewAdapter reuses existing writePendingDraftSidecar | Acceptable; removed migration complexity |
| PollHandle.state as Record<string,unknown> | Acceptable | Second async adapter with conflicting state keys (Phase 5 problem) |

## Failure Mode Review

| FM | Risk | Mitigation |
|---|---|---|
| Sidecar written AFTER deliver() -- crash loses poll handle | HIGH | Write sidecar BEFORE calling adapter.deliver(); enforced at code structure level |
| GitHubDraftReviewAdapter called when prContext absent | MEDIUM | Returns DeliveryReceipt { kind: 'error' } when prNumber/prRepo not available from WorkflowRunSuccess |
| Old pending-draft sidecar for trigger that removed reviewerIdentity | LOW | Existing recoverPendingDraftPollers() warns and deletes (already handled) |

## Runner-Up / Simpler Alternative Review

- **Descoped GitCommitAdapter to Phase 5** -- eliminates worktreeContext extension to DeliveryPayload; reduces Phase 4 to 4 focused slices
- **Reuse pending-draft-*.json format** -- GitHubDraftReviewAdapter calls writePendingDraftSidecar() directly; no new sidecar format in Phase 4
- Both simplifications accepted.

## Philosophy Alignment

All principles satisfied. YAGNI honored by descoping. Errors as data (deliver() returns receipt). Thin wrapper (delegates to existing GitHubReviewApprovalAdapter). Acceptable tension: parallel paths during migration (mutually exclusive via source guard).

---

## Findings

**No RED findings.**

**ORANGE: prContext for GitHub adapter must come from WorkflowRunSuccess, not TriggerDefinition**
GitHubDraftReviewAdapter needs prNumber and prRepo to create the draft review. These currently come from `triggerCtx` (the webhook payload context) in maybeRunPostWorkflowActions(). In the new path, they need to flow through DeliveryPayload or be extracted from workflowTrigger.context at the call site in route(). Must design this explicitly before implementation.

**YELLOW: Deprecation warning for reviewerIdentity is emitted at session-start time, not at trigger-load time**
If emitted at trigger load (startup), it floods logs for every trigger using reviewerIdentity. Better to emit once per session when both are set on WorkflowTrigger.

---

## Recommended Revisions

1. **Phase 4 scope (final):** 4 slices only:
   - Slice 1: `GitHubDraftReviewAdapter` in delivery-adapter.ts (wraps existing adapter)
   - Slice 2: Extend YAML `delivery:` block to support `token:` and `login:` sub-fields
   - Slice 3: In `route()`: when `deliveryConfig.source === 'explicit'` and kind is `github_draft_review`, write pending-draft sidecar + call `GitHubDraftReviewAdapter.deliver()`; skip `maybeRunPostWorkflowActions()` for those triggers
   - Slice 4: Emit deprecation warning in route() when both reviewerIdentity and explicit deliveryConfig are set on WorkflowTrigger

2. **prContext solution:** `DeliveryPayload` gains optional `prContext?: { prNumber: number; prRepo: string; prUrl: string }` populated from `workflowTrigger.context` at the route() call site (the context already has itemNumber and itemUrl for mr-review triggers).

## Residual Concerns

- GitCommitAdapter and generalized sidecar format deferred to Phase 5
- dispatch() path still gets no delivery in Phase 4 (same as Phase 3)
- Slack/GitLab adapters deferred to Phase 5+
