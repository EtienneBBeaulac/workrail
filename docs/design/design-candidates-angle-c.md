# Design Candidates: Automated MR Review -- Framing-Risk Angle (C)

**Focus angle:** Each candidate is anchored to the primary framing risk:

> If PR authors respond to findings at the same rate regardless of who the comment is attributed to (WorkTrain vs. Etienne), then identity matching is purely cosmetic and the entire identity layer is unnecessary complexity.

Each candidate answers: what is the right architecture if the current problem framing is wrong?

**Persona:** A product manager who has shipped features that missed the mark because they optimized for what users said they wanted instead of what would change their behavior, and now insists on falsifiable success criteria before committing to architecture.

---

## Candidate 1: WorkTrain Builds Its Own Review Reputation (No Identity Layer)

**Primary mechanism:** WorkTrain posts reviews as itself using its own GitHub account and brand, with approval gating for quality -- identity matching is skipped entirely on the hypothesis that credibility follows track record, not attribution.

**p-value (typical AI would suggest this):** 0.25

### How it works end-to-end

A `github_prs_poll` trigger fires when a PR is opened or updated on a configured repo. The trigger has no `reviewerIdentity` field -- it uses a `WORKTRAIN_GITHUB_TOKEN` env var pointing to a `worktrain-bot` GitHub account. When the trigger fires, WorkTrain immediately posts a brief acknowledgment comment as itself: "WorkTrain review in progress" with an ETA. The `wr.mr-review` workflow runs via `spawn_agent`, produces a `wr.review_verdict` artifact with typed findings. The final step has `requireConfirmation: true`, parking the session at a gate. The gate routing is extended to support an "outbox-wait" path -- a new gate type (`humanApprovalRequired: true` on the gate config) -- the coordinator posts the entire `wr.review_verdict` to the outbox as a formatted summary, then polls for cursor advancement. When the operator runs `worktrain inbox`, they scan the findings. Approval is whole-review-binary (not per-finding) at this stage. A new delivery stage `postReviewComments` reads the approved artifact and posts inline and summary comments as the `worktrain-bot` account.

The identity layer is deliberately absent. WorkTrain builds a track record as WorkTrain. Over months, authors either do or do not respond to its findings at the same rate as findings from a human reviewer. That empirical signal is the falsification test for the framing risk. If response rates are equivalent, the entire identity infrastructure was never worth building.

### WorkTrain primitives used/extended

- `github_prs_poll`: extended to dispatch on PR-open (not just reviewer-assignment), removing the need to detect assignment at all. The trigger fires for any PR on configured repos.
- Gate system: extended with a new `humanApprovalRequired: true` gate type that routes to the outbox-wait path instead of spawning an autonomous evaluator. This is a new code path in the gate router, but it does not change the gate system's existing autonomous evaluation path.
- Outbox: `postToOutbox()` called with the formatted `wr.review_verdict`. `pollOutboxAck()` polls for cursor advancement as the approval signal.
- Delivery pipeline: new `postReviewComments` stage added. Reads `session.artifacts[]` (requires a small delivery-layer change to expose the artifact array alongside `lastStepNotes`).

### New infrastructure required

- `worktrain-bot` GitHub account (or GitLab equivalent) -- a real account with a token stored in env config. This is the single most significant new requirement: a separate GitHub identity. Moderate operational cost.
- Gate router extension: new code path for `humanApprovalRequired` that awaits outbox acknowledgment rather than spawning an evaluator session. Approximately 200-400 lines in the coordinator.
- `postReviewComments` delivery stage: deterministic TypeScript that calls `gh api` or the GitHub REST API to post inline and summary comments. Equivalent to etienne-clone's `postReviewToGitLab()` pipeline.
- Whole-review binary approval via `worktrain inbox` is an increment over the current coarse ack -- requires the inbox CLI to display finding summaries before the operator marks read.

### Criterion analysis

- **C1 (native fit):** Configured entirely in `triggers.yml` (workflowId, workspacePath, branchStrategy), env vars for `WORKTRAIN_GITHUB_TOKEN`. No new service. Satisfies.
- **C2 (approval gate integrity):** Gate parks the session; outbox-wait path blocks delivery until the operator acks. No silent post path. Satisfies.
- **C3 (reviewer assignment detection):** Does NOT satisfy. Trigger fires on PR-open, not reviewer-assignment. WorkTrain reviews every PR on configured repos, not just ones assigned to the operator. This is a feature-scope tradeoff: the assignment signal is traded for simplicity. Partial miss.
- **C4 (posting identity):** Posts as `worktrain-bot`, not the operator. Does NOT satisfy in the strict reading. Satisfies the structural requirement (a real identity, not anonymous) but not identity matching.
- **C5 (approval UX quality):** Whole-review binary approval via CLI inbox. Fast (under 1 min to read summary), but not per-finding granular. Partial.
- **C6 (self-improvement loop):** Excellent fit. WorkTrain uses the exact same pipeline to review its own PRs. No special-casing needed for self-review.
- **C7 (team scale):** Second reviewer just adds another trigger with the same `WORKTRAIN_GITHUB_TOKEN`. Or WorkTrain reviews for the whole team with a single trigger. Zero per-reviewer config. Best case for team scale.
- **C8 (quality coupling):** Quality gate is the same approval gate. If findings are weak, the operator drops them or does not ack. The forcing function is operator judgment on the whole review. Weaker than a per-finding drop -- bad batches may get rejected wholesale, wasting good findings.

---

## Candidate 2: Identity-Matched Posting with Empirical A/B Holdout

**Primary mechanism:** Ship identity-matched posting, but instrument it from day one with an A/B holdout that attributes half of reviews to WorkTrain directly -- so the framing risk becomes falsifiable within 60 days of real use rather than being assumed away.

**p-value (typical AI would suggest this):** 0.08

### How it works end-to-end

This candidate does not avoid identity matching -- it treats the framing risk as a design constraint to be falsified quickly rather than assumed true or false. The full identity infrastructure ships as described in other candidates (reviewer identity token, posting as operator, per-trigger soul file for voice). But alongside it, a `reviewAttributionMode` field is added to `TriggerDefinition`: `operator` (default), `worktrain`, or `auto` (randomly assigned per review using a reproducible hash of the PR ID). When `auto` is selected, the coordinator logs the assignment to the session store under a structured `attributionExperiment` metadata field.

After 60 days (or N reviews), a `worktrain diagnose --attribution-experiment` command produces a table: response rate to findings (comment replies, finding-addressed commits) by attribution mode. If the rates are statistically equivalent, the operator has falsification evidence for the framing risk. If they diverge, the identity layer is validated as structural.

The approval gate is per-finding granular (Slack block actions, equivalent to etienne-clone's model). Reviewer assignment detection fires the trigger. All C-series criteria are fully satisfied. The novel contribution is treating the framing risk as a measurement problem, not a design debate.

### WorkTrain primitives used/extended

- `TriggerDefinition`: new `reviewerIdentity: { githubToken, githubLogin }` and `reviewAttributionMode: 'operator' | 'worktrain' | 'auto'` fields.
- Gate system: extended with `humanApprovalRequired: true` path plus Slack integration for per-finding block actions. This is the heaviest infrastructure dependency.
- Session store: `attributionExperiment` metadata field on session events, so `worktrain diagnose` can join them.
- `github_prs_poll`: extended with `review-requested:<user>` GitHub search qualifier to detect reviewer assignment.
- Delivery pipeline: new `postReviewComments` stage, posts as either operator identity or WorkTrain identity based on the session's recorded attribution.

### New infrastructure required

- Slack integration (Socket Mode or webhook + block actions) -- this is the riskiest assumption. If Slack infra is not acceptable, the per-finding approval UX is degraded to the inbox CLI.
- `attributionExperiment` logging in the session store and a `worktrain diagnose --attribution-experiment` reporting mode.
- Everything from Candidate 1's delivery stage and gate extension.
- The A/B split logic itself: a deterministic hash of the PR ID to assign attribution mode, so the assignment is reproducible and auditable.

### Criterion analysis

- **C1 (native fit):** Mostly satisfied -- new `TriggerDefinition` fields are native config. Slack dependency is the only non-native element. Partial.
- **C2 (approval gate integrity):** Per-finding Slack approval gate blocks every post. Full satisfaction.
- **C3 (reviewer assignment detection):** GitHub search API with `review-requested:<user>` qualifier. Satisfies.
- **C4 (posting identity):** Full operator identity (token, login) for the `operator` attribution mode. Satisfies.
- **C5 (approval UX quality):** Per-finding Slack block actions -- the etienne-clone model. Best-in-class for this criterion.
- **C6 (self-improvement loop):** Works for self-review; WorkTrain reviewing its own PRs would use `reviewAttributionMode: 'worktrain'` (it cannot post as a human for its own PRs). Clean.
- **C7 (team scale):** Each reviewer adds their own trigger with their own `reviewerIdentity`. Second reviewer's A/B experiment accumulates independently. Satisfies.
- **C8 (quality coupling):** Per-finding drop in Slack means weak findings get dropped before posting. Strong forcing function.

---

## Candidate 3: Approval-as-the-Product -- Skip Reviewer Assignment, Post After Human Edit

**Primary mechanism:** Reframe the product as "WorkTrain drafts; you edit and post" -- WorkTrain produces a draft review document in a personal `reviews/` branch, the operator edits it in their editor like any other document, commits it, and a delivery trigger detects the commit and posts it under the operator's identity. Reviewer assignment detection and the gate system are both bypassed.

**p-value (typical AI would suggest this):** 0.06

### How it works end-to-end

This candidate questions whether the trigger (reviewer assignment) is the right entry point. Instead of WorkTrain detecting assignment and racing to produce a review before the human would have time to look at the PR, WorkTrain runs proactively on every PR that opens on configured repos and deposits a draft review file into a personal branch: `reviews/<date>/<pr-number>.md`. The file contains structured findings formatted as Markdown with per-finding decision lines:

```markdown
<!-- DECISION: post | drop | edit -->
## Finding: Missing error handling in auth middleware
...
```

The operator pulls the branch (or reads it in GitHub's file editor), edits the file, changes DECISION markers to `post` or `drop`, and commits. A `file_change_poll` trigger watches the `reviews/` directory for committed changes with at least one `post` decision. When it fires, a short deterministic delivery workflow reads the committed file, filters for `post` decisions, and posts the findings under the operator's identity via a stored token. No gate system. No Slack. No new approval infrastructure.

The operator's editing IS the approval. The per-finding granularity comes from the document structure. The operator can edit the prose of any finding before posting -- better than Slack, which only allows approve/drop/edit in a constrained UX.

### WorkTrain primitives used/extended

- `github_prs_poll`: trigger on PR-open, no reviewer-assignment detection needed. WorkTrain reviews everything; the operator decides what to post by committing.
- `autoCommit: true` + `branchStrategy: 'worktree'`: WorkTrain's wr.mr-review session commits the draft to `reviews/<pr-number>.md` in a worktree of the operator's personal branch. The final step no longer needs `requireConfirmation: true` -- the gate IS the edit-and-commit flow.
- New trigger type or adapted `file_change_poll`: watches for changes in the `reviews/` directory on the personal branch. This trigger type may not yet exist; the closest primitive is `github_prs_poll` watching for file changes in a branch.
- Delivery workflow: a short workflow (not wr.mr-review -- that already ran) that reads the committed file, parses DECISION markers, and calls the GitHub API to post inline and summary comments as the operator.

### New infrastructure required

- `reviews/` branch convention and directory structure -- just a git branch, no new service.
- File-change polling trigger (may require a new trigger adapter: `github_file_change_poll` watching a branch path pattern). This is non-trivial if the trigger type does not exist.
- Delivery workflow for parsing committed review files and posting. Deterministic TypeScript or a simple shell script wrapped in a minimal workflow.
- `reviewerIdentity` field in `TriggerDefinition` for the delivery posting step. Same new field as other candidates, but used only in the delivery step, not in the review step.

### Criterion analysis

- **C1 (native fit):** Mostly native. The `reviews/` branch convention requires no new service. The file-change polling trigger may be a new trigger type -- moderate infra cost. Partial.
- **C2 (approval gate integrity):** The edit-and-commit IS the approval. No post happens until the operator commits at least one `post` decision. Zero silent post path. Satisfies.
- **C3 (reviewer assignment detection):** Not satisfied. Fires on PR-open, not reviewer-assignment. This is intentional -- the candidate rejects the assignment trigger as the entry point.
- **C4 (posting identity):** Posts as operator via stored token. Satisfies.
- **C5 (approval UX quality):** Per-finding granularity via DECISION markers in Markdown. The UX is a text editor, not a Slack message. Fast if the operator is already in their editor; slow if they have to context-switch to GitHub file editor. Speed is uncertain -- could be under 2 min or over 5 min depending on workflow. Partial.
- **C6 (self-improvement loop):** Good fit. WorkTrain reviewing its own PRs would deposit into `reviews/` and then auto-approve (no human needed for self-review -- the commit IS the approval, and WorkTrain can commit autonomously for its own PRs with a different decision flow). Clean seam.
- **C7 (team scale):** Second reviewer gets their own `reviews/` branch and their own trigger watching it. Clean separation. Satisfies.
- **C8 (quality coupling):** The operator must edit before posting. They cannot accidentally post without looking at the findings. Strong forcing function -- stronger than a Slack "approve all" button.

---

## Candidate 4: Probabilistic Quality Gate -- Post Only When Confidence Exceeds Threshold, No Approval UX Needed

**Primary mechanism:** Reframe approval as a quality signal rather than a human action -- WorkTrain posts autonomously as WorkTrain when `wr.review_verdict.confidence` exceeds a configured threshold, requires human approval only for low-confidence reviews, and operators tune the threshold until they trust the auto-post rate. The approval gate is eliminated for high-confidence reviews.

**p-value (typical AI would suggest this):** 0.05

### How it works end-to-end

This candidate questions whether approval-by-default is actually the right model. The argument: if WorkTrain's review quality were high enough that 90% of findings were correct, useful, and appropriately voiced, requiring operator approval for every review would be pure overhead. The real goal is not "operator eyes on every review" -- it is "no bad reviews post without operator intervention." These are different requirements, and the second one can be satisfied with a confidence gate.

In this design, `wr.mr-review` produces a `wr.review_verdict` artifact with per-finding and overall `confidence` scores (0.0-1.0). A new `autoPostThreshold` field in the trigger config (default: `null`, meaning always require approval) sets the minimum confidence for auto-post. When the artifact's overall confidence exceeds the threshold, WorkTrain posts immediately as WorkTrain (not the operator -- no identity matching needed for autonomous post). When confidence is below the threshold, it falls back to the outbox-wait path with whole-review approval.

Operators start with `autoPostThreshold: null` (always approve). As they gain confidence in review quality, they raise the threshold incrementally. Over time, 80% of reviews post autonomously with no approval UX required. The 20% that are uncertain or contain critical findings require approval.

The framing risk is handled directly: if authors respond equivalently regardless of attribution, there is no reason to build identity matching at all. WorkTrain earns trust through high-confidence track record.

### WorkTrain primitives used/extended

- `wr.mr-review`: extended to produce `confidence` scores per finding and at the review level. This requires changes to the workflow's final step and to the `wr.review_verdict` schema -- non-trivial cognitive quality work.
- Gate system: `autoPostThreshold` check happens in the gate router. If `confidence >= threshold`, gate is auto-passed without human input. If below, falls back to outbox-wait path.
- `TriggerDefinition`: new `autoPostThreshold?: number` field.
- `github_prs_poll`: extended with reviewer assignment detection (same as other candidates) to scope reviews to assigned PRs.
- Delivery pipeline: new `postReviewComments` stage. Posts as WorkTrain identity for auto-posts; uses `reviewerIdentity` (if configured) for operator-approved posts.

### New infrastructure required

- Confidence scoring in `wr.mr-review` -- this is a significant quality engineering effort, not a plumbing problem. Confidence must be meaningful (calibrated) to be trusted for auto-post decisions. This is the riskiest assumption in this candidate.
- `autoPostThreshold` routing logic in the gate router.
- The delivery stage (same as other candidates).
- Reviewer assignment detection (same as other candidates).

### Criterion analysis

- **C1 (native fit):** New `TriggerDefinition` field + gate router logic. Native fit. Satisfies.
- **C2 (approval gate integrity):** High-confidence reviews post without approval. This directly trades off C2 for the autonomy goal. Does NOT fully satisfy C2 by the stated definition ("every review operator-approved before posting"). This candidate intentionally rejects C2 as stated.
- **C3 (reviewer assignment detection):** Same extension as other candidates. Satisfies.
- **C4 (posting identity):** Auto-posts as WorkTrain, operator-approved posts can use operator identity. Partial.
- **C5 (approval UX quality):** For the fraction of reviews requiring approval, outbox-wait with whole-review ack. Fast, but not per-finding granular. Partial.
- **C6 (self-improvement loop):** Excellent fit. WorkTrain reviewing its own PRs with `autoPostThreshold: 0.85` -- high confidence posts go straight to comments on the self-review PR. The autonomous loop runs without any human gate once confidence is calibrated.
- **C7 (team scale):** Each reviewer configures their own `autoPostThreshold`. One reviewer may trust WorkTrain more than another. Clean per-trigger config. Satisfies.
- **C8 (quality coupling):** The confidence gate IS the quality coupling. A weak review with low confidence scores does not auto-post. But it requires confidence scoring to actually be calibrated -- which it may not be initially. The forcing function is softer than human review until confidence scores are validated.

---

## Candidate 5: Findings-as-Issues -- Post Nothing to the PR; Open GitHub Issues Instead

**Primary mechanism:** Reframe the output channel entirely -- instead of posting review comments on the PR (which requires identity matching, approval timing, and posting infrastructure), WorkTrain opens GitHub issues for each finding, tagged with the PR number and severity, and the developer resolves them before merge. No PR comment infrastructure needed. No identity matching. No per-finding approval UX.

**p-value (typical AI would suggest this):** 0.04

### How it works end-to-end

This candidate questions whether PR comments are the right output format at all. The hypothesis it falsifies: PR comments are the canonical feedback channel because they are contextual and ephemeral -- they live and die with the PR. But this forces the review timing problem (post before the developer merges) and the identity problem (whose name is on the comment). If findings were GitHub issues instead, they are persistent, assignable, linkable to commits, and searchable. They survive the PR merge. They create a record of patterns. They feed back into the backlog.

In this design, `wr.mr-review` produces a `wr.review_verdict` artifact. A new delivery stage `openFindingIssues` reads the `findings[]` array and opens one GitHub issue per finding with severity >= "medium" (configurable threshold). Each issue is titled `[MR Review] <finding title>` and body includes the PR link, file/line context, finding description, and a "close if resolved before merge" guidance. The operator is notified (macOS notification + webhook POST using the existing `NotificationService`) that issues were opened. They can glance at the issues, close any that are noise, and the developer sees the open issues as a merge checklist.

The entire approval mechanism is replaced by the issue-close flow. Per-finding "approval" is the operator closing a noise issue. No Slack. No gate extension. No posting token for PR comments. The operator's review is asynchronous from the PR -- they can process findings at their own pace.

The identity question evaporates: issues are opened as WorkTrain (the `WORKTRAIN_GITHUB_TOKEN`), not the operator. The credibility comes from the issues being correct and actionable, not from attribution.

### WorkTrain primitives used/extended

- `github_prs_poll`: trigger on PR-open or reviewer-assignment (either works, since posting timing is decoupled from the PR approval flow).
- `wr.mr-review`: no changes. `wr.review_verdict` artifact already has `findings[]` with severity and description.
- Delivery pipeline: new `openFindingIssues` stage. Calls `gh issue create` via bash (or the GitHub REST API directly). Reads `session.artifacts[]` -- requires the same small delivery-layer change as other candidates to expose artifacts.
- `NotificationService`: existing notification mechanisms used to alert the operator that issues were opened. No new notification infrastructure.
- Gate system: `requireConfirmation: true` on the final step can remain, but the gate can be auto-evaluated (existing gate path) to confirm finding count is above noise threshold before opening issues. No human-in-the-loop gate needed.

### New infrastructure required

- `openFindingIssues` delivery stage: deterministic TypeScript, approximately 150-250 lines. Calls `gh issue create` per finding. Idempotency via issue title matching (do not open duplicates if triggered twice for the same PR).
- `WORKTRAIN_GITHUB_TOKEN` env var: same as Candidate 1.
- A `minSeverityToIssue` config field in the trigger (or a default in the delivery stage). Prevents noise issues for "nitpick" findings.
- Issue-to-PR linkage tracking: a delivery artifact recording which issues were opened for which PR, so `worktrain diagnose` can surface "3 issues opened, 2 closed before merge" for observability.

### Criterion analysis

- **C1 (native fit):** New delivery stage + `WORKTRAIN_GITHUB_TOKEN` env var. Fully native. No new service. Best-in-class for C1.
- **C2 (approval gate integrity):** The gate is autonomous (existing evaluator path). Issues open without human approval. Strictly speaking, this does NOT satisfy C2 as stated ("every review operator-approved before posting"). Issues open autonomously -- the operator's control is post-hoc (closing noise issues), not pre-hoc (approving before post). The candidate intentionally rejects C2.
- **C3 (reviewer assignment detection):** Optional -- can fire on PR-open instead of assignment. If reviewer assignment is added, it scopes the issue-opening to PRs the operator actually cares about. Partial (same extension as other candidates available but not required).
- **C4 (posting identity):** Posts as WorkTrain (issues under `worktrain-bot` account). Does NOT satisfy the strict reading of C4 (post as operator). Issues are a different output channel where identity matching is less load-bearing -- the finding's correctness matters more than whose name is on the issue.
- **C5 (approval UX quality):** Post-hoc: operator closes noise issues. No pre-post approval UX. Speed depends on issue notification latency. Approval is asynchronous and has no defined latency bound. Does NOT satisfy C5.
- **C6 (self-improvement loop):** Excellent fit. WorkTrain reviewing its own PRs opens issues against the workrail repo itself. These issues feed directly into the `docs/ideas/backlog.md` / GitHub issue queue. The self-improvement loop's input queue is populated by WorkTrain's own review process. This is the strongest C6 of any candidate.
- **C7 (team scale):** Second reviewer adds a trigger pointing to the same or different repo. Issues opened by both triggers are distinguishable by label or assignee. Clean. Satisfies.
- **C8 (quality coupling):** Issues are opened for findings >= `minSeverityToIssue`. Weak or nitpick findings never open issues. But there is no operator check before opening -- a low-quality review opens issues that the developer then has to close as noise. The forcing function is weaker than pre-post operator approval. Partial.
