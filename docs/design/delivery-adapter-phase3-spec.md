# Delivery Adapter Phase 3 -- Spec

## Feature Summary

Operators can configure a delivery channel per-trigger in `triggers.yml` using a `delivery:` block. After a workflow session completes, the daemon calls `adapter.deliver()` for any `cli_inbox` adapter in the resolved config. Every session also emits a `delivery_planned` event so tooling can display what delivery is configured before the session runs.

## Acceptance Criteria

1. A trigger with `delivery: { kind: 'cli_inbox' }` in `triggers.yml` has that config reflected in its parsed `TriggerDefinition.deliveryConfig`, overriding the synthesized default.

2. After a successful workflow session triggered via `route()`, the daemon writes a valid `{ id, message, timestamp }` JSON line to `~/.workrail/outbox.jsonl` when the resolved `deliveryConfig` includes a `cli_inbox` adapter.

3. When the resolved `deliveryConfig` includes `git_commit` or `github_draft_review` adapters (from synthesized legacy fields), `adapter.deliver()` is NOT called for those -- `maybeRunDelivery()` and `maybeRunPostWorkflowActions()` continue to handle them.

4. After `runWorkflow()` emits `session_started`, it emits a `delivery_planned` daemon event containing the resolved adapter kinds for the session.

5. A trigger with no `delivery:` block continues to behave exactly as before Phase 3 (existing `maybeRunDelivery` and `maybeRunPostWorkflowActions` run unchanged).

6. `tsc --noEmit` passes clean; existing trigger-store and trigger-router tests pass.

## Non-Goals

- Calling `adapter.deliver()` for `git_commit` or `github_draft_review` adapters (Phase 4)
- Removing `maybeRunDelivery()` or `maybeRunPostWorkflowActions()` (Phase 4)
- Gate inheritance of `deliveryConfig`
- Fan-out delivery (multiple adapters including both cli_inbox and github_draft_review simultaneously -- Phase 4)
- `reviewerIdentity` deprecation

## External Interface

New `triggers.yml` field:
```yaml
delivery:
  kind: cli_inbox       # currently only cli_inbox is activated in Phase 3
```

New daemon event (appended to daily event log):
```json
{ "kind": "delivery_planned", "sessionId": "...", "deliveryAdapterKinds": ["cli_inbox"], "ts": 1234567890 }
```

## Edge Cases and Failure Modes

- `adapter.deliver()` error: logged, never throws, never affects workflow result
- `delivery_planned` event lost if daemon crashes between session_started and event write: acceptable, informational only
- Trigger with `delivery: { kind: 'github_draft_review' }` in YAML: parsed and stored, but `adapter.deliver()` NOT called for it in Phase 3 (cli_inbox filter). The synthesized github_draft_review from reviewerIdentity is still handled by existing path.

## Verification

| AC | Verification |
|---|---|
| 1 | Unit test: trigger-store parses delivery: block, TriggerDefinition has correct deliveryConfig overriding synthesized default |
| 2 | Unit test: trigger-router calls CliInboxAdapter.deliver() and outbox.jsonl is written |
| 3 | Unit test: synthesized config with git_commit adapter -- verify adapter.deliver() NOT called for it |
| 4 | Unit test: runWorkflow() emits delivery_planned event after session_started |
| 5 | All existing trigger-store and trigger-router tests pass |
| 6 | tsc --noEmit passes |
