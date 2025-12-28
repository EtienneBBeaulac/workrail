# Agent Context Guidance (v2)

WorkRail v2 is designed so agents **do not manage engine state** and do not need to optimize large “context payloads” as a primary correctness mechanism.

## What replaces this in v2

- **Token-based execution**: use `start_workflow` / `continue_workflow` with opaque tokens (`stateToken`, `ackToken`).
- **Rehydrate is read-only**: calling `continue_workflow` without `ackToken` must be side-effect-free.
- **Durable progress lives in `output`**: write durable recaps/artifacts through `output`, not by echoing large context.
- **Checkpointing is replay-safe**: `checkpoint_workflow` uses `stateToken` + `checkpointToken` and is idempotent.

## Canonical references (v2)

- Execution contract: `docs/reference/workflow-execution-contract.md`
- Core locks (idempotency, checkpointing, `SessionHealth` gating): `docs/design/v2-core-design-locks.md`
- Authoring reference: `docs/design/workflow-authoring-v2.md`
