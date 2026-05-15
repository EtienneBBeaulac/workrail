# Design Review Findings: GitHub Draft Review as Approval Channel

## Tradeoff Review

| Tradeoff | Acceptable? | Failure condition | Hidden assumption |
|----------|-------------|-------------------|-------------------|
| Polling latency (no push signal) | Yes | PR merged before poller detects draft submission (rare) | GitHub API reflects state changes within poll interval |
| Browser-only (no mobile) | Yes for v1 | Operator reviews primarily on mobile; reviews queue for days | Operator has GitHub open regularly; macOS notification is sufficient |
| GitLab gap | **Hard gap** | GitLab is the primary deployment platform | GitHub is primary platform -- not stated, must be confirmed |
| Learning from edits deferred | Yes | Review generation quality so low operator rewrites everything | Review generation quality is good enough to approve/lightly edit |

## Failure Mode Review

| Failure mode | Handled? | Missing mitigation | Risk level |
|-------------|----------|--------------------|-----------|
| FM1: No post-workflow action pathway (SF1) | Partially -- design avoids DEFAULT_DELIVERY_PIPELINE | **Post-workflow action pathway must be built first; no delivery works without it** | **CRITICAL** |
| FM2: Stale diff anchoring | Yes -- draft anchored at creation time | Optional: notify operator of new commits since draft creation | Low |
| FM3: Voice gap in approve-only secondary adapters | Handled in v1 (GitHub edit is native) | Post-v1 Slack/console adapters need per-finding edit | Low (v1 only) |
| FM4: branchStrategy:none dirties main checkout | **Not addressed** | Need `branchStrategy: 'read-only'` variant -- isolated worktree, no delivery, removed after session | Medium |

## Runner-Up / Simpler Alternative Review

**Elements worth borrowing from Candidate 5:**
- Append approval record to session event log at draft submission detection (30 lines) -- gives audit trail without git infrastructure
- Use Candidate 5 as the GitLab variant explicitly: GitHub = Candidate 2 (draft review), GitLab = Candidate 5 (branch-merge) or Candidate 1 (console panel)

**Simpler alternative analysis:**
The minimum viable version (reviewerIdentity field + reviewer assignment filter + post-workflow action pathway + draft review creation + PendingDraftReviewPoller + macOS notification) is ~600-800 lines with no external services. This is already the simplest design that satisfies all must-have criteria. No further simplification is possible without removing the approval gate.

**Hybrid worth adopting:** Candidate 2 (GitHub) + Candidate 1 (console panel) as GitLab fallback, routed via `ReviewApprovalAdapter` interface. This is a two-line config difference with no forked logic.

**Small addition worth borrowing from Candidate 1:** `postAckStage` -- post an acknowledgment comment at trigger-fire time ("I've been assigned as reviewer and will post feedback shortly"). ~50 lines, runs pre-workflow, decoupled from the draft mechanism.

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Functional core / imperative shell | Satisfied -- review cognition in session, posting in delivery |
| Scripts-first coordinator | Satisfied -- agent produces artifact, coordinator posts |
| Structured outputs at phase boundaries | Satisfied -- typed `wr.review_verdict` crosses boundary |
| Zero LLM routing turns | Satisfied -- posting decision is operator action, not LLM |
| Make illegal states unrepresentable | Satisfied -- GitHub PENDING draft is structurally invisible until published |
| WorkTrain builds WorkTrain | Satisfied -- self-review uses same pipeline |
| Operator in the loop for credibility-bearing actions | Satisfied -- publishing the draft is the operator action |
| Overnight-safe | **Tension** -- review posting is supervised by design (acceptable for human-PR review category) |

## Findings

### RED (must address before this direction is viable)

**R1: Post-workflow action pathway must be designed and built first.**
DEFAULT_DELIVERY_PIPELINE is a commit/PR pipeline. Review sessions produce no HandoffArtifact. There is no current mechanism to trigger post-session delivery actions for non-commit workflows. Building the approval channel before building the action pathway leaves the feature with no reliable execution path. This is the single highest-risk failure mode.

**R2: GitLab gap must be explicitly scoped.**
The GitHub PENDING draft review has no direct GitLab equivalent. If the operator uses GitLab (as is the case for Zillow), Candidate 2 is not viable as stated. A GitLab variant must be designed as part of the same initiative (Candidate 1 console panel or Candidate 5 branch-merge as the GitLab path). This is not a post-v1 enhancement -- it is a pre-ship scope decision.

### ORANGE (should address before shipping)

**O1: wr.mr-review v3 quality is a prerequisite for C8 to have teeth.**
The quality coupling criterion (C8) depends on wr.mr-review generating findings good enough that the operator mostly approves rather than rewrites. If confidence scoring in wr.mr-review v3 is uncalibrated, C8 is nominal. The review feature should not be enabled in production until a qualitative calibration pass confirms that the majority of findings are approvable without rewriting. This is a quality gate on wr.mr-review v3, not on the posting architecture.

**O2: `branchStrategy: 'read-only'` variant needed for PR branch checkout.**
Review sessions need to inspect the actual PR branch diff. With `branchStrategy: 'none'`, the agent must `git fetch` + `git checkout pr-branch` in the main workspace, which dirties it and blocks concurrent sessions. A new `branchStrategy: 'read-only'` variant (isolated worktree, no commit/push, removed after session) is needed before concurrent reviews or multi-reviewer setups are safe.

### YELLOW (track, address in backlog)

**Y1: Polling latency for draft submission detection.**
The PendingDraftReviewPoller adds 30-60s detection latency after the operator publishes the draft. For active PRs, this means the review comments appear 1-2 minutes after publication. Acceptable for v1; a GitHub App webhook (`pull_request_review` event) would eliminate latency but requires more infrastructure.

**Y2: Learning from operator edits.**
When the operator edits a finding before publishing, WorkTrain doesn't capture the diff between the original and published text as a style/preference signal. Post-v1 enhancement: compare original artifact findings to published review comments, extract style deltas, feed into per-workspace identity doc updates.

**Y3: Acknowledgment comment timing.**
The `postAckStage` (post "review in progress" comment at trigger-fire) decouples acknowledgment from review completion. But if wr.mr-review takes 45 minutes and the operator published the draft, there's no "review complete, feedback posted" notification. The operator may not know the review is done. A completion notification (macOS + webhook) after draft creation fills this gap.

## Recommended Revisions to Selected Direction

1. **Add explicit scope statement:** "GitHub-first v1; GitLab variant (Candidate 1 console panel) to be designed and shipped in parallel or immediately following."
2. **Rename 'postReviewComments delivery stage' to 'draft review creation post-workflow action'** -- the delivery pipeline framing is architecturally wrong (SF1). The correct framing is a new `postWorkflowActions` list in TriggerDefinition.
3. **Add `ReviewApprovalAdapter` interface** explicitly to the architecture so Slack and console approval can be added as opt-in adapters post-v1 without requiring architecture changes.
4. **Add `postAckStage` (acknowledgment comment) as a concrete scope item** -- small, high-value, decoupled from the approval mechanism.
5. **Add `branchStrategy: 'read-only'` to the scope** -- needed before concurrent review sessions are safe.
6. **Clarify build order:** post-workflow action pathway → wr.mr-review v3 prerequisites (model-tier spawn_agent, external context tools) → reviewer assignment detection → reviewerIdentity field → PendingDraftReviewPoller → draft review creation wiring.

## Residual Concerns

- **GitHub API rate limiting for per-user PAT tokens:** review-heavy periods with multiple concurrent sessions polling and posting could hit the 5000 requests/hour authenticated limit. Monitoring and exponential backoff should be built into the PendingDraftReviewPoller.
- **Confidence calibration timeline:** wr.mr-review v3's confidence field must be empirically validated before enabling auto-gating based on confidence. Until calibrated, all reviews should route to operator approval regardless of confidence.
- **Two-reviewer approval collision:** if two reviewers are configured and both trigger on the same PR, two independent draft reviews appear under different identities. This is probably the right behavior, but should be explicit in the design (not a bug, a feature -- two reviewers means two reviews).
