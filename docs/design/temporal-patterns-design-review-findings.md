# Temporal Patterns Design Review Findings

**Status:** Review complete (Apr 14, 2026)
**Candidates doc:** `docs/design/temporal-patterns-design-candidates.md`
**Discovery doc:** `docs/ideas/temporal-discovery.md`

---

## Tradeoff Review

### T1: Step-level crash recovery (accepted)
A crashed step restarts from its beginning, not from the last completed tool call. Acceptable for v1.

**Condition that invalidates this tradeoff:** A step with non-idempotent destructive side effects (send email, create branch, post Slack message) executes those effects, then crashes before the next step is committed. On restart, the side effect fires again.

**Mitigation required before production:** The `requiredEvidence` field (planned in backlog) must be considered a prerequisite for daemon production use, not just a nice-to-have. It closes this gap for destructive-side-effect steps by requiring the agent to confirm evidence before advancing.

### T2: 1s approval gate polling (accepted)
For human-scale approval waits (minutes to hours), 1s polling is negligible.

**Condition that invalidates:** 100+ concurrent sessions simultaneously in approval-wait state = 6,000 file reads/minute. Upgrade path: `fs.watch` on the session log directory. No interface change needed.

### T3: Trigger cursor commit failure = possible double-fire (accepted)
Idempotency key (trigger event ID as workflowId) prevents actual duplicate sessions.

**Condition that invalidates:** Trigger sources without stable event IDs. Resolution: document as a `TriggerSourcePortV2` contract requirement; provide a deterministic hash utility for sources without native IDs.

### T4: No horizontal daemon scale (accepted)
Single-process, single-machine for v1. Multi-instance deferred to cloud tier.

**Condition that invalidates:** User attempts to run two daemon instances on the same machine with the same `~/.workrail/` directory. The trigger cursor store must use atomic writes (temp\u2192rename) to prevent corruption -- this is already in the design.

---

## Failure Mode Review

### FM1: Disk full at token persistence window (HIGHEST RISK)

A daemon step completes (session advances) but the disk-full condition prevents `daemon-state.json` write. On restart, the daemon re-executes the completed step.

**Coverage:** Atomic temp\u2192rename prevents partial writes. The re-execution failure mode remains for the window between step completion and token file write.

**Missing mitigation:** `requiredEvidence` field. Until it ships, steps with destructive side effects should be explicitly marked as "restart-safe" in workflow authoring guidelines.

### FM2: Approval notification silent failure

All notification channels fail (Slack rate limit, email spam). Session is waiting for approval but no one knows.

**Coverage:** `step_approval_pending` event in session log. Console badge.

**Missing mitigation:** Console MUST display approval-waiting sessions prominently in the session list (not just in session detail). This is a UI requirement.

### FM3: Trigger cursor commit failure (LOW RISK)

Covered by idempotency key. Correctly handled.

### FM4: Two daemons on same machine (LOW RISK)

`LocalSessionLockV2` prevents session corruption. Trigger cursor atomic writes prevent cursor corruption. Idempotency key prevents duplicate sessions. Well-covered.

---

## Runner-Up / Simpler Alternative Review

### Candidate B (Approval Gate) -- runner-up

Not weaker -- correctly deferred (post-daemon-MVP). One element worth pulling forward:

**GREEN finding:** Add `step_approval_pending/received/timeout` to `DomainEventV1` discriminated union NOW (zero behavior change, prevents future schema-breaking change). The schema reservation costs zero LOC.

### Simplification of Candidate A

Plain `fs.writeFile` (20 LOC) instead of a `DaemonStateStore` port (80 LOC) was considered and rejected. The port abstraction is required for testability (all I/O through injected ports -- consistent with 20+ existing ports). Inconsistency cost exceeds simplicity gain.

Scope correction: daemon ports live in `src/daemon/ports/`, not `src/v2/ports/`. This is a correct separation -- not a simplification.

### Hybrid A+B

`PersistedDaemonState` should include an optional `approvalGate` field:
```typescript
interface PersistedDaemonState {
  sessionId: string;
  continueToken: string;
  stepIndex: number;
  approvalGate?: { stepId: string; timeoutAt: string; notifyChannels: string[] };
}
```
Zero additional LOC in Candidate A. Makes Candidate B restart trivial when it ships.

### Simplification of Candidate D

Generic `TriggerDispatcher` can be simplified: v1 hardcodes a loop over configured trigger sources instead of a generic dispatcher. Saves ~100 LOC. `TriggerSourcePortV2` interface kept (justified by 3 required v1 trigger sources). `TriggerDispatcher` added when a third source is needed.

---

## Philosophy Alignment

| Principle | A | B | C | D |
|-----------|---|---|---|---|
| Errors as data | SATISFIED | SATISFIED | N/A | SATISFIED |
| Make illegal states unrepresentable | SATISFIED | SATISFIED (pending schema) | N/A | SATISFIED |
| Explicit domain types | SATISFIED | SATISFIED | N/A | SATISFIED |
| Validate at boundaries | SATISFIED | TENSION* | N/A | SATISFIED |
| Immutability | SATISFIED | SATISFIED | N/A | SATISFIED |
| DI for boundaries | SATISFIED | SATISFIED | N/A | SATISFIED |
| YAGNI | SATISFIED | SATISFIED | N/A | TENSION** |

*B tension: HMAC approval token must be validated at the Express middleware layer (before session lock acquired), not inside the engine.
**D tension: `TriggerSourcePortV2` interface added before second source exists. Justified by v1 scope (3 sources needed).

---

## Findings

### RED findings (blocking)

**None.** No blocking issues found. The four candidates are sound.

### ORANGE findings (important, fix before shipping)

**O1: `requiredEvidence` is a production prerequisite for daemon use.**
Destructive-side-effect steps + daemon crash = side effect re-executed on restart. The daemon should not be used in production for workflows with destructive steps until `requiredEvidence` is implemented. This is not a design flaw -- it's a scope dependency.

**O2: HMAC approval token validation must be at Express middleware layer, not engine layer.**
Unsigned or malformed approval requests must be rejected before the session lock is acquired. This is a 'validate at boundaries' requirement.

### YELLOW findings (improve soon)

**Y1: Console must display approval-waiting sessions prominently in session list.**
Not just in session detail. If the console badge is buried, approval gates become unusable. This is a UI requirement for Candidate B.

**Y2: Add `step_approval_pending/received/timeout` to `DomainEventV1` discriminated union before ANY approval gate ships.**
Schema reservation costs zero LOC. Prevents future breaking schema changes.

**Y3: `TriggerSourcePortV2` contract must document stable event ID requirement.**
Trigger sources must either provide a stable event ID or a deterministic hash utility. Undocumented contract = subtle bugs when a new trigger source is implemented.

**Y4: Daemon port scope correction.**
New daemon ports should live in `src/daemon/ports/`, not `src/v2/ports/`. Daemon concerns are not engine concerns.

---

## Recommended Revisions

1. **Add `approvalGate?` field to `PersistedDaemonState`** (Candidate A hybrid with B). Zero extra LOC, makes B trivial to implement later.

2. **Add `step_approval_pending/received/timeout` event kinds to `DomainEventV1` union** (Y2). Schema reservation only.

3. **Document `requiredEvidence` as a production prerequisite** (O1). Add a warning to the daemon `README` or `backlog.md` build order notes.

4. **Simplify `TriggerDispatcher` for v1** (Candidate D simplification). Hardcoded loop over configured sources. Generic dispatcher deferred.

5. **Document `TriggerSourcePortV2` stable-ID contract** (Y3). One-line JSDoc comment on the `poll()` method.

---

## Residual Concerns

1. **Candidate C false gap.** The landscape research incorrectly identified workflow versioning as an open gap. `PinnedWorkflowStorePortV2` already solves it completely. The discovery process caught this, but it's worth noting: the landscape research should have checked the existing codebase before concluding there was a gap. Future discovery workflows should include a codebase search step before declaring a design gap.

2. **Sub-step durability is an open question for long-running AI operations.** A WorkRail step that calls an LLM for 45 minutes (multi-hop reasoning, large context operations) would lose all progress on crash. For v1 (typical step = 1-5 minutes), this is acceptable. For WorkRail Auto cloud (long-running autonomous coding tasks), this deserves a design session when the evidence of need materializes.

3. **Multi-tenancy seams were identified but not fully designed.** `orgId` as a prefix in `TriggerCursorStore` and `DaemonStateStore` paths is the right seam, but the full multi-tenancy design (credential vault, per-org rate limits, namespace isolation) is deferred. This is correctly deferred for the local daemon -- it must be designed before cloud deployment.
