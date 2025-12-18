# ADR 005: Agent-First Workflow Execution via Opaque Tokens

**Status:** Accepted  
**Date:** 2025-12-17

## Context

WorkRail workflows are driven by an LLM agent operating inside a chat UI. Chat UIs allow users to rewind/edit conversation history, which makes any server-side “current pointer” state inherently unreliable: the agent can unknowingly resume from an earlier point in time.

WorkRail runs locally (stdio MCP) and is intended for a single developer machine. We optimize for an “honest-but-buggy” caller model rather than malicious clients. Confidentiality is not a primary requirement, but integrity and fail-fast validation remain important to catch accidental corruption and protocol drift.

This ADR is constrained by the MCP platform model (no server push into the chat, no transcript access, lossy/replayed tool calls). See:

- `docs/reference/mcp-platform-constraints.md`

We recently moved to a state/event workflow engine and exposed internal engine state at the MCP boundary (`state` + optional `event`). While correct and expressive, this leaks engine internals into the agent contract. In practice it increases agent error rate, increases payload complexity, and makes tool descriptions harder to keep aligned with actual tool schemas.

We also have “session tools” primarily to power a dashboard. Today, session state can drift out of sync under rewinds because the dashboard/session layer treats the server’s session pointer as authoritative.

As a concrete example of boundary drift, we observed `workflow_next` tool descriptions still referencing `completedSteps` while the actual tool contract had already shifted to a state/event schema. This kind of mismatch is easy to introduce when the public API exposes engine internals and evolves quickly.

Rewinds create an additional reality gap: meaningful work often happens “between workflow calls.” If a user rewinds after substantial off-workflow work (e.g., implementing code guided by the agent without advancing a workflow step), that context is lost unless WorkRail offers a durable persistence primitive that does not advance workflow state.

## Before / After (Why this ADR exists)

### Before (agent submits progress)

- Agent submits “progress” directly (e.g., completed steps).
- Issues:
  - Easy for the agent to hallucinate or drift from reality.
  - Hard to model loops and step instances precisely.
  - Rewinds are ambiguous (what is “the current run” if history changed?).

### Current (engine internals exposed)

- Agent submits engine internals (`state` + `event`) and must understand protocol mechanics.
- Issues:
  - Tool boundary is not agent-first; the agent constructs data it shouldn’t need to understand.
  - Description drift is easy (we already saw mismatches between tool descriptions and input schemas).

### Proposed (opaque tokens)

- Agent submits opaque tokens minted by WorkRail; WorkRail owns the engine mechanics.
- Rewinds become a first-class, correct behavior (older token → older snapshot).

## Decision

Make workflow execution tools **agent-first** by hiding engine internals behind two opaque primitives:

- **`stateToken`**: an opaque, server-minted representation of the workflow execution snapshot (including workflow identity/version and run identity). The client must round-trip it unchanged.
- **`ackToken`**: an opaque, server-minted acknowledgement token representing “I completed the pending step WorkRail instructed for this `stateToken`”. The server must treat `(stateToken, ackToken)` as **idempotent** (replay returns the same response and does not double-advance).

Sessions are **demoted** to a dashboard/UX projection over immutable token lineage rather than an authoritative pointer:

- The dashboard groups and renders runs for human consumption.
- The workflow “truth” is always derived from the token presented by the client.
- Rewinds/forks are represented as branches in token lineage, not as “session desync”.

Pin workflow definitions for deterministic runs:

- `start_workflow` pins a run to a specific workflow snapshot identified by a content hash (`workflowHash`).
- `stateToken` embeds `workflowHash` so runs remain deterministic even if workflow files evolve.
- Pinned workflow snapshots must be persisted in session storage to support export/import and long-lived runs.

Tools are renamed for clarity:

- `workflow_get` → `inspect_workflow` (read-only definition/preview; never executes)
- `workflow_next` → split into `start_workflow` + `continue_workflow` (explicit lifecycle: start a run, then continue it)

Introduce a checkpoint primitive for rewind resilience outside the strict workflow step loop:

- `checkpoint_workflow`: append a durable summary/artifact without advancing workflow state. This is intended for “off-workflow” work and post-workflow iteration. It should be treated as opt-in and can be gated behind a feature flag while it is validated in real usage.

## Consequences

### Positive

- **Rewind/fork correctness**: rewinding a chat naturally reuses an older `stateToken` and continues from that snapshot.
- **Agent usability**: the agent no longer constructs engine internals (loop stacks, discriminated unions, etc.).
- **Idempotent progress**: replays of the same completion do not advance twice.
- **Dashboard consistency**: sessions become a graph/timeline of token lineage; rewinds produce branches rather than desync.
- **Durable memory**: checkpoints capture high-signal progress that would otherwise be lost when rewinding or trimming chat context.
- **Portable sharing**: sessions can be exported/imported locally, and rendered exports (e.g., Markdown/PDF) can be generated as projections of session artifacts.
- **Deterministic runs**: pinning workflows by content hash prevents “live” behavior changes mid-run when workflow files are edited.

### Negative

- **Token design requirements**: tokens must be versioned, validated, and (at minimum) tamper-evident (e.g., signature/HMAC).
- **Migration effort**: MCP tool names and contracts change; workflow authors may need to add explicit output contracts for structured dashboards (see contract spec).
- **More surface area**: checkpointing adds a new tool and a new user/agent behavior. To mitigate, keep checkpoint payloads minimal and gate behind a feature flag until proven.
- **More persistence**: pinning workflow snapshots and storing event logs requires explicit session storage (still local-only and small).

## Alternatives Considered

- **Server-managed session as truth**: breaks under chat rewinds unless additional concurrency/forking machinery is required.
- **Keep exposed engine state**: correct but not agent-first; easy to drift in descriptions/schemas and increases agent failure modes.
- **ClientCallId idempotency**: adds additional surface area; we prefer to make `ackToken` idempotent.
- **Runtime inference of step semantics**: brittle across diverse workflows; avoid guessing.

## Related

- Tool contract spec: `docs/reference/workflow-execution-contract.md`
- Append-only session/run log: `docs/adrs/006-append-only-session-run-event-log.md`
- Resumption lookup + checkpoint-only sessions: `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
