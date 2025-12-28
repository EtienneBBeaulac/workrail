# Feature Flags Architecture (v2)

WorkRail v2 treats configuration/flags as a **control-plane concern** that must respect two hard constraints:

- **Tool discovery is bounded at initialization**: tool sets and schemas cannot be changed live for an already-initialized agent.
- **Correctness is token- and durable-truth-driven**: flags must not create “hidden behavior” that makes runs non-deterministic.

## Canonical locks (v2)

- Desired vs applied + restart-required UX: `docs/design/v2-core-design-locks.md` (Console architecture locks)
- Tool discovery bounded constraint: `docs/reference/mcp-platform-constraints.md`

## v2 model: desired vs applied

WorkRail v2 must treat config as two states:

- **desired**: what the user wants (editable in Console)
- **applied**: what the running MCP server actually has loaded

The server computes an `appliedConfigHash` at startup for the applied config. When desired != applied, Console must show **restart required**.

## Restart-required triggers (closed set)

A config change is restart-required if it changes any of:

- MCP **tool set** (tools added/removed)
- MCP tool **schema** (inputs/outputs)
- workflow source registration impacting discovery/catalog
- feature flags that gate tools or tool schemas

## Runtime-safe config changes

Runtime-safe changes are limited to:

- read-only presentation settings (UI-only)
- retention settings for projections that do not affect correctness of existing run graphs
