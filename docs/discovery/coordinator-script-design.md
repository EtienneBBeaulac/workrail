# Coordinator Script Architecture Discovery

**Date:** 2026-04-18
**Discovery path:** design_first (goal was a solution statement; risk is solving the wrong abstraction)
**Status:** In progress

---

## Artifact Strategy

This document is a **human-readable discovery report** for Etienne and future pipeline authors. It is NOT workflow execution memory -- that lives in WorkRail step notes and context variables. If this file and the WorkRail session disagree, the session notes are authoritative.

**What this doc is for:**
- Architecture recommendation with rationale
- Key design decisions and tradeoffs
- Open questions and risks
- Reference for implementation

**What this doc is not for:**
- Tracking workflow execution state
- Storing session continue tokens or checkpoint data

---

## Context / Ask

**Stated goal:** Design the first coordinator script template -- the script that drives a multi-phase WorkRail pipeline using worktrain spawn/await.

**Reframed problem (solution-bias stripped):** How should multi-phase WorkRail pipelines be orchestrated -- what is the right abstraction layer, locus of control, and failure model for driving sequential and parallel child sessions?

**Goal was a solution statement.** The original framing assumed: (a) a script is the right locus, (b) worktrain spawn/await are the right primitives, (c) a reusable template is achievable. These assumptions are challenged below.

---

## Path Recommendation

**design_first** -- The dominant risk is shaping the wrong abstraction. Two viable architectures exist (coordinator script vs. native WorkRail workflow with spawn_agent). Without clarifying the real problem first, we risk building the wrong thing at the wrong layer.

Rationale against `landscape_first`: the landscape is already well-understood from code reading. The risk is not ignorance of options, it is premature commitment to the script model without examining the native workflow alternative.

Rationale against `full_spectrum`: the reframing is already complete from Step 1. The uncertainty is architectural (which layer owns coordination), not conceptual (what is coordination).

---

## Constraints / Anti-goals

**Core constraints:**
- Zero LLM cost for coordination routing decisions (scripts, not LLM reasoning, for deterministic logic)
- Coordinator must be observable: console DAG must show parent-child session tree
- Coordinator must be testable without a live daemon (mockable spawn/await primitives)
- Must not require engine changes to add a new pipeline
- Must handle fan-out parallelism (spawn N child sessions, collect all N results)

**Anti-goals:**
- Do NOT build a coordinator that uses an LLM to route between phases
- Do NOT require modifications to trigger-router.ts or workflow-runner.ts for each new pipeline
- Do NOT produce a template so generic it cannot express mr-review's loop-with-retry topology
- Do NOT couple the coordinator's failure model to the daemon's Semaphore (no deadlock risk)

---

## Key Facts From Code Reading

### worktrain spawn (worktrain-spawn.ts)
- Flags: `--workflow <id>`, `--goal <text>`, `--workspace <path>`, `[--port <n>]`
- HTTP POST to `/api/v2/auto/dispatch` with `{ workflowId, goal, workspacePath }`
- Output to stdout: session handle (string, e.g. `sess_abc123`)
- Output to stderr: progress/errors
- Return: CliResult success | failure | misuse
- **Does NOT pass context variables** -- only workflowId, goal, workspacePath

### worktrain await (worktrain-await.ts)
- Flags: `--sessions <h1,h2,...>`, `[--mode all|any]`, `[--timeout 30m]`
- Polls GET `/api/v2/sessions/:sessionId` every 3 seconds
- Terminal statuses: `complete`, `complete_with_gaps`, `blocked`, `dormant`
- Output to stdout: JSON `{ results: [{ handle, outcome, status, durationMs }], allSucceeded }`
- **CRITICAL GAP: No step notes, no findings, no structured artifacts returned**
- Exit code 0 if all succeeded, 1 if any failed/timed out

### spawn_agent tool (workflow-runner.ts L1415)
- Available inside workflow steps (not as a CLI command)
- Blocking: parent AgentLoop pauses inside execute() until child completes
- Returns: `{ childSessionId, outcome: 'success'|'error'|'timeout', notes: string }`
- Depth-limited: default max depth 3
- **Returns last step notes from child** -- actionable content available immediately
- **Serial only**: cannot fan out N children in parallel (each call blocks)
- Parent session's maxSessionMinutes keeps ticking while child runs

### trigger-router.ts dispatch()
- Fire-and-forget via KeyedAsyncQueue
- Returns immediately (202 pattern)
- Uses global Semaphore (max 3 concurrent by default)
- **Why spawn_agent cannot use dispatch()**: dispatch is fire-and-forget; calling it inside a running session would lose the result. Direct runWorkflow() call is used instead.

### classify-task-workflow.json
- Single-step, fast, no tools, no subagents
- Outputs: taskComplexity, riskLevel, hasUI, touchesArchitecture, taskType, affectedDomains, recommendedPipeline
- `recommendedPipeline` is an ordered array of workflow IDs
- Notes are the output channel -- no structured context variables emitted

---

## Critical Gap: worktrain await Does Not Return Session Content

The backlog pseudocode (backlog.md L1793-1795) shows:
```
3. Calls `await_sessions(handles)` → structured findings (script waits)
4. Parses the findings JSON block from each session's output (script)
5. Routes: clean → merge queue, minor → spawn fix agent, blocking → escalate
```

But the real `worktrain await` output is `{ handle, outcome, status, durationMs }` -- no findings, no notes.

**To route on content, the coordinator must:**
1. `worktrain await --sessions h1,h2` -- wait for completion
2. For each completed session handle, call GET `/api/v2/sessions/:sessionId` -- retrieve step notes
3. Parse the structured block from notes
4. Route on parsed content

This is a missing primitive: **worktrain notes <session-handle>** (or a --include-notes flag on worktrain await).

---

## Two Candidate Architectures

### Candidate A: Coordinator Script (TypeScript/Shell)

```
coordinator-mr-review.ts
  1. spawn handles[] = worktrain spawn --workflow mr-review for each PR (parallel fire-and-forget)
  2. await results = worktrain await --sessions h1,h2,h3
  3. for each handle: GET /api/v2/sessions/:id -> parse step notes -> extract findings
  4. route: clean -> merge queue, minor -> spawn fix agent, blocking -> escalate
  5. await fix agents -> re-review loop (circuit breaker at 3)
  6. merge clean PRs
```

**Pros:**
- True parallel fan-out (fire-and-forget spawn, batch await)
- Deterministic routing (zero LLM cost for coordination)
- Testable: mock fetch, mock worktrain CLI
- Reusable: script is a standalone artifact others can copy

**Cons:**
- Invisible to WorkRail: coordinator script is not a session in the DAG
- No session DAG for the coordinator itself (only child sessions are visible)
- Requires a running process outside the daemon (shell script lifetime)
- Must handle port discovery, daemon connectivity separately
- **Missing primitive:** must query session notes separately after await

### Candidate B: WorkRail Workflow with spawn_agent Steps

```
coordinator-mr-review-workflow.json
  Step 1: Gather PRs
  Step 2: For each PR, call spawn_agent(mr-review-workflow) -- SERIAL (one at a time)
  Step 3: Route based on outcome + notes from spawn_agent
  Step 4: spawn_agent(fix-workflow) if needed, re-review
  Step 5: Merge
```

**Pros:**
- Full WorkRail observability: coordinator IS a session in the DAG
- Child sessions linked via parentSessionId
- Console DAG shows the full tree
- spawn_agent returns notes directly (no separate query needed)
- Session state is durable (daemon crash recovery)

**Cons:**
- Serial only: cannot spawn N review sessions in parallel
- Parent session time limit accumulates across all child runs
- At depth limit 3 (default), nested spawn_agent chains are constrained
- Coordinator logic is in workflow JSON prompt blocks, not testable TypeScript

### Candidate C: Hybrid -- Script Coordinator with Session Registration

A TypeScript coordinator script that:
- Calls worktrain spawn (parallel) + worktrain await (batch)
- Registers itself as a coordinator session with a workflowId (so it appears in the DAG)
- After await, queries session notes via HTTP, routes on content
- Reports phase transitions back to the daemon as structured events

**Pros:** Parallel fan-out + DAG visibility + testable TypeScript
**Cons:** Requires new engine primitive (coordinator session registration) -- not yet built

---

## Landscape Packet

### Current State Summary

Two orchestration primitives exist today (both shipped, neither battle-tested):

| Primitive | Layer | Parallelism | Returns Content | Observable in DAG |
|-----------|-------|-------------|-----------------|-------------------|
| `worktrain spawn` + `worktrain await` | CLI / HTTP | Yes (fire N, await all) | No (outcome + status only) | No (script is invisible) |
| `spawn_agent` tool | Engine / workflow step | No (blocking, serial) | Yes (notes returned inline) | Yes (parentSessionId in store) |

Neither primitive is complete for the target use case:
- Script model: parallel but content-blind
- Native model: content-aware but serial

### Existing Workflows Available as Targets
- `coding-task-workflow-agentic` (lean v2)
- `mr-review-workflow.agentic.v2`
- `routine-context-gathering`, `routine-hypothesis-challenge`, `routine-philosophy-alignment`
- `ui-ux-design-workflow`, `production-readiness-audit`, `architecture-scalability-audit`
- `bug-investigation.agentic.v2`, `wr.discovery`
- `classify-task-workflow` (new, single-step, outputs recommendedPipeline array)

### Engineering State (git log context)
- `spawn_agent` shipped in commit `4254feb7` (feat: in-process child session delegation)
- `worktrain spawn` / `worktrain await` -- Tier 3 in Apr 18 grooming: "already merged, needs real-world test"
- `classify-task-workflow` exists but not yet wired into any coordinator
- `parentSessionId` is in session store; console tree view is the next planned feature

### Hard Constraints From Code
1. `dispatch()` in TriggerRouter is fire-and-forget + Semaphore-gated. Calling from inside a running session deadlocks. This is why `spawn_agent` uses direct `runWorkflow()` call, not `dispatch()`.
2. `worktrain await` stdout schema is `AwaitResult = { results: [{ handle, outcome, status, durationMs }], allSucceeded }`. No notes.
3. `worktrain spawn` CLI: `{ workflowId, goal, workspacePath }` only. No context variable passing.
4. `spawn_agent` depth limit: default max 3. Root (0) → child (1) → grandchild (2) → blocked at 3.
5. `spawn_agent` blocks the parent AgentLoop's execute() method. The parent cannot do other work while child runs.

### Obvious Contradictions

**C1: Backlog assumes findings from await, but CLI returns none.**
Backlog pseudocode (backlog.md L1793): `await_sessions(handles) → structured findings`. Real CLI returns `{ outcome, status, durationMs }` only. Every coordinator that routes on content has an undocumented extra HTTP step.

**C2: Backlog envisions parallel fan-out, but spawn_agent is serial.**
Backlog (backlog.md L2190): `await_sessions({ handles: [...], mode: 'all' })` implies a non-blocking spawn primitive. But `spawn_agent` (the native tool) blocks. The CLI (`worktrain spawn` / `worktrain await`) can do parallel, but returns no content.

**C3: classify-task output is in notes, not in context variables.**
The classify-task workflow outputs via step notes (a markdown block), not via WorkRail context variables. A coordinator that reads classify output must parse the notes string -- there is no structured `context.taskComplexity` to read directly.

### Evidence Gaps
- **Gap 1:** Whether GET /api/v2/sessions/:id currently returns full step notes in the runs array (the await code reads `runs[0].status` but not notes -- unclear if notes are included in the response body)
- **Gap 2:** Whether a `--context` flag for `worktrain spawn` is planned (needed to pass classify output to coding-task session)
- **Gap 3:** Whether non-blocking spawn_agent (fire + await_all) is on the roadmap (would resolve C2)

---

## Problem Frame Packet (Deep)

### Stakeholders

**Primary user: Etienne (WorkTrain builder / first pipeline author)**
- Job: Wire up an autonomous pipeline that runs the full develop-review-fix-merge cycle without manual coordination
- Outcome: Spend Monday morning reviewing Slack, not manually driving 8 agent sessions in sequence
- Pain: Today every handoff (review complete -> spawn fix agent -> re-review) requires Etienne to be online, read the findings, and manually kick the next step
- Constraint: Must be able to reason about what went wrong when a pipeline fails at 2am

**Secondary user: Future WorkTrain pipeline authors (teams adopting WorkTrain)**
- Job: Add their own pipelines (onboarding pipeline, data migration pipeline, etc.)
- Outcome: Write a new pipeline by copying a template and changing workflow IDs and routing rules
- Pain: If the coordinator pattern is hard to understand or extend, each team rewrites it from scratch
- Constraint: Cannot be expected to understand the WorkRail engine internals

### Jobs / Desired Outcomes

1. **Full autonomy:** A trigger fires, the pipeline runs, a Slack message arrives with outcome. No human in the loop.
2. **Debuggability:** When something goes wrong, Etienne can trace exactly what each phase did and why the coordinator made each routing decision.
3. **Composability:** The pipeline is assembled from existing workflow primitives, not a monolithic LLM session.
4. **Parallelism:** Review N PRs simultaneously, not one at a time.

### Tensions

**T1: Observability vs. Parallelism**
- Native `spawn_agent` (observable in DAG, serial) vs. script + worktrain CLI (parallel, invisible to DAG)
- You cannot have both today. Console DAG tree = serial. Parallel fan-out = invisible coordinator.

**T2: Content access vs. Simplicity**
- Routing on findings requires 2-call HTTP sequence (session detail + node detail) after worktrain await
- Simpler coordinator ignores findings and routes only on exit code (succeeded / failed) -- but this loses the clean/minor/blocking distinction
- The backlog explicitly wants content-based routing; simplicity would sacrifice the main value proposition

**T3: Template reuse vs. Pipeline specificity**
- A generic pipeline runner (execute recommendedPipeline array from classify-task) is maximally reusable but cannot express mr-review's loop-with-retry
- A specialized mr-review coordinator can express the full topology but is not reusable
- The first coordinator template will set the pattern -- wrong abstraction level here propagates to all future pipelines

**T4: Build now vs. Build right**
- worktrain spawn/await are merged but untested (Tier 3 Apr 18 grooming)
- spawn_agent just shipped (commit 4254feb7) and needs real-world validation
- Building the coordinator NOW uses primitives that are still in "needs testing" state
- Waiting for primitives to stabilize reduces rework risk but delays the autonomous pipeline

**T5: Script model vs. Workflow model (the central architectural tension)**
- Script: parallel, testable, zero LLM cost, but invisible to DAG and no native failure recovery
- Workflow: observable, content-aware via spawn_agent, but serial and time-budget constrained
- The backlog explicitly names coordinator scripts as the intended model -- but the code reality shows spawn_agent is the more capable primitive for content-based routing

### Success Criteria (observable)

1. A coordinator triggers from a cron or webhook, runs the mr-review pipeline for all open PRs, and posts a Slack summary -- without Etienne touching anything
2. When findings are "blocking", the coordinator spawns a fix agent and re-reviews (not just logs and exits)
3. When a child session fails, the coordinator's Slack summary names WHICH PR failed and WHY (the finding text)
4. The console DAG shows all child sessions linked to the coordinator as a tree (even if the coordinator itself is invisible as a script)
5. A second pipeline (e.g. implement-feature) can be added by writing a new 50-line TypeScript file and changing 3 workflow IDs

### Primary Framing Risk

**If spawn_agent becomes non-blocking (fire + await_all) in the near term, the entire script-vs-workflow calculus inverts.**

Currently the script model wins on parallelism (the only dimension where it beats native workflows). If spawn_agent gets a non-blocking mode with batch-await, native workflows become strictly better: same parallelism, plus DAG observability, plus notes available inline, plus no separate HTTP calls. In that scenario, building a coordinator script template today would be building the wrong abstraction -- the right abstraction would be a coordinator workflow JSON file.

This is not generic. It is a specific condition (spawn_agent async mode shipping) that would make the current framing wrong. The decision hinges on whether to build the script now or wait for/build the async spawn_agent first.

## Open Questions

1. **Parallel fan-out with spawn_agent:** Is there a plan to make spawn_agent non-blocking (fire-and-forget + await_all)? If yes, Candidate B becomes viable for parallel pipelines.
2. **worktrain await --include-notes flag:** Is this planned? Without it, every coordinator routing on content needs a separate HTTP call.
3. **worktrain spawn --context flag:** The current CLI does not pass context variables to the spawned session. How does the coordinator pass classify-task output (taskComplexity, recommendedPipeline) to the coding-task session?
4. **Coordinator session registration:** Is there a plan for scripts to register as coordinator sessions so they appear in the DAG?
5. **Session notes API:** Is GET /api/v2/sessions/:id currently returning full step notes in the runs array? The await code reads `runs[0].status` but not notes.

---

## Problem Frame Packet

**Primary uncertainty:** Whether the script model or the native workflow model is the right long-term abstraction -- given that spawn_agent is blocking+serial today, but the backlog explicitly describes async spawn + batch await as the desired primitive.

**Known approaches:** Coordinator script (Candidate A), native workflow (Candidate B), hybrid (Candidate C).

**Key stakeholders:** Anyone building a coordinator pipeline (today: Etienne; soon: teams using WorkTrain autonomously).

---

## Candidate Directions

### Candidate Generation Expectations

This is a **design_first** pass with **THOROUGH** rigor. Requirements for the candidate set:
1. At least one candidate must meaningfully reframe the problem (not just package an obvious solution)
2. All candidates must address the central tension: observability vs. parallelism
3. All candidates must specify how they handle content-based routing (the 2-call HTTP gap or native notes)
4. One candidate must represent the "build now with current primitives" position (pragmatic)
5. One candidate must represent the "build the right primitive first" position (strategic)
6. The spread must not cluster -- candidates genuinely differ in abstraction level

---

### Candidate 1: TypeScript Coordinator Script (Minimal, Build Now)

**One-sentence summary:** A standalone TypeScript file with DI-injected spawn/await/HTTP effects that drives the mr-review pipeline using today's worktrain spawn/await CLI plus a 2-call HTTP sequence to retrieve step notes for routing.

**Concrete shape:**
```typescript
// coordinator-mr-review.ts
interface CoordinatorDeps {
  readonly spawnSession: (workflowId: string, goal: string, workspace: string) => Promise<string>; // returns sessionHandle
  readonly awaitSessions: (handles: string[], mode: 'all'|'any', timeoutMs: number) => Promise<AwaitResult>;
  readonly getSessionNotes: (handle: string) => Promise<string | null>; // GET /api/v2/sessions/:id/nodes/:tipNodeId -> recapMarkdown
  readonly listOpenPRs: () => Promise<PullRequest[]>; // gh pr list --json
  readonly mergePR: (number: number) => Promise<void>;
  readonly postSlack: (message: string) => Promise<void>;
  readonly stderr: (line: string) => void;
}

type FindingsSeverity = 'clean' | 'minor' | 'blocking';

async function runMrReviewPipeline(deps: CoordinatorDeps, workspace: string): Promise<CoordinatorResult>
```

Notes are retrieved via: GET /api/v2/sessions/:id (get tip nodeId from runs[0].nodes[preferredTipNodeId]) then GET /api/v2/sessions/:id/nodes/:nodeId (get recapMarkdown). Parsed by a `parseFindings(recapMarkdown: string): FindingsSeverity` function that scans for known severity markers.

**Tensions resolved:** T3 (specific topology: loop-with-retry), T2 (content access via explicit 2-call HTTP)
**Tensions accepted:** T1 (no parallelism), T4 (build now, not right)
**Wait -- parallelism:** This candidate CAN achieve parallel fan-out by calling `spawnSession` N times before calling `awaitSessions([h1, h2, h3, ...])`. The `awaitSessions` dep wraps `worktrain await` which polls all sessions concurrently. **This resolves T1.**

**Boundary solved at:** TypeScript module boundary. All I/O injected via `CoordinatorDeps`. Testable with fake deps (no live daemon).

**Failure mode to watch:** `parseFindings` is a string parser on LLM-generated markdown. If the mr-review workflow changes its notes format, the parser silently misclassifies. Must have a `'unknown'` severity fallback that defaults to 'blocking' (conservative).

**Relation to existing patterns:** Directly follows `WorktrainSpawnCommandDeps` / `WorktrainAwaitCommandDeps` DI pattern. Same injectable interface shape.

**Gains:** Ships today. Uses stable primitives. Fully testable. Parallel fan-out. Content-based routing.
**Gives up:** Invisible to console DAG (coordinator is not a WorkRail session). No durable state (script crash = lost progress). Notes parsing is brittle.

**Impact surface:** None -- coordinator is a standalone file. Does not require engine changes.

**Scope:** Best-fit for "first coordinator template."

**Philosophy honored:** Errors as data (CliResult pattern), Dependency injection, Exhaustiveness (FindingsSeverity union), Validate at boundaries (parseFindings validates at HTTP response boundary)
**Philosophy tension:** Not fully deterministic if notes format varies (string parsing on LLM output)

---

### Candidate 2: Serial Coordinator Workflow (Native, Observable)

**One-sentence summary:** A WorkRail workflow JSON file where each pipeline phase is a step that calls `spawn_agent` once, receives notes inline, and uses those notes to set context variables that the next step reads.

**Concrete shape:**
```json
{
  "id": "coordinator-mr-review",
  "steps": [
    {
      "id": "gather-prs",
      "procedure": ["Run gh pr list --json, set context.openPRs"]
    },
    {
      "id": "review-loop",
      "loopCondition": "context.openPRs.length > 0",
      "procedure": [
        "Pop one PR from context.openPRs",
        "Call spawn_agent(mr-review-workflow-agentic, goal: 'Review PR #N')",
        "Read spawn_agent result.notes",
        "If notes contain CLEAN: add to context.mergeQueue",
        "If notes contain MINOR: call spawn_agent(coding-task-workflow-agentic, 'Fix: <finding>')",
        "If notes contain BLOCKING: add to context.escalationList"
      ]
    },
    {
      "id": "merge-queue",
      "procedure": ["For each PR in mergeQueue: run git merge sequence"]
    }
  ]
}
```

Each `spawn_agent` call blocks until child completes, then returns `{ outcome, notes }`. Notes are available immediately -- no HTTP polling needed.

**Tensions resolved:** T1 (fully observable in console DAG), T2 (notes available inline)
**Tensions accepted:** T1 partial (serial review -- one PR at a time, not parallel), T4 (cannot build right now, needs workflow JSON authoring)

**Boundary solved at:** WorkRail workflow step boundary. All coordination logic in workflow JSON prompt instructions + agent reasoning.

**Failure mode to watch:** Parent session's maxSessionMinutes accumulates across all spawn_agent calls. Reviewing 10 PRs with a 30-minute child budget each requires the parent to have 300+ minutes. Time budget explosion is silent -- parent times out while children are running.

**Relation to existing patterns:** Directly uses spawn_agent as designed. Follows the workflow-runner.ts spawn_agent pattern (blocking, errors as data, parentSessionId).

**Gains:** Full DAG observability. Session state is durable (daemon restart recovers). Notes available inline, no separate HTTP call.
**Gives up:** Serial reviews (10 PRs = 10x review time). Time budget scales linearly. Routing logic is in LLM-readable prompt, not testable TypeScript.

**Impact surface:** None. A new workflow JSON file.

**Scope:** Best-fit IF serial review is acceptable.

**Philosophy honored:** Errors as data (spawn_agent returns outcome), Exhaustiveness (outcome enum), Observable state
**Philosophy tension:** Routing logic is LLM prompt text, not typed domain logic. Coordinator philosophy says scripts, not LLM reasoning -- this violates the scripts-first principle.

---

### Candidate 3: Build Async spawn_agent First, Then Native Coordinator Workflow

**One-sentence summary:** Extend spawn_agent with a non-blocking mode (`blocking: false`) that returns a `pendingHandle` immediately, add an `await_agents` tool that takes an array of pendingHandles and blocks until all complete, then build the coordinator as a WorkRail workflow that uses these new tools for parallel + observable + content-aware orchestration.

**Concrete shape (new engine API):**
```typescript
// New tool: spawn_agent with blocking: false
spawn_agent({ workflowId, goal, workspacePath, blocking: false }) 
  → { pendingHandle: string } // returns immediately

// New tool: await_agents  
await_agents({ handles: ['ph_abc', 'ph_def'], mode: 'all' })
  → [{ handle, childSessionId, outcome, notes }] // blocks until all complete
```

The coordinator workflow then becomes:
```
Step 1: Gather PRs (script/bash)
Step 2: Spawn all review sessions in parallel (call spawn_agent with blocking:false for each PR)
Step 3: Await all (call await_agents)
Step 4: Route on notes (typed context variables set from parsed notes)
Step 5: Spawn fix agents (blocking spawn_agent, one at a time)
Step 6: Merge
```

**Tensions resolved:** T1 (parallel + observable), T2 (notes inline from await_agents), T4 (builds the right primitive)
**Tensions accepted:** T4 partial (does not ship today -- requires engine work)

**Boundary solved at:** WorkRail engine boundary. New tools in workflow-runner.ts.

**Failure mode to watch:** The non-blocking spawn pattern must not use `dispatch()` (deadlock risk via Semaphore + queue slot). The implementation must use the same `runWorkflow()` pattern as the blocking spawn_agent, but launch it as a concurrent Promise that is tracked in a coordinator-owned pending map.

**Relation to existing patterns:** Extends spawn_agent in workflow-runner.ts (L1415). The blocking version already exists -- non-blocking is an additive extension. `pendingHandle` concept mirrors the CLI's sessionHandle.

**Gains:** Resolves all 5 decision criteria. Parallel fan-out + observability + content routing + DAG tree + extensible. The coordinator workflow is the long-term correct abstraction.
**Gives up:** Does not exist today. Requires engine PR before coordinator can be built. 2-4 week delay (estimate).

**Impact surface:** workflow-runner.ts (new makeAwaitAgentsTool), workflow-runner.ts (extend makeSpawnAgentTool), possibly workflow-runner.ts executeWorkflowLoop for pending handle tracking.

**Scope:** Too broad for "first coordinator template" alone, but correctly scoped for "right long-term architecture."

**Philosophy honored:** All 5 decision criteria. Architectural fixes over patches. Make illegal states unrepresentable (pending handle as a typed domain type).
**Philosophy tension:** YAGNI -- this builds a speculative primitive before any coordinator has validated the need in production.

---

### Candidate 4: Minimal Script + Structured Notes Contract (Pragmatic + Future-Proof)

**One-sentence summary:** Build Candidate 1 (TypeScript coordinator script) but add a structured `## COORDINATOR_OUTPUT` JSON block to the mr-review workflow's final step notes as a first-class contract, making the coordinator's dependency on notes format explicit and versioned rather than fragile string parsing.

**Concrete shape:**

In `mr-review-workflow.agentic.v2.json` final step, add to `outputRequired`:
```json
{
  "coordinatorOutput": "JSON block in exact format:\n```json\n{\"findings\": [{\"severity\": \"clean|minor|blocking\", \"summary\": \"...\", \"prNumber\": N}]}\n```"
}
```

In the coordinator script:
```typescript
function parseCoordinatorOutput(notes: string): Result<CoordinatorOutput, ParseError> {
  const match = /```json\n([\s\S]+?)\n```/.exec(notes);
  if (!match) return err({ kind: 'missing_block' });
  return parseJson(match[1]).andThen(validateCoordinatorOutput);
}
```

The coordinator is now a typed consumer of a versioned contract, not a fragile markdown parser.

**Tensions resolved:** T2 (typed content-based routing), T3 (mr-review topology with loop-with-retry), T1 partial (parallel via worktrain spawn + await)
**Tensions accepted:** T1 (invisible to DAG), T4 (builds now at script layer)

**Boundary solved at:** Notes contract boundary (between workflow and coordinator). The contract is the seam.

**Failure mode to watch:** The coordinator output contract must be maintained in sync with the workflow JSON. If the workflow changes the JSON block format without updating the coordinator, parsing fails. Needs schema versioning or a shared type definition.

**Relation to existing patterns:** The handoff artifact (delivery-action.ts `parseHandoffArtifact`) already does exactly this -- parses a structured JSON block from step notes. The coordinator contract is the same pattern at the coordination layer.

**Gains:** Parallel fan-out + typed routing + works today + extensible to other workflows. The notes contract is explicit rather than implicit.
**Gives up:** Invisible to DAG. Notes contract couples coordinator to specific workflow version.

**Impact surface:** mr-review workflow JSON (add coordinatorOutput to outputRequired), coordinator script (use typed parser), possibly a shared `coordinator-contract-types.ts` file.

**Scope:** Best-fit. Pragmatic + the most defensible long-term.

**Philosophy honored:** Validate at boundaries, Errors as data, Prefer explicit domain types (CoordinatorOutput > string parse), Exhaustiveness (FindingsSeverity discriminated union)
**Philosophy conflict:** None significant.

---

## Comparison and Recommendation

### Tensions x Candidates Matrix

| Criterion | C1 (Script, minimal) | C2 (Workflow, serial) | C3 (Async spawn_agent) | C4 (Script + contract) |
|-----------|----------------------|----------------------|------------------------|------------------------|
| Parallel fan-out | YES | NO | YES | YES |
| Content-based routing | YES (fragile parse) | YES (inline) | YES (inline) | YES (typed contract) |
| Structured failure data | YES | YES | YES | YES |
| Console DAG tree | NO | YES | YES | NO |
| New pipeline = new file | YES | YES | YES | YES |
| Ships today | YES | YES | NO | YES |
| Testable without daemon | YES | NO | NO | YES |

### Recommended Direction: Candidate 4 (Script + Structured Notes Contract)

**Build a TypeScript coordinator script with DI-injected effects, parallel fan-out via worktrain spawn + await, and content-based routing against an explicit `## COORDINATOR_OUTPUT` JSON block added to the mr-review workflow's final step.**

Rationale:
1. Only C1 and C4 achieve parallel fan-out + ship today + testable without daemon
2. C4 > C1 because typed contract (explicit domain type) vs. fragile regex (philosophy violation)
3. C2 loses on serial reviews (N*reviewTime) and routing logic in LLM prompts (scripts-first violation)
4. C3 is the correct long-term direction but does not exist (YAGNI until C4 validates the topology)

**The coordinator output contract pattern is already proven in the codebase:** `parseHandoffArtifact` in `src/trigger/delivery-action.ts` does exactly this for the coding-task workflow. The coordinator contract is the same pattern at the coordination layer.

### What C4 Gives Up

Console DAG visibility. The coordinator script is invisible -- not a WorkRail session. Mitigation: child sessions appear in the console as a flat list with parentSessionId links once that UI is built. Phase transitions logged to stderr with session handles.

**C4 is a stepping stone, not a permanent decision.** Once async spawn_agent ships (C3 direction), the coordinator workflow will have DAG visibility + all current advantages. C4 validates the topology in production so that C3 is built on confirmed requirements.

### Self-Critique

**Strongest counter-argument:** Notes contract coupling creates a maintenance dependency between the coordinator script and a specific version of the mr-review workflow. If the workflow format changes, the coordinator silently fails or throws a parse error. Candidate 2 avoids this entirely (the LLM reads whatever notes exist).

**Pivot conditions:**
1. If notes contract adds too much friction across multiple coordinator scripts -> use structured context variables (workflow final step sets context.coordinatorOutput, coordinator reads it via GET session context) instead of notes block
2. If async spawn_agent is scheduled within 2 weeks -> consider waiting and going directly to C3
3. If DAG observability is critical for the first real pipeline debug -> accept C2's serial reviews to get the tree view

## Challenge Notes

### Adversarial Challenge of Candidate 4 (Leading Direction)

**Challenge 1: The notes contract is a false solution to the wrong problem.**

Candidate 4 adds a `## COORDINATOR_OUTPUT` JSON block to the mr-review workflow. But what happens when there are 10 different coordinator pipelines, each with a different output contract? You now have N contracts to maintain, each coupling a coordinator to a specific workflow version. The `parseHandoffArtifact` precedent is actually a warning, not a green light -- the handoff artifact has already caused fragility when workflow output formats drifted. Coordinator contracts multiply this surface area.

**Resolution:** Valid concern, but the alternative (LLM prose routing in C2) has the same coupling problem in a less visible form -- the coordinator LLM must still understand what 'BLOCKING' means in free-form text. Typed contracts are preferable to implicit text conventions even if they require maintenance. Mitigation: a shared `coordinator-contract-types.ts` with a versioned schema, and a `validate_coordinator_output` step in the workflow's verify block that rejects outputs that don't match the schema.

**Challenge 2: worktrain spawn does not pass context variables -- classify-task output cannot reach the coding-task session.**

The mr-review pipeline does not need classify-task output. But the full implementation pipeline (implement-feature coordinator) requires passing `{ taskComplexity, recommendedPipeline }` from classify-task to the coding-task session. The current worktrain spawn CLI has no `--context` flag. A coordinator that needs to pass context must use HTTP directly: POST /api/v2/auto/dispatch with a `context` body field.

**Resolution:** Confirmed gap. Add `passContext: (handle: string, context: Record<string, unknown>) => Promise<void>` to CoordinatorDeps, implemented via HTTP. This must be documented in the coordinator template as a required dep. It is not a blocker for the mr-review coordinator specifically (which does not need classify output), but IS a blocker for the implement-feature coordinator.

**Challenge 3: The coordinator script is not durable. If the script process dies mid-pipeline, all coordination state is lost.**

If the coordinator crashes after spawning 5 review sessions but before collecting their results, those sessions are orphaned in 'in_progress' state. The coordinator has no way to recover -- it cannot re-acquire the session handles it created. The script's state is entirely in-memory.

**Resolution:** This is a real limitation with no clean fix in Candidate 4. Mitigation: write session handles to a state file (`~/.workrail/coordinator-state/{run-id}.json`) at each phase transition. On coordinator restart, read the state file and resume from the last checkpoint. This adds complexity but is not insurmountable. Alternatively: accept the limitation for the first coordinator and note it as a reason to invest in C3 (native workflow + daemon durability).

**Challenge 4: 'Parallel fan-out' requires calling spawnSession N times before awaitSessions. But worktrain spawn is sequential at the CLI level -- each CLI invocation is a separate process.**

Actually this is a non-issue. The coordinator script calls the `spawnSession` dep N times (N async HTTP calls in parallel via Promise.all), then calls `awaitSessions` once with all handles. The HTTP calls are non-blocking. True parallelism IS achievable in the TypeScript coordinator. This challenge fails.

**Challenge 5: What if the first mr-review pipeline reveals that the topology is wrong?**

If the first real pipeline run shows that the mr-review workflow needs to return richer data than the notes contract provides, the coordinator needs a contract change + workflow change + coordinator change. In C2 (native workflow), a format change is handled by changing the LLM prompt -- no parse layer to update. This makes C2 more flexible for early iteration.

**Resolution:** Valid tradeoff. C4 is less flexible to format changes than C2. Mitigation: keep the coordinator output block minimal for v1 (severity + summary + prNumber only) and add fields incrementally. Schema versioning via a `version: 1` field in the JSON block lets the coordinator detect stale contract versions.

### Challenge Verdict

**C4 holds up under challenge.** The three real concerns (contract maintenance, no context passing, no durability) are documented limitations with known mitigations, not blockers. The challenge confirms C4 as the right first coordinator design, with C3 (async spawn_agent + native workflow) as the explicit next investment after production validation.

---

## Resolution Notes

**Selected Direction: Candidate 4** -- TypeScript coordinator script with DI-injected effects, parallel fan-out via worktrain spawn + await, and an explicit `## COORDINATOR_OUTPUT` JSON block in the mr-review workflow as the typed findings contract.

**Runner-up: Candidate 3** -- async spawn_agent + native coordinator workflow. This is the correct long-term direction. It should be built after C4 validates the topology in production.

**Why C4 over C2:** C2 is serial (N*reviewTime). C2 routing logic lives in LLM prompts (violates scripts-first principle). C2 is not testable without a live daemon.

**Why C4 over C1:** C1 uses fragile regex on free-form notes. C4 uses a typed contract (`## COORDINATOR_OUTPUT` JSON block). The difference is the same as parseHandoffArtifact vs. ad-hoc string parsing.

**Why C4 before C3:** YAGNI. Async spawn_agent does not exist. Build C4 first, run it in production, then use the validated topology to spec async spawn_agent properly.

---

## Decision Log

**Decision 1:** Path = design_first. Rationale: goal was a solution statement; two viable architectures existed; risk was premature commitment to wrong abstraction level.

**Decision 2:** Selected Candidate 4 (TypeScript script + coordinator output contract). Rationale: parallel fan-out, typed routing, testable, ships today, extensible. C3 is the long-term direction but YAGNI until production validates the topology.

**Decision 3:** Notes contract pattern confirmed by precedent (parseHandoffArtifact in delivery-action.ts). The coordinator output block is the same pattern at the coordination layer.

**Decision 4:** Three documented limitations accepted as known tradeoffs: (a) coordinator invisible to console DAG, (b) no context passing from worktrain spawn CLI (use HTTP directly), (c) no durability on coordinator crash (state file mitigation optional for v1).

**Decision 5:** C3 (async spawn_agent) named as next engine investment. Trigger: after first coordinator (C4) has run in production with real PRs.

---

## Final Summary

### Recommended Architecture

**Candidate 4: TypeScript Coordinator Script with Structured Notes Contract**

Build a standalone TypeScript file (`coordinator-mr-review.ts`) with:

1. **CoordinatorDeps DI interface** -- all effects injectable (spawn, await, notes retrieval, PR list, merge, Slack):
   ```typescript
   interface CoordinatorDeps {
     readonly spawnSession: (workflowId: string, goal: string, workspace: string, context?: Record<string, unknown>) => Promise<string>;
     readonly awaitSessions: (handles: string[], timeoutMs: number) => Promise<AwaitResult>;
     readonly getAgentResult: (handle: string) => Promise<AgentResult>; // 2-call HTTP internally
     readonly listOpenPRs: () => Promise<PullRequest[]>;
     readonly mergePR: (number: number) => Promise<void>;
     readonly postSlack: (message: string) => Promise<void>;
     readonly stderr: (line: string) => void;
   }
   ```

2. **AgentResult bridge type** (mirrors future async spawn_agent result):
   ```typescript
   type AgentResult = { handle: string; childSessionId: string | null; outcome: SessionOutcome; notes: string | null };
   ```

3. **Two-tier findings parsing**:
   - Preferred: parse `## COORDINATOR_OUTPUT` JSON block from notes (typed contract)
   - Fallback: scan for BLOCKING/MINOR/CLEAN keywords in notes (graceful degradation)
   - Unknown severity defaults to 'blocking' (conservative)

4. **Parallel fan-out via Promise.all + worktrain await**:
   ```typescript
   const handles = await Promise.all(prs.map(pr => deps.spawnSession('mr-review-workflow-agentic', `Review PR #${pr.number}`, workspace)));
   const awaitResult = await deps.awaitSessions(handles, 30 * 60 * 1000);
   const agentResults = await Promise.all(handles.map(h => deps.getAgentResult(h)));
   ```

5. **Typed routing** over FindingsSeverity discriminated union:
   ```typescript
   type FindingsSeverity = 'clean' | 'minor' | 'blocking' | 'unknown';
   ```

6. **Required parallel workflow change: add verify step to mr-review workflow**
   The mr-review workflow's final step must include in `outputRequired`:
   ```
   coordinatorOutput: "JSON block: ## COORDINATOR_OUTPUT\n```json\n{\"findings\": [{\"severity\": \"clean|minor|blocking\", \"summary\": \"...\", \"prNumber\": N}]}\n```"
   ```
   And in `verify`: "## COORDINATOR_OUTPUT block is present with valid JSON matching the coordinator schema."

### Notes Retrieval: 2-Call HTTP Sequence

The `getAgentResult` dep implementation does:
1. GET `/api/v2/sessions/:sessionId` -- find `runs[0].nodes` preferred tip node ID
2. GET `/api/v2/sessions/:sessionId/nodes/:nodeId` -- get `recapMarkdown` (step notes)
3. Parse coordinator output block from recapMarkdown

### Context Passing

The `spawnSession` dep uses HTTP dispatch directly (not worktrain spawn CLI):
```
POST /api/v2/auto/dispatch { workflowId, goal, workspacePath, context }
```
The `context` body field is supported (verified in console-routes.ts L519).
The worktrain spawn CLI does not have a `--context` flag -- use HTTP for context-passing pipelines.

### Pipeline Sequence (mr-review coordinator)

```
1. listOpenPRs() -> [PR]
2. Parallel: spawnSession('mr-review-workflow-agentic', goal, workspace) for each PR
3. awaitSessions(all handles, 30m)
4. For each handle: getAgentResult -> parse findings
5. Route:
   - clean -> mergeQueue
   - minor -> spawnSession('coding-task-workflow-agentic', 'Fix: <finding>'), await, re-review (max 3 passes)
   - blocking -> escalation list (Slack + GitLab comment)
   - unknown -> escalation list (conservative default)
6. mergePR() for each clean PR (serial, pull before each to avoid conflicts)
7. postSlack(summary)
```

### What This Gives Up

- Console DAG tree view: coordinator is not a WorkRail session. Child sessions appear as a flat list. **Mitigation:** parentSessionId is already in the session store; console tree view is the next planned feature and will retroactively make child sessions visible.
- Coordinator crash durability: script state is in-memory. **Mitigation (v2):** state file at `~/.workrail/coordinator-state/{run-id}.json` written at each phase transition.

### Long-Term Direction (Candidate 3)

After the first coordinator script runs in production and validates the topology:
- Build `spawn_agent(blocking: false)` + `await_agents([handles])` native engine tools
- Build a coordinator as a WorkRail workflow JSON file using these tools
- This gives: parallel fan-out + console DAG observability + daemon durability + inline notes (no 2-call HTTP)
- The `AgentResult` bridge type in C4 makes this migration trivial (same result shape)

### Open Questions (non-blocking)

1. Is non-blocking spawn_agent on the near-term roadmap? If yes, skip C4 and build C3 directly.
2. Should `worktrain spawn` get a `--context` flag? Would simplify coordinator deps for context-passing pipelines.
3. Should `worktrain await` get a `--include-notes` flag? Would consolidate the 2-call HTTP into the CLI.

### Confidence Band: HIGH

All findings are grounded in direct code reading of: `worktrain-spawn.ts`, `worktrain-await.ts`, `workflow-runner.ts` (spawn_agent section), `trigger-router.ts`, `classify-task-workflow.json`, `console-types.ts`, `console-routes.ts`, and 4 backlog sections. No speculative assumptions.
