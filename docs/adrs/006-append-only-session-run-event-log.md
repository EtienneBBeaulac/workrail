# ADR 006: Append-Only Session/Run Event Log as Source of Truth

**Status:** Accepted  
**Date:** 2025-12-17

## Context

WorkRail runs as a local stdio MCP server. Chat UIs can rewind/edit history without warning, and WorkRail cannot read the chat transcript or push messages into it. Agents are lossy and can replay tool calls.

We need workflow execution to be deterministic, rewind-safe, and export/import resumable, while keeping the MCP tool surface small and hard to misuse.

## Decision

Use an **append-only event log per session** as the **source of truth** for durable state, and derive all dashboard/session views as projections.

Definitions:

- **Session**: a UX grouping for a single workstream (ticket/PR/chat). Sessions are not an authoritative pointer; they are a projection over stored events.
- **Run**: a single workflow execution pinned to a workflow snapshot. A session can contain 0..N runs.
- **Node graph**: each run forms a **DAG of nodes** representing execution snapshots. Rewinds naturally create **branches** (multiple children from the same parent node).

We also record **observations** (e.g., git branch, HEAD SHA) as append-only events to improve resume/search accuracy without relying on agent-provided identity.

Preference changes are also treated as durable truth:

- Preferences are a closed set of WorkRail-defined values (not arbitrary key/value).
- Effective preferences are recorded on nodes (or via append-only events) so behavior is rewind-safe and export/import safe.

Compiled workflow snapshots are treated as part of the durable truth:

- Workflow execution is pinned to a `workflowHash` computed from the **fully expanded compiled workflow** (including built-in template expansion, feature application, and selected contract packs).
- The pinned snapshot (by hash) is persisted so export/import and long-lived runs remain deterministic even as on-disk workflow files or builtin packs evolve.

## Why

- **Rewind-safe correctness**: “current pointer” state drifts under rewinds. A graph of immutable snapshots makes forks explicit and correct.
- **Deterministic resume**: execution resumes from a stored snapshot node, not from chat context.
- **Export/import resumability**: portable events and node snapshots can be moved between machines; tokens are re-minted on import.
- **Tool simplicity**: agents should not manage or construct engine internals; the engine owns the mechanics.

## Consequences

- Tokens (`stateToken`, `ackToken`) are **handles**, not truth. The canonical truth is stored events and node snapshots.
- The storage model must support:
  - stable identifiers for runs and nodes
  - edges keyed for idempotency
  - portable node payloads sufficient to rehydrate execution deterministically
- The event log may include a bounded “decision trace” (step selection reasons, loop decisions, fork detection) to support debugging/auditing as first-class capabilities without relying on chat transcript history.
- “Sessions” and “latest” are derived views; no authoritative server-side cursor.

- Global preferences are treated as defaults only: they are copied into a session baseline at the start of work, so later global changes do not retroactively affect existing runs.

- Export/import bundles should be able to carry the durable truth (events, node snapshots, pinned workflow snapshots) so another machine can import and resume deterministically.

- The **Workrail Console** (UI) is a derived projection over the event log and stored workflow snapshots; it does not mutate the event log except indirectly via workflow editing (which writes to source storage).

## Related

- MCP constraints: `docs/reference/mcp-platform-constraints.md`
- Normative tool contract: `docs/reference/workflow-execution-contract.md`
- Token boundary decision: `docs/adrs/005-agent-first-workflow-execution-tokens.md`
- Resume and checkpoint-only sessions: `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
