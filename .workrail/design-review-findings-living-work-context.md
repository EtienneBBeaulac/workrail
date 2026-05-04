# Design Review Findings: Living Work Context

## Tradeoff Review

**T1: Coordinator remains manually-per-phase-pair**
Acceptable at 3 phase pairs. Named pivot: if phase pairs grow to 5+, extract `buildContextSummary()`. No violation of acceptance criteria under current scope.

**T2: assembledContextSummary 8KB cap unchanged**
Risk: rendered handoff content from multiple phases could approach the cap. Mitigation required: add `maxItems` and `maxLength` Zod constraints on array fields (`keyDecisions`, `keyConstraints`, `keyInvariants`) to bound rendered output. Without this, silent truncation is possible.

**T3: ShapingHandoffArtifactV1 may prove redundant**
Accepted -- deferred to Phase 2. Phase 1 uses pitch content injection instead (no new schema). Token budget risk is bounded by deferral.

---

## Failure Mode Review

**FM1: Phase agents omit artifacts on thin completions**
Handled via existing fallback chain (artifacts -> recapMarkdown). Must be explicitly implemented at shaping->coding and coding->review boundaries (not just discovery->shaping). Template exists in `full-pipeline.ts`.

**FM2: Schema drift between artifact definition and workflow behavior**
Handled via Zod at read boundary. Missing observability: no `DaemonEvent` emitted on Zod validation failure. Low severity -- fallback works, but failure is not surfaced in event log.

**FM3: Workflows don't emit artifacts without authoring changes (HIGHEST RISK)**
The coordinator change is dead code without corresponding `wr.coding-task` final step updates. Required: (a) add `wr.contracts.coding_handoff` to final step output contract, (b) add agent instruction in final step prompt to emit the artifact. Also required: integration test asserting artifact presence in lifecycle harness.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (C) element absorbed:** Implement `CodingHandoffArtifactV1` first; defer shaping->coding schema until validated by real runs. This is Phase 1.

**Simpler variant accepted for shaping->coding:** Coordinator reads and injects pitch file content (up to 4KB) into coding agent's `assembledContextSummary`. No new artifact schema needed for that boundary. The pitch IS the shaping handoff.

---

## Philosophy Alignment

All core principles satisfied. Two mild tensions (coordinator not yet using pure `buildContextSummary()`, pitch injection is a targeted addition not a full architectural fix) are explicitly deferred to Phase 2 with named conditions. No risky conflicts.

---

## Findings

**RED -- Missing workflow authoring changes (FM3)**
`CodingHandoffArtifactV1` will never appear in `getAgentResult().artifacts[]` unless the `wr.coding-task` final step is updated to emit it. The coordinator change alone is dead code. Workflow authoring changes and an integration test are hard prerequisites.

**ORANGE -- 8KB cap needs Zod bounds on array fields (T2)**
Without `maxItems`/`maxLength` constraints on `keyDecisions[]` and similar array fields, verbose agent outputs could silently truncate mid-sentence at the 8KB boundary. Mitigation is cheap (Zod constraints in schema definition).

**YELLOW -- No DaemonEvent on Zod validation failure (FM2)**
Schema drift falls back gracefully but invisibly. Adds a low-severity observability gap. Not blocking but worth a follow-up issue.

---

## Recommended Revisions

1. **Add to Phase 1 scope:** Zod `maxItems(8)` and `max(200)` constraints on all array fields in `CodingHandoffArtifactV1`
2. **Add to Phase 1 scope:** Update `wr.coding-task` final step -- add `wr.contracts.coding_handoff` to output contract and agent instruction to emit the artifact
3. **Add to Phase 1 scope:** Lifecycle integration test asserting `CodingHandoffArtifactV1` is present in the final step's artifacts
4. **Defer to follow-up:** Emit a `DaemonEvent` (`schema_validation_failed`) when Zod parse fails on a known-kind artifact
5. **Defer to Phase 2:** `ShapingHandoffArtifactV1`, `buildContextSummary()`, per-run context file

---

## Residual Concerns

- The pitch content injection (coordinator reads pitch file, injects content into coding system prompt) requires `AdaptiveCoordinatorDeps.readFile()` -- verify this is already on the interface or add it. It is likely available (`readFile` appears in `WorktrainAwaitCommandDeps`) but the coordinator deps interface must be checked.
- If the `wr.coding-task` agent does not reliably reach the final handoff step (stuck, timeout, early completion), the artifact is never emitted. The fallback is `recapMarkdown` -- but the recapMarkdown of a stuck session is not useful context for the review agent. This failure mode is inherent to the pipeline architecture and not new, but it remains unmitigated.
