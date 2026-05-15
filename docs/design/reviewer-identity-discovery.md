# Discovery: Automated MR Review with Identity-Matched Comments

## Context / Ask

**Stated goal:** Implement automated reviewer-assigned MR review with identity-matched comments as a native WorkTrain capability -- architecturally coherent, not bolted on.

**Reframed problem:** Code review requires continuous context-switching from a skilled engineer, but review quality and credibility are tied to that specific person's judgment and voice -- making it hard to delegate without losing trust or slowing authors down.

**Goal type:** solution_statement (original goal names a solution; problem is underneath)

**Solution ambitiousness:** ideal_solution -- user explicitly said "if that means we need to rethink a little bit the architecture, that's fine." Full latitude.

**Problem domain:** software (system architecture, WorkTrain daemon design)

**Rigor mode:** THOROUGH

## Path Recommendation

`full_spectrum` -- the stated goal is a solution statement requiring reframing, AND we need landscape grounding (what WorkTrain already has, what etienne-clone already validated) before generating coherent architectural candidates.

Rationale: `design_first` would skip the landscape audit that's critical here -- WorkTrain already has triggers, polling, gates, spawn_agent, outbox. We need to understand what primitives exist before deciding whether this is "bolt on" or "native". `landscape_first` alone would skip the reframing work already done. `full_spectrum` covers both.

## Constraints / Anti-goals

**Core constraints:**
- Must fit WorkTrain's architecture (triggers.yml, soul files, standard workflow IDs, daemon model)
- Must not post anything under operator identity without explicit operator approval (zero surprise posts)
- Must work without a separate bot GitHub/GitLab account (WorkTrain identity model: act as the user)
- Must survive the WorkTrain daemon crash/recovery model
- Identity matching must not require LLM impersonation that could feel deceptive to close collaborators

**Anti-goals:**
- NOT a standalone bot -- no separate service, no separate repo, no separate deploy
- NOT fire-and-forget autonomous posting (every review needs a human glance)
- NOT dependent on webhook infrastructure as the only trigger path (polling must work)
- NOT a generic review tool -- must know which repos/PRs the operator actually cares about reviewing

## Artifact Strategy

This document is for **human readers** -- a readable record of the discovery process. It is NOT execution truth. Execution truth lives in WorkRail session notes and context variables. If the session is rewound or resumed, the notes survive; this file may not.

## Landscape Packet

### What exists in WorkTrain (relevant primitives)

**Trigger system:**
- `github_prs_poll` / `gitlab_poll` already poll open PRs/MRs on a schedule and dispatch review sessions. The routing to `wr.mr-review` is already live.
- `dispatchCondition` can filter webhook payloads (equals only). No equivalent for polling triggers.
- Context injected by polling: `{ mrId, mrTitle, mrUrl, mrUpdatedAt, mrAuthorUsername }` (GitLab) / `{ itemId, itemNumber, itemTitle, itemUrl, itemUpdatedAt, itemAuthorLogin }` (GitHub). **No `requested_reviewers` field.**

**Reviewer assignment detection: does not exist.**
- Neither `github_prs_poll` nor `gitlab_poll` fetches or filters by reviewer assignment.
- `GitHubPR` type has no `requested_reviewers` field.
- `GitLabMR` type has no `reviewers` field.
- GitHub search API supports `review-requested:<user>` qualifier but the list endpoint does not filter by reviewer.
- GitLab MR list API supports `?reviewer_id=` but it's unused.

**Gate system:**
- `requireConfirmation: true` on a workflow step parks the session at `gate_checkpoint`, returning `WorkflowRunGateParked` from `runWorkflow()`.
- The coordinator spawns an autonomous evaluator session (`wr.gate-eval-generic`) to evaluate the gate -- not a human.
- `resumeFromGate()` injects the `GateVerdict` into `firstStepPrompt` and re-fires `runWorkflow()`.
- **There is no human-in-the-loop gate path.** The gate is designed for coordinator-automated evaluation, not operator approval.

**Outbox / approval channel:**
- `postToOutbox()` appends to `~/.workrail/outbox.jsonl`.
- `pollOutboxAck()` polls `inbox-cursor.json`. Returns `'acked'` when the human runs `worktrain inbox` (cursor advances). No per-message ack, no "approve/reject" response type.
- `worktrain inbox` CLI reads and marks-read. Cannot accept typed responses.
- Notification channels: macOS native + webhook POST. Neither is interactive.

**Delivery pipeline:**
- Staged (`DeliveryStage[]`), extensible by design. Current stages: parseHandoff → gitDelivery → recordCommitShas → cleanupWorktree → deleteSidecar.
- Reads `lastStepNotes` for `HandoffArtifact` (commitType, prTitle, filesChanged). Does NOT read session `artifacts[]`.
- `autoCommit` / `autoOpenPR` flags drive git delivery. No `autoPostReview` flag.
- No stage exists for "post review comment to GitLab/GitHub."

**wr.mr-review workflow:**
- 8-phase workflow with parallel reviewer families via `spawn_agent`. Emits `wr.review_verdict` artifact: `{ verdict, confidence, findings[], summary }`.
- Explicitly prohibits posting: "do not post comments, approve, reject, or merge unless the user explicitly asks."
- `requireConfirmation: true` already on the final step (`phase-6-final-handoff`) -- the gate fires but is evaluated autonomously (or not at all in the current deployment).
- Quality overhaul is a known open item (score 13).

**Identity model:**
- `botIdentity: { name, email }` on `WorkflowTrigger` -- git commit attribution only. No `githubToken` or `reviewerLogin`.
- Per-trigger `soulFile` path exists in `TriggerDefinition` -- can carry persona/style instructions in prose.
- `buildSystemPrompt()` has no `persona` or `reviewerIdentity` parameter. The agent always presents as "WorkRail Auto."
- No structured mechanism to tell the delivery layer "post this review as GitHub user X with token Y."

**etienne-clone (prior art):**
- **Identity system**: three markdown files (`philosophy.md`, `preferences.md`, `review-voice.md`) assembled into `composeReviewPrompt()` with XML priority zones. Directly applicable -- same pattern as per-trigger soul file.
- **GitLab posting**: `GitLabClient.postDiscussion()` + `postInlineDiscussion()`. `postReviewToGitLab()` pipeline with idempotency markers, inline/summary comment formatting, noise gate. Directly portable to a delivery stage.
- **Slack approval flow**: Socket Mode, block actions (`finding:post`, `finding:drop`, `finding:edit`, `review:approve_all`), per-finding state machine in `PendingReviewStore`. Every review gates through Slack before posting -- approval-by-default. This is the model WorkTrain needs.

### Key gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| No `requested_reviewers` field in polling adapters | Blocking | Must add to both GitHub + GitLab adapters |
| No human-in-the-loop approval gate path | Blocking | Current outbox ack is too coarse; Slack-style per-finding approval needs a new mechanism |
| No `autoPostReview` delivery stage | Blocking | Needs new DeliveryStage + new DeliveryFlags field |
| No reviewer identity (token, login) in TriggerDefinition | Blocking | New field needed for posting API calls |
| Outbox has no typed response path | Moderate | `pollOutboxAck` is cursor-only; no "approve/reject" semantics |
| wr.mr-review quality (shallow findings, no sub-investigations) | Moderate | Separate backlog item; needed before identity-matched posting is worthwhile |

### Precedents / analogues

- etienne-clone: validates approval-by-default (every review goes to Slack, not just uncertain ones). Its identity doc + GitLab posting infrastructure is the most directly applicable prior art.
- CodeRabbit: autonomous review bot; posts as itself (no identity matching). Demonstrates the "WorkTrain reviews as WorkTrain" alternative.

## Problem Frame Packet

### Frames considered

**Frame 1 (original goal): "Identity-matched automated review posting"**
- Candidate it generates that Frame 2 wouldn't: persona/voice injection layer, per-reviewer soul files
- Risk: identity matching is cosmetic; significant complexity for uncertain trust gain

**Frame 2: "Eliminate the review context-switch"**
- Reframes away from identity: what matters is that findings are good and the operator can approve quickly
- Candidate it generates that Frame 1 wouldn't: "WorkTrain reviews as WorkTrain, builds its own reputation over time"
- Advantage: avoids the identity complexity layer entirely

**Frame 3: "Operator-in-the-loop review acceleration"**
- The approval gate is the feature, not the automation. WorkTrain does the work; you spend 90 seconds approving.
- Candidate it generates: prioritize the approval UX (Slack/outbox per-finding), treat identity as a later polish layer

**Synthesis:** Frames 2 and 3 are more architecturally honest than Frame 1. The core value is **speed + quality**, not voice matching. But for the operator's specific use case (named reviewer, team relationship, credibility transfer), voice matching is probably load-bearing -- at least for the initial rollout. Frame 3 is the right implementation frame: nail the approval gate first, add identity layering second.

### Primary uncertainty resolved

**Is identity matching structural or cosmetic?**
- Verdict: **structural for trust transfer, cosmetic for the approval gate architecture.** The approval gate (Frame 3) is needed regardless. Identity matching layers on top without changing the approval gate design. Build the gate first; identity is an enrichment layer on the review artifact.

### Constraints confirmed from landscape

1. Every review must be operator-approved before posting (etienne-clone validated this; gate system needs extension)
2. Reviewer assignment detection requires new fields in polling adapters (non-trivial but bounded)
3. Posting requires new delivery infrastructure (new stage, new TriggerDefinition fields)
4. Identity per trigger (soul file) is already supported; identity for posting (token, login) is new
5. The outbox ack mechanism is too coarse for per-finding approval; a new approval channel is needed

## Decision Criteria

**Remaining uncertainty type:** Recommendation uncertainty -- we have enough research to generate candidates; what's uncertain is which architectural shape is the right long-term building block, especially for the approval channel.

**Unresolved challenged assumptions:**
- A1 (identity matching is structural): still unresolved; requires real-world data. Candidates must work whether or not identity matching is load-bearing.
- A3 (fire-and-forget is wrong): resolved -- approval-by-default is confirmed correct. Every candidate must have an operator approval gate.

**Abstract principles at play:**
1. Structured outputs at every boundary (vision) -- the review artifact must be typed, not free-text, before posting
2. Zero LLM turns for routing (vision) -- the decision "should I post this?" must be a deterministic operator action, not an LLM judgment
3. Functional core / imperative shell (CLAUDE.md) -- review cognition in the workflow session; posting as a deterministic delivery script
4. Scripts-first coordinator -- posting is infra, not agent work; the coordinator/delivery layer posts, the agent produces the artifact
5. Operator in the loop for credibility-bearing actions -- the vision explicitly says WorkTrain pauses when "a finding is Critical and requires explicit human approval before merging." Review posting is the same category.

**Decision criteria (priority order):**

| # | Criterion | Type | Weight |
|---|-----------|------|--------|
| C1 | **Native fit:** Configured entirely in triggers.yml + soul files + standard workflow IDs. No new infrastructure service. | Compatibility threshold | Must-have |
| C2 | **Approval gate integrity:** Every review is operator-approved before posting, with no path that posts silently. | Compatibility threshold | Must-have |
| C3 | **Reviewer assignment detection:** Can detect when you (not just any user) are assigned as reviewer on configured repos. | Compatibility threshold | Must-have |
| C4 | **Posting identity:** Can post under your GitHub/GitLab identity (your token, your login) with your credibility. | Compatibility threshold | Must-have |
| C5 | **Approval UX quality:** The approval interaction is fast (<2 min) and granular enough to drop individual noisy findings. Per-finding approval is better than whole-review approval. | Quality-aspirational | High |
| C6 | **Vision alignment -- self-improvement loop:** The architecture chosen here is one WorkTrain could use to review its own PRs in the self-improvement loop. If a direction would require WorkTrain to have special self-review infrastructure separate from what it uses for human repos, it's a design smell. | Vision-aligned | High |
| C7 | **Forward seam for team-scale:** The design allows a second team member to add their own reviewer trigger without forking infrastructure. Each reviewer is just another trigger + soul file + reviewer identity config. | Quality-aspirational (long-term) | Medium |
| C8 | **wr.mr-review quality coupling:** The design does not silently ship under-quality reviews under the operator's name. It must have a forcing function (quality gate or staged rollout) to prevent weak findings from posting. | Compatibility threshold | Must-have |

**Ideal end state (restated for criteria calibration):**
WorkTrain has a native 'reviewer' role -- configured in triggers.yml, soul file, and reviewer identity. When assigned (or a PR opens), WorkTrain acknowledges, runs deep review via spawn_agent sub-investigations, produces a typed `wr.review_verdict` artifact, and routes to an outbox/Slack channel for operator one-tap approval. The approval UX shows individual findings with approve/drop controls. After approval, a deterministic delivery script posts the comments as the operator. Teammates know it's "you + WorkTrain" and find reviews more thorough. A second teammate adds their own reviewer trigger by copying the config. WorkTrain reviews its own PRs in the self-improvement loop using the same pipeline.

## Candidate Directions

*Generated by three parallel subagents (angles: ideal end state, riskiest assumption, framing risk). Synthesized and deduplicated by main agent. 15 raw candidates collapsed to 5 with distinct primary mechanisms.*

### Cross-executor insight (not reached by any single angle)

The most important insight from comparing all three angles: **the approval channel and the posting identity are fully orthogonal dimensions**. No executor surfaced this explicitly. Every candidate that has approval-by-default works regardless of whether it posts as the operator or as WorkTrain. The "who posts?" question and the "how does the operator say yes?" question can be configured independently per trigger. This should be reflected in the architecture: `reviewerIdentity` (posting auth) and `approvalChannel` (gate routing) are separate config concerns.

**Second cross-executor insight:** `wr.mr-review v3` is a shared prerequisite for all candidates. The new requirements surfaced in conversation (model-tier dispatch in spawn_agent, external context tools for fetching Jira/MR description/docs, wr.mr-review evolved to coordinator-style fan-out) are load-bearing before any approval channel is worth building. No approval channel is worth building until the review quality is good enough to post under anyone's name.

### What was collapsed

- A1 (Slack + identity) and B-D (Slack port) share the same primary mechanism -- merged into Candidate 4
- A2 (console approval) and B-C (console panel) share the same mechanism -- merged into Candidate 1  
- A4 (CLI TUI) and B-B (enriched outbox CLI) share the same mechanism (terminal-based approval) -- collapsed into Candidate 1 as the fallback channel option
- C1 (WorkTrain-as-itself) and C4 (probabilistic auto-post) compose naturally -- merged into Candidate 3
- C3 (edit-the-document) and B-E (branch-merge as approval) share the "document editing as approval" pattern -- merged into Candidate 5 with git-native framing
- B-A (file JSON manifest) is subsumed by Candidates 1 and 5 -- it is a degenerate form of both

### Candidate 1: Native Console Approval + Identity Layer + wr.mr-review v3

**Primary mechanism:** The WorkTrain Console gains a minimal interactive approval panel; `reviewerIdentity` (token + login) is added to `TriggerDefinition`; reviewer-assignment detection is added to polling adapters; a new `postReviewComments` delivery stage posts findings as the operator after approval.

**What's new vs. existing WorkTrain:**
- `github_prs_poll` / `gitlab_poll` adapters: add `reviewerLogin` filter; fetch `requested_reviewers` (GitHub) / `reviewers` (GitLab) fields
- `TriggerDefinition`: new `reviewerIdentity: { githubToken, githubLogin }` field (env-resolved, same pattern as `hmacSecret`)
- Gate router: new `gateKind: 'human_approval'` branch that writes pending verdict to `review-inbox.jsonl` instead of spawning `wr.gate-eval-generic`
- WorkRail Console: two new endpoints (`GET /api/v2/review/pending`, `POST /api/v2/review/pending/:sessionId/approve`). Breaks read-only invariant narrowly -- one action type, localhost only
- Delivery pipeline: new `postAckStage` (fires before workflow, posts acknowledgment comment), new `postReviewComments` stage (reads approved `wr.review_verdict` artifacts, posts inline + summary comments)
- `WorkflowRunSuccess`: expose `artifacts[]` alongside `lastStepNotes` so delivery stage can read them
- `wr.mr-review v3`: upgraded to coordinator-style workflow -- phase-0 fetches requirements context via new external context tools (Jira, MR description, linked docs); reviewer families use model-tier spawn (cheap/haiku agents for sweep, capable/sonnet for synthesis); final step posts identity-aware artifacts; requireConfirmation re-routed to human gate

**Criteria:** Fully satisfies C1-C8. Console as approval channel is better than CLI for per-finding granularity; macOS notification provides push signal. Weakness: not async (operator must be at browser; no mobile).

**What makes this the native-fit candidate:** Every component either extends an existing WorkTrain primitive (console, delivery pipeline, trigger definition, gate router) or adds a new field to an existing type. No new process, no new service, no external dependency.

---

### Candidate 2: GitHub Draft Review as Approval Channel

**Primary mechanism:** WorkTrain creates a GitHub pending draft review under the operator's identity (GitHub's own "pending review" feature); the operator publishes it via GitHub's native "Finish your review" UI; a coordinator polling loop detects the submission and marks the gate resolved.

**What's new vs. existing WorkTrain:**
- Gate router: `human_approval` path calls GitHub REST API to create `event: 'PENDING'` draft review with inline comments from `wr.review_verdict.findings[]`
- New `PendingDraftReviewPoller`: polls `GET /pulls/:number/reviews` every 30-60s for the operator login, detects when pending review transitions to submitted. ~300-500 lines
- `wr.review_verdict` findings schema: add optional `filePath`, `lineNumber` for inline placement
- `TriggerDefinition`: `reviewerIdentity` same as Candidate 1; no `approvalChannel` field needed -- draft review is the default when `reviewerIdentity` is present
- No console changes. No Slack. No new CLI commands.

**The inversion:** WorkTrain posts the draft; the operator publishes it. GitHub's pending review is private (invisible to author) until the operator submits or dismisses. The approval UX IS the GitHub PR review UI -- the operator's natural environment, zero new tool to learn. Per-finding editing, deletion, and commenting is native GitHub.

**Criteria:** Fully satisfies C1-C4, C6, C7. C5 (approval UX): best-in-class for operators who review in GitHub; no mobile friction beyond normal GitHub mobile. C8: operator can delete weak findings before submitting. Main gap: requires polling loop to detect submission (polling latency, no push signal from GitHub).

**What makes this architecturally interesting:** Zero new UI infrastructure. The approval channel is GitHub itself. WorkTrain's only new surface is the draft-review creation API call and the submission polling loop.

---

### Candidate 3: WorkTrain-as-Itself with Confidence-Gated Graduated Autonomy

**Primary mechanism:** WorkTrain posts as WorkTrain (its own GitHub account) with whole-review outbox approval initially; an `autoPostThreshold` field allows operators to gradually raise the confidence threshold until most reviews post autonomously. Identity matching is skipped entirely.

**What's new vs. existing WorkTrain:**
- `WORKTRAIN_GITHUB_TOKEN` env var: WorkTrain's own GitHub account token (single shared account across all review triggers)
- Gate router: new outbox-wait path -- posts formatted `wr.review_verdict` summary to outbox, polls for cursor-advancement ack. Much simpler than per-finding approval; coarser but fast
- `TriggerDefinition`: new `autoPostThreshold?: number` field (null = always require approval; 0.9 = auto-post when confidence >= 90%)
- `worktrain inbox` CLI: upgraded to display finding summaries before marking read (so the operator sees what they're approving)
- Delivery pipeline: same `postReviewComments` stage as Candidate 1, but always uses `WORKTRAIN_GITHUB_TOKEN`
- No reviewer assignment detection required -- can fire on PR-open for any PR on configured repos

**The framing challenge:** This candidate bets that authors respond to correct, useful findings regardless of attribution -- and that WorkTrain earns credibility through track record, not identity matching. If that framing is wrong, the identity layer can be layered on top without changing the approval architecture.

**Criteria:** C1 (satisfies), C2 (satisfies -- outbox wait blocks delivery), C3 (partial -- assignment detection not required but can be added), C4 (does not satisfy strict reading -- posts as WorkTrain, not operator), C5 (partial -- whole-review approval is coarser than per-finding), C6 (excellent -- strongest self-improvement loop fit of all candidates), C7 (excellent -- second reviewer adds trigger with same shared token), C8 (satisfies via outbox approval).

**What makes this architecturally important:** Simplest path to shipping. No new TriggerDefinition identity fields, no posting auth complexity. If the identity hypothesis turns out to be wrong (authors don't care who the comment is from), this was the right design. If it's right, identity can be layered on later.

---

### Candidate 4: Slack Per-Finding Approval (Ideal End State / etienne-clone Port)

**Primary mechanism:** A first-class `SlackApprovalAdapter` is added to WorkTrain's notification layer; when the human approval gate fires, findings are posted as Slack Block Kit cards with per-finding Post/Drop/Edit buttons (Socket Mode); operator approval drives `resumeFromGate()`.

**What's new vs. existing WorkTrain:**
- All additions from Candidate 1 (reviewer identity, assignment detection, postReviewComments delivery stage, wr.mr-review v3)
- `NotificationService`: new `SlackApprovalAdapter` implementing a `ReviewApprovalAdapter` interface
- `PendingReviewStore`: per-session file-backed state machine at `~/.workrail/review-pending/<sessionId>.json`
- Slack app: Socket Mode (outbound WebSocket, no public URL needed) or incoming webhook for receiving block actions
- Gate router: `human_approval` path calls `adapter.awaitApproval()` which resolves when `PendingReviewStore` reaches terminal state
- ~600-800 lines of new TypeScript + Slack app configuration

**The UX ceiling:** Per-finding one-tap in Slack is the best approval experience of any candidate. Push notification to phone. Sub-30 seconds for a 5-finding review. etienne-clone already validated this exact model. This is what the ideal end state looks like.

**Criteria:** Fully satisfies all C1-C8 when Slack is available. C1 partial: requires Slack app setup (external dependency). Critical risk: Slack workspace restrictions may block app installation.

**Designed as an opt-in adapter:** The architecture should make Slack one of several `ReviewApprovalAdapter` implementations, not the only path. Candidates 1-3 are the fallbacks; Candidate 4 is the upgrade.

---

### Candidate 5: Branch-Merge as Approval Signal (Git-Native Audit Trail)

**Primary mechanism:** WorkTrain commits the `wr.review_verdict` artifact to a `review-staging/<sessionId>` branch; the operator edits findings directly (removing or annotating), merges the branch; a second polling trigger detects the merge and fires the posting delivery stage. The git merge IS the approval -- permanently recorded.

**What's new vs. existing WorkTrain:**
- Delivery pipeline: `gitDeliveryStage` extended with a `createReviewStagingBranch` mode; commits `review-output.json` to the staging branch
- New second trigger in `triggers.yml`: `github_prs_poll` watching `review-inbox` branch for merges; `workflowId: 'wr.review-dispatch'` (thin workflow that reads the merged artifact and fires posting)
- `TriggerDefinition`: new `reviewDelivery: 'branch-annotation' | 'gate'` field
- No gate system extension required. No new approval UI.
- `reviewerIdentity` field for posting auth (same as other candidates)
- A permanent `review-inbox` branch as the merge target

**Unique properties:** The approval record is in git, timestamped, with the operator's git author. No transient state that can be lost on daemon restart. The only candidate where the approval history is fully auditable. The operator edits the review artifact in their editor -- better prose control than Slack modals or checkbox UIs. The "review the review" mental model is slightly confusing but git-native.

**Criteria:** C1 (satisfies), C2 (satisfies -- no post without explicit merge), C3 (same extension as others), C4 (satisfies via reviewerIdentity), C5 (partial -- editing JSON is slower than button-click; better with a `reviews/<pr>.md` markdown format), C6 (excellent -- review-staging PRs in the workrail repo feed directly into the self-loop), C7 (satisfies -- per-reviewer review-inbox branch), C8 (satisfies -- operator edits before merging).

---

### Synthesis: Approval channel × identity as independent dimensions

All 5 candidates share a common required layer:
- Reviewer assignment detection (adapter extension -- same work regardless of candidate)
- `reviewerIdentity` field in `TriggerDefinition` (for posting auth -- optional in Candidate 3)
- `postReviewComments` delivery stage (reads approved artifacts, posts via GitHub/GitLab API)
- `wr.mr-review v3` (model-tier fan-out, external context tools, coordinator-style phases)

The candidates diverge only on the **approval channel** choice:
| Candidate | Approval channel | New infra cost |
|-----------|-----------------|----------------|
| 1 (Console) | Browser panel (localhost) | Medium (console write capability) |
| 2 (GitHub draft) | GitHub PR UI | Low (polling loop only) |
| 3 (WorkTrain-as-itself) | CLI outbox ack | Minimal |
| 4 (Slack) | Slack block actions | High (Slack app + Socket Mode) |
| 5 (Branch merge) | Git merge | Low (review-inbox branch + trigger) |

**The architecture should treat approval channel as a pluggable adapter** (`ReviewApprovalAdapter` interface), so operators can start with Candidate 3 (simplest) and upgrade to Candidate 4 (best UX) without changing anything else.

### New requirements to fold in (surfaced in conversation)

Two requirements from the user that all candidates must accommodate:

1. **Model-tier dispatch in `spawn_agent`**: each agent spec in the parallel form should accept a `model` override or tier (`cheap | standard | capable`). Cheap agents for wide sweep, capable agent for synthesis. Requires new field on `SingleSpawnSpec` and propagation through `agentConfig`. Affects wr.mr-review v3 directly.

2. **Native external context tools for daemon sessions**: `fetch_jira_issue`, `fetch_mr_description`, `fetch_url` (docs/specs), `fetch_github_issue`. Currently only path is Bash + curl. These are needed for "was the right thing implemented?" -- answering that question requires fetching requirements. Read-only, deterministic, no side effects -- fit the daemon tool model exactly. Affects wr.mr-review v3 phase-0.

## Challenge Notes

**Challenge rung used:** Rung 2 (same-family executor with explicit steelmanning instructions). Cross-family verification not possible in this session. `recommendationConfidenceBand` is therefore at most 'medium' for any final recommendation.

### Three structural findings (each questions a fundamental assumption, not just implementation scope)

**SF1: The delivery pipeline is a commit/PR pipeline, not a general post-workflow action pipeline.**
`DEFAULT_DELIVERY_PIPELINE` is structured as: `parseHandoffStage` (reads `HandoffArtifact` from `lastStepNotes`, stops pipeline on failure) → `gitDeliveryStage` → `recordCommitShas` → `cleanupWorktree` → `deleteSidecar`. A review workflow produces no commit and no `HandoffArtifact`. `parseHandoffStage` would stop the pipeline before `postReviewComments` ever runs. "Add a delivery stage" is not a simple additive change -- it requires either (a) a completely separate post-workflow action pathway, or (b) a fundamental generalization of `DEFAULT_DELIVERY_PIPELINE`. This affects all candidates that describe adding a `postReviewComments` delivery stage (Candidates 1, 2, 4). Only Candidate 2 avoids this: GitHub draft review creation is a single API call at workflow completion, independent of the delivery pipeline.

**SF2: Stale-diff problem when posting review comments.**
GitHub review comments are anchored to specific diff hunks. If the PR receives new commits between WorkTrain generating findings and the operator approving, the line numbers shift. Comments anchored to old hunks post as stale or misanchored. The operator approved a prose rendering in the console panel; what posts is a positioned annotation against a possibly-changed diff. This is not transient -- it produces misleading authoritative-looking comments. Affects Candidates 1, 4. Candidate 2 avoids it: the draft review is created at generation time (anchored to the current diff), and the operator publishes that same draft (or discards it if the diff has changed too much). The draft-review API handles anchoring at creation time.

**SF3: Candidate 1 primarily solves "how to build an approval UI", not "delegation blocked by voice/judgment".**
The real problem requires (1) findings sound like the operator and (2) the operator's name appears only on findings they would have approved. Candidate 1 addresses (2) via the approval gate but addresses (1) only through the soul file -- which influences generation but gives the operator no ability to edit individual findings before posting. If findings are phrased wrong (correct but not the operator's voice), the approval panel becomes a rewrite interface where the operator drops everything and does the review manually. Candidate 2 directly solves this: draft review findings are editable per-finding before publish -- the operator exercises per-finding judgment, not just batch approval.

### Accepted tradeoffs reassessed

- **Console read-only invariant**: already broken by `POST /api/v2/auto/dispatch` (confirmed in codebase by the challenger). The slope question is: how many unauthed POST endpoints is acceptable? This is tactical, not structural -- the invariant was already compromised.
- **Must be at browser**: genuinely problematic for async use. Reviews may queue for hours if the operator is not watching the console. The macOS notification provides a push signal, but it requires a browser open. This is a real friction point, not cosmetic.
- **wr.mr-review v3 as prerequisite**: confirmed as shared prerequisite for all candidates -- not scope creep, but it does mean the approval channel has nothing useful to approve until v3 ships.

### Pre-mortem: specific failure conditions

1. **"This will fail if"** the PR receives new commits after WorkTrain generates findings but before the operator approves in the console. Posted comments are anchored to old diff lines and appear misaligned to the PR author. The operator approved correct findings; what posts is confusing noise.

2. **"This will fail if"** the `parseHandoffStage` in the delivery pipeline halts execution before a `postReviewComments` stage can run, because review sessions produce no `HandoffArtifact`. The stage never fires and no review is posted. This silently drops all reviews.

3. **"This will fail if"** the operator edits the finding text in their head before approving ("this is right but I'd phrase it differently") but the approval UI only offers approve/drop. They approve -- and the finding posts with phrasing they wouldn't have used. The identity layer works architecturally but fails the "sounds like me" requirement that makes it socially useful.

4. **"This will fail if"** wr.mr-review generates findings with low `filePath`/`lineNumber` fidelity because the workflow didn't fetch the actual diff or checkout the branch. Posted inline comments land on wrong lines. The issue: `branchStrategy: 'none'` (correct for read-only review sessions) means the agent works in the main checkout, not the PR branch. The agent must explicitly `git fetch` + `git checkout` the PR branch to read the diff, which dirties the main checkout.

### Runner-up strengthened by challenge

**Candidate 2 (GitHub Draft Review) is strengthened by SF1, SF2, and SF3:**
- Avoids SF1 (no delivery pipeline dependency -- draft review creation is a single API call)
- Avoids SF2 (draft is anchored to the diff at creation time; operator publishes the same draft)
- Directly addresses SF3 (per-finding editing before publish -- operator exercises voice, not just approval)

The challenge materially weakened the case for Candidate 1 and materially strengthened Candidate 2. No position change required (challenge happens before selection), but the selection step should weigh these structural findings.

## Resolution Notes

### Selection

**Winner: Candidate 2 -- GitHub Draft Review as Approval Channel**

**Runner-up: Candidate 5 -- Branch-Merge as Approval Signal**

**Eliminated:** Candidate 3 (C4 FAIL -- posts as WorkTrain, not operator), Candidate 4 (C1 FAIL -- external Slack dependency violates must-have), Candidate 1 (conditional pass only -- SF1 structural issue means postReviewComments stage can't live in DEFAULT_DELIVERY_PIPELINE as described; conditionally viable if SF1 is fixed, but C2 was won cleanly by Candidates 2 and 5)

### Why Candidate 2 wins

Candidate 2 collapses three independent requirements into one GitHub API primitive:
- **C4 (posting identity)**: draft is created with operator's token -- GitHub shows their avatar and login
- **C2 (approval gate)**: draft reviews are invisible to PR authors until explicitly published -- no silent post path exists structurally (not enforced by policy)
- **SF2 (stale diff)**: draft is anchored to the diff at creation time; the operator publishes the same draft, not a re-fetched version

It avoids all three structural findings from the adversarial challenge:
- SF1: draft review creation is a GitHub API call, not a delivery pipeline stage -- no parseHandoffStage dependency
- SF2: anchoring at creation time, not at approval time
- SF3: GitHub's native "Finish your review" UI has per-finding editing, deletion, and commenting -- the operator publishes findings in their own words

The approval UX is GitHub's own PR review interface -- the operator's natural environment for this work. No new tool to learn, no new tab to monitor, no new service to configure. The new implementation surface is bounded to one new component: `PendingDraftReviewPoller` (~300-500 lines).

**C5 tie-breaker:** Both Candidate 2 and 5 pass all must-have criteria. C5 (approval UX quality, high weight) is the deciding quality-aspirational criterion. Candidate 2: PASS (native GitHub per-finding editing, operator already in GitHub). Candidate 5: PARTIAL (JSON editing in diff view, "review the review" mental model, unlikely to hit <2 min for non-trivial reviews).

### Why Candidate 5 is the runner-up (not the winner)

Candidate 5 has one genuinely unique property no other candidate has: the approval record is permanently in git. This matters for auditing and compliance. But C5 is PARTIAL -- the "review the review" UX adds friction and cognitive overhead. For the stated success criterion (<2 min per review), Candidate 5 is unlikely to get there for non-trivial review sets.

**Trigger to switch to Candidate 5:** If GitHub's draft review API (a) rate-limits per-user token in a way that prevents posting for high-volume review periods, (b) doesn't support a required review category (GitLab migration), or (c) the polling latency turns out to be unacceptably long (>5 min detection delay). In any of those cases, Candidate 5 is the clean fallback.

### Comparison to idealEndState

The idealEndState called for: native WorkTrain config, operator approval with per-finding controls, identity-matched posting, deep spawn_agent review with model-tier fan-out, external context tools, Slack/outbox draft approval, learns from operator edits over time.

Candidate 2 reaches: native config (C1), per-finding editing (GitHub UI), identity-matched posting (C4), approval before posting (C2). It does not reach: Slack (intentionally -- Slack fails C1), learning from operator edits (post-v1 enhancement), deep review quality (depends on wr.mr-review v3 shared prerequisite).

The gap from idealEndState:
1. **Approval channel richness**: Slack is richer UX (mobile, push); Candidate 2 is polling-detected, browser-only. Candidate 4 (Slack) would close this gap but fails C1. The architecture should allow Slack as an opt-in second adapter later, once C1 is satisfied by making it additive.
2. **Learning from operator edits**: when the operator edits finding text before publishing, WorkTrain doesn't currently learn from those edits. This is a post-v1 enhancement that requires comparing the published draft to the original to extract style preferences.
3. **GitLab**: GitHub's draft review API has no direct GitLab equivalent. GitLab has draft notes (`isDraft: true`) but the UX is different. A GitLab-specific variant is needed for GitLab repos.

The shortfall is justified: Candidate 2 is the right first-principles design that satisfies all must-haves and the key quality-aspirational criterion (C5) without external service dependencies. The gaps are real enhancement opportunities, not design flaws.

### Shared prerequisites (required before any candidate is buildable)

These are not specific to Candidate 2 -- all candidates require them:

1. **wr.mr-review v3**: coordinator-style workflow with model-tier spawn_agent fan-out (cheap sweepers, capable synthesizer), external context tools (fetch_jira_issue, fetch_mr_description, fetch_url), phase-0 fetching requirements context, revised wr.review_verdict schema with filePath/lineNumber per finding
2. **Reviewer assignment detection**: GitHub (`review-requested:<user>` search qualifier or `requested_reviewers[]` field in polling adapter) + GitLab (`?reviewer_id=` filter)
3. **`reviewerIdentity` field in TriggerDefinition**: `{ githubToken, githubLogin }` (or gitlab variant), env-resolved
4. **Post-workflow action pathway for non-commit sessions**: separate from DEFAULT_DELIVERY_PIPELINE (which is commit/PR-only). Review sessions need a post-workflow action that fires after session completion, reads session artifacts[], and runs reviewer-identity-aware posting logic. This is new platform infrastructure that all review posting candidates require.
5. **Model-tier dispatch in spawn_agent**: `model` override per agent spec in the parallel form (`SingleSpawnSpec.model?` field). Required for wr.mr-review v3.
6. **External context tools**: `fetch_jira_issue`, `fetch_mr_description`, `fetch_url` as native daemon tools. Required for wr.mr-review v3.

### New WorkTrain platform capabilities implied

The discovery surfaced two new first-class platform capabilities beyond the review feature:

**1. Post-workflow action pathway for non-commit sessions.**
The delivery pipeline is a commit/PR pipeline. Review, analysis, and monitoring sessions need their own post-workflow action pathway. This should be a first-class concept in TriggerDefinition: `postWorkflowActions: [...]` -- a list of typed actions that fire after session completion, reading from session artifacts[] rather than lastStepNotes HandoffArtifact. `postDraftReview`, `postReviewComments`, `openFindingIssues`, `postToSlack` would all be entries in this list. This is architecturally cleaner than forcing review delivery through the commit pipeline.

**2. ReviewApprovalAdapter interface.**
The approval channel (console panel, GitHub draft, Slack, branch-merge) should be pluggable. Define a `ReviewApprovalAdapter` interface that gate routing calls when a human approval gate fires. Candidate 2 (GitHub draft) is the default adapter; Candidate 4 (Slack) is an opt-in adapter; Candidate 1 (console) is another opt-in. Operators configure the adapter in triggers.yml. This makes the approval channel an operator configuration choice, not a design decision baked into the codebase.

### Selection tier and confidence band

**Selection tier:** `contextual_recommendation` -- fresh-context executor provided ranked evidence; two candidates passed all must-have criteria; C5 was the deciding quality-aspirational criterion; the selection follows directly from the evidence.

**Recommendation confidence band:** medium -- no cross-family challenge was possible (Rung 2 used); the structural findings are significant and well-evidenced; GitLab gap and polling latency risk are real unknowns.

**Does not upgrade from Phase 3d baseline (medium).** The challenge found structural issues but they strengthened the selection of Candidate 2 rather than introducing new uncertainty.

## Problem Frame Packet (step 5)

### Primary users

| User | Job to be done | Current pain |
|------|---------------|--------------|
| Operator (reviewer) | Review PRs without losing flow on other work | Context-switch cost; review sits or gets rushed |
| PR author | Get actionable feedback fast so they can unblock | Waiting hours or days; uncertain whose standards apply |
| Team | Maintain review quality without reviewer as bottleneck | Quality degrades when reviewer is overloaded |

### Reframes / HMW questions

**HMW 1:** How might we give WorkTrain its own review reputation so authors trust its standards directly -- eliminating the identity layer entirely?

**HMW 2:** How might we make the operator's approval so fast (< 30 seconds) that the approval gate is never the bottleneck, and posting as yourself is still honest to the team?

### Primary framing risk

**Specific falsification condition:** If PR authors respond to findings at the same rate regardless of who the comment is attributed to (WorkTrain vs. Etienne), then identity matching is purely cosmetic -- no trust transfer occurs, and the entire identity layer is unnecessary complexity. This would change the recommended direction from "identity-matched posting" to "WorkTrain reviews as WorkTrain with a strong operator-approval gate." This should be empirically testable after a few months of real use.

### Identified tensions

1. **Identity fidelity vs. infrastructure complexity** -- voice matching requires new `TriggerDefinition` fields, soul-file persona system, and posting auth; posting as WorkTrain requires none of that
2. **Approval-by-default vs. fire-and-forget autonomy** -- review credibility requires a human glance on every output; this is fundamentally at odds with WorkTrain's autonomous model
3. **Reviewer assignment trigger vs. proactive review** -- waiting for assignment is reactive but bounded; proactive (PR creation) creates noise for PRs you may never review
4. **wr.mr-review quality vs. identity layer ordering** -- identity-matched shallow findings are worse than honest shallow ones; quality must ship before identity is worth adding
5. **Gate-for-human-approval vs. gate-for-autonomous-evaluation** -- current gate system routes to an autonomous evaluator; rerouting to human requires a design extension
6. **Per-finding approval vs. whole-review approval** -- fine-grained (etienne-clone Slack model) is better UX and lets operator drop noise; whole-review is simpler but less useful
7. **WorkTrain-as-you vs. WorkTrain-as-itself** -- two genuinely different product positions with different trust dynamics and different complexity costs
8. **Read-only review session vs. checkout-branch worktree** -- inspecting the actual PR diff requires checking out the branch; `branchStrategy: 'none'` dirties the main checkout; `branchStrategy: 'worktree'` adds overhead for a read-only session

### Philosophy sources

- `docs/vision.md` -- "zero LLM turns for routing", "structured outputs at every boundary", "correctness over speed"
- `AGENTS.md` -- WorkTrain architecture rules, protected files, commit conventions
- `~/.claude/CLAUDE.md` -- operator's coding philosophy: immutability by default, make illegal states unrepresentable, functional core/imperative shell, scripts-first coordinator
- `docs/design/v2-core-design-locks.md` -- locked engine design decisions

## Decision Log

- Step 1: Goal classified as solution_statement. Reframed to: delegation is blocked because review credibility is tied to personal voice/judgment, not just technical accuracy.
- Step 1: Three challenged assumptions recorded: identity matching may be cosmetic; assignment may not be the right trigger; fire-and-forget may be wrong model (etienne-clone validated approval-by-default).
- Step 2: Path = full_spectrum, rigor = THOROUGH, ambitiousness = ideal_solution.
- Step 4 (landscape): Parallel subagents audited all WorkTrain primitives. Key finding: reviewer assignment detection absent from all polling adapters; gate system autonomous-evaluator-only (no human path); DEFAULT_DELIVERY_PIPELINE is commit/PR-only; per-trigger soul files already exist; etienne-clone validates approval-by-default model.
- Step 7 (synthesis): Cross-executor insight: approval channel and posting identity are orthogonal dimensions. ReviewApprovalAdapter interface should be pluggable. All candidates share common prerequisites (wr.mr-review v3, assignment detection, reviewerIdentity field, post-workflow action pathway).
- Step 8 (candidate generation): 15 raw candidates from 3 parallel angles collapsed to 5 with distinct primary mechanisms. New requirements folded in: model-tier dispatch in spawn_agent, native external context tools.
- Step 9 (adversarial challenge): Rung 2 used. Three structural findings: (SF1) DEFAULT_DELIVERY_PIPELINE halts before postReviewComments stage; (SF2) stale diff anchoring problem; (SF3) approve-only gap solved by GitHub native draft edit. All three strengthen Candidate 2.
- Step 10 (selection): Fresh-context executor confirmed Candidate 2 (GitHub draft review) wins. Candidate 3 eliminated (C4 FAIL), Candidate 4 eliminated (C1 FAIL -- Slack), Candidate 1 conditional pass only (SF1 architectural issue). Candidate 2 and 5 are the clean-pass candidates; C5 (UX quality) is the deciding quality-aspirational criterion -- Candidate 2 PASS, Candidate 5 PARTIAL.
- Step 12 (review): All review findings (R1-R2-O1-O2) classified as TACTICAL. Direction unchanged. Two RED findings address scoping/ordering, not direction validity.
- Final: selectedDirection = Candidate 2 (GitHub Draft Review), runnerUp = Candidate 5 (Branch-Merge), confidenceBand = medium.

## Final Summary

### Recommendation

**Direction:** GitHub Draft Review as Approval Channel (Candidate 2)

**In one sentence:** WorkTrain reviews PRs by creating a PENDING draft review under the operator's GitHub identity, which the operator publishes via GitHub's native PR UI, with a polling loop to detect submission and resolve the gate.

**Confidence band:** medium

### What this enables

WorkTrain becomes a native reviewer in your team workflow. When you're assigned a PR (or it opens on a configured repo), WorkTrain runs a deep multi-angle review (via spawn_agent fan-out with model-tier dispatch), produces a typed `wr.review_verdict` artifact, and files a draft review on GitHub under your identity. You get a macOS notification, open GitHub, see your draft, edit/delete individual findings as you see fit (voice, accuracy, tone), and click "Submit review." Your name, your standards -- WorkTrain did the cognitive sweep.

The self-improvement loop uses the same pipeline: WorkTrain reviews its own PRs in the workrail repo, and you approve the findings before they post. No special-casing.

### Architecture shape

```
github_prs_poll trigger (reviewerLogin filter)
  → wr.mr-review v3 session
      phase-0: fetch requirements (fetch_jira_issue, fetch_mr_description, fetch_url)
      phase-1-N: spawn_agent fan-out (cheap model for sweep, capable model for synthesis)
      final step: wr.review_verdict artifact (verdict, confidence, findings[{severity, summary, filePath, lineNumber}])
  → post-workflow action (separate from DEFAULT_DELIVERY_PIPELINE)
      → create PENDING draft review via GitHub API (reviewerIdentity.githubToken)
      → macOS notification: "WorkTrain draft ready on PR #N"
  → PendingDraftReviewPoller (polls every 30-60s)
      → detect draft published by operator
      → resolve gate, record in session event log
```

### Build order (with prerequisites)

1. **Post-workflow action pathway** -- new platform concept; TriggerDefinition `postWorkflowActions: [...]`; fires after session completion; reads `session.artifacts[]` not `lastStepNotes`. Zero review posting works without this.
2. **wr.mr-review v3 prerequisites** -- model-tier dispatch in spawn_agent (`SingleSpawnSpec.model?`); native external context tools (`fetch_jira_issue`, `fetch_mr_description`, `fetch_url`); wr.review_verdict findings schema extended with `filePath`, `lineNumber`.
3. **Reviewer assignment detection** -- `github_prs_poll` adapter: add `review-requested:<login>` search qualifier or `requested_reviewers[]` field + client filter. `TriggerDefinition.pollingSource`: add `reviewerLogin` field.
4. **`reviewerIdentity` field in TriggerDefinition** -- `{ githubToken, githubLogin }`, env-resolved.
5. **GitHub draft review creation** -- single API call at post-workflow action time: `POST /repos/:owner/:repo/pulls/:number/reviews` with `event: 'PENDING'` and per-finding comments.
6. **PendingDraftReviewPoller** -- polls `GET /repos/:owner/:repo/pulls/:number/reviews`, detects submission, resolves gate, appends event to session log.
7. **branchStrategy: 'read-only'** -- isolated worktree for review sessions that need to inspect PR branch without dirtying main.

### Runner-up

**Candidate 5 (Branch-Merge)** -- switch to this if: GitHub draft API rate-limits in high-volume periods, GitLab is the deployment target, or Q2 falsification condition is confirmed (see below).

### GitLab variant

GitHub draft review has no GitLab equivalent. For GitLab deployments: use Candidate 1 (console approval panel) or Candidate 5 (branch-merge) as the GitLab path. `ReviewApprovalAdapter` interface makes this a config choice, not a code fork.

### Key pre-implementation verification

**Verify before building:** Does a GitHub PENDING draft review created via REST API (`POST .../reviews` with `event: 'PENDING'`) appear in the authenticated user's browser "Finish your review" panel? The recommendation assumes yes (account-level, not session-level) -- this is reasonable and consistent with GitHub's API semantics, but should be verified with a simple API call before the PendingDraftReviewPoller is built. If the answer is no, pivot to Candidate 5.

### Residual risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| GitHub draft API session semantics unverified | HIGH | Verify with one API call before committing to architecture |
| Post-workflow action pathway not yet built | HIGH | Build first; nothing else works without it |
| GitLab gap must be scoped pre-ship | HIGH | Decision: include GitLab variant in same initiative, or explicitly out-of-scope |
| Poller crash during operator publication -- gate stuck | MEDIUM | On daemon restart, check `GET .../reviews` to detect already-submitted drafts; reconcile with session event log |
| Session wr.review_verdict artifact becomes stale after operator edits | MEDIUM | Record what was actually posted in a separate field or event, distinct from what WorkTrain generated |
| Multiple sessions racing on same PR | MEDIUM | Deduplication guard at trigger level (already exists: 30s dispatch dedup; verify it's sufficient) |
| Token scope: PAT needs `pull_requests: write` + SAML authorization per-org | LOW | Document in triggers.yml setup guide; fail clearly with 403 rather than silently |
| wr.mr-review v3 confidence calibration | MEDIUM | Do not enable quality-gating based on confidence until empirically calibrated |
