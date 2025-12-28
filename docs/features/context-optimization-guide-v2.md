# Context Optimization Guide for Workflows (v2)

WorkRail v2 is designed to reduce the need for “context optimization” as a correctness strategy by moving workflow execution state behind opaque tokens and persisting durable progress in WorkRail storage.

## What replaces this in v2

- **Opaque tokens**: `start_workflow` / `continue_workflow` return `stateToken` / `ackToken`; agents do not send engine state like `completedSteps`.
- **Rehydrate is read-only**: `continue_workflow` without `ackToken` is side-effect-free.
- **Durable progress**: write `output.notesMarkdown` (and optional artifacts) when acknowledging steps.
- **Checkpointing**: call `checkpoint_workflow` with `stateToken` + `checkpointToken` to persist off-step progress (idempotent).

## Canonical references (v2)

- Execution contract: `docs/reference/workflow-execution-contract.md`
- Core locks (idempotency, checkpointing, `SessionHealth` gating): `docs/design/v2-core-design-locks.md`
