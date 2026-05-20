# Handoff: May 20, 2026

## Where we are

This session did a significant amount of architecture, design, and planning work. Here is the complete state.

## What was merged today

**PR #1072** (`refactor/etienneb/delivery-adapter-classes`) -- being merged now. Contains:
- `GitHubDraftReviewAdapter` and `GitCommitAdapter` as proper `DeliveryAdapter<K>` classes
- `PollHandle` and `PendingDeliverySidecar` as typed discriminated unions (no more unsafe casts)
- `GateResumeCallback` named type, threaded into `recoverPendingDeliveryPollers` -- gate sessions now resume after daemon restart
- `PendingDeliverySidecar` types extracted to `pending-delivery-sidecar.ts`
- `_runDeliveryByKind` as an exhaustive switch with `assertNever`
- All planning docs, roadmap, design outputs

## The roadmap (in order)

### 1. Engine hint content fixes -- GitHub issue #1074 🔴 NEXT

**Why first:** This is the root cause of 0/13 `wr.mr-review` success rate. The engine actively misdirects agents with wrong guidance. Everything else builds on this.

**What it is:** 4 targeted changes in 3 engine files.
1. Extract `getBlockedMessage()` registry to `src/v2/durable-core/schemas/artifacts/blocked-messages.ts`
2. Wire `reason-model.ts` `reasonToBlocker()` to dispatch through the registry -- correct `suggestedFix` to say "pass in `output.artifacts`" with a minimal scaffold; handle empty-artifacts case
3. Fix `advance.ts:137` -- use actual contractRef from `primaryReason.pointer` instead of hardcoded `"wr.assessment"`
4. Add wrong-kind + empty-artifacts detection in `artifact-contract-validator.ts`

**Design:** `docs/plans/cortex-hint-content-design.md`

**Prerequisites before implementing:**
- Verify `pointer.contractRef` is populated on all `MISSING_REQUIRED_OUTPUT` blocking paths
- Add `wr.contracts.assessment` entry to the registry (currently only in `reason-model.ts` inline)
- blocked-messages registry must not import from `reason-model.ts` (circular import risk) -- put in artifact schema layer

**Acceptance criteria:** see GitHub issue #1074

**Implementation:** Use `wr.coding-task` workflow. This is a ~1 day PR.

---

### 2. PR #1072 MR review -- GitHub issue #1076

After #1074 merges, fire a new `wr.mr-review` session against PR #1072 (it's now on main but needs a review on record). The previous review session stuck on the exact bug #1074 fixes.

---

### 3. SessionCortex Phase 1+2 -- GitHub issue #1075

**What it is:** Cross-turn failure detection + hint/scaffold injection.
- Subscribes to existing `turn_end` event
- Counts per-step engine rejections
- Tier 1 (failure count 1): inject hint via `agent.steer()` before next LLM turn
- Tier 2 (failure count 2): inject scaffolded example
- Backed by typed append-only crash-safe `cortex-{sessionId}.jsonl` event log

**Design:** `docs/plans/session-harness-design.md`
**Pitch:** `.workrail/current-pitch.md` (also at `docs/plans/session-cortex-phase1-2-pitch.md`)

**Scaffold content draws from the `blocked-messages` registry created in step 1** -- no hand-authored strings.

**Key constraints:**
- MUST NOT add a mutating hook to `_executeTools()` hot path
- Cortex event log written before `steer()` is called (crash safety invariant)
- Intervention threshold is 1 (fire on first failure, not third)
- Coordinate with existing `no_progress` stuck detector, not duplicate it

**Implementation:** Use `wr.coding-task` workflow. This is a ~3-5 day PR.

---

### 4. End-to-end verification -- GitHub issue #1077

After steps 1-3: fire a real `wr.mr-review` session on a real PR. Confirm draft review posts, inline comments appear, gate resumes when operator submits. Manual daemon crash + restart test for poller recovery.

---

### 5. Remove `human_approval` gate from wr.mr-review -- GitHub issue #1078

After verification: remove the redundant `requireConfirmation: { kind: 'human_approval' }` from `phase-6-final-handoff`. GitHub draft review is already operator-controlled. Hash out the blocking verdict case first.

---

## Key design decisions made this session

**Delivery adapter architecture:** The reason sessions were silently failing is that the engine's blocked response says "fix notesMarkdown" and "submit wr.assessment" regardless of what the step actually needs. Two root causes confirmed: wrong suggestedFix text in `reason-model.ts`, hardcoded wrong type in `advance.ts:137`. Both are one-line fixes.

**SessionCortex:** Uses the existing `turn_end` event (which already carries all toolResults). The `SessionState` is NOT persisted to disk -- the cortex event log is the minimum persistence layer needed for suspension/resumption after daemon restart. Dynamic tool description per step (C3) was considered and rejected for being MCP-incompatible (MCP server builds a static tool list at startup). C3 is a valid daemon-only follow-on.

**Scaffold content:** Each artifact schema file already has a `getBlockedMessage()` function. The fix is to wire the engine to use it. No new hand-authored content needed.

**Pluggable delivery:** Discovery recommended "Named Adapter Registry" (C1) -- now implemented. The MCP server's static tool list is a structural constraint that limits some improvements to daemon-only.

## Files to read to get up to speed

- `docs/tickets/next-up.md` -- the active roadmap
- `docs/ideas/backlog.md` -- run `npm run backlog -- --min-score 11 --unblocked-only`
- `docs/plans/cortex-hint-content-design.md` -- engine fix design
- `docs/plans/session-harness-design.md` -- SessionCortex architecture
- `docs/plans/session-cortex-phase1-2-pitch.md` -- shaped pitch for Phase 1+2
- `.workrail/current-pitch.md` -- same pitch, used by coding-task workflow
