# MCP Platform Constraints (Design Inputs)

This document records platform constraints that shape WorkRail’s architecture and tool contracts. These are “facts of life” for our environment, not preferences.

## Interaction model constraints

- **No server push into the chat**
  - The MCP server cannot “push” actions into the conversation.
  - Any action must be initiated by the agent via tool calls.

- **No reliable access to chat transcript**
  - WorkRail cannot read or depend on the user’s conversation history.
  - Rewinds/editing can delete context without warning; durable memory must live in WorkRail storage.

## Resumption and rewind implications

- **Brand new chat resumption requires an external handle**
  - Without transcript access, a new chat cannot “resume” unless the agent/user supplies a handle (e.g., a token or a lookup query resolved against durable storage).

- **Rewinds are indistinguishable from legitimate replays at the transport layer**
  - WorkRail should infer fork/resume behavior from its own durable graph state (e.g., whether the provided snapshot is a tip) rather than attempting to reason about chat history.

## Tool-call and agent behavior constraints

- **Agents are lossy and inconsistent**
  - Agents can omit fields, hallucinate payloads, or call tools out of order.
  - Contracts must be self-correcting: text-first outputs, structured blockers/warnings, and “next input” templates.

- **Tool discovery is bounded**
  - Tool schemas/descriptions are learned at MCP initialization (and after restarts).
  - Do not assume dynamic renegotiation mid-session.
  - Preference/mode changes must be represented as durable inputs/events (and surfaced via Studio) rather than relying on implicit chat state.

- **WorkRail cannot introspect the agent’s environment**
  - WorkRail only knows the tools it exposes; it cannot “see” what other tools an agentic IDE provides.
  - Capability detection must be done via explicit agent-reported observations (e.g., probe steps) and recorded durably, not inferred.

## Determinism and recovery constraints

- **Requests and responses must be self-contained**
  - Tool handlers cannot ask follow-up questions directly; they can only return data.
  - “Blocked” states must include enough structured information to recover on the next call.

- **Replays can happen**
  - Even locally, tool calls can be repeated (restart/regenerate/retry).
  - Protocols should be idempotent where possible (e.g., token/ack for workflow advancement).

## Observation-only metadata

- **Environment metadata can only be observed at tool-call time**
  - Some useful signals (e.g., git branch, HEAD SHA) cannot be “kept updated” continuously without an agent-initiated call.
  - These signals should be recorded as append-only observations to improve resume/search accuracy, not as mutable state.

## Environment and storage constraints

- **Local-only by default (stdio)**
  - Storage is local filesystem.
  - Sharing requires explicit export/import (no implicit “share links” unless we introduce remote publishing later).

- **Integrity over confidentiality**
  - Confidentiality is not a primary requirement in local-only mode.
  - Integrity and fail-fast validation still matter to catch accidental corruption or contract drift.

### Export/import implications

- **Resumable sharing requires portable truth**
  - Opaque runtime tokens are not sufficient for portability; exported bundles must include portable snapshots and versioned schemas so imports can resume deterministically.
  - Integrity checks (e.g., manifest digests) are recommended to detect corruption and fail fast with actionable errors.

## Payload and capability constraints

- **Token/payload budgets matter**
  - Keep inputs/outputs reasonably small.
  - Store large artifacts as session artifacts/references instead of repeating them in every call.

- **Capability variability**
  - The agent’s surrounding tools differ by IDE/client.
  - WorkRail must degrade gracefully and gate optional features behind capability checks / feature flags.

## Multi-entrypoint constraint

- **Cross-transport drift risk**
  - MCP/CLI/JSON-RPC must share canonical models and normalization/validation logic.
  - “One protocol, multiple doors” is a requirement to prevent inconsistent behavior.

## See also

- Normative execution protocol: `docs/reference/workflow-execution-contract.md`
- ADR 005 (opaque tokens): `docs/adrs/005-agent-first-workflow-execution-tokens.md`
- ADR 006 (append-only session/run log): `docs/adrs/006-append-only-session-run-event-log.md`
- ADR 007 (resume + checkpoint-only sessions): `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
