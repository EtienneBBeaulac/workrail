# Workflow Execution Contract (Token-Based)

This document describes the proposed “token-based” workflow execution tools intended to be **agent-first**, **rewind/fork safe**, and **idempotent**.

Decision record: `docs/adrs/005-agent-first-workflow-execution-tokens.md`

## Goals

- Provide a minimal, primitives-only MCP contract that agents can use reliably.
- Support rewinds/forks/parallel runs naturally (chat UIs are not monotonic).
- Keep the workflow engine internal; avoid leaking execution internals to clients.
- Treat errors as data (structured error payloads; no throwing across boundaries).

## Non-Goals

- Automatically infer structured output semantics from workflow prompts.
- Require the agent to manage dashboard sessions explicitly.

## Tool Set

### `workflow_list`

Lists available workflows.

### `workflow_inspect`

Read-only retrieval of workflow metadata and/or a preview to help select a workflow.

### `workflow_start`

Starts a new workflow run and returns the first pending step plus opaque tokens.

### `workflow_advance`

Advances an existing workflow run by acknowledging completion of the pending step for a given snapshot.

## End-to-End Flows

### Basic flow (single workflow)

1. Call `workflow_list` and `workflow_inspect` to select a workflow (read-only).
2. Call `workflow_start` to begin execution.
3. Repeat:
   - Follow `pending.prompt`
   - Call `workflow_advance` with the returned `stateToken` and `ackToken`
4. Stop when `isComplete == true` (and `pending == null`).

### Rewind/fork behavior (chat UIs)

If the user rewinds conversation history, the agent may repeat a prior call sequence and reuse an older `stateToken`.

This is expected and correct:

- An older `stateToken` represents an older snapshot.
- Advancing from that token creates a new branch in the run's lineage.
- The dashboard should render forks rather than treating this as “desync”.

### Multiple workflows (sequential, parallel, nested)

Agents may run multiple workflows in a single chat:

- **Sequential**: finish workflow A, then start workflow B.
- **Parallel/interleaved**: keep multiple `{stateToken, ackToken}` pairs and advance any run in any order.
- **Nested**: run workflow B “inside” a step of workflow A by:
  - starting and advancing B separately
  - writing B’s results into A via `context` or step output

No special “nesting API” is required for correctness; it is an orchestration choice.

## Core Concepts

### `stateToken` (opaque snapshot)

- **Minted by WorkRail**.
- Encodes (internally): `workflowId`, `workflowVersion` (or schema hash), `runId`, and execution snapshot data.
- Must be **opaque** to clients: clients round-trip it without modification.
- Must be **validated** by WorkRail (version + signature/HMAC) to prevent tampering.

### `ackToken` (opaque completion acknowledgement)

- **Minted by WorkRail** per pending step and per `stateToken`.
- Represents “the client completed the pending step instruction returned with this snapshot”.
- Must be **idempotent**:
  - Replaying the same `(stateToken, ackToken)` returns the same response payload.
  - Replaying does not advance the run twice.
- Must be **replay-safe by design**:
  - Clients may resend the same request due to retries or tool-call replay.
  - WorkRail must return the same response for the same `(stateToken, ackToken)` pair.
- Must be **scoped**:
  - An `ackToken` from run A must not be usable on run B.
  - An `ackToken` from snapshot X must not be usable on snapshot Y.

### `context` (external inputs)

`context` carries external facts that can influence conditions and loop inputs, e.g.:

- identifiers: ticket id, repo path, branch
- workflow parameters: `quantity`, `deliverable`
- constraints: “don’t run detekt”, “no network”, etc.

Do not place workflow progress state in `context`.

## What the Agent Must and Must Not Do

- **MUST**:
  - Treat `stateToken` and `ackToken` as opaque values.
  - Round-trip both tokens exactly as returned.
  - Only advance the workflow by calling `workflow_advance` with the current tokens.
- **MUST NOT**:
  - Construct or mutate workflow execution state (completed steps, loop stacks, etc.).
  - Guess tool payload shapes beyond what the tool schema and examples provide.

## Request/Response Shapes

### `workflow_start` request

```json
{
  "workflowId": "mr-review-workflow",
  "context": {
    "ticketId": "AUTH-1234",
    "complexity": "Standard"
  }
}
```

### `workflow_start` response (example)

```json
{
  "stateToken": "st.v1....",
  "pending": {
    "stepId": "phase-0-triage",
    "title": "Phase 0: Triage & Review Focus",
    "prompt": "…",
    "requireConfirmation": true
  },
  "ackToken": "ack.v1....",
  "isComplete": false,
  "session": {
    "sessionId": "AUTH-1234",
    "runId": "run_01JFD..."
  }
}
```

Notes:
- `session` is **informational** and for dashboard UX only. Correctness is driven by tokens.

### `workflow_advance` request

```json
{
  "stateToken": "st.v1....",
  "ackToken": "ack.v1....",
  "context": {
    "notesMarkdown": "Completed phase 0. MR is Standard complexity; focus on DI wiring and tool contract correctness."
  }
}
```

### `workflow_advance` response (example)

```json
{
  "stateToken": "st.v1.next....",
  "pending": {
    "stepId": "phase-1-context",
    "title": "Phase 1: Contextual Understanding & Confirmation",
    "prompt": "…",
    "requireConfirmation": true
  },
  "ackToken": "ack.v1.next....",
  "isComplete": false,
  "session": {
    "sessionId": "AUTH-1234",
    "runId": "run_01JFD..."
  }
}
```

## Dashboard / Sessions (UX Projection)

Sessions are a UX layer that should be updated **natively** as a side effect of `workflow_start`/`workflow_advance`:

- Store token lineage as an append-only graph:
  - node: `stateTokenHash`
  - edge: `parentStateTokenHash -> childStateTokenHash` (created on successful advance)
- Rewinds naturally create branches (multiple children for the same parent) instead of “desync”.
- Session pointers (like “latest”) are derived views, not authoritative state.

## Replacing File-Based Docs with Dashboard Artifacts (Optional)

Some workflows currently instruct the agent to write markdown files. The token-based contract can support dashboard-native documents by allowing an optional, step-defined `output` payload in `workflow_advance`:

- Default: accept `notesMarkdown` and render it per step.
- For workflows that need structured dashboards: steps should explicitly define an output contract (schema + example) to avoid inference.

### Defaults for legacy workflows (no output contract)

If a workflow has not been updated to include an explicit output contract, WorkRail can still provide a usable dashboard without guessing semantics:

- Render a per-step “Notes” artifact from `context.notesMarkdown` (or a dedicated `notesMarkdown` field if introduced later).
- Show token lineage, pending step metadata, and completion timestamps.

This is intentionally generic. Structured artifacts (tables, findings, MR comments, etc.) require explicit contracts.

### How explicit output contracts can work

Two compatible approaches:

1. **In-workflow contract**: each step includes an output schema + example (kept small).
2. **Server-side registry**: the workflow references a named output contract, and WorkRail provides the schema and example.

Either way, the workflow (not heuristics) is authoritative.

This approach keeps the agent interaction primitive and moves deterministic “doc updates” into server-side reducers.

### Appendix A: Example dashboard artifacts for `mr-review-workflow` (illustrative)

This appendix illustrates the *shape* of what an agent might send and what the dashboard might render. It is intentionally small and primitives-only for the agent. The exact schema should be declared explicitly by the workflow (or by a referenced contract registry).

#### Example: `workflow_advance` with structured `output`

```json
{
  "stateToken": "st.v1....",
  "ackToken": "ack.v1....",
  "context": {
    "ticketId": "AUTH-1234",
    "complexity": "Standard"
  },
  "output": {
    "kind": "mr_review.phase_0_triage",
    "review": {
      "mrTitle": "fix(di): explicitly wire MCP description provider",
      "classification": "Standard",
      "focusAreas": ["tool contract correctness", "DI wiring", "agent usability"]
    },
    "revisionLogEntry": "Triage completed; created review session and established focus areas."
  }
}
```

WorkRail would store this as dashboard artifacts (example conceptual mapping):

- `review.header`: `mrTitle`, `classification`, `focusAreas`
- `review.revisionLog[]`: append entry

#### Example: changed files table rows (Phase 1)

```json
{
  "kind": "mr_review.changed_files",
  "changedFiles": [
    {
      "path": "src/mcp/tool-description-provider.ts",
      "summary": "Remove debug log; ensure provider wiring is explicit",
      "risk": "L"
    },
    {
      "path": "src/di/container.ts",
      "summary": "Wire description provider in composition root",
      "risk": "M"
    }
  ]
}
```

Dashboard render intent:

- a “Changed Files” table rendered from `changedFiles[]` with deterministic ordering and dedupe keyed by `path`.

#### Example: findings and copy-ready MR comments (Phase 2+)

```json
{
  "kind": "mr_review.findings",
  "findings": [
    {
      "severity": "Major",
      "location": { "file": "src/mcp/tool-descriptions.ts", "line": 79 },
      "title": "Tool description drift: mentions completedSteps but tool uses state/event",
      "rationale": "Agents will send the wrong shape and fail the tool boundary contract.",
      "suggestion": "Update authoritative and standard descriptions to match the current schema."
    }
  ],
  "mrComments": [
    {
      "location": { "file": "src/mcp/tool-descriptions.ts", "line": 79 },
      "title": "Fix workflow_next tool description drift",
      "body": "The description references completedSteps, but the tool input schema now expects state + optional event. This mismatch will cause agent misuse; please update descriptions to match the current contract."
    }
  ]
}
```

Notes:
- The workflow can keep using its rich prompts (and “functionReferences” in the workflow definition) while the dashboard replaces file I/O by treating these outputs as structured artifacts.
- If a workflow does not provide an output contract, WorkRail should fall back to the generic per-step notes dashboard (no inference).

## FAQ

### How is `stateToken` “opaque”?

Opaque means clients treat it as an uninterpreted string. WorkRail is free to encode internal state however it wants (and change that encoding over time) as long as it can validate and decode it server-side.

In practice, WorkRail should make tokens tamper-evident (e.g., signature/HMAC) and versioned (e.g., `st.v1...`, `st.v2...`) to support safe evolution.

### Is `ackToken` enough? What about loops and confirmations?

Yes. Loops, confirmations, and other control structures are internal workflow mechanics represented in the snapshot behind `stateToken`. The public contract is simply:

- WorkRail tells the agent what to do next (`pending`).
- The agent completes it.
- The agent acknowledges completion using the `ackToken` issued for that snapshot.

### Do we need `workflowId` on `workflow_advance`?

No. `workflowId` can be embedded into `stateToken`. Keep `workflowId` only on `workflow_start` (because there is no token yet). Optionally return `workflowId` in responses as informational metadata for the dashboard.

### If sessions are “demoted”, do we still need session tools?

Sessions become a UX projection, so session creation/updating can happen as a side effect of `workflow_start`/`workflow_advance` without extra agent-facing tools.

Separate session tools can still exist for human/ops convenience (open dashboard, inspect stored session graphs, cleanup), but normal agents should not need to call them.
