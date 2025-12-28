# ADR 007: Resumption UX via Lookup + Checkpoint-Only Sessions (Flagged)

**Status:** Accepted  
**Date:** 2025-12-17

## Context

WorkRail cannot access chat history. A brand new chat has no transcript context and cannot “resume” unless it supplies some external handle.

Requiring users to copy/paste opaque execution tokens (`stateToken`) between chats is high friction. However, adding broad session CRUD tools expands the tool surface area and is easy for agents to misuse.

## Decision

Introduce two **optional, feature-flagged** MCP tools that improve resumption without reintroducing mutable session state:

1) **`resume_session` (flagged)**: a read-only lookup tool that supports queries like “resume my session about xyz”.
   - Returns **tip-only** resume targets (latest branch tip by deterministic policy).
   - Uses a **layered search** strategy (titles/keys first; durable notes/artifact previews next; deep search last).
   - Returns bounded, high-signal snippets for disambiguation and a recommended candidate when confidence is high.

2) **`start_session` (flagged)**: enables checkpoint-only sessions in the future.
   - Mints an opaque `sessionToken` / `sessionRef` so `checkpoint_workflow` can attach durable outputs even when no workflow run is active.
   - Does **not** introduce general-purpose session update/read/write APIs.

Both tools are behind the same feature flag(s) as the capability they unlock.

## Why

- **Resumption requires a handle**: without transcript access, the system must rely on durable storage.
- **Reduce user friction**: lookup by “xyz” is materially easier than copy/paste of long tokens.
- **Keep tool surface area small**: one lookup tool + one narrowly-scoped session tool, both flagged, avoids a sprawling CRUD API.
- **Deterministic + rewind-safe**: resumption should target the run’s latest tip; rewinds/forks should be explicit and represented as branches.

## Consequences

- `resume_session` must be backed by durable storage and stable projections (see ADR 006).
- Resume ranking uses layered search: git observations (branch/HEAD SHA) at highest tier, then durable node recap outputs, then workflow id/name matching. No session-level title/tag fields exist; aboutness is derived from observations and outputs.
- The contract must clearly separate:
  - **resumption** (tip): return bounded durable recap up to the pending step
  - **rewind/fork** (non-tip): automatically fork and return branch-focused context the agent likely lost (including a bounded downstream recap), without requiring user confirmation

- Export/import must be **resumable**:
  - bundles carry portable run graph nodes and pinned workflow snapshots
  - tokens are re-minted on import from stored node snapshots

## Related

- MCP constraints: `docs/reference/mcp-platform-constraints.md`
- Normative tool contract: `docs/reference/workflow-execution-contract.md`
- Append-only storage model: `docs/adrs/006-append-only-session-run-event-log.md`
- Token boundary decision: `docs/adrs/005-agent-first-workflow-execution-tokens.md`
