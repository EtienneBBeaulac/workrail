# Design Candidates: Automated MR Review with Identity-Matched Posting
## Angle B -- Approval Channel Focus

**Focus angle:** Anchor every candidate to the riskiest assumption -- build the most defensible design that does not bet on any single assumption being true. The riskiest assumption is that per-finding approval (C5) requires a heavy approval channel (Slack or web UI). Each candidate handles the approval channel differently, from the simplest possible to the most sophisticated, without betting the whole feature on one channel working.

**Persona:** A pragmatic ops engineer who has been burned by over-engineered systems that never shipped, and deeply values "things that work on day one with minimal moving parts."

---

## Candidate A: File-Based Approval Gate (Structured JSON Handshake)

**Primary mechanism:** The gate parks the session, writes a structured approval manifest to `~/.workrail/review-outbox/<sessionId>.json`, and the operator edits the file (or runs a thin CLI shim) to approve/drop individual findings before running `worktrain review-deliver <sessionId>`.

**p-value:** 0.05 (unlikely -- most assistants reach for Slack or a web UI first)

### How it works end-to-end

When `wr.mr-review` completes, `requireConfirmation: true` on the final step parks the session at `gate_checkpoint`. Instead of spawning an autonomous gate evaluator, the trigger router detects a new `gateKind: 'human_approval'` field on the step and writes a structured approval manifest to a well-known path:

```
~/.workrail/review-outbox/<sessionId>.json
```

The manifest contains the full `wr.review_verdict` artifact -- verdict, confidence, and the `findings[]` array -- with an `approved` boolean field on each finding (`true` by default). The operator opens the file in any editor, sets `approved: false` on any finding they want to drop, saves, and runs:

```bash
worktrain review-deliver <sessionId>
```

The CLI reads the manifest, constructs a filtered `wr.review_verdict` (approved findings only), and calls `resumeFromGate` with a synthesized `GateVerdict: approved`. The delivery pipeline's new `postReviewStage` reads the reviewer identity from `TriggerDefinition.reviewerIdentity` and posts the filtered findings as inline and summary comments under the operator's GitHub/GitLab token.

The acknowledgment comment ("I've been assigned as reviewer and will post a full review shortly") is posted immediately at trigger-fire time via a lightweight `postAckStage` that runs before the workflow session starts -- no gate needed for that part.

### WorkTrain primitives used and extended

- **Gate system extended:** new `gateKind: 'human_approval'` field on workflow steps. The trigger router checks this field before deciding whether to spawn the autonomous gate evaluator or write the approval manifest instead. The engine itself is untouched -- `requireConfirmation: true` still parks the session; the router's gate-dispatch logic gains a branch.
- **Delivery pipeline extended:** new `postAckStage` (fires before workflow start) and `postReviewStage` (fires after gate resume with approved verdict). Both stages read `trigger.reviewerIdentity` for auth.
- **`TriggerDefinition` extended:** new `reviewerIdentity: { githubToken, githubLogin }` (or gitlab variant) field. Resolved from environment at load time (same pattern as `hmacSecret`).
- **New `reviewerAssignedFilter`** on `github_prs_poll` and `gitlab_poll` pollingSource: `reviewerLogin: "etienneb"`. The adapters add `requested_reviewers` to `GitHubPR` and `reviewers` to `GitLabMR`, and the polling scheduler filters to PRs where the configured login appears.

### New infrastructure required

- One new file: `~/.workrail/review-outbox/<sessionId>.json` (written by trigger router, read by CLI command)
- One new CLI command: `worktrain review-deliver <sessionId>` (reads manifest, calls resumeFromGate, triggers postReviewStage)
- No new service, no Slack app, no web UI
- The manifest file is a human-readable JSON blob -- the operator can open it in VS Code, approve/drop with simple edits, or write a one-liner script to auto-approve all findings

### Criteria assessment (C1-C8)

- **C1 (native fit):** Configured entirely in `triggers.yml` (new `reviewerIdentity` + `reviewerAssignedFilter` fields). No new service. Passes.
- **C2 (approval gate integrity):** No silent post path. `postReviewStage` only runs after `worktrain review-deliver` is explicitly called and the manifest file exists with operator-written state. Passes.
- **C3 (reviewer assignment detection):** New `reviewerLogin` filter on polling adapters. Requires adding `requested_reviewers` to `GitHubPR` type and `?reviewer_username=` query param to GitLab adapter. Bounded work, no new service. Passes.
- **C4 (posting identity):** `trigger.reviewerIdentity.githubToken` used in `postReviewStage` for API calls. Posting appears as the operator's account. Passes.
- **C5 (approval UX quality):** The file-edit UX is not fast for non-technical operators, but for a solo ops engineer who lives in the terminal it is sub-2-minute. Granularity is per-finding (each finding has its own `approved` field). Trades UX polish for zero new infrastructure. Partial pass -- acceptable for day-one.
- **C6 (self-improvement loop):** WorkTrain reviewing its own PRs uses exactly the same pipeline -- the daemon writes the manifest, a human (or a future autonomous approver) calls `review-deliver`. The seam exists. Passes.
- **C7 (team scale):** Each reviewer adds their own trigger with their own `reviewerIdentity` and `reviewerLogin`. The manifest file lives under `<sessionId>.json` -- no collision. Passes.
- **C8 (quality coupling):** Quality gate is enforced by the manifest: if `wr.review_verdict` confidence is `low`, `postReviewStage` can refuse to post and require the operator to add `force: true` to the manifest. This prevents weak reviews from posting silently. Passes.

---

## Candidate B: Enriched Outbox + `worktrain review-approve` Interactive CLI

**Primary mechanism:** The gate writes per-finding entries to `outbox.jsonl` with structured metadata, and a new `worktrain review-approve <sessionId>` CLI command presents an interactive approve/drop TUI that writes back to a typed response file, then triggers delivery.

**p-value:** 0.12 (slightly more common -- CLI-based approval UIs appear occasionally, but the per-finding outbox extension is unusual)

### How it works end-to-end

The existing `outbox.jsonl` structure is extended. Today each entry is `{ id, message, metadata, timestamp }`. The new schema adds a `responseSchema` field and a `responseFile` path:

```json
{
  "id": "...",
  "message": "Review ready: PR #42 -- 3 findings need approval",
  "metadata": { "sessionId": "...", "workflowId": "wr.mr-review", "kind": "review_approval_request" },
  "responseSchema": "review_approval",
  "responseFile": "~/.workrail/review-responses/<id>.json",
  "findings": [ { "id": "f1", "severity": "major", "summary": "..." }, ... ],
  "timestamp": "..."
}
```

The `worktrain review-approve` CLI reads the outbox, finds entries with `kind: 'review_approval_request'`, and renders a simple terminal list. The operator presses `y`/`n`/`e` (approve/drop/edit comment) on each finding. The CLI writes a `review_approval` response to `responseFile` and then calls `resumeFromGate` internally.

The gate resume path in the trigger router polls `responseFile` existence (bounded poll, 90-minute timeout). When the file appears, it reads the typed response, constructs the filtered verdict, and fires `postReviewStage`.

This approach keeps the outbox as the canonical notification channel (already exists) and extends it with structured response capability rather than replacing it.

### WorkTrain primitives used and extended

- **Outbox extended:** `OutboxMessage` gains optional `responseSchema`, `responseFile`, and `findings[]` fields. The trigger router writes these fields when parking a `human_approval` gate.
- **Gate polling loop:** the trigger router's gate-dispatch path adds a file-poll branch for `human_approval` gates (polls every 30s, timeout configurable via trigger). No new long-lived process needed -- the trigger router's existing async gate evaluation loop handles this.
- **New CLI command:** `worktrain review-approve` -- reads outbox, renders TUI, writes response file.
- **Delivery pipeline extended:** `postReviewStage` reads `trigger.reviewerIdentity` (new field) for auth.
- **`TriggerDefinition` extended:** `reviewerIdentity`, `reviewerAssignedFilter` (same as Candidate A).

### New infrastructure required

- Schema extension to `OutboxMessage` (backward-compatible -- old consumers ignore new fields)
- One new CLI command with a simple interactive loop (no external TUI library needed -- readline suffices)
- One new polling branch in the trigger router's gate-dispatch path (bounded, timeout-safe)
- No new service, no Slack, no web UI

### Criteria assessment (C1-C8)

- **C1 (native fit):** Configured in `triggers.yml`. The outbox is already native WorkTrain infrastructure. Passes.
- **C2 (approval gate integrity):** Gate only resumes when `responseFile` is written by the CLI. No silent post path exists -- the poll loop times out and writes an outbox escalation if no response arrives. Passes.
- **C3 (reviewer assignment detection):** Same polling adapter extension as Candidate A. Passes.
- **C4 (posting identity):** Same `reviewerIdentity` field. Passes.
- **C5 (approval UX quality):** The CLI TUI is faster than editing a JSON file -- arrow keys and single keystrokes. Still requires the operator to be in the terminal, but is genuinely sub-90-second for a 3-5 finding review. Per-finding granularity. Good pass.
- **C6 (self-improvement loop):** The same approval channel works for WorkTrain reviewing its own PRs. An autonomous approver could write the `responseFile` programmatically. Passes.
- **C7 (team scale):** Each reviewer runs `worktrain review-approve` with their own session ID. The response file is session-scoped. No collision. Passes.
- **C8 (quality coupling):** The CLI can surface a confidence warning ("confidence: low -- are you sure you want to post?") and require explicit confirmation before writing the response file. Passes.

---

## Candidate C: WorkRail Console Interactive Approval Panel

**Primary mechanism:** The gate writes pending-approval state to the session store (a new `gate_pending_human_approval` event kind), and the WorkRail Console grows a minimal interactive approval panel -- a single-page view with per-finding checkboxes and a "Post Review" button -- that writes back via a new `POST /api/v2/review/approve` endpoint.

**p-value:** 0.20 (moderately common -- extending the console with interactivity is an obvious next step, though the console is currently read-only)

### How it works end-to-end

When a `human_approval` gate fires, the trigger router appends a `gate_pending_human_approval` event to the session event log. This event carries the full `wr.review_verdict` artifact as its payload. The WorkRail Console already reads the session store -- it immediately surfaces this session in the dashboard with a "Pending Approval" badge.

The operator opens the console (`http://localhost:3100`), navigates to the session, and sees a review approval panel: the verdict summary, confidence band, and a list of findings each with an approve/drop checkbox. A "Post Review" button (disabled until at least one finding is approved) sends a `POST /api/v2/review/approve` with the sessionId and the per-finding approval state.

The console server writes a `gate_human_verdict` event to the session store and signals the trigger router's gate-resume path (via `DaemonEventEmitter` or a simple file poll -- the console server and daemon share the same process in the current architecture). The trigger router calls `resumeFromGate` with the operator-constructed verdict, and `postReviewStage` fires.

### WorkTrain primitives used and extended

- **Session event log extended:** new event kind `gate_pending_human_approval` (carries verdict payload). New event kind `gate_human_verdict` (carries per-finding approval state). Both are appended to the existing session store.
- **WorkRail Console extended:** new route `/sessions/:id/review-approve` (HTML page). New API endpoint `POST /api/v2/review/approve`. The console server is already a standalone HTTP server -- adding one route and one endpoint is additive.
- **Gate resume path extended:** new `human_approval` branch in trigger router that polls `gate_human_verdict` events (or listens on `DaemonEventEmitter`).
- **Delivery pipeline extended:** `postReviewStage` + `postAckStage` as in previous candidates.
- **`TriggerDefinition` extended:** `reviewerIdentity`, `reviewerAssignedFilter`.

### New infrastructure required

- Two new session event kinds (engine event log, append-only)
- One new console route + one new API endpoint (the console server already exists)
- No new external service, no Slack, no authentication (console is already unauthenticated on localhost)
- The console is currently read-only by design -- this breaks that invariant. Acceptable because the write surface is narrow (one endpoint, one action type) and the console is localhost-only.

### Criteria assessment (C1-C8)

- **C1 (native fit):** Configured in `triggers.yml`. Uses existing console + session store infrastructure. Passes.
- **C2 (approval gate integrity):** Gate only resumes when `gate_human_verdict` event is appended by the console API. No silent post path. Passes.
- **C3 (reviewer assignment detection):** Same polling adapter extension. Passes.
- **C4 (posting identity):** Same `reviewerIdentity` field. Passes.
- **C5 (approval UX quality):** Browser UI with checkboxes is the most ergonomic of the non-Slack options. Sub-90-second for 5 findings. Per-finding granularity. The console is already accessible at a known localhost URL. Strong pass.
- **C6 (self-improvement loop):** WorkTrain reviewing its own PRs could use the same console panel, or a future autonomous approver could hit the same endpoint. Passes.
- **C7 (team scale):** Each reviewer's console shows their pending sessions. Multiple reviewers can use the same infrastructure. Passes.
- **C8 (quality coupling):** The console panel can surface the confidence band prominently and require acknowledgment before enabling the "Post Review" button on low-confidence verdicts. Passes.

**Notable tradeoff vs. other candidates:** breaks the console's read-only invariant. The console documentation (`console/README.md`) states "no interactive actions." This is a genuine design tension -- adding interactivity to a read-only observer changes the trust model. The write surface is narrow and localhost-only, which limits the risk, but it is a real constraint to document.

---

## Candidate D: Slack Block Actions -- Full Etienne-Clone Port

**Primary mechanism:** Port the etienne-clone Slack approval flow directly into WorkTrain as a first-class notification adapter. The gate writes a `pending_review` message to a Slack channel via Socket Mode, and the operator uses Slack block action buttons (per-finding post/drop/edit) before an approve-all final action triggers delivery.

**p-value:** 0.50 (the most "obvious" answer -- Slack integration is what most teams reach for first, and the etienne-clone validates it works)

### How it works end-to-end

WorkTrain gains a new `NotificationAdapter` type: `SlackApprovalAdapter`. When a `human_approval` gate fires, the trigger router calls `adapter.sendReviewApproval(sessionId, verdict)`, which posts a Slack message using the Block Kit format validated in etienne-clone: a header block with PR title and verdict summary, then one section block per finding with "Post" / "Drop" / "Edit" buttons and a severity badge.

The operator clicks individual "Post" or "Drop" buttons in Slack. Each click sends a block action payload to WorkTrain's Slack Socket Mode listener (or an outbound webhook receiver). The `SlackApprovalAdapter` maintains a `PendingReviewStore` -- a per-session in-memory (or file-backed) state machine tracking which findings have been approved, dropped, or are pending. When all findings have a disposition (or the operator clicks "Approve All"), the adapter writes the final approval state and signals the gate-resume path.

The delivery pipeline's `postReviewStage` then posts approved findings as GitHub/GitLab comments under the operator's identity.

### WorkTrain primitives used and extended

- **`NotificationService` extended:** new `SlackApprovalAdapter` implementing a `ReviewApprovalAdapter` interface. Injected alongside the existing macOS/webhook notification adapters.
- **Gate resume path extended:** `human_approval` branch calls `adapter.awaitApproval(sessionId, timeoutMs)` which resolves when the `PendingReviewStore` reaches a terminal state.
- **New `SlackConfig` in `TriggerDefinition`:** `slackBotToken`, `slackChannelId`, `slackSocketMode: true/false`. Resolved from environment.
- **New `PendingReviewStore`:** simple file-backed state machine at `~/.workrail/review-pending/<sessionId>.json` -- survives daemon restarts.
- **Delivery pipeline extended:** `postReviewStage` + `postAckStage` + `reviewerIdentity` field (same as other candidates).

### New infrastructure required

- Slack app registration: Bot Token Scopes (`chat:write`, `reactions:write`), Socket Mode or a public-facing webhook URL for block actions
- `PendingReviewStore` (new module, ~200 lines)
- `SlackApprovalAdapter` (new module, ~300 lines; most logic already validated in etienne-clone)
- Slack block action routing in the daemon's HTTP server or Socket Mode handler
- If Socket Mode: no public URL needed (outbound WebSocket). If webhook: requires publicly accessible URL (not localhost-friendly)

### Criteria assessment (C1-C8)

- **C1 (native fit):** Mostly native -- configured in `triggers.yml` (`slackConfig` fields), no new separate service. Socket Mode runs inside the daemon process. Passes with caveat: requires external Slack app setup.
- **C2 (approval gate integrity):** The `PendingReviewStore` ensures no finding posts without a recorded approval action. The gate times out with an outbox escalation if no Slack response arrives. Passes.
- **C3 (reviewer assignment detection):** Same polling adapter extension. Passes.
- **C4 (posting identity):** Same `reviewerIdentity` field. Passes.
- **C5 (approval UX quality):** Best-in-class UX of all candidates. Per-finding granularity with one-tap actions in the tool the operator already has open. Sub-30-second for a 5-finding review. Strong pass.
- **C6 (self-improvement loop):** The self-improvement loop approval could use the same Slack channel, or a future autonomous approver could programmatically write the `PendingReviewStore`. Passes with friction.
- **C7 (team scale):** Each reviewer configures their own `slackChannelId` (DM or private channel). Fully parallel. Passes.
- **C8 (quality coupling):** Slack message can surface the confidence band prominently. Low-confidence verdicts get a warning block. Passes.

**Critical risk:** Slack app setup is an external dependency. If the operator's Slack workspace has restricted app installation, Socket Mode requires IT approval. The whole feature is blocked if Slack setup fails. This is the most complete UX but the highest infrastructure bet. It should be designed as an opt-in adapter, not the only approval path -- otherwise Candidates A or B must exist as fallback.

---

## Candidate E: Approval-by-Annotation -- Branch-Push as the Approval Signal (p < 0.10)

**Primary mechanism:** Skip an explicit approval UI entirely. After `wr.mr-review` completes, WorkTrain commits the `wr.review_verdict` as a structured JSON artifact to a review branch and pushes it. The operator reviews the artifact in the GitHub/GitLab diff view, edits the `findings[]` array directly in the PR (drop unwanted findings by deleting them, add a `drop: true` field, or reorder), and merges the review branch into a review-staging branch. The merge event is the approval signal -- WorkTrain's webhook trigger detects the merge and fires `postReviewStage`.

**p-value:** 0.03 (highly unconventional -- uses the code review workflow itself as the approval UX, which is circular but not incoherent)

### How it works end-to-end

When `wr.mr-review` completes, instead of parking at a gate, the delivery pipeline runs a modified `gitDeliveryStage` that:

1. Creates a short-lived branch `review-staging/<sessionId>` in the workspace
2. Commits the `wr.review_verdict` artifact as `review-output.json` to that branch
3. Opens a "review approval PR" from `review-staging/<sessionId>` to a dedicated `review-inbox` branch

The operator sees this PR in GitHub/GitLab like any other PR. They open `review-output.json`, read the findings, and edit the file directly -- deleting findings they want to drop or adding `"approved": false`. They merge (or approve) the PR.

WorkTrain has a second trigger (`github_prs_poll` with `targetBranch: "review-inbox"`) watching for merges to `review-inbox`. When a merge is detected, it reads `review-output.json` from the merged commit, constructs the approved verdict from the remaining (non-dropped) findings, and fires `postReviewStage` against the original PR.

### WorkTrain primitives used and extended

- **Delivery pipeline:** no new gate needed. `gitDeliveryStage` gains a `createReviewStagingBranch` mode (controlled by `trigger.reviewDelivery: 'branch-annotation'`).
- **Second polling trigger:** a `github_prs_poll` or `gitlab_poll` trigger with a `targetBranch` filter and `workflowId: 'wr.review-dispatch'` -- a thin workflow that reads `review-output.json`, constructs the approval verdict, and fires the `postReviewStage` delivery action.
- **`TriggerDefinition` extended:** `reviewDelivery: 'branch-annotation' | 'gate'` field. `reviewerIdentity` for posting auth.
- **No new approval channel**: the approval UX is the standard GitHub/GitLab PR diff view -- zero new UI infrastructure.

### New infrastructure required

- A `review-inbox` branch (permanent, never deleted -- serves as the merge target)
- A thin `wr.review-dispatch` workflow (reads `review-output.json`, emits approval verdict)
- A second polling trigger in `triggers.yml` watching for merges to `review-inbox`
- Minor extension to `gitDeliveryStage` to support `createReviewStagingBranch` mode
- No Slack, no console changes, no CLI commands, no external dependencies

### Criteria assessment (C1-C8)

- **C1 (native fit):** Configured entirely in `triggers.yml` (two triggers) and a thin workflow file. No new service. Passes.
- **C2 (approval gate integrity):** No silent post path. `postReviewStage` only fires when the review-staging PR is merged (an explicit operator action). The review-inbox branch is the gate. Passes.
- **C3 (reviewer assignment detection):** Same polling adapter extension. Passes.
- **C4 (posting identity):** Same `reviewerIdentity` field. Passes.
- **C5 (approval UX quality):** Editing JSON in a GitHub PR diff is awkward but faster than most engineers expect for a small findings list. Per-finding granularity (delete a finding object = drop it). Not sub-2-minute for large finding lists without tooling. Partial pass -- UX is worse than Candidates B/C/D for large reviews.
- **C6 (self-improvement loop):** Perfect fit. WorkTrain reviewing its own PRs would create review-staging PRs in the workrail repo itself. The operator reviews and merges them. The self-improvement loop seam is identical to the external repo case. Strong pass.
- **C7 (team scale):** Each reviewer gets their own `review-inbox` branch (e.g. `review-inbox/etienneb`) and a corresponding trigger. No collision. Passes.
- **C8 (quality coupling):** The review-dispatch workflow can check `wr.review_verdict.confidence` before calling `postReviewStage` and require that the operator add an explicit `forcePost: true` field to `review-output.json` if confidence is low. Passes.

**Unexpected advantage:** the approval record is permanent, auditable, and stored in git. Every review approval is a commit with a timestamp and an author. This is the only candidate where the approval itself is archival -- all others rely on transient state (files, outbox, Slack messages) that can be lost on daemon restart or disk wipe. For compliance use cases this is a meaningful property.

**Unexpected disadvantage:** the circular structure (reviewing the review) can be confusing. "I'm getting a PR to review my review" is not an obvious UX. It requires a clear naming convention and documentation for team members to understand what `review-staging/*` PRs are. It also creates noise in the PR list.

---

## Comparison Summary (No Ranking)

| Criterion | A: File Manifest | B: Outbox CLI | C: Console Panel | D: Slack | E: Branch Annotation |
|---|---|---|---|---|---|
| C1 Native fit | Yes | Yes | Yes | Yes (with Slack app) | Yes |
| C2 Approval gate | Yes | Yes | Yes | Yes | Yes |
| C3 Assignment detection | Requires adapter work | Same | Same | Same | Same |
| C4 Posting identity | Yes | Yes | Yes | Yes | Yes |
| C5 UX quality | Adequate (file edit) | Good (CLI TUI) | Good (browser) | Best (Slack) | Awkward (JSON edit) |
| C6 Self-improvement | Seam exists | Seam exists | Seam exists | Friction | Natural fit |
| C7 Team scale | Yes | Yes | Yes | Yes | Yes (per-branch) |
| C8 Quality coupling | Yes (force field) | Yes (CLI warn) | Yes (UI gate) | Yes (Slack block) | Yes (forcePost field) |
| New infrastructure | Minimal | Minimal | Console write endpoint | Slack app + Socket Mode | review-inbox branch + trigger |
| External dependency | None | None | None | Slack workspace | None |
| Day-one risk | Lowest | Low | Low | High (Slack setup) | Low |
| UX sophistication | Low | Medium | Medium | High | Low |
| Audit trail | Session log | Session log | Session log | Session log + Slack | Git commit (permanent) |

**Approval channel spectrum:** Candidate A (file edit) -> Candidate B (CLI TUI) -> Candidate C (browser checkboxes) -> Candidate D (Slack one-tap) -> Candidate E (git merge as signal).

Candidates A and E are the unconventional ones (p < 0.10). Candidate A bets on the operator being comfortable with JSON; Candidate E bets on the "review the review" mental model being acceptable. Both are lower infrastructure bets than Candidates C and D.

The riskiest assumption (per-finding approval requires heavy infrastructure) is refuted by Candidates A, B, and E -- all three deliver per-finding granularity (C5) with zero new external services. Candidate D is the only one that bets on a specific external channel.
