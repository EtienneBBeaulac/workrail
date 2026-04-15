# Agent WorkRail Protocol Guide

**Purpose:** This document is a human-readable reference for understanding how AI agents (like Claude) interact with WorkRail using the v2 MCP tool API.

**Audience:** Agent developers, workflow authors, and users who want to understand the agent-side execution model.

**Not for:** Workflow engine internals, storage/database implementation, UI/dashboard code.

**Execution truth is in WorkRail session notes and context variables, not in this file. This is a read artifact only.**

> **Note on shipping status:** WorkRail v2 is actively developed. Some features described here are design-locked and may not be fully implemented in the current release. Where uncertain, the normative spec (`docs/reference/workflow-execution-contract.md`) takes precedence.

> **Relationship to tool descriptions:** The tool descriptions that agents see at runtime (at MCP initialization) are defined in `src/mcp/workflow-protocol-contracts.ts`. This guide reflects the same semantics. If the two ever diverge, the tool descriptions are authoritative for agent runtime behavior.

---

## Context / Ask

Understand the WorkRail v2 agent-side protocol:
- What MCP tools agents call and in what order
- What data agents send and receive at each step
- How `continueToken` works and what it encodes
- What the agent's role is vs the user's role
- How rehydration, checkpointing, and session resume work

## Path Recommendation

`landscape_first` — the system is well-documented; the task is synthesizing existing facts into a clear reference, not designing anything new.

## Constraints / Anti-goals

- Focus: v2 tools only (`list_workflows`, `inspect_workflow`, `start_workflow`, `continue_workflow`, `checkpoint_workflow`, `resume_session`)
- No v1 tools (`advance_workflow`, `discover_workflows`)
- No engine internals (storage, session database, execution state machine)
- No dashboard/Studio UI

---

## Landscape Packet

### 1. System Overview

WorkRail is a step-by-step workflow enforcement engine delivered as an MCP server. It compiles workflow definitions (JSON) into a durable execution graph (DAG), then guides agents through it one step at a time. The agent never sees the full workflow -- it receives one step's prompt, does the work, submits output, and WorkRail decides what comes next.

**v1 vs v2:**
- v1 (legacy): stateless request/response. Tools: `workflow_list`, `workflow_get`, `workflow_next`, `workflow_validate`. No durable sessions, no branching.
- v2 (current, default): durable session engine with DAG-based model. Tools: `list_workflows`, `inspect_workflow`, `start_workflow`, `continue_workflow`, `checkpoint_workflow`, `resume_session`. Supports loops, blocked nodes, fork detection, rewind.

### 2. The v2 Tool Set and Call Sequence

#### Discovery (read-only, no side effects)

**`list_workflows`**
- Input: `{ workspacePath, tags?, includeSources? }`
- Without `tags`: returns a compact `tagSummary` (~500 tokens) with when-to-use phrases per tag
- With `tags`: returns the full workflow list filtered to those tags
- Shortcut: if a workflow ID in `tagSummary.examples[]` already matches the goal, go straight to `start_workflow`

**`inspect_workflow`**
- Input: `{ workflowId, mode: "metadata"|"preview", workspacePath }`
- `metadata` mode: name + description only
- `preview` mode: full step-by-step breakdown (default)
- Read-only, no execution state created

#### Execution (mutates durable state)

**`start_workflow`**
- Input: `{ workflowId, workspacePath, goal }`
  - `goal`: one sentence (e.g., "implement OAuth refresh token rotation") -- populates session title in dashboard
- Creates a durable session, pins the run to the current workflow hash
- Returns: first step's prompt + `continueToken` (ct_...) + `checkpointToken` (cp_...)
- The `continueToken` carries session identity AND advance authority

**`continue_workflow`** (the core loop tool)
- Input: `{ continueToken, intent?, context?, output? }`
  - `continueToken`: opaque, round-trip exactly as returned. Two kinds:
    - `ct_...` (continueToken from start_workflow or previous continue_workflow): has advance authority
    - `st_...` (resumeToken from checkpoint_workflow or resume_session): identity only, valid only for `intent: "rehydrate"`
  - `intent`: `"advance"` | `"rehydrate"`. Auto-inferred if omitted: output present = advance, absent = rehydrate
  - `context`: external facts, **only what changed** since last call. WorkRail auto-merges with previous context.
  - `output.notesMarkdown`: per-step summary (THIS step only, never cumulative). WorkRail concatenates across steps.
  - `output.artifacts[]`: optional structured data per workflow output contract
- **Advance** (intent=advance, output provided): step acknowledged as complete, WorkRail advances DAG, returns next step
- **Rehydrate** (intent=rehydrate, no output): state recovery -- returns current pending step without any durable mutation. Used after rewinds, restarts, or lost context. **Side-effect-free.**

**`checkpoint_workflow`**
- Input: `{ checkpointToken }` (from most recent start_workflow or continue_workflow response)
- Creates a durable save point at the current node WITHOUT advancing workflow state
- Returns: `checkpointNodeId` + `resumeToken` (st_...) for cross-chat resume + `nextCall.params.continueToken` to continue in current chat
- Idempotent: replaying the same checkpointToken is a no-op

**`resume_session`**
- Input: `{ workspacePath, query?, runId?, sessionId?, gitBranch?, gitHeadSha? }`
- Read-only lookup across `~/.workrail/sessions/` to find matching prior sessions
- Returns up to 5 ranked candidates with ready-to-use continuation templates
- To resume: call `continue_workflow` with the candidate's `nextCall.params` (`continueToken` + `intent: "rehydrate"`)

### 3. Token Semantics

| Token | Prefix | Created by | Carries | Valid for |
|-------|--------|-----------|---------|-----------|
| continueToken | `ct_` | start_workflow, continue_workflow | session identity + advance authority | advance + rehydrate |
| resumeToken | `st_` | checkpoint_workflow, resume_session | session identity only | rehydrate only |
| checkpointToken | `cp_` | start_workflow, continue_workflow | checkpoint authority for current node | checkpoint_workflow call |

**Key invariants:**
- All tokens are opaque: agents must round-trip them without inspection or modification
- Tokens are scoped: a token from run A cannot be used on run B
- Idempotency: replaying the same (continueToken, output) returns the same response without double-advancing
- Older tokens = older snapshots: advancing from an older continueToken creates a new branch (rewind-safe)

### 4. Agent Role vs User/Engine Role

**Agent MUST:**
- Call `list_workflows` (or read workrail://tags resource) before starting any multi-step task
- Execute each returned step exactly as written
- Call `continue_workflow` with `output.notesMarkdown` documenting work done THIS step (required in guided mode; omitting returns a blocked response)
- Round-trip all tokens as opaque strings *(schema-enforced: tokens are validated by WorkRail; modified tokens will fail)*
- Put only CHANGED facts in `context` (WorkRail auto-merges)
- In full-auto mode: gather context by best effort, make explicit assumptions, record gaps -- never silently skip

**Agent MUST NOT:**
- Construct or mutate workflow execution state
- Decode, inspect, or modify tokens *(schema-enforced)*
- Assume what step comes next before calling `continue_workflow`
- Accumulate prior notes into `output.notesMarkdown` (per-step scope only -- behavioral correctness, not schema-enforced)
- Re-pass unchanged context fields (wastes tokens -- behavioral, not schema-enforced)
- Send `output` when `intent` is `"rehydrate"` *(schema-enforced: Zod validation rejects this combination)*

**WorkRail engine owns:**
- Step selection and sequencing
- Loop and conditional control flow
- DAG advancement
- Session persistence (`~/.workrail/sessions/`)
- Blocking vs never-stop mode behavior
- Token minting and validation

**User/workflow author owns:**
- Workflow definitions (step prompts, output contracts, loop structure)
- Execution mode (guided vs full_auto_stop_on_user_deps vs full_auto_never_stop)
- When to start/resume workflows
- When to checkpoint

### 5. End-to-End Flow (Happy Path)

```
list_workflows({ workspacePath })
  → tagSummary or workflow list

[optional] inspect_workflow({ workflowId, mode: "preview", workspacePath })
  → step breakdown

start_workflow({ workflowId, workspacePath, goal })
  → { pending: { stepId, prompt }, continueToken: "ct_1", checkpointToken: "cp_1", isComplete: false }

[agent does the work described in pending.prompt]

continue_workflow({ continueToken: "ct_1", output: { notesMarkdown: "..." } })
  → { pending: { stepId, prompt }, continueToken: "ct_2", checkpointToken: "cp_2", isComplete: false }

[repeat until isComplete: true]

continue_workflow({ continueToken: "ct_N", output: { notesMarkdown: "..." } })
  → { isComplete: true, pending: null }
```

### 6. output.notesMarkdown Requirements

The most important data the agent sends back. Per-step scope only (WorkRail concatenates). Required for advance calls (omitting blocks the step in guided mode). Quality guidelines:
1. What you did and key decisions/trade-offs
2. What you produced (files, functions, test results, numbers)
3. Anything notable (risks, open questions, deliberate omissions)

Format: markdown headings, bullets, bold, code refs. Be specific (file paths, function names, counts). 10-30 lines target.

### 7. Rehydration and Rewind Safety

When chat context is lost (restart, rewind, long conversation):
- Call `continue_workflow` with the last known `continueToken` and **no output** (or `intent: "rehydrate"`)
- WorkRail returns the current pending step's prompt (and recap of prior steps up to budget)
- This is completely side-effect-free -- no advancement, no node creation
- If using a resumeToken (st_...) from a checkpoint: same pattern, forces rehydrate-only

Rewinds naturally create branches: advancing from an older continueToken creates a new sibling branch in the run's DAG. WorkRail tracks all branches; the dashboard renders forks rather than treating them as errors.

### 8. MCP Platform Constraints That Shape the Protocol

- No server push: all actions must be initiated by the agent via tool calls
- No transcript access: WorkRail cannot read chat history -- durable memory must live in session storage
- Agents are lossy: they can omit fields or call tools out of order -- contracts are self-correcting
- Replays happen: all execution tools are designed to be idempotent or replay-safe
- Local-only storage: sessions in `~/.workrail/sessions/` as append-only event logs

### 9. Evidence Gaps and Limitations

- The `context` auto-merge behavior (WorkRail merges with previous context) is described in tool schemas but the merge strategy details are in engine code not examined in full
- `output.artifacts[]` closed set of valid kinds is workflow/contract-defined; not fully inventoried here
- `blocked` state handling (when WorkRail returns `kind: "blocked"` with structured blockers) is specified in the execution contract but not traced through actual handler code
- `full_auto` mode variants and their exact behavioral differences are described normatively but engine implementation not verified

## Problem Frame Packet

### Stakeholders

| Stakeholder | Primary job / outcome | Pain or tension |
|-------------|----------------------|-----------------|
| **Agent developers** (e.g., Claude Code users) | Execute complex tasks reliably without reinventing process | Understanding the token protocol and what to send/not send on each call is non-obvious; agents tend to over-send context or under-send notes |
| **Workflow authors** | Define step-by-step processes that agents follow faithfully | The boundary between "what the workflow enforces" vs "what the agent decides" is opaque until you read the contract |
| **End users** | Get multi-step tasks done correctly, with recoverable progress | Rewinds and context loss silently break progress unless checkpointing is used |
| **WorkRail engine** (system stakeholder) | Maintain durable, rewind-safe, deterministic execution | Cannot read chat transcript; must infer intent from tokens alone |

### Core Tension

The fundamental tension is between **agent autonomy** and **workflow fidelity**. Agents are general-purpose reasoners that naturally want to anticipate and skip ahead. WorkRail's value proposition requires the agent to receive and execute exactly one step at a time, never looking ahead. The token protocol enforces this -- but only if the agent respects it.

Secondary tension: **token frugality vs completeness**. The `context` field should carry only changed facts, but agents often echo everything back. The `output.notesMarkdown` must be specific and substantive, but agents often write vague summaries. Both failure modes degrade WorkRail's value.

### Success Criteria

1. Agent calls `continue_workflow` with `output.notesMarkdown` after each step (not at the end of all steps)
2. Agent round-trips `continueToken` exactly without modification
3. Agent sends only changed facts in `context` (not the full prior context)
4. Agent uses rehydrate correctly (no output) when recovering from context loss
5. Agent does not skip `list_workflows` / `start_workflow` for multi-step tasks

### Key Assumptions (could be wrong)

- The agent always receives and processes the full step prompt before acting (could be truncated in very long sessions)
- The `continueToken` is always available in the response -- if a tool call fails silently, the token is lost and rehydration via `resume_session` is the only path
- WorkRail's context auto-merge is a deep merge (objects merged, arrays replaced) -- this assumption about merge semantics affects what agents need to send

### Reframes / HMW Questions

1. **HMW make the token protocol self-documenting?** -- The current design relies heavily on the agent reading and internalizing the tool description. What if the response itself always included a `nextCall.params` template the agent should copy?
2. **HMW reduce the notes quality variance?** -- `output.notesMarkdown` quality varies wildly across agents and contexts. What if the workflow step itself declared a required notes template structure?
3. **Reframe:** The "agent executes one step" model could also be read as "WorkRail is the user's persistent planner, and each tool call is the agent checking in with the planner." This framing makes the `continue_workflow` interaction feel more natural -- it's a check-in, not a submission.

### Framing Risks

1. This document treats WorkRail v2 as stable and shipped -- but `AGENTS.md` notes some features are "design-locked but not necessarily shipped yet." The protocol contract may describe aspirational behavior.
2. The token auto-inference (`output present = advance`) is convenient but creates a subtle footgun: accidentally passing `output` in a rehydrate call returns an error (`output` + `intent:rehydrate` is explicitly rejected by the input schema).

## Candidate Directions

**Path-specific expectations (landscape_first):** Candidates must reflect what the landscape actually shows -- the tool call sequence, token semantics, and agent role boundaries as documented in source and spec. Candidates should differ in presentation style (how the information is organized for the reader), not in invented approaches or novel designs.

### Candidate A: Tutorial-style flow guide

Structure the guide as a narrative that walks through a complete end-to-end example. Start from "agent receives a request" and trace through every tool call with annotated request/response payloads. Focus on the happy path first, then add recovery (rehydrate, checkpoint) as a separate section.

**Strengths:** Easy to follow for newcomers; concrete examples ground abstract concepts; shows the token lifecycle in context.
**Weaknesses:** Less scannable for experienced developers who need quick lookup; example specificity can become outdated.

### Candidate B: Reference-style spec

Structure the guide as a reference document organized by tool, with a tool catalog, token table, agent rules (MUST/MUST NOT), and a separate "gotchas" section. Happy path is summarized as a sequence diagram. Recovery paths are part of the same tool entries.

**Strengths:** Scannable and lookup-friendly; mirrors how API docs work; each tool entry is self-contained.
**Weaknesses:** Requires more context to understand for newcomers; the "why" behind rules is harder to convey in reference format.

**Recommendation:** Hybrid -- use the Candidate B reference structure (tool catalog, token table, MUST/MUST NOT rules) as the primary organization, but embed a complete end-to-end flow section (Candidate A style) early in the document as the narrative anchor. The current design doc already has this hybrid structure.

## Challenge Notes

*(To be filled during review)*

## Resolution Notes

*(To be filled after synthesis)*

## Decision Log

- **2026-04-05**: Chose `landscape_first` path — the source material is already well-documented; goal is synthesis, not reframing.
- **2026-04-05**: Delegation not attempted — task is single-agent synthesis from already-gathered source code; no parallel cognition benefit.
- **2026-04-05**: Web browsing not needed — all authoritative sources are local files in `src/mcp/` and `docs/reference/`.
- **2026-04-05**: Selected **Candidate 2 (hybrid AGENTS.md-style guide)** over Candidate 1 (flat spec). Primary reason: "document why not what" is the strongest applicable philosophy principle, and the primary failure mode of a flat spec is that developers treat non-obvious constraints as arbitrary and violate them in production. Candidate 2 adapts the proven `AGENTS.md` structure already established in this repo.
- **2026-04-05**: Challenge against Candidate 2 failed to materially weaken it. The brevity argument for Candidate 1 is valid but applies to tool descriptions (already separate in `workflow-protocol-contracts.ts`), not developer reference docs. Accepted tradeoff: slightly higher maintenance burden for rationale sentences.

## Final Summary

### What the Investigation Found

WorkRail v2 is a durable, DAG-based workflow enforcement engine delivered as an MCP server. Agents interact with it via 6 MCP tools:

1. **`list_workflows`** -- discover available workflows by tag or get a tag summary
2. **`inspect_workflow`** -- read-only preview of workflow steps (never mutates state)
3. **`start_workflow`** -- create a durable session, get the first step prompt + `continueToken`
4. **`continue_workflow`** -- the core loop: advance (send output) or rehydrate (no output)
5. **`checkpoint_workflow`** -- save progress at current node without advancing
6. **`resume_session`** -- cross-chat session lookup by query/runId/sessionId

### The Core Protocol (3 sentences)

Call `start_workflow` with `workflowId`, `workspacePath`, and a one-sentence `goal`. Receive the first step's prompt and a `continueToken`. Loop: do the step's work, call `continue_workflow` with `output.notesMarkdown` (THIS step only) and the `continueToken`, get the next step. Stop when `isComplete: true`.

### The Non-Obvious Parts

- **`continueToken`** is opaque and unified: it replaced the older stateToken+ackToken pair. Round-trip it exactly. A `ct_` prefix means it can advance; an `st_` (resumeToken) can only rehydrate.
- **Rehydrate is side-effect-free**: omitting `output` (or passing `intent: "rehydrate"`) returns the current step without changing anything. Use this after context loss or rewinds.
- **`context` is incremental**: only send changed facts. WorkRail auto-merges with previous context.
- **`output.notesMarkdown` is per-step scope**: WorkRail concatenates across steps. Never write a cumulative summary.
- **Sending `output` + `intent: "rehydrate"`** is schema-rejected (Zod validation error). The auto-inference rule (`output present = advance`) makes this easy to trigger accidentally.

### Confidence Band

**High.** All findings are traceable to source code (`src/mcp/v2/tools.ts`, `src/mcp/workflow-protocol-contracts.ts`) and the normative spec (`docs/reference/workflow-execution-contract.md`). Three minor evidence gaps exist (blocked state handler internals, full_auto mode engine behavior, artifacts schema closed set) but do not affect the core protocol.

### Residual Risks

1. Some v2 features may be design-locked but not fully shipped (noted in guide header)
2. Guide could drift from runtime tool descriptions in `src/mcp/workflow-protocol-contracts.ts` (pointer added to guide header)
