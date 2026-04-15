# WorkRail User Interaction Discovery

## Artifact Strategy Note

This document is a **human-readable reference artifact** -- it summarizes findings for people to read. It is NOT execution truth. Execution truth lives in WorkRail's session notes and context variables. If the session is rewound or resumed, the notes survive; this file may not be regenerated automatically.

---

## Context / Ask

Understand how human users actually interact with WorkRail vs what agents do, whether users ever directly launch workflows, what the console UI is actually for, what users see during a workflow run, and what the `goal` parameter means in practice.

## Path Recommendation

**landscape_first** -- the dominant need is understanding the current landscape: what the system does, how it is structured, and how the two surfaces (MCP/agent vs console/human) relate. There is no design ambiguity or need to reframe the problem. The question is factual: how does the system work today?

Rationale for rejecting `full_spectrum`: the problem is well-framed. No evidence of a wrong-problem risk. Full spectrum would add design/reframing work that is not needed for a landscape investigation.

Rationale for rejecting `design_first`: there is no design decision pending. The goal is understanding, not shaping a concept.

## Constraints / Anti-goals

- No code changes -- this is a read-only investigation
- Do not infer unimplemented features as real (only document what exists in source)
- Do not conflate the MCP server interface with the console UI

---

## Landscape Packet

### Current-State Summary

WorkRail is an MCP server that enforces step-by-step workflow execution on AI agents. It has two distinct surfaces: an MCP API (agent-facing) and a console web dashboard (human-facing). These surfaces serve fundamentally different roles and have no overlap in responsibility.

**Existing approaches / precedents:**
- MCP-based tool drip-feeding (one step revealed at a time -- agent can't skip ahead)
- SSE-based real-time console updates (console subscribes to workspace change events)
- Domain event sourcing for session state (all state is derived from immutable event logs)
- Session title derived from `goal` context key -- bridges human intent to console display

**Option categories for user interaction:**
- Direct API: NOT available to humans (only agents call MCP tools)
- Console UI: available to humans, read-only observation only
- Natural language prompt to agent: the only human-initiated path to workflow execution

**Notable contradictions:** None found. The system is consistent in its design. The console and MCP interface have no overlap.

**Strong constraints from source:**
- `V2StartWorkflowInput.goal` is required (`z.string().min(1)`) -- no workflow can start without a goal
- Console API endpoints are all GET/read-only -- there is no POST/PUT endpoint for creating or modifying sessions
- `FullEmptyState` component confirms design intent: humans are guided to prompt agents, not to click buttons

**Evidence gaps:**
- Did not inspect the full HTTP API server routes -- only confirmed the console hooks use GET endpoints. A more complete audit would read `src/application/` or the Express routes to confirm there is no write endpoint exposed to the console.
- Did not read `src/v2/usecases/console-service.ts` fully -- only the title derivation section. The full service might expose additional projections not covered here.

### The Two Distinct Surfaces

WorkRail has two completely separate user-facing surfaces:

#### 1. MCP Server (Agent-facing)

The MCP server exposes tools that AI agents call during conversation. The human user never calls these tools directly -- they prompt their AI agent, and the agent calls WorkRail's MCP tools.

**Tools exposed:**
- `list_workflows` / `mcp__workrail__list_workflows` -- discover available workflows
- `inspect_workflow` / `mcp__workrail__inspect_workflow` -- preview a workflow's steps
- `start_workflow` / `mcp__workrail__start_workflow` -- begin a workflow, get Step 1
- `continue_workflow` / `mcp__workrail__continue_workflow` -- complete a step, get the next one
- `checkpoint_workflow` -- save progress and get a resume token
- `resume_session` -- reconnect to an interrupted session

**How a user triggers a workflow:**
The user types a natural language prompt to their AI agent, e.g.:
> "Use the bug-investigation workflow to debug this auth issue"
or simply:
> "Fix the auth bug"

The agent then autonomously calls `start_workflow`, receives Step 1, completes it, calls `continue_workflow`, and so on. The human's only ongoing role is to answer questions the agent asks as part of step execution.

**The agent is the WorkRail client. The human is the agent's client.**

#### 2. Console UI (Human-facing, read-only observer)

The console is a web dashboard (`console/src/`) that humans use to observe ongoing and past workflow sessions. It is **not** a workflow launcher -- it is a monitoring/retrospective tool.

**What the console shows:**
- `WorkspaceView` -- main landing page; lists branches grouped by git repo, each with sessions sorted by recency and status
- `SessionList` -- filterable/searchable archive of all sessions with sort, group, and status filter controls
- `SessionDetail` -- drills into a specific session and shows the execution DAG (Directed Acyclic Graph) of all nodes the agent created, including blocked attempts and alternative paths
- `NodeDetailPanel` -- click a node to see its content: step prompt, agent notes, gaps, artifacts

**Console data flow:**
- Polls `/api/v2/sessions` every 30s (fallback)
- Subscribes to `/api/v2/workspace/events` SSE stream for real-time updates -- invalidates queries on `change` events
- `useSessionDetail` polls every 5s while a session is viewed
- All API calls are read-only GET requests; the console cannot trigger, cancel, or modify workflows

**What the console displays for a session:**
- Session title (derived from `goal` -- see below)
- Status badge: `in_progress`, `blocked`, `dormant`, `complete`, `complete_with_gaps`
- Health badge
- Run DAG visualization (`RunDag`) -- the full execution graph
- Unresolved gaps and critical gap warnings
- Workflow name and run IDs

### What `goal` Is and Who Sets It

`goal` is a **required parameter** on `start_workflow` (see `V2StartWorkflowInput` in `src/mcp/v2/tools.ts`):

```typescript
goal: z.string().min(1).describe('A short sentence describing what you are trying to accomplish...')
```

**Who sets it:** The AI agent. The agent is instructed (via MCP tool description and workflow system prompts) to pass the user's intent as `goal` when calling `start_workflow`. Example values from the spec:
- `"implement OAuth refresh token rotation"`
- `"review PR #47 before merge"`
- `"investigate why the build fails on CI"`

**What it does:**
1. Immediately stored as a `CONTEXT_SET` domain event with `source: 'initial'` at session creation (`buildInitialEvents` in `start.ts`)
2. Persisted in the session's event log
3. Displayed as the **session title** in the console UI

**Session title derivation** (priority order in `console-service.ts` and `session-summary-provider`):
1. `goal` context field (set at `start_workflow` call time)
2. Other well-known context keys: `taskDescription`, `mrTitle`, `prTitle`, `ticketTitle`, `problem`
3. First descriptive line from the earliest recap note
4. Falls back to workflowId/sessionId

The agent can also update context variables via `continue_workflow` (the `context` parameter), which may later override the session title if those well-known keys are set.

### How Sessions Are Created

Sessions are created exclusively by `start_workflow` MCP tool calls. There is no console "New Session" button or API endpoint that creates sessions.

**Creation flow:**
1. Agent calls `start_workflow({ workflowId, workspacePath, goal })`
2. Handler creates a unique `sessionId`, `runId`, `nodeId`
3. `buildInitialEvents` emits 5+ domain events: `SESSION_CREATED`, `RUN_STARTED`, `NODE_CREATED`, `PREFERENCES_CHANGED`, `CONTEXT_SET` (with `{ goal }`)
4. Events are persisted to the session event log
5. Handler returns the first step prompt + `continueToken` to the agent
6. Console subscribes to SSE events and immediately reflects the new session

### The Console Empty State

When no sessions exist, `WorkspaceView` shows a `FullEmptyState` component with a rotating prompt suggestion like:
> "Use the **coding task workflow** to add a dark mode toggle to the settings page"

This confirms: the console never launches workflows itself. It tells the user to tell their agent.

### Users vs Agents -- Summary Table

| Action | Who Does It |
|--------|-------------|
| Type a task prompt | Human user |
| Call `start_workflow` | AI agent |
| Call `continue_workflow` | AI agent |
| Set `goal` parameter | AI agent (based on user's prompt) |
| Answer agent questions during a step | Human user |
| View sessions in console | Human user |
| Filter/search sessions | Human user |
| Click a session to see its DAG | Human user |
| Click a node to see step details | Human user |
| Launch/cancel/modify a workflow | Nobody via console -- agent only |

---

## Problem Frame Packet

### Primary Stakeholders

**Human users (developers/knowledge workers):**
- Job: get complex tasks done correctly with AI assistance; monitor what the AI is doing; understand the outcome
- Pain: without WorkRail, AI agents jump to implementation prematurely and produce inconsistent results; hard to know what the agent actually did
- Constraint: users interact only via natural language prompts to their agent -- they have no direct handle on WorkRail's internals

**AI agents (Claude, Cursor, etc.):**
- Job: execute user tasks according to workflow structure, step by step
- Pain: if agents skip steps or ignore structure, quality degrades
- Constraint: agents receive one step at a time -- future steps are hidden until previous ones are complete

### Core Tension

**Control vs. transparency:** The human gives up fine-grained control (they can't skip steps, modify the workflow mid-run, or re-order execution) in exchange for guaranteed structure and quality. The console partially compensates by showing exactly what the agent did -- but it is retrospective, not interactive.

**User influence is indirect:** Human intent flows through the agent. If the agent misinterprets the user's goal or sets `goal` poorly, the session title in the console will be misleading. The human has no way to correct it from the console.

### Success Criteria

1. Human can find and review any past session in the console within seconds
2. Session titles (derived from `goal`) are descriptive enough to identify what the session was about
3. The console accurately reflects the current workflow state (via SSE real-time updates)
4. The human can diagnose why an agent got stuck (blocked/dormant status, gaps, DAG view)
5. Workflow execution is reproducible and consistent across runs

### Assumptions That Could Be Wrong

1. **"The console is purely read-only"** -- there might be write endpoints in the HTTP API that weren't examined. Evidence gap: didn't fully audit the HTTP router. Probability: low (console hooks only use GET, empty state design intent is clear).
2. **"Users never launch workflows directly"** -- there could be a CLI command or script path not discovered. Evidence gap: didn't inspect `src/cli/` or any shell scripts for session creation. This is the most material assumption.
3. **"goal is always set by the agent"** -- there could be a way for humans to set context before a session starts. No evidence of this.

### HMW Questions

- How might a human user provide richer task context upfront so the agent sets `goal` more precisely?
- How might the console allow lightweight human interaction (e.g., adding a note to a blocked session) without breaking the clean read-only contract?

### Framing Risks

- **Risk 1:** The investigation focused on the console and MCP tools. A CLI tool for direct session management might exist in `src/cli/` and was not examined.
- **Risk 2:** "What users see" was interpreted as "what the console shows." There may be agent-mediated feedback to users during workflow execution that the investigation didn't characterize in detail.

---

## Candidate Directions

### Candidate Generation Constraints (landscape_first path)

The candidate set must reflect landscape precedents and constraints, not free invention. Since this is a discovery investigation, "candidates" are **framings of the answer**, not design proposals. Each framing must:
- Be grounded in evidence from source files
- Not assert things not confirmed by code
- Clearly address the original questions about user vs agent roles, console purpose, and `goal` meaning

### Candidate A: The Complete Two-Surface Model (Primary)

**Framing:** WorkRail has exactly two surfaces. The MCP server is agent-only. The console is human-only and read-only. There is no third surface.

**Supporting evidence:**
- Console hooks: all GET requests, no write endpoints
- `FullEmptyState`: tells users to prompt their agent, not click anything
- `V2StartWorkflowInput.goal`: required field set by agent code path, not UI
- `buildInitialEvents`: session creation is triggered only from MCP call handler

**Confidence:** High. All evidence points here.

**Limitation:** `src/cli/` directory not examined. A CLI could theoretically allow direct session creation.

### Candidate B: Two-Surface Model Plus Possible CLI Path (Caveat)

**Framing:** The two-surface model is correct for the web console and MCP interface. However, a CLI tool in `src/cli/` might allow direct session creation or workflow launch by humans, creating a third surface.

**Supporting evidence:** `src/cli/` exists in the directory listing but was not examined.

**Confidence:** Low for the extension. The README and integration docs show no CLI workflow-launching capability. The README Quick Start goes directly to MCP config and agent prompts.

**Verdict:** Candidate A is the correct primary framing. Candidate B is a caveat to note, not a competing theory.

---

## Decision Log

- Chose `landscape_first` path: the task is understanding the existing system, not reframing or designing. Code reading was sufficient; no web access or delegation was needed.
- Did not delegate to subagents: the investigation was straightforward and well-scoped. Parallel subagents would add latency without improving answer quality for a single-domain factual question.
- Phase 3d adversarial challenge: read `src/cli/commands/start.ts` to test CLI gap assumption. Confirmed: `workrail start` CLI launches the MCP server process, not workflow sessions. Two-surface model validated.
- Review found: 0 Red, 1 Orange (goal fidelity -- outside WorkRail's control), 3 Yellow (design-inherent or low-probability residuals). No direction change.
- Resolution mode: direct recommendation. Confidence: high. No prototype or research followup needed.

---

## Final Recommendation

**The two-surface model is the complete and accurate picture of WorkRail user interaction.**

### Confidence: High

All original questions are answered with high confidence. The primary failure mode risk (CLI gap) was eliminated by adversarial challenge. Remaining concerns are Yellow/Orange and do not affect the core model.

### Recommendation Summary

1. **Humans never directly launch workflows.** The only human action is prompting their AI agent. WorkRail's MCP tools are agent-callable only.

2. **The console is a read-only monitoring dashboard.** Humans use it to observe what agents did, check session status, inspect execution DAGs, and review step notes and gaps. There is no write path.

3. **`goal` is a required field set by the agent** at `start_workflow` time. It captures the human's intent in one sentence, is validated at the MCP boundary (`z.string().min(1)`), stored as a `CONTEXT_SET` domain event with `source: 'initial'`, and displayed as the session title in the console.

4. **Sessions are created only by `start_workflow` MCP calls.** No other creation path exists.

### Residual Risks (1 Orange, 3 Yellow)

- **O1 (goal fidelity):** Sessions may have unhelpful titles if agents write generic `goal` strings. Fallback exists (recap text as priority 2) but only activates after first advance. Outside WorkRail's direct control.
- **Y1 (eventual consistency):** Console lags by up to 5s due to event log projection. Acceptable for an observation tool.
- **Y2/Y3 (unexamined areas):** `scripts/` directory and full HTTP router not audited. Low probability of material findings; AGENTS.md and console source strongly support the read-only model.

---

## Final Summary

### Selected Path: landscape_first

**Problem framing:** Factual question about an existing system. No design decision pending; no reframing needed. Landscape evidence from source files was the right primary tool.

### Landscape Takeaways

- WorkRail is organized around a strict principal hierarchy: Human -> Agent -> WorkRail MCP -> Event Log -> Console
- The console is a downstream projection system, not a control plane
- Domain event sourcing (append-only log) is what makes the console inherently read-only
- SSE + polling gives near-real-time updates, but the fundamental model is eventually consistent

### Chosen Direction: The Two-Surface Model

WorkRail has exactly two user-facing surfaces:
1. **MCP tools** (agent-callable only) -- `start_workflow`, `continue_workflow`, `resume_session`, `checkpoint_workflow`
2. **Console UI** (human read-only) -- session list, DAG view, node detail

**Why it won:** Confirmed by 6 independent evidence sources (README, AGENTS.md, console API hooks, FullEmptyState component, V2StartWorkflowInput schema, buildInitialEvents). Primary failure mode (CLI gap) was eliminated by adversarial challenge reading `src/cli/commands/start.ts`.

### Strongest Alternative

Candidate 2 (Two-Surface + CLI Audit) was the only alternative. It was subsumed by the adversarial challenge -- the CLI audit was performed and confirmed harmless. No genuine alternative survives.

### Confidence Band: High

### Residual Risks

| ID | Description | Severity | Mitigation |
|----|-------------|----------|-----------|
| O1 | goal fidelity depends on agent quality | Orange | Fallback to recap text (priority 2 title source) |
| Y1 | Console is eventually consistent (5s lag) | Yellow | SSE + 5s polling minimizes lag; acceptable for observation tool |
| Y2 | scripts/ directory not examined | Yellow | AGENTS.md + README provide strong evidence against write paths |
| Y3 | HTTP router not fully audited | Yellow | Console API hooks are all GET; AGENTS.md confirms read-only |

### Next Actions

- No code changes needed for this investigation
- If the user needs end-user documentation for WorkRail, use this doc as the basis
- If O1 becomes a real operational problem (poor session titles), consider adding `goal` quality guidelines to AGENTS.md or agent prompt templates
- If exhaustive system audit is required (e.g., for security review), examine `scripts/` and HTTP API router to close Y2/Y3

---

WorkRail has a clean separation of concerns:
- **Agents use MCP tools** to execute workflows step by step. The human never calls MCP tools directly.
- **Humans use the console** to observe what agents did, see session status, inspect execution DAGs, and review step notes and gaps.
- **`goal`** is a required field the agent sets at `start_workflow` time. It captures the human's task intent in one sentence, is stored as an initial `CONTEXT_SET` event, and becomes the session title shown in the console.
- **Sessions are created only by `start_workflow` calls** -- there is no human-initiated session creation path.
- **The console is read-only** -- it is a monitoring/retrospective tool, not a workflow launcher.
