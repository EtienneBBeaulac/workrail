# Briefing for next agent

**Current branch:** `fix/etienneb/engine-hint-content-fixes`
**Current task:** Fix engine hint content (GitHub issue #1074)
**Full handoff doc:** `docs/plans/handoff-may-20-2026.md`

## What to do right now

Run `wr.coding-task` with goal: "Fix engine hint content -- correct misleading artifact validation guidance (issue #1074)"

The design is complete. Read `docs/plans/cortex-hint-content-design.md` before touching any code.

## The 4 changes

**Change 1:** Create `src/v2/durable-core/schemas/artifacts/blocked-messages.ts`
- A registry mapping each `ArtifactContractRef` to its `getBlockedMessage()` output
- Each contract schema file already has `getBlockedMessage()` -- collect them here
- Include `wr.contracts.assessment` (currently only in `reason-model.ts` inline)
- MUST NOT import from `reason-model.ts` (circular import risk)

**Change 2:** Wire `src/mcp/handlers/v2-advance-core/reason-model.ts` `reasonToBlocker()`
- Replace the binary `ASSESSMENT_CONTRACT_REF` dispatch with a registry lookup
- For known contractRefs: set `suggestedFix` to the scaffold with prefix "Pass this artifact in `output.artifacts` of your `complete_step` call:"
- For empty `output.artifacts` (artifacts array is empty but outputContract declared): say "your `output.artifacts` was empty -- pass it as: [scaffold]"
- For unknown contractRefs: fall back to "Check the step's outputContract for the required artifact format and pass it in `output.artifacts`"

**Change 3:** Fix `src/mcp/handlers/v2-execution/advance.ts` line 137
- Load `contractRef` from `primaryReason.pointer` (it has kind `output_contract` and carries `contractRef`)
- Replace hardcoded `"wr.assessment"` and the example with the actual contractRef and its scaffold from the registry
- Fallback to generic message if no registry entry

**Change 4:** Add wrong-kind detection in `src/v2/durable-core/domain/artifact-contract-validator.ts`
- Before kind-filtering, capture submitted artifact kinds
- When agent submitted `wr.assessment` but `wr.loop_control` is required: "You submitted kind 'wr.assessment', but this step requires kind 'wr.loop_control'"

## Prerequisites to verify before implementing

1. Check that `primaryReason.pointer` reliably carries `contractRef` in all `MISSING_REQUIRED_OUTPUT` blocking paths -- if it's sometimes `undefined`, the registry dispatch silently falls back to generic (acceptable but must be intentional, not a bug)
2. Verify no circular imports: `blocked-messages.ts` can import from schema files, but nothing should create a cycle back to `reason-model.ts`
3. **Change 3 code path:** `advance.ts:134` is in `src/mcp/handlers/v2-execution/advance.ts`. The `blocked_attempt_limit_exceeded` error fires when `chainDepth >= MAX_BLOCKED_ATTEMPT_RETRIES`. At that point you have `nodeId` and `args.lockedIndex`. The blocked snapshot's blockers are stored in the execution snapshot loaded via `snapshotStore.getExecutionSnapshotV1(nodeCreated.data.snapshotRef)` -- but the circuit-breaker fires BEFORE loading the snapshot. Instead, walk the `lockedIndex.nodeCreatedByNodeId` ancestor chain to find the original step's `node_created` event, then load its snapshot to get the stored blockers and extract `contractRef` from the primary `output_contract` pointer. Alternatively (simpler): load the snapshot that's already referenced in the current `blocked_attempt` nodeCreated event -- the circuit-breaker is inside the `snapshotStore.getExecutionSnapshotV1` callback, so the snapshot IS available at that point. Check the actual code path before deciding.
4. **Change 4 type change:** `ArtifactContractValidationError` in `src/v2/durable-core/domain/artifact-contract-validator.ts` currently has three codes: `MISSING_REQUIRED_ARTIFACT`, `INVALID_ARTIFACT_SCHEMA`, `UNKNOWN_CONTRACT_REF`. The wrong-kind detection needs to communicate what kinds were submitted. Add a `submittedKinds?: readonly string[]` field to the `MISSING_REQUIRED_ARTIFACT` variant (it's only relevant when the array was non-empty but no kind matched). This field then flows up through `formatArtifactValidationError()` to produce the "You submitted kind 'X', but this step requires kind 'Y'" message.
5. **Required test cases:** The test suite must explicitly cover all 4 cases. Check `tests/unit/v2/` and `tests/integration/v2/` for existing blocker/advance tests and add cases for: (a) `wr.loop_control` step missing artifact -- suggestedFix says `output.artifacts` not `notesMarkdown`; (b) circuit-breaker names the actual contractRef not `wr.assessment`; (c) wrong kind submitted -- message names both the submitted kind and the required kind; (d) empty `output.artifacts` array -- message says "your output.artifacts was empty".

## Acceptance criteria (from issue #1074)

- `npx vitest run` passes
- `tsc --noEmit` clean
- Blocked message for `wr.loop_control` step says "pass in `output.artifacts`" with a minimal `wr.loop_control` example
- `blocked_attempt_limit_exceeded` error names the actual contractRef, not hardcoded `wr.assessment`
- Submitting wrong kind produces: "You submitted kind 'X', but this step requires kind 'Y'"
- Empty `output.artifacts` produces: "your output.artifacts was empty -- pass it as: [scaffold]"

## After this PR merges

Next step is SessionCortex Phase 1+2 (issue #1075). Pitch at `.workrail/current-pitch.md`. The cortex draws from the same `blocked-messages` registry created here.
