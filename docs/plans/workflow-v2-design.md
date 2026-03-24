# Workflow v2 Design

This is the **canonical durable design doc** for WorkRail v2.

Use it for:

- durable architectural intent
- invariants that should remain true over time
- the high-level reasoning behind the v2 model

Do **not** use this doc as a chat-resumption script or a line-by-line implementation cookbook.

## North star

Make agent-driven workflows **deterministic and rewind-safe** while keeping the WorkRail tool surface small, durable, and hard to misuse.

## Durable design principles

### Token-based execution boundary

Agents should never assemble engine internals. The MCP boundary should expose opaque tokens and explicit intents instead.

### Append-only truth

Execution truth should be append-only, with sessions/runs/dashboard views derived from projections.

### Pinned determinism

Runs should be pinned to the fully expanded compiled workflow snapshot so replay/resume behavior stays stable.

### Recovery without transcript dependence

WorkRail should not depend on the chat transcript for correctness. Recovery context should come from durable execution truth.

### Closed, typed execution semantics

Preferences, contracts, and other workflow-shaping primitives should prefer closed sets and explicit semantics over loose bags of data.

## Important consequences

### Rewinds are an engine concern

Rewinds should branch safely rather than pushing structural recovery onto the user or agent.

### Preferences are product semantics, not arbitrary metadata

Execution preferences should be WorkRail-defined and durable, not an unbounded preference bag.

### Authoring power should stay deterministic

Templates, features, contracts, and related authoring primitives should remain auditable and deterministic, not become ad hoc runtime magic.

### Failure visibility matters

The system should prefer explicit blocked/error paths and durable recovery over silent degradation.

## Canonical references

- `docs/reference/workflow-execution-contract.md`
- `docs/reference/mcp-platform-constraints.md`
- `docs/adrs/005-agent-first-workflow-execution-tokens.md`
- `docs/adrs/006-append-only-session-run-event-log.md`
- `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
- `docs/design/v2-core-design-locks.md`

## Companion docs

- `docs/plans/workflow-v2-roadmap.md`
- `docs/plans/v2-followup-enhancements.md`
