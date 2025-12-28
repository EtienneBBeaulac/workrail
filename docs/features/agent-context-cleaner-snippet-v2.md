# Context Cleaner for Agents (v2)

WorkRail v2 does not have a direct equivalent of the v1 “context cleaner” snippet, because:

- workflow execution state is behind opaque tokens (`stateToken`, `ackToken`)
- agents do not send engine state like `completedSteps`
- durable memory is persisted via `output` and `checkpoint_workflow` (with `checkpointToken`)

## Canonical references (v2)

- Execution contract: `docs/reference/workflow-execution-contract.md`
- Core locks (idempotency, checkpointing): `docs/design/v2-core-design-locks.md`
