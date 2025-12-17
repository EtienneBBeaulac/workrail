# MCP Platform Constraints (Design Inputs)

This document records platform constraints that shape WorkRail’s architecture and tool contracts. These are “facts of life” for our environment, not preferences.

## Interaction model constraints

- **No server push into the chat**
  - The MCP server cannot “push” actions into the conversation.
  - Any action must be initiated by the agent via tool calls.

- **No reliable access to chat transcript**
  - WorkRail cannot read or depend on the user’s conversation history.
  - Rewinds/editing can delete context without warning; durable memory must live in WorkRail storage.

## Tool-call and agent behavior constraints

- **Agents are lossy and inconsistent**
  - Agents can omit fields, hallucinate payloads, or call tools out of order.
  - Contracts must be self-correcting: text-first outputs, structured blockers/warnings, and “next input” templates.

- **Tool discovery is bounded**
  - Tool schemas/descriptions are learned at MCP initialization (and after restarts).
  - Do not assume dynamic renegotiation mid-session.

## Determinism and recovery constraints

- **Requests and responses must be self-contained**
  - Tool handlers cannot ask follow-up questions directly; they can only return data.
  - “Blocked” states must include enough structured information to recover on the next call.

- **Replays can happen**
  - Even locally, tool calls can be repeated (restart/regenerate/retry).
  - Protocols should be idempotent where possible (e.g., token/ack for workflow advancement).

## Environment and storage constraints

- **Local-only by default (stdio)**
  - Storage is local filesystem.
  - Sharing requires explicit export/import (no implicit “share links” unless we introduce remote publishing later).

- **Integrity over confidentiality**
  - Confidentiality is not a primary requirement in local-only mode.
  - Integrity and fail-fast validation still matter to catch accidental corruption or contract drift.

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
