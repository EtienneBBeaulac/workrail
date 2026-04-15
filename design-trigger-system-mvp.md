# WorkRail Autonomous Platform - Trigger System MVP Design

**Status:** Draft  
**Date:** 2026-04-14  
**Scope:** Minimal webhook server + trigger dispatcher to start workflows autonomously

> **Artifact strategy:** This document is a human-readable design reference. It is NOT execution truth.
> Durable workflow state lives in WorkRail session notes and context variables.
> If this file is lost or rewound, the session notes survive and can reconstruct the decision record.
> Capabilities confirmed available: delegation (mcp__nested-subagent__Task), web browsing (WebFetch), gh CLI.

---

## Problem Frame Packet (Deep)

### Primary users / stakeholders

| User | Job to be done | Pain today |
|---|---|---|
| Developer / MR author | Get structured feedback on code before merge | Manual review is slow; async; no consistency |
| Team lead / reviewer | Ensure MR quality without reviewing every line | Time cost; inconsistent review depth across team |
| WorkRail operator | Configure automated workflows without writing code | No trigger mechanism; must manually invoke MCP |
| WorkRail maintainer | Keep core MCP server clean while adding automation | Risk of coupling trigger infra into the MCP transport |

### Tensions

1. **Autonomy vs. accountability.** An autonomous MR reviewer posts comments under a bot identity. Developers may distrust bot feedback or feel surveilled. The system must be transparent about its nature and scope.
2. **Immediacy vs. reliability.** GitLab expects a 200 ACK within 10 seconds. The agentic loop may take 30-120 seconds. The async dispatch model handles this, but errors in the async path are invisible to GitLab -- no retry signal.
3. **Stateless webhook receiver vs. stateful WorkRail sessions.** The webhook receiver is deliberately stateless, but if the WorkRail MCP server restarts mid-session, in-flight agentic loops are lost with no recovery path in the MVP.
4. **"Smallest thing" vs. useful thing.** A 3-step review workflow that just reads diffs and posts a comment may produce low-signal output. The MVP trades quality for simplicity. The workflow YAML quality determines perceived value, not the trigger architecture.
5. **Workflow re-use vs. trigger-specific customization.** The same `mr-review-workflow-agentic` could be triggered manually (via MCP) or automatically (via trigger). But the contextVariables injected by the trigger daemon differ from those a human would provide. The workflow must be authored to work in both modes or only one.

### Success criteria

1. A GitLab MR opened event reliably triggers a WorkRail session start (P99 < 500ms from webhook receipt to `start_workflow` call)
2. The session runs to completion without human intervention for well-formed MRs
3. A comment is posted to the MR within 5 minutes of the MR being opened
4. Webhook failures (invalid signature, unknown event) return appropriate HTTP error codes and are logged
5. Multiple concurrent MR opens do not interfere with each other (session isolation)
6. The trigger daemon can be started/stopped independently of the MCP server

### Assumptions

- The WorkRail MCP server is running in HTTP mode (`WORKRAIL_TRANSPORT=http`) when the trigger daemon is active
- The `mr-review-workflow-agentic` workflow is authored for autonomous execution (no human-input steps)
- The trigger daemon has network access to both the WorkRail MCP server and the GitLab API
- GitLab is configured to send webhooks to the trigger daemon's public URL (or via tunnel for local dev)
- The agentic runner calls an LLM (Claude API) to execute each step -- the runner is not just a protocol driver

### Reframes / HMW questions

**Reframe 1: The trigger daemon is not a scheduler -- it's an event-to-intent translator.**
The daemon's job is not to run workflows; it is to translate a raw GitLab event into a WorkRail intent (workflowId + goal + context). Everything else -- session management, step execution, state durability -- is WorkRail's job. This framing keeps the daemon narrow.

**Reframe 2: The workflow YAML is the product, not the trigger server.**
The trigger server is plumbing. The thing users will experience is the quality of the `mr-review-workflow-agentic` workflow. A great trigger server with a weak workflow produces no value. The MVP should treat workflow authoring as equally important as the server code.

**HMW 1: How might we make the agentic loop observable so operators can see what happened without reading log files?**
(Answer: session notes are already durable in WorkRail's event log; the trigger daemon could surface a simple status API.)

**HMW 2: How might we recover an in-flight agentic session if the MCP server restarts?**
(Answer: WorkRail's `resume_session` use case + checkpoint tokens; the runner could checkpoint before each continue_workflow call and resume from the last checkpoint. Out of scope for MVP but the seam exists.)

### Framing risks

1. **Risk: We build a trigger server but the MCP HTTP transport can't handle concurrent sessions.** Mitigation: validate StreamableHTTPServerTransport concurrency before building the runner loop. This is the #1 pre-build check.
2. **Risk: The "agentic runner loop" is actually the hard part and gets underspecified.** The pseudocode shows `executeStep()` as a black box. In practice this needs an LLM call, tool access, and error handling. The loop pseudocode is not enough to build from -- a separate `mr-review-workflow-agentic` spec is needed.
3. **Risk: The trigger daemon becomes a general-purpose automation framework.** The anti-goals section explicitly excludes this. Enforce it by keeping `triggers.yml` schema minimal and rejecting feature requests that require dynamic config.

---

## Context / Ask

WorkRail currently operates in a fully human-in-the-loop mode: a developer calls `start_workflow` via MCP, then drives each step manually with `continue_workflow`. The ask is to design the smallest autonomous platform that lets WorkRail _start_ a workflow in response to a real external event -- specifically a GitLab MR being opened -- and complete it without human intervention, posting results back as a GitLab MR comment.

**First trigger:** `gitlab.mr.opened` → `mr-review-workflow-agentic` → MR comment with review

---

## Path Recommendation

**`design_first`** -- the dominant risk here is shaping the wrong concept. The trigger architecture could easily balloon into a general-purpose automation platform (which WorkRail is not positioned to be), or collapse into a simple script that bypasses WorkRail's durable session model entirely. The reframing question -- "what is the trigger layer's job vs. the session layer's job" -- is load-bearing and must be answered before any pseudocode.

Justification over alternatives:
- `landscape_first` would be premature: we don't need to map all trigger systems; we need to decide where WorkRail's boundary is.
- `full_spectrum` is appropriate for open-ended problems; this one has a clear outcome constraint (smallest thing, one trigger, one workflow).

---

## Constraints / Anti-Goals

**Constraints:**
- Must fit the existing WorkRail DI container and session model (no parallel session store)
- Must not require changes to workflow YAML schema for the MVP
- Must be deployable as a single additional process alongside the existing MCP server
- Must use the existing `start_workflow` → `continue_workflow` protocol as the internal dispatch mechanism
- GitLab webhook signature must be verified before any session is created
- All state lives in the WorkRail session store (append-only event log); the webhook process is stateless

**Anti-Goals:**
- Not a general automation platform -- no cron, no polling, no multi-provider fan-out in v1
- Not a workflow authoring UI -- trigger config is a static YAML file
- Not a replacement for the MCP server -- the trigger daemon sits alongside it
- No GitHub/Jira/Slack triggers in scope for MVP
- No human approval gate in the trigger path (that's a future workflow step concern)
- No retry queue, dead-letter queue, or durability for the webhook receiver itself (keep it simple; GitLab retries on 5xx)

---

## Landscape Packet

### WorkRail internals (observed)

**Entry points:**
- `src/mcp-server.ts` -- resolves transport mode (`stdio` | `http`) and starts the appropriate server
- `src/mcp/transports/http-entry.ts` -- mounts Express app, binds StreamableHTTPServerTransport at `/mcp`, scans ports 3100-3199
- `src/mcp/transports/http-listener.ts` -- minimal `createHttpListener(port)` + `bindWithPortFallback(start, end)`

**DI container (`src/di/container.ts`):**
- `bootstrap()` = `initializeContainer()` + `startAsyncServices()`
- Layered: Runtime → Config → StorageChain → V2Services → Services
- V2 bounded context: append-only `LocalSessionEventLogStoreV2`, `ExecutionSessionGateV2` (lock + health gating), content-addressed snapshot store
- Session identity: `SessionId` (branded string), tokens are opaque `ct_` / `st_` prefixed strings

**Session lifecycle (observed):**
- `start_workflow(workflowId, workspacePath, goal)` → creates session, mints first `ct_` continueToken
- `continue_workflow(continueToken, output)` → advances state, mints next token
- Sessions stored under `~/.workrail/sessions/{projectHash}/{workflowId}/{sessionId}.json`
- `ExecutionSessionGateV2` is the single choke point: acquires lock, validates health, runs callback, releases lock

**HTTP server already exists:** `src/infrastructure/session/HttpServer.ts` (feature-flagged via `sessionTools`). The trigger server will be a _separate_ Express app on a separate port, not mounted on the MCP transport.

### Reference systems

**AutoGPT `github/triggers.py`:**
- Clean separation: `GitHubTriggerBase` (reusable base) + `GithubPullRequestTriggerBlock` (event-specific)
- `BlockWebhookConfig` declares `provider`, `webhook_type`, `resource_format`, `event_filter_input`, `event_format`
- Webhook validation in `GithubWebhooksManager.validate_payload()`: checks `X-GitHub-Event` header + HMAC-SHA256 signature
- Key insight: event type is normalized to `pull_request.opened` format -- event family + action

**AutoGPT webhook manager (observed pattern):**
```python
# Validate → normalize event type → dispatch
payload_body = await request.body()
hash_object = hmac.new(webhook.secret, payload_body, sha256)
expected = "sha256=" + hash_object.hexdigest()
if not hmac.compare_digest(expected, signature_header): raise 403
event_type = header_event + "." + payload.get("action")  # e.g. pull_request.opened
```

**OpenClaw `task-executor.ts`:**
- `createQueuedTaskRun()` → `ensureSingleTaskFlow()` -- creates a TaskRecord + optional Flow wrapper
- Task lifecycle: `queued` → `running` → terminal
- Key insight: the executor is the dispatch boundary; it decouples the trigger from the runtime

**Claude Code `sessionRunner.ts`:**
- Spawns a child `claude` process per session with `spawn(execPath, args)`
- Communicates over stdin/stdout JSON lines
- Tracks `SessionActivity` (tool_use events) for status reporting
- Key insight: autonomous execution = spawn child process + observe output stream

---

## Problem Frame Packet

### The real problem

WorkRail's MCP tools are designed for a human-in-the-loop agent. `start_workflow` and `continue_workflow` are the right primitives, but they assume the agent driving them is a human-controlled LLM. The autonomous platform needs:

1. A **trigger receiver** that listens for external events and converts them to WorkRail session starts
2. An **agentic runner** that drives a WorkRail session to completion without human input
3. A **reporter** that posts structured output back to the originating system (GitLab)

### Reframe

The trigger system is not a new workflow engine -- it is an **adapter layer** that:
- Translates external events into `start_workflow` calls
- Owns the autonomous execution loop (calling `continue_workflow` in a loop until `isComplete`)
- Owns the side-effect reporting (GitLab API comment post)

WorkRail's session model remains unchanged. The trigger daemon is a client of the WorkRail MCP server (via HTTP transport).

### The minimal viable boundary

```
GitLab → [Webhook Server] → [Trigger Dispatcher] → [WorkRail MCP HTTP] → [Agentic Runner Loop] → [GitLab API]
```

Each box is a distinct concern:
- Webhook server: HTTP listener, signature validation, event normalization
- Trigger dispatcher: event-to-workflow mapping via static config
- WorkRail MCP HTTP: existing server, no changes needed
- Agentic runner loop: calls start_workflow, then loops continue_workflow until complete
- GitLab API: posts MR comment with accumulated notes

---

## Candidate Generation Expectations

**Path:** `design_first` -- candidates must include at least one direction that meaningfully reframes the problem, not just packages the obvious standalone-daemon solution.

**Required spread:**
1. The obvious solution: standalone trigger daemon as MCP client (Option A)
2. The architectural reframe: embed trigger capability inside the existing MCP server via a new tool or endpoint -- "make WorkRail autonomous from within"
3. The radical simplification: no daemon at all -- a GitLab CI job calls `start_workflow` directly as a one-shot MCP client and posts the result

**Evaluation criteria for each candidate:**
- Does it satisfy all 5 decision criteria? (zero core changes, standalone, static config, ~400 LOC, session isolation)
- What is the failure mode?
- What is the seam for future extension?

---

## Candidate Directions

### Candidate A: Standalone trigger daemon (recommended -- simplest satisfying solution)

A new Node.js process (`src/trigger/`) that:
1. Runs its own Express server on a dedicated port (e.g. 4100)
2. Connects to WorkRail's HTTP MCP server as a client
3. Has a static trigger config YAML
4. Spawns an agentic runner per trigger event

**Pros:** Clean separation, no changes to existing MCP server, horizontally composable  
**Cons:** Two processes to manage; requires WorkRail HTTP mode to be running

**Tensions resolved:** Daemon-as-independent-process (fails/restarts without touching MCP server). Concurrent sessions handled via in-flight session Set (mirrors `ExecutionSessionGateV2.activeSessions` pattern). Typed config via `TriggerConfig` Zod schema. Reporter is a post-completion side effect.  
**Tension accepted:** In-flight session loss on daemon crash (no automatic recovery in MVP; session lock TTL frees orphaned sessions).  
**Failure mode:** StreamableHTTPServerTransport concurrent session behavior unverified. Must validate before building runner.  
**Follows:** `http-listener.ts` + `http-entry.ts` split pattern (pure listener + wired entry point). `ExecutionSessionGateV2` in-flight tracking pattern.  
**Gain:** Zero changes to MCP server. Independent deployability. ~400 LOC.  
**Give up:** No automatic recovery from mid-flight crash.  
**Philosophy:** Honors errors-as-data, validate-at-boundaries, DI for I/O, small pure functions. Honors YAGNI (no retry queue, no dynamic config).  
**Scope:** Best-fit. Evidence: satisfies all 5 decision criteria.

---

### Candidate B: GitLab CI job as one-shot MCP client (radical simplification -- no daemon)

**Summary:** No persistent trigger daemon. Instead, a GitLab CI pipeline job (triggered by the MR) runs a Node.js script (`npx @workrail/trigger-runner`) that:
1. Connects to the WorkRail HTTP MCP server
2. Calls `start_workflow` + drives the loop to completion
3. Posts the review comment
4. Exits

The CI job IS the agentic runner. No long-running process.

**Tensions resolved:** Eliminates the daemon lifecycle problem entirely. No orphaned sessions on crash -- the CI job failure is visible in GitLab CI. GitLab's 10-second webhook timeout is irrelevant (CI jobs aren't webhook handlers). Session isolation is natural (each CI job is a separate process).  
**Tension accepted:** Requires a GitLab CI configuration change per repo (`.gitlab-ci.yml` edit). No central trigger config -- each repo configures its own runner. The WorkRail MCP server must be reachable from GitLab CI runners (network access concern).  
**Failure mode:** WorkRail MCP server must be publicly routable or on the same network as GitLab CI runners. Not viable for self-hosted GitLab with local WorkRail.  
**Adapts:** Claude Code `sessionRunner.ts` spawn-and-observe pattern -- but instead of spawning a child process, the CI job IS the process.  
**Gain:** Simplest possible architecture. No daemon. No webhook server. No `triggers.yml`. GitLab CI handles retry, visibility, and lifecycle.  
**Give up:** Requires GitLab CI to be the trigger mechanism (not a webhook). Tight coupling to GitLab CI; other event sources (Jira, Slack) can't use this path. Centralized trigger configuration impossible.  
**Philosophy:** Honors YAGNI (no daemon infrastructure). Conflicts with dependency-injection (no DI container -- one-shot script). Honors single-responsibility (the script does one thing).  
**Scope:** Too narrow for a platform trigger system. Solves the immediate problem but forecloses the extension seam. Best for a proof-of-concept, not an MVP platform.

---

### Candidate C: WorkRail self-triggering via `register_trigger` MCP tool (architectural reframe)

**Summary:** Add two new MCP tools to the existing server:
- `register_trigger(eventPattern, workflowId, workspacePath, goalTemplate)` -- registers a trigger in an in-memory or persisted trigger store
- Internal HTTP webhook endpoint `/triggers/gitlab` added to the existing Express app in `http-entry.ts`

The MCP server itself becomes the trigger receiver. When a GitLab webhook arrives at `/triggers/gitlab`, the server dispatches internally to `start_workflow` + spawns an async agentic runner loop.

**Tensions resolved:** No separate process to manage. Single port (3100). Operator uses MCP tools to configure triggers (same interface as everything else). Trigger registration is durable if persisted to the v2 store.  
**Tension accepted:** Violates the single-responsibility of the MCP transport layer. The MCP server now has two concerns: serving MCP protocol AND receiving webhooks. Adding the webhook route to `http-entry.ts` couples them. Failure in the webhook path can destabilize the MCP server.  
**Failure mode:** A crash in the agentic runner loop (async, unhandled rejection) could affect the MCP server process. The existing Express error handling would need to be extended. The MCP server is no longer independently stable from the trigger infrastructure.  
**Departs from:** `http-entry.ts` design philosophy (comments explicitly say: 'Bot service use case -- no workspace roots. HTTP mode is for autonomous clients'). The file is designed for one purpose; adding webhook routes changes its contract.  
**Gain:** Single process. No daemon. `register_trigger` is a natural MCP tool. Trigger config lives in WorkRail's own store (consistent with v2 event log model).  
**Give up:** MCP server independence. Clean separation of concerns. Makes MCP server harder to test (webhook side effects in a protocol server).  
**Philosophy:** Conflicts with single-responsibility, validate-at-boundaries (mixing two boundary types), and architectural-fixes-over-patches. The trigger concern is being patched into the MCP server rather than addressed at the right seam.  
**Scope:** Too broad for MVP. Requires MCP tool schema changes, a new trigger store, and entangles two concerns. Evidence: would require changes to `http-entry.ts`, `tool-registry.ts`, and DI container -- violating the zero-core-changes criterion.

---

**Decision: Candidate A.**

Candidates B and C each solve a real subset of the problem:
- B is the right answer for a proof-of-concept or single-repo use case
- C is the right long-term answer if WorkRail becomes a self-hosting platform

For the MVP -- a deployable trigger system that satisfies all 5 criteria and creates the right extension seam -- Candidate A is the only fit.

---

## MVP Spec: Webhook Server + Trigger Dispatcher

### 1. Process topology

```
Process 1: WorkRail MCP Server (existing)
  WORKRAIL_TRANSPORT=http WORKRAIL_HTTP_PORT=3100
  Exposes: POST /mcp

Process 2: WorkRail Trigger Daemon (new)
  WORKRAIL_TRIGGER_PORT=4100
  WORKRAIL_MCP_URL=http://localhost:3100/mcp
  Config: ~/.workrail/triggers.yml
  Exposes: POST /webhook/gitlab
```

### 2. Trigger config schema (`~/.workrail/triggers.yml`)

```yaml
# WorkRail trigger configuration
# Maps external webhook events to WorkRail workflow starts

triggers:
  - id: gitlab-mr-opened-review
    provider: gitlab
    event: merge_request.opened          # normalized event type
    filter:                              # optional payload matchers (all must match)
      target_branch: main               # only trigger on MRs targeting main
    workflow:
      id: mr-review-workflow-agentic
      workspacePath: /home/workrail/repos/my-project
      goalTemplate: "Review MR !{iid}: {title}"
    reporter:
      kind: gitlab_mr_comment
      mrIdPath: object_attributes.iid   # JSONPath into payload
      projectIdPath: project.id
```

**Design notes:**
- `event` uses normalized form `{event_type}.{action}` -- same convention as AutoGPT
- `filter` is a flat key-value match against the webhook payload (no CEL/jinja for MVP)
- `goalTemplate` supports `{field}` interpolation from the webhook payload
- `reporter` is declared per-trigger, not per-workflow (separation of concerns)
- `workspacePath` is the workspace the agentic runner uses -- must be a git repo the runner can access

### 3. Webhook server design (`src/trigger/webhook-server.ts`)

```typescript
// POST /webhook/gitlab
// Headers: X-Gitlab-Token (shared secret), X-Gitlab-Event
async function handleGitLabWebhook(req: Request, res: Response): Promise<void> {
  // --- Boundary validation ---
  const signature = req.headers['x-gitlab-token'] as string;
  if (!verifyGitLabSignature(signature, config.gitlab.webhookSecret)) {
    res.status(403).json({ error: 'invalid_signature' });
    return;
  }

  const eventHeader = req.headers['x-gitlab-event'] as string;
  // GitLab sends "Merge Request Hook", normalize to "merge_request.opened"
  const eventType = normalizeGitLabEvent(eventHeader, req.body);

  // Respond 200 immediately -- GitLab has a 10s timeout
  res.status(200).json({ received: true });

  // --- Async dispatch (fire-and-forget from webhook handler's perspective) ---
  dispatchTrigger(eventType, req.body).catch((err) => {
    logger.error('[trigger] Dispatch failed', { eventType, err });
  });
}
```

**GitLab signature note:** GitLab uses a shared secret token (not HMAC-SHA256). The `X-Gitlab-Token` header must equal the configured secret exactly. Simple `timingSafeEqual` comparison is sufficient and safer than string equality.

**GitLab event normalization:**
| X-Gitlab-Event header | payload.object_attributes.action | Normalized event |
|-|-|-|
| `Merge Request Hook` | `open` | `merge_request.opened` |
| `Merge Request Hook` | `update` | `merge_request.updated` |
| `Merge Request Hook` | `close` | `merge_request.closed` |
| `Merge Request Hook` | `merge` | `merge_request.merged` |

### 4. Trigger dispatcher (`src/trigger/dispatcher.ts`)

```typescript
async function dispatchTrigger(eventType: string, payload: unknown): Promise<void> {
  // 1. Find matching trigger configs
  const matches = config.triggers.filter(t =>
    t.event === eventType && matchesFilter(t.filter, payload)
  );
  if (matches.length === 0) return; // no-op

  // 2. Dispatch each match (parallel OK -- different sessions)
  await Promise.all(matches.map(trigger => runTrigger(trigger, payload)));
}

async function runTrigger(trigger: TriggerConfig, payload: unknown): Promise<void> {
  const goal = interpolateGoal(trigger.workflow.goalTemplate, payload);

  // 3. Start a WorkRail session via MCP HTTP
  const startResult = await mcpClient.startWorkflow({
    workflowId: trigger.workflow.id,
    workspacePath: trigger.workflow.workspacePath,
    goal,
  });

  // 4. Run the agentic loop
  const notes = await runAgenticLoop(startResult.continueToken, trigger, payload);

  // 5. Report results
  await report(trigger.reporter, payload, notes);
}
```

### 5. Agentic runner loop (`src/trigger/agentic-runner.ts`)

```typescript
async function runAgenticLoop(
  initialToken: string,
  trigger: TriggerConfig,
  payload: unknown,
): Promise<string> {
  let token = initialToken;
  const allNotes: string[] = [];

  while (true) {
    // Advance the workflow one step
    // For the MVP, the workflow is self-contained (each step instructs the agent what to do)
    // The runner just advances with a standard "step complete" output
    const result = await mcpClient.continueWorkflow({
      continueToken: token,
      intent: 'advance',
      output: {
        notesMarkdown: await executeStep(result.step, trigger, payload),
      },
    });

    if (result.output?.notesMarkdown) {
      allNotes.push(result.output.notesMarkdown);
    }

    if (result.isComplete) break;
    token = result.continueToken;
  }

  return allNotes.join('\n\n---\n\n');
}
```

**Key insight from Claude Code `sessionRunner.ts`:** The runner loop pattern is: spawn/start → read step → execute step → emit output → repeat until terminal. The execution of each step is the concern of the _workflow definition_ itself -- the runner just drives the protocol.

**For `mr-review-workflow-agentic`:** Each step in the workflow YAML will have its own prompt instructions. The runner passes the MR context (diff URL, branch info) as context variables. The workflow steps do the actual analysis.

### 6. GitLab API calls needed

```typescript
// Context gathering (before or during workflow -- passed as contextVariables)
GET /api/v4/projects/:id/merge_requests/:iid/changes
// Returns: diffs for all changed files

GET /api/v4/projects/:id/merge_requests/:iid
// Returns: title, description, author, target_branch, source_branch

// Reporting (after workflow completes)
POST /api/v4/projects/:id/merge_requests/:iid/notes
Body: { body: "## WorkRail MR Review\n\n{accumulated_notes}" }
// Auth: GITLAB_TOKEN env var (personal access token or CI job token)
```

**Auth:** `Authorization: Bearer ${GITLAB_TOKEN}` header. The trigger daemon needs a GitLab PAT with `api` scope.

### 7. Workflow definition sketch (`mr-review-workflow-agentic.yml`)

```yaml
id: mr-review-workflow-agentic
name: MR Review (Agentic)
description: Autonomously reviews a GitLab MR and posts findings as a comment

steps:
  - id: fetch-context
    prompt: |
      You are reviewing MR !{{contextVariables.mrIid}} in project {{contextVariables.projectId}}.
      Title: {{contextVariables.title}}
      
      Fetch the MR diff using the GitLab API and summarize:
      - What changed (files, line counts)
      - The apparent intent of the change
      Record your findings in notes.

  - id: review-changes
    prompt: |
      Based on the diff you fetched in the previous step, review the changes for:
      1. Correctness and logic errors
      2. Security concerns
      3. Missing tests
      4. Style/convention violations
      
      Be specific. Reference file names and line numbers where relevant.
      Record your complete review in notes.

  - id: write-summary
    prompt: |
      Synthesize your review into a concise MR comment. Format:
      ## WorkRail Review
      **Summary:** one sentence
      
      **Findings:**
      - [SEVERITY] finding description (file:line)
      
      **Verdict:** APPROVE | REQUEST_CHANGES | COMMENT
      
      Record the final comment text in notes.
```

### 8. Full path pseudocode (webhook to MR comment)

```
GitLab sends:
  POST /webhook/gitlab
  X-Gitlab-Token: <secret>
  X-Gitlab-Event: Merge Request Hook
  Body: { object_kind: "merge_request", object_attributes: { iid: 42, action: "open", title: "..." }, project: { id: 123 } }

Webhook server:
  1. verifyGitLabSignature(header, secret)  → pass
  2. normalizeEvent("Merge Request Hook", "open")  → "merge_request.opened"
  3. res.status(200).send()  ← GitLab gets immediate ACK
  4. dispatchTrigger("merge_request.opened", payload)  ← async

Dispatcher:
  5. find matching trigger: gitlab-mr-opened-review
  6. interpolateGoal("Review MR !{iid}: {title}", payload)
     → "Review MR !42: Add OAuth refresh token rotation"
  7. POST /mcp  {start_workflow, workflowId: "mr-review-workflow-agentic", workspacePath: ..., goal: ...}
     ← {continueToken: "ct_abc123", step: {prompt: "fetch-context step..."}}

Agentic runner loop:
  8. executeStep(step="fetch-context", context={mrIid:42, projectId:123, title:"..."})
     → calls GitLab API: GET /api/v4/projects/123/merge_requests/42/changes
     → summarizes diff in 200 words
     → returns notesMarkdown: "## Fetch Context\n- 3 files changed..."
  9. POST /mcp  {continue_workflow, continueToken: "ct_abc123", output: {notesMarkdown: ...}}
     ← {continueToken: "ct_def456", step: {prompt: "review-changes step..."}}
  10. executeStep(step="review-changes", ...)
      → analyzes diff from notes context
      → returns notesMarkdown: "## Review\n- [HIGH] Missing input validation..."
  11. POST /mcp  {continue_workflow, ...}
      ← {continueToken: "ct_ghi789", step: {prompt: "write-summary step..."}}
  12. executeStep(step="write-summary", ...)
      → synthesizes final comment
      → returns notesMarkdown: "## WorkRail Review\n**Summary:** ...\n..."
  13. POST /mcp  {continue_workflow, ...}
      ← {isComplete: true, continueToken: null}

Reporter:
  14. POST /api/v4/projects/123/merge_requests/42/notes
      Authorization: Bearer <GITLAB_TOKEN>
      Body: { body: "## WorkRail Review\n..." }
      ← {id: 555, body: "...", author: {name: "workrail-bot"}}

Done. MR !42 now has a WorkRail review comment.
```

---

## Challenge Notes

1. **The agentic runner is a client of the WorkRail MCP server -- but MCP over HTTP is a session-stateful protocol.** The `StreamableHTTPServerTransport` in `http-entry.ts` is designed for a single long-lived MCP session, not concurrent webhook-triggered sessions. Multiple concurrent MR opens would create multiple simultaneous MCP sessions. Need to verify the HTTP transport handles this. The existing `sessionIdGenerator: () => crypto.randomUUID()` in `http-entry.ts` suggests sessions are already UUID-keyed, but the transport's concurrency behavior needs validation.

2. **The agentic runner loop assumes each step can be executed without human judgment.** The `mr-review-workflow-agentic` workflow must be authored specifically for autonomous execution -- no steps that say "wait for user input" or "ask the user to decide". This is a workflow authoring constraint, not a framework constraint. The runner loop itself is straightforward.

3. **Step execution in the runner loop.** The pseudocode above shows `executeStep()` as a black box. In practice this means the runner needs to call an LLM (e.g. via Claude API) with the step prompt + accumulated context. This is the real "agentic" part. The Claude Code `sessionRunner.ts` spawns a `claude` process -- the WorkRail trigger daemon could do the same: spawn `claude --sdk-mode` per step, or use the Anthropic SDK directly for a cleaner integration.

4. **Context propagation.** The MR payload (iid, project ID, diff URL) needs to be passed into the workflow as `contextVariables`. The `continue_workflow` API accepts a `context` object that WorkRail auto-merges. The initial `start_workflow` call should include the MR context so the first step has access to it.

5. **Token security.** The `X-Gitlab-Token` shared secret must be loaded from env, not config YAML. The trigger daemon config YAML should reference the env var name, not the secret value.

---

## Resolution Notes

- **Option A (standalone daemon) is the right architecture.** It keeps the MCP server clean, makes the trigger daemon independently deployable and restartable, and aligns with the principle of explicit domain types at boundaries.
- **The workflow YAML is a first-class contract.** The `mr-review-workflow-agentic` workflow needs to be authored with the autonomous execution context in mind -- prompts that produce structured notes, not prompts that ask questions.
- **The reporter is a post-session side effect.** It reads from the accumulated session notes after `isComplete`, rather than during execution. This keeps the workflow definition pure (no GitLab API calls in workflow YAML).
- **Context propagation via `context` object.** MR metadata (iid, project ID, diff) flows into the session via `start_workflow` contextVariables and is readable by each step's prompt template.

---

## Decision Log

| Decision | Choice | Rationale |
|---|---|---|
| Trigger architecture | Standalone daemon (Candidate A) | Separation of concerns; MCP server stays clean; only candidate satisfying all 5 criteria |
| Candidate B rejected | CI job as one-shot MCP client | No centralized extension seam; per-repo CI config; right for PoC, wrong for platform |
| Candidate C rejected | MCP-native register_trigger | Violates single-responsibility of http-entry.ts; requires changes to 3 core files; too broad |
| Signature verification | X-Gitlab-Token timingSafeEqual | GitLab uses shared secret, not HMAC-SHA256 like GitHub |
| Webhook response | 200 immediately, async dispatch | GitLab 10s timeout; ACK first, work later |
| Config format | Static YAML triggers.yml | MVP: no dynamic config, no database; extension seam via YAML |
| Reporter timing | Post-completion, reads session notes | Keeps workflow YAML pure; no side effects in steps |
| Context propagation | `context` object in start_workflow + continue_workflow | Uses existing WorkRail protocol; no schema changes |
| Step execution | LLM call per step (Claude API or spawn) | Agentic steps need LLM; WorkRail protocol is the orchestration layer |
| Error handling | Top-level error catch + error comment fallback | Converts silent daemon crash into visible MR comment |
| Observability | Structured run logging to ~/.workrail/trigger-runs/ | Borrowed from Candidate B's CI visibility strength |
| Rate limiting | Exponential backoff on GitLab POST /notes | Standard mitigation for GitLab API 429 responses |

---

## Final Summary

**Confidence: High.** Architecture survived adversarial challenge; 4 review findings incorporated as required implementation revisions (not direction changes).

The WorkRail autonomous trigger system MVP is a **standalone trigger daemon** (`src/trigger/`) that:

1. Runs an Express webhook server on port 4100
2. Receives `POST /webhook/gitlab` with GitLab signature validation (`timingSafeEqual` on X-Gitlab-Token)
3. Normalizes events to `{event_type}.{action}` format (e.g. `merge_request.opened`)
4. Matches events against a static `~/.workrail/triggers.yml` config
5. Calls the existing WorkRail HTTP MCP server to start a workflow
6. Drives an agentic execution loop (start -> loop continue until complete)
7. Posts accumulated session notes as a GitLab MR comment via the GitLab API
8. On any failure: posts an error comment ('WorkRail review could not be completed: {error}') and logs to disk

The daemon is a client of the existing WorkRail MCP server -- zero changes required to the MCP server, session store, or workflow engine.

**Implementation surface:**
- Trigger layer: ~400 LOC across 5 files
- Agentic step execution: ~200 additional LOC (Anthropic SDK integration or `claude` spawn)
- Total MVP: ~600 LOC + `mr-review-workflow-agentic.yml` + `~/.workrail/triggers.yml`

**Files:**
- `src/trigger/webhook-server.ts` -- Express + signature verification
- `src/trigger/dispatcher.ts` -- event matching + trigger dispatch
- `src/trigger/config-loader.ts` -- YAML trigger config parsing + Zod validation
- `src/trigger/agentic-runner.ts` -- MCP client loop + error comment fallback
- `src/trigger/reporters/gitlab.ts` -- GitLab API comment post + 429 retry
- `workflows/mr-review-workflow-agentic.yml` -- workflow definition (autonomous execution)
- `~/.workrail/triggers.yml` -- user-provided trigger config (not in repo)

**Pre-build checklist (before writing runner loop):**
1. Send 3 concurrent `start_workflow` requests to WorkRail HTTP MCP server; verify all 3 return distinct `ct_` tokens without timeout. (~30 min)
2. Confirm `SESSION_LOCK_RETRY_AFTER_MS` value in `src/v2/durable-core/constants.ts` is acceptable as the orphaned-session recovery window.

**Residual risks:**
1. Concurrent MR opens: `StreamableHTTPServerTransport` concurrency unverified (pre-build validation required)
2. Workflow YAML quality: the trigger architecture is sound; perceived value depends entirely on the review workflow prompts
3. GitLab bot identity: create a dedicated `workrail-bot` GitLab account for review comment clarity
