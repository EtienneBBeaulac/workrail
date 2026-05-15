# Design Candidates: Automated MR Review with Identity -- Ideal End State Angle (A)

**Focus angle:** Anchor every candidate to the ideal end state -- build the best achievable design if
effort and scope were no constraint. Each candidate represents a real architectural direction for
WorkTrain, using its existing primitives where possible but not limited by them.

**Persona:** Senior distributed systems engineer with a bias toward making the right abstractions
even when it is more work upfront.

---

## Candidate 1: Full Reviewer Identity Layer with Slack Per-Finding Approval

**Primary mechanism:** A first-class `reviewerIdentity` extension to `TriggerDefinition` drives
reviewer-assignment detection in the GitHub/GitLab polling adapters, a new `humanApprovalGate`
coordinator path blocks delivery until the operator approves findings via Slack block actions, and a
new `postReviewComments` delivery stage posts inline and summary comments under the operator's token.

**p-value (typical AI would suggest this):** 0.45

### How it works end-to-end

A `github_prs_poll` trigger gains two new optional fields: `reviewerIdentity` (containing
`githubLogin` and a token resolved from env) and `reviewerAssignmentFilter: true`. When both are
set, the GitHub polling adapter switches from the standard list endpoint to the GitHub search API
with a `review-requested:<login>` qualifier, scoping dispatch to PRs where the operator is
specifically assigned. The `GitHubPR` type gains a `requested_reviewers` field. On dispatch, the
context injected into the session includes `reviewerLogin` alongside the existing `mrUrl`,
`mrTitle`, etc.

The `wr.mr-review` workflow runs through its existing phases, including parallel `spawn_agent`
sub-investigations. The workflow's final step (`phase-6-final-handoff`) already has
`requireConfirmation: true`, which parks the session at `gate_checkpoint` and returns
`WorkflowRunGateParked`. The daemon's gate handling is extended with a new gate type discriminant:
when the trigger has `reviewerIdentity` set and the sidecar records `humanApprovalRequired: true`,
the gate router takes the human-approval path instead of spawning `wr.gate-eval-generic`. In this
path, the coordinator extracts the `wr.review_verdict` artifact from the session store, formats it
as a Slack message with per-finding block actions (approve/drop/edit per finding, plus
`review:approve_all`), and posts to a configured Slack channel via Socket Mode or webhooks. The
operator sees the formatted review with finding cards. Each card has "Post" and "Drop" buttons. An
"Edit" action opens a modal with the finding text pre-filled. The operator processes findings in
under two minutes; their choices are recorded in a `ReviewApprovalDecision[]` struct. When the last
finding is actioned, the Slack app (or a polling coordinator loop) calls `resumeFromGate()` with a
`GateVerdict` that injects the approved finding list. The resumed session runs a short final step
that produces a cleaned `wr.review_verdict` artifact containing only approved findings.

The delivery pipeline then runs a new `postReviewComments` stage that reads the approved artifact
from `session.artifacts[]` (requiring a one-line change to expose artifacts alongside
`lastStepNotes` in `WorkflowRunSuccess`), calls the GitHub REST API to post inline comments for
findings with `filePath`/`lineNumber` context and a summary comment, all authenticated with the
operator's `githubToken` from `reviewerIdentity`. Idempotency markers prevent duplicate posts if
the stage retries.

### WorkTrain primitives used/extended

- `github_prs_poll` adapter: GitHub search API path added for reviewer-assignment detection. The
  `GitHubPollingSource` type gains an optional `reviewerLogin` field; `GitHubPR` gains
  `requested_reviewers`. The adapter switches API call based on whether `reviewerLogin` is present.
- `TriggerDefinition`: new `reviewerIdentity?: { githubToken: string; githubLogin: string }` and
  `humanApprovalRequired?: boolean` fields. Both resolved from env at parse time by `trigger-store.ts`.
- Gate system: the coordinator's gate router gains a new code path for `humanApprovalRequired` that
  routes to `pendingHumanApproval` state instead of spawning `wr.gate-eval-generic`. This is a
  ~300-line addition inside the existing gate-evaluator dispatcher, no structural change.
- `PipelineContext` / `WorkflowRunSuccess`: expose `artifacts[]` alongside `lastStepNotes` so the
  new delivery stage can read the `wr.review_verdict` without re-loading the session store.
- Delivery pipeline: new `postReviewComments` stage that calls the GitHub REST API (or `gh api`
  via bash) to post inline and summary comments. Reads `reviewerIdentity.githubToken` from the
  trigger.
- `ReviewVerdictArtifactV1`: `findings[]` extended with optional `filePath` and `lineNumber`
  fields so inline comments can be placed correctly. Backward compatible via `.optional()`.

### New infrastructure required

- **Slack app**: the largest new dependency. Socket Mode or incoming webhooks for posting; outgoing
  webhooks or OAuth for button actions. The `PendingReviewStore` from etienne-clone is the correct
  prior art -- a per-finding state machine keyed by Slack message ts and review session ID.
  Approximately 600-800 lines of new TypeScript plus Slack app configuration. This is the riskiest
  assumption: if Slack infra is unacceptable, the per-finding UX degrades to a coarser channel.
- `ReviewApprovalDecision` type: a discriminated union `{ findingId: string; decision: 'post' | 'drop' | 'edit'; editedText?: string }[]` stored in the gate sidecar during the approval wait.
- `reviewerIdentity` env resolution in `trigger-store.ts`: same pattern as existing token resolution.
- GitHub inline comment API integration: `POST /repos/:owner/:repo/pulls/:pull_number/reviews` with
  per-finding `comments[]` array. Idempotency via body marker (same pattern as etienne-clone's
  `postReviewToGitLab()` idempotency markers).

### Criterion analysis

- **C1 (native fit):** All new behavior is in `triggers.yml` (`reviewerIdentity`, `humanApprovalRequired`),
  soul files (persona/voice for the agent), and standard workflow IDs. No new external service beyond
  the Slack app. Satisfies if Slack is acceptable; partial if it is not.
- **C2 (approval gate integrity):** Every review is gated behind per-finding Slack approval. No
  code path posts without at least one approved finding. Zero silent post path. Fully satisfies.
- **C3 (reviewer assignment detection):** GitHub search API with `review-requested:<login>` qualifier.
  GitLab equivalent: `?reviewer_id=<uid>` on the MR list API. Both are bounded additions to the
  existing polling adapters. Fully satisfies.
- **C4 (posting identity):** Posts as operator via `reviewerIdentity.githubToken` and `githubLogin`.
  The PR review API `submitted_by` is the operator's username. Fully satisfies.
- **C5 (approval UX quality):** Per-finding Slack block actions, equivalent to etienne-clone's
  validated model. Sub-two-minute approval is achievable. Best-in-class satisfaction.
- **C6 (self-improvement loop):** WorkTrain reviewing its own PRs uses the exact same pipeline.
  `reviewerIdentity` would be the operator's identity -- WorkTrain posts findings under the
  operator's name on the workrail repo's own PRs. The architecture is unchanged for self-review.
  Clean seam.
- **C7 (team scale):** A second reviewer adds their own trigger with their own `reviewerIdentity`
  fields and their own `soulFile` for voice. The Slack channel can be per-reviewer or shared. No
  forking of infrastructure -- the Slack app is shared, each reviewer is a different trigger config.
  Satisfies.
- **C8 (quality coupling):** Per-finding drop means weak findings never post. Additionally, the
  `humanApprovalRequired: true` gate can be conditioned on a minimum `confidence` threshold in the
  `wr.review_verdict` artifact -- reviews below a configurable threshold can auto-drop all findings
  and notify the operator rather than opening a Slack approval flow for a low-quality batch. Strong
  forcing function.

---

## Candidate 2: Console-First Approval -- Extend WorkTrain Console with Interactive Review Inbox

**Primary mechanism:** The existing read-only WorkTrain Console is extended with a write-capable
approval endpoint; the coordinator posts `wr.review_verdict` payloads to a new
`/api/v2/review/pending` endpoint; the operator opens the console (already running at
`localhost:3100+`), inspects per-finding cards with approve/drop toggles, and submits the decision
via a button click that calls back to the coordinator, which then calls `resumeFromGate()` and
triggers delivery.

**p-value (typical AI would suggest this):** 0.12

### How it works end-to-end

The WorkTrain Console (`src/console/standalone-console.ts`) is currently a read-only HTTP server
that reads `~/.workrail/data/sessions/` directly. This candidate upgrades it to a lightweight
write-capable approval server for review sessions only -- no general mutation, no authentication
changes, scoped entirely to the review approval flow.

When a `wr.mr-review` session parks at the gate, the gate router (extended for `humanApprovalRequired`)
writes the pending `wr.review_verdict` to a new in-memory store (backed by a JSONL file at
`~/.workrail/review-inbox.jsonl` for crash recovery). A new console route `GET /api/v2/review/pending`
returns the list of pending reviews with their session IDs and finding arrays. The console UI renders
a "Reviews" tab alongside the existing session list. Each pending review shows the PR title,
verdict, confidence, and a finding table with per-row "Post" / "Drop" toggle buttons. A "Submit
approval" button is enabled once all findings are actioned. On submit, the browser calls
`POST /api/v2/review/pending/:sessionId/approve` with the `ReviewApprovalDecision[]` body. The
console server validates, calls `resumeFromGate()` with the constructed `GateVerdict`, removes the
entry from `review-inbox.jsonl`, and responds 200.

The `NotificationService` sends a macOS native notification when a review is ready for approval:
"WorkTrain review ready -- 5 findings need your approval." The operator clicks the notification
(or checks the console proactively), spends 60-90 seconds on the finding table, and submits.
Delivery follows the same `postReviewComments` stage as Candidate 1.

### WorkTrain primitives used/extended

- `standalone-console.ts`: upgraded from read-only to partially write-capable. New routes
  `GET /api/v2/review/pending` and `POST /api/v2/review/pending/:sessionId/approve`. The existing
  session-read routes are unchanged. The console process gains a reference to the coordinator's
  gate-resume function -- this requires either an in-process architecture (console and daemon in the
  same Node process, which is already the case for the standalone daemon) or a local IPC channel.
  Since `worktrain console` is currently a standalone process, a lightweight named pipe or Unix
  socket between the daemon and console processes is needed.
- Gate router: same `humanApprovalRequired` extension as Candidate 1. Writes to `review-inbox.jsonl`
  instead of posting to Slack.
- `NotificationService`: existing macOS notification is used to alert the operator. No new
  notification infrastructure -- the notification carries a URL to the console's review tab.
- `PipelineContext` / `WorkflowRunSuccess`: same artifacts[] exposure as Candidate 1.
- Delivery pipeline: same `postReviewComments` stage as Candidate 1.

### New infrastructure required

- **Console write capability**: the console transitions from a pure read server to a server with two
  write endpoints scoped to review approval. This is architecturally meaningful -- the console is
  now a participant in the workflow lifecycle, not just an observer. Approximately 400-600 lines of
  new TypeScript in the console layer plus a UI component (~300 lines of vanilla JS or the existing
  console's frontend framework).
- **Daemon-to-console IPC**: the `POST .../approve` handler in the console process needs to call
  `resumeFromGate()` which lives in the daemon. If both run in the same process (possible in the
  standalone daemon+console mode), this is a direct function call. If separate processes, a Unix
  domain socket or HTTP loopback call is needed. The standalone mode integration is the clean path.
- `review-inbox.jsonl`: a new JSONL file in `~/.workrail/` that persists pending review approvals
  across daemon restarts. The coordinator re-registers pending reviews on startup from this file.
- `ReviewApprovalDecision` type: same as Candidate 1.
- `reviewerIdentity` in `TriggerDefinition`: same addition as Candidate 1.
- GitHub reviewer-assignment detection: same polling adapter extension as Candidate 1.

### Criterion analysis

- **C1 (native fit):** The console is already part of WorkTrain's native tooling. Extending it with
  two approval endpoints is additive and requires no external service dependency. Stronger native fit
  than the Slack candidate. Fully satisfies.
- **C2 (approval gate integrity):** Every review parks in `review-inbox.jsonl` and blocks delivery
  until the operator calls the approve endpoint. The JSONL backing means approval state survives
  daemon crashes. Zero silent post path. Fully satisfies.
- **C3 (reviewer assignment detection):** Same polling adapter extension as Candidate 1. Satisfies.
- **C4 (posting identity):** Same `reviewerIdentity` field and posting stage as Candidate 1. Satisfies.
- **C5 (approval UX quality):** Per-finding toggles in the console UI. The console is not a push
  channel -- the operator must open a browser tab. The macOS notification provides the push signal.
  If the operator is at their computer, sub-two-minute approval is achievable. If they are on mobile
  or away from the desk, the console is inaccessible. Partial -- worse than Slack for async approval,
  better than CLI inbox for finding granularity.
- **C6 (self-improvement loop):** The same pipeline applies for WorkTrain reviewing its own PRs.
  WorkTrain's own PRs appear in the review inbox alongside external repos. Clean seam.
- **C7 (team scale):** Second reviewer adds their own trigger. The console shows all pending reviews
  from all triggers. The `reviewerIdentity.githubLogin` field labels each pending review by
  reviewer, so the shared console displays clearly whose review awaits approval. Satisfies.
- **C8 (quality coupling):** Pending reviews with low confidence can be labeled in the console UI
  ("Low confidence -- WorkTrain is uncertain about these findings"). The operator can drop all
  findings for a low-quality batch with a single "Drop all" button. Forcing function is operator
  judgment at per-finding granularity.

---

## Candidate 3: Approval-via-Reply -- Review Comments as GitHub Draft Review, Operator Publishes

**Primary mechanism:** WorkTrain submits the full review as a GitHub "pending" draft review under
the operator's identity (never published), posts a notification with the draft review URL, and the
operator publishes it (or dismisses it) directly in the GitHub PR UI with a single click -- making
the GitHub PR interface itself the approval channel.

**p-value (typical AI would suggest this):** 0.08

### How it works end-to-end

GitHub's Pull Request Review API has a two-phase model: `POST /repos/:owner/:repo/pulls/:number/reviews`
with `event: 'PENDING'` creates a draft review visible only to the reviewer (the authenticated user).
Pending reviews appear in the GitHub UI under "Finish your review" -- the reviewer sees all their
draft comments, can edit or delete individual comments, and can publish with "Submit review" or
discard with "Dismiss". This is exactly per-finding granularity with zero new UI infrastructure --
it uses GitHub's existing draft review flow.

WorkTrain completes `wr.mr-review`, produces `wr.review_verdict`, parks at the gate. The gate
router (extended for `humanApprovalRequired`) calls the GitHub API to create a pending draft review
under the operator's `reviewerIdentity.githubToken`: one draft inline comment per finding (with
`path`, `line`, `body`), plus a summary comment in the review body. The draft review ID is stored
in the gate sidecar. WorkTrain posts a macOS notification: "WorkTrain draft review ready on
<PR title> -- click to review in GitHub" with a direct link to the PR's review page.

The operator clicks the link, sees their draft review in the GitHub PR UI, can edit any finding's
comment text, delete noisy findings, and clicks "Submit review" (Approve/Comment/Request changes).
WorkTrain has no way to detect the submission in real time via the GitHub REST API -- it must poll.
The coordinator polls `GET /repos/:owner/:repo/pulls/:number/reviews` every 30-60 seconds for the
operator's `reviewerLogin`, checking whether the pending review has transitioned to a submitted
state. When the poll detects the submission, it reads the final submitted review's comments (the
operator may have edited them), writes a synthetic `ReviewApprovalDecision[]` based on what was
actually submitted vs. what was drafted, and stores the result. Since delivery has already happened
(GitHub published the review), the gate is resolved by logging the submission event and cleaning up
the sidecar -- there is no second posting step.

This inverts the delivery model: WorkTrain posts the draft; the operator publishes it. The `wr.mr-review`
session's gate is resolved asynchronously when the polling loop detects the submission.

### WorkTrain primitives used/extended

- `github_prs_poll` adapter: reviewer-assignment detection same as Candidates 1-2. Additionally,
  the polling adapter gains an optional post-dispatch polling loop that monitors pending draft
  reviews for a specific login on specific PRs. This can be a second polling trigger with a shorter
  interval (30s) scoped to the operator's login.
- Gate router: extended for `humanApprovalRequired` -- but the gate action is "create draft review"
  and "start polling for submission" rather than "wait for Slack action" or "wait for console POST".
  The coordinator writes a `pendingDraftReview` record to the gate sidecar with the draft review ID.
- `TriggerDefinition`: `reviewerIdentity` field same as other candidates. No `humanApprovalRequired`
  field needed -- the draft-review path is triggered automatically by `reviewerIdentity` being present.
- `wr.review_verdict`: findings need `filePath` and `lineNumber` fields for inline comment placement.
  Same extension as Candidate 1.
- `NotificationService`: macOS notification used for the "draft review ready" alert. Existing
  infrastructure with a new message type.

### New infrastructure required

- **Draft review polling loop**: a coordinator background task (or an additional polling trigger)
  that periodically calls `GET .../pulls/:number/reviews` to detect when the pending review has been
  submitted. This is new coordinator infrastructure: a `PendingDraftReviewPoller` that reads
  `pendingDraftReview` records from the gate sidecar directory and resolves gates on submission
  detection. Approximately 300-500 lines.
- **GitHub draft review API integration**: `POST /repos/:owner/:repo/pulls/:number/reviews` with
  `event: 'PENDING'`, inline comment array. The response includes a `review_id` stored in the sidecar.
  On submission detection, the poller reads the final review via `GET .../reviews/:review_id` to
  confirm the comments match. ~200 lines.
- No Slack app. No console write capability. No new UI. The entire approval UX is GitHub's existing
  "Finish your review" interface.
- `reviewerIdentity` env resolution: same as other candidates.
- GitHub reviewer-assignment detection: same polling adapter extension as other candidates.

### Criterion analysis

- **C1 (native fit):** No external service beyond GitHub (already required for posting). The polling
  loop is new coordinator infrastructure but requires no new configuration fields beyond
  `reviewerIdentity`. Configured entirely in `triggers.yml`. Fully satisfies.
- **C2 (approval gate integrity):** The draft review is pending -- it cannot be seen by the PR author
  or other reviewers until the operator submits it. The operator explicitly publishes or discards.
  Zero silent post path. Fully satisfies.
- **C3 (reviewer assignment detection):** Same as other candidates. Satisfies.
- **C4 (posting identity):** Draft review created and published as the operator via their token. The
  PR page shows the operator's avatar and login as the reviewer. Best-in-class satisfaction -- the
  identity is unambiguous and native to GitHub.
- **C5 (approval UX quality):** GitHub's PR review UI is the operator's natural environment. No new
  tool to learn, no new channel to monitor. Per-finding editing and deletion is native. The
  notification provides the push signal. For an operator who reviews PRs in GitHub anyway, this is
  the lowest-friction approval flow of any candidate. However, it requires the operator to be in a
  browser -- mobile GitHub is workable but less ergonomic. Sub-two-minute approval is achievable
  for a concise review.
- **C6 (self-improvement loop):** WorkTrain reviewing its own PRs creates a draft review on the
  workrail repo. The operator sees it in the GitHub PR UI, edits as needed, and publishes. Identical
  flow. Clean seam.
- **C7 (team scale):** Second reviewer adds their own trigger with their own `reviewerIdentity`.
  Each reviewer's draft reviews appear under their GitHub account. No shared approval channel to
  manage. Strongest team-scale behavior of any candidate.
- **C8 (quality coupling):** A low-quality review creates a draft review with weak findings. The
  operator sees them in the GitHub UI before submitting. They can delete all findings and dismiss
  the review. But there is no pre-draft quality gate -- a session with low `confidence` still
  creates a draft review that the operator must then dismiss. Adding a confidence-threshold check
  before creating the draft (skip draft creation if confidence < threshold, send notification
  instead) closes this gap.

---

## Candidate 4: Findings as First-Class WorkTrain Events -- Signal-Driven Approval via `signal_coordinator` Extension

**Primary mechanism:** Rather than building a new approval channel, extend the existing
`signal_coordinator` tool and `DaemonEventEmitter` event stream to carry per-finding approval
signals; the operator approves findings via a `worktrain approve` CLI subcommand that reads the
signal stream and writes structured approval responses; the daemon's gate router polls the signal
stream as the approval channel, eliminating all new external service dependencies.

**p-value (typical AI would suggest this):** 0.06

### How it works end-to-end

The `signal_coordinator` tool already writes per-session signal records to
`~/.workrail/signals/<sessionId>.jsonl` and emits `signal_emitted` events on the
`DaemonEventEmitter`. The daemon's event stream is a JSONL append log. This candidate treats the
signal channel as a bidirectional pipe: the agent emits signals (already working), and the operator
responds via a new `worktrain approve <sessionId>` CLI command that writes approval responses to a
symmetric `~/.workrail/signals/<sessionId>-responses.jsonl` file.

When `wr.mr-review` parks at the gate, the gate router takes the `humanApprovalRequired` path:
instead of spawning `wr.gate-eval-generic` or posting to Slack, it posts a macOS notification
("WorkTrain review ready -- run: `worktrain approve <sessionId>`") and polls
`~/.workrail/signals/<sessionId>-responses.jsonl` with exponential backoff for an approval response.
The operator runs `worktrain approve <sessionId>` in their terminal. This command reads the pending
`wr.review_verdict` from the session store, renders a terminal TUI (using `inquirer` or
`@clack/prompts`, which WorkTrain already uses elsewhere in the CLI) that shows each finding with
[P]ost / [D]rop / [E]dit options. The operator navigates with arrow keys, makes per-finding decisions
in under two minutes, and confirms. The CLI writes a structured `ReviewApprovalResponse` to
`~/.workrail/signals/<sessionId>-responses.jsonl`.

The polling gate router detects the response file, reads it, constructs a `GateVerdict` with the
approved findings, and calls `resumeFromGate()`. Delivery proceeds via the `postReviewComments`
stage. The signal files are cleaned up after delivery.

### WorkTrain primitives used/extended

- `signal_coordinator` tool: semantics unchanged (fire-and-observe). The extension is the symmetric
  response channel (a new responses JSONL file) -- the tool itself does not need changes.
- Gate router: `humanApprovalRequired` path polls `~/.workrail/signals/<sessionId>-responses.jsonl`
  with a configurable timeout (default 4 hours -- the gate does not expire overnight). Uses
  `fs.watch` or a short-interval poll. ~200 lines in the gate router.
- `NotificationService`: existing macOS notification with the CLI command in the message. No new
  notification infrastructure.
- `worktrain` CLI: new `approve` subcommand (~300-400 lines). Reads session artifacts via the
  console HTTP API (already accessible at `localhost:3100/api/v2/sessions/:id`), renders a TUI with
  `@clack/prompts`, writes the response file. Fully local -- no external service.
- `PipelineContext` / `WorkflowRunSuccess`: same artifacts[] exposure as other candidates.
- Delivery pipeline: same `postReviewComments` stage as other candidates.
- `TriggerDefinition`: `reviewerIdentity` field same as other candidates.
- GitHub reviewer-assignment detection: same polling adapter extension as other candidates.

### New infrastructure required

- **`worktrain approve` CLI subcommand**: the primary new code. Terminal TUI using `@clack/prompts`
  for per-finding navigation. Writes `ReviewApprovalResponse` to the response JSONL. ~300-400 lines.
- **`ReviewApprovalResponse` type**: a discriminated union `{ findingId: string; decision: 'post' | 'drop'; editedSummary?: string }[]` stored in the response JSONL.
- **Gate router polling loop**: `fs.watch` or interval-based polling of the response JSONL for
  the session. Bounded by a configurable approval timeout (default: 4 hours). ~200 lines.
- No Slack. No console write capability. No new HTTP endpoints. No external service dependencies
  beyond GitHub for posting.

### Criterion analysis

- **C1 (native fit):** All infrastructure is within WorkTrain's existing process and file system
  conventions (`~/.workrail/` sidecar files, `DaemonEventEmitter`, existing CLI). No new external
  services. Best-in-class native fit. Fully satisfies.
- **C2 (approval gate integrity):** Gate blocks until `worktrain approve` writes a response. No
  response, no delivery. The gate timeout is operator-configurable. Zero silent post path. Fully
  satisfies.
- **C3 (reviewer assignment detection):** Same polling adapter extension as other candidates. Satisfies.
- **C4 (posting identity):** Same `reviewerIdentity` and `postReviewComments` delivery stage as
  other candidates. Satisfies.
- **C5 (approval UX quality):** The terminal TUI is the approval channel. Per-finding navigation
  with arrow keys. An operator comfortable with the terminal can complete approval in under two
  minutes. An operator who does not monitor a terminal proactively may miss the notification --
  the macOS notification provides the push signal, but it requires running a command rather than
  clicking a link. Compared to Slack (push to phone, tap) or GitHub PR UI (browser bookmark), the
  CLI requires more friction if the operator is away from their desk. Partial -- excellent for
  terminal-native operators, suboptimal for mobile or browser-first operators.
- **C6 (self-improvement loop):** WorkTrain reviewing its own PRs parks at the gate; the operator
  runs `worktrain approve <sessionId>` to approve the self-review findings. The same CLI command
  works for both external and self-review sessions. Clean seam.
- **C7 (team scale):** Second reviewer adds their own trigger and runs `worktrain approve` for their
  sessions. The `~/.workrail/signals/` directory is per-machine -- each reviewer runs the daemon and
  CLI on their own machine. Clean separation. Satisfies.
- **C8 (quality coupling):** The TUI can display the review's `confidence` level prominently ("Low
  confidence review -- WorkTrain recommends reviewing all findings carefully before posting"). The
  operator sees this before approving any finding. Soft forcing function -- not a hard block, but
  visible. Can be hardened by requiring an extra confirmation step for `confidence: 'low'` sessions.

---

## Candidate 5: Review Verdict as a Persistent Knowledge Record -- Approval Deferred, Findings Fed into WorkTrain's Own Memory

**Primary mechanism:** Decouple review posting from review generation entirely: WorkTrain produces a
`wr.review_verdict` and writes it to a persistent per-PR knowledge record in a structured review
store; a separate long-running `wr.review-delivery` workflow periodically reads the store, presents
findings to the operator through a batched weekly digest, and posts approved findings in bulk --
transforming the approval model from per-review-real-time to batched-async, which surfaces patterns
across PRs and feeds WorkTrain's own codebase knowledge.

**p-value (typical AI would suggest this):** 0.04

### How it works end-to-end

This candidate challenges the assumption that review feedback must be posted to the PR before merge.
In many teams, PR review comments that arrive after the PR is merged are still acted on -- they
become follow-up commits, refactoring tasks, or convention updates. This candidate bets that
WorkTrain's findings are often high enough quality to be valuable even if delivered slightly after
merge, and that the operator's time is better spent doing a weekly 10-minute review digest session
rather than real-time per-PR approvals that fragment their workflow.

When `wr.mr-review` completes, the `wr.review_verdict` artifact is written to a persistent review
store at `~/.workrail/review-store/<repo>/<pr-number>.json`. This happens without any gate --
WorkTrain stores all findings unconditionally, regardless of quality confidence. A nightly
`wr.review-delivery` workflow (triggered by a cron-style `generic` trigger) reads the review store,
groups findings by severity and category across all unreviewed PRs, deduplicates patterns that
appear in multiple PRs (e.g., "missing error handling in async functions" appearing in 3 PRs is one
pattern finding, not three), and produces a batched `ReviewDigest` with cross-PR insight. The
digest is presented to the operator via the console's "Reviews" tab (read-only display, no
gate-based approval UX needed) and a daily notification.

The operator reviews the digest once a day or week. For findings they want to post, they use a
`worktrain post-finding <pr-number> <finding-id>` CLI command that posts that specific finding
directly to the (possibly already merged) PR or the relevant commit. For pattern findings (appearing
in multiple PRs), the CLI offers "open a GitHub issue for this pattern" as an alternative to PR
comments. The review store functions as WorkTrain's long-term codebase memory -- it accumulates
findings across sessions, enabling WorkTrain to notice that error handling in the auth middleware
has been a recurring concern for three months.

### WorkTrain primitives used/extended

- `wr.mr-review`: final step no longer requires `requireConfirmation: true` for the delivery gate.
  The session completes and its `wr.review_verdict` is written to the review store by a new
  post-session hook in the delivery pipeline.
- Delivery pipeline: new `writeReviewStoreStage` stage that reads `session.artifacts[]`, extracts
  `wr.review_verdict`, and writes it to `~/.workrail/review-store/<repo>/<pr-number>.json`. This
  runs regardless of `autoCommit` -- it is a new unconditional stage for review-type sessions.
  ~150 lines.
- `wr.review-delivery`: a new workflow that reads the review store, groups findings, deduplicates
  patterns, and presents the digest. Triggered by a `generic` trigger with a cron-like interval
  (could be a `schedule` trigger type that does not yet exist, or a webhook from an external cron
  service). This workflow's agent uses `spawn_agent` to look up PR context for findings that are
  cross-cutting. ~new workflow JSON.
- Console: new `GET /api/v2/review/digest` endpoint (read-only, consistent with the console's
  current read-only model) that renders the current review digest. No write capability needed.
- `TriggerDefinition`: `reviewerIdentity` field same as other candidates (for posting). But the
  gate system is not extended -- no `humanApprovalRequired` path needed.
- GitHub reviewer-assignment detection: same polling adapter extension as other candidates (optional
  -- can fire on PR-open if real-time assignment detection is not required for the async model).

### New infrastructure required

- **Review store**: a structured JSON store at `~/.workrail/review-store/`. Keyed by repo+PR number.
  Append-only per-PR records. ~100 lines of I/O infrastructure plus a `ReviewStoreEntry` type.
- **Pattern deduplication logic**: the `wr.review-delivery` workflow's agent groups findings across
  PRs and identifies recurring patterns. This is cognitive work done by a workflow agent session
  (using `spawn_agent` for cross-PR analysis) -- not a deterministic algorithm. The quality of
  pattern detection depends on the agent's capabilities. This is an open-ended risk.
- **`worktrain post-finding` CLI subcommand**: approximately 200-300 lines. Reads a specific finding
  from the review store, formats it, and posts via the GitHub API using `reviewerIdentity`.
- **`wr.review-delivery` workflow**: new JSON workflow definition. Uses the existing workflow engine --
  no engine changes needed.
- **Schedule trigger type** (or external cron webhook): the nightly digest requires a recurring
  trigger. If a `schedule` trigger type does not exist, an external cron that fires a `generic`
  webhook is the workaround. Creating a native `schedule` trigger type (~300 lines in the polling
  scheduler) would make this self-contained.

### Criterion analysis

- **C1 (native fit):** The review store and `wr.review-delivery` workflow are entirely within
  WorkTrain's existing patterns (new workflow JSON, new delivery stage, new CLI subcommand). A native
  `schedule` trigger would complete the picture. Satisfies with that addition.
- **C2 (approval gate integrity):** There is no real-time approval gate -- findings are stored, and
  the operator approves asynchronously via the digest. The `worktrain post-finding` command is the
  approval action. No finding posts without the operator explicitly calling the command. Satisfies
  the intent of C2 (no silent post), but by a fundamentally different mechanism: no gate at all,
  just a persistent record that requires an explicit post action.
- **C3 (reviewer assignment detection):** Optional in the async model. If the trigger fires on
  PR-open (not assignment), WorkTrain reviews every PR and stores all findings. The operator
  decides which findings to post after the fact, regardless of whether they were formally assigned
  as reviewer. The assignment signal becomes less important when posting is decoupled from review
  timing. Partially satisfies -- can be added, but the design works without it.
- **C4 (posting identity):** `worktrain post-finding` uses `reviewerIdentity.githubToken`. Satisfies.
- **C5 (approval UX quality):** The digest model is fundamentally async -- it trades real-time
  per-review approval for a batched weekly session. The per-finding granularity is excellent
  (individual `worktrain post-finding` calls). But the speed criterion (< 2 min per review) is
  inverted: the operator spends 10-15 minutes once a week rather than 2 minutes per review. For
  PRs that benefit from timely feedback (pre-merge), this is a regression. Partial -- the model
  works only if authors tolerate post-merge or delayed feedback.
- **C6 (self-improvement loop):** Outstanding fit. WorkTrain's findings on its own PRs accumulate
  in the review store. The `wr.review-delivery` workflow identifies recurring patterns in the
  workrail codebase itself -- "this anti-pattern appears in 4 sessions this month" becomes a
  backlog item. The review store becomes WorkTrain's long-term memory about its own code quality.
  Best-in-class C6 of any candidate.
- **C7 (team scale):** Second reviewer adds their own trigger and their own `reviewerIdentity`. Their
  findings go into the same review store (or a separate store keyed by reviewer). The digest can
  show per-reviewer finding counts. Satisfies.
- **C8 (quality coupling):** Low-quality findings never post silently -- the operator must explicitly
  call `worktrain post-finding` for each one. The digest's cross-PR deduplication is itself a
  quality signal: a finding that recurs across three PRs with low confidence is probably noise,
  visible as a pattern in the digest. Strongest forcing function of any candidate for preventing
  noise posting, at the cost of timeliness.
