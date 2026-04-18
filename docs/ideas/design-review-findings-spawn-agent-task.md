# Design Review Findings: spawn_agent Tool Implementation

_Concise, actionable findings for main-agent synthesis. Design: Candidate 2 (pre-create session with _preAllocatedStartResponse, then blocking runWorkflow())._

> Note: Full discovery-phase review is in `design-review-findings-spawn-agent.md`. This file is for the current coding task review pass.

---

## Tradeoff Review

### T1: Parent clock keeps ticking while child runs
- Confirmed acceptable. Success criterion 2 ('parent does not advance until child completes') is satisfied even on timeout (parent aborts, not advances).
- When parent times out, child continues as orphaned session. Work is preserved in session store. Session tree preserves the parent-child link.
- Mitigation needed: document in tool description.
- **Status: ACCEPTED.**

### T2: _preAllocatedStartResponse comment needs update
- Current comment: 'set only by the dispatch HTTP handler.' spawn_agent will be another legitimate internal caller.
- If not updated, future developer may remove spawn_agent support as accidental usage.
- **Status: REQUIRED FIX (low effort, Step 1.1).**

### T3: One extra async call in execute()
- executeStartWorkflow() is ~10-50ms (no LLM call). Negligible for a tool that blocks 1-30 minutes.
- **Status: ACCEPTED.**

### T4: session_created.data extension
- Confirmed `z.object({})` uses strip mode (not `.strict()`). Extension with `parentSessionId?: z.string().optional()` is backward-compatible.
- `buildInitialEvents()` currently hardcodes `data: {}` -- requires threading `parentSessionId` parameter.
- **Status: REQUIRED, LOW RISK.**

---

## Failure Mode Review

### FM1: Parent timeout while child is running
- Severity: LOW. Child completes normally, work preserved, session tree intact.
- Design coverage: adequate. Orphaned child traceable via parentSessionId.
- **No revision required.**

### FM2: executeStartWorkflow() succeeds, runWorkflow() fails before AgentLoop starts
- Severity: MEDIUM. Zombie session in store (shows as 'running' indefinitely).
- Design coverage: partial. Parent gets `{ childSessionId, outcome: 'error', notes: errorMessage }` -- child session is observable. But zombie cleanup is deferred.
- Mitigation for Phase 1: document as known edge case. Phase 2: session timeout/zombie cleanup.
- **Status: ACCEPTED for Phase 1.**

### FM3: spawnDepth propagation failure
- Severity: HIGH if unmitigated. FULLY MITIGATED by using typed `readonly spawnDepth?: number` field on `WorkflowTrigger`.
- After fix: severity drops to LOW (depth is typed, cannot be accidentally lost).
- **Status: MITIGATED.**

### FM4: Depth bypass via width (sequential spawning)
- Severity: LOW for Phase 1. `maxSessionMinutes` on parent is the practical limit.
- **Status: ACCEPTED, deferred to Phase 2.**

---

## Runner-Up / Simpler Alternative Review

**Candidate 1 (direct runWorkflow, no pre-create):** Close alternative. Simpler execute() -- no executeStartWorkflow() call. Loses: `childSessionId` is unknown until after runWorkflow() starts; crash-before-start has no childSessionId to return.

**No elements worth borrowing from Candidate 1.** C2 already does everything C1 does plus the session-ID-upfront guarantee.

**Could skip session_created.data extension?** Technically yes -- `parentSessionId` in `context_set` events is still durable and queryable. But the extension is ~8 lines total and future-proofs DAG queries. Keep it.

---

## Philosophy Alignment

### Clearly satisfied
- Errors as data: discriminated union return, no throws
- DI for boundaries: ctx, apiKey, emitter all injected at construction time
- Immutability: WorkflowTrigger fully readonly, new fields also readonly
- Exhaustiveness: WorkflowRunResult match handles all 4 variants
- Validate at boundaries: depth check at start of execute()
- YAGNI: Phase 1 only; non-blocking spawn deferred
- Make illegal states unrepresentable: childSessionId always present (pre-create guarantees it)

### Under tension (acceptable)
- Architectural fixes over patches: parentSessionId via internalContext is somewhat patch-like. Acceptable because internalContext is an established pattern for daemon-internal injection (is_autonomous, workspacePath). Tension is low.
- Compose with small pure functions: execute() has two async operations (~50 lines). Complexity is necessary and bounded.

---

## Findings

### Red (blocking)
_None._

### Orange (required before implementation)

**O1: Use `readonly spawnDepth?: number` on WorkflowTrigger (not `context.spawnDepth`)**
Rationale: generic context map can be silently overwritten by trigger system or other callers, breaking depth enforcement. Typed field makes the invariant explicit and compiler-checked.
Files: `src/daemon/workflow-runner.ts` (WorkflowTrigger type definition)
**Status: Design already incorporates this fix.**

**O2: Update `_preAllocatedStartResponse` comment to list spawn_agent as legitimate caller**
Rationale: current comment misleads future developers. Without this update, spawn_agent support could be removed as accidental.
Files: `src/daemon/workflow-runner.ts` (WorkflowTrigger._preAllocatedStartResponse JSDoc)
**Status: Must be applied during implementation.**

**O3: Thread parentSessionId into buildInitialEvents() for session_created.data**
Rationale: the `internalContext` injection only reaches `context_set` events, not `session_created.data`. For the typed schema extension to work, `buildInitialEvents()` needs a new optional parameter.
Files: `src/mcp/handlers/v2-execution/start.ts` (`buildInitialEvents()` signature and call site)
**Status: Required -- not in original design review, discovered during implementation analysis.**

### Yellow (should-fix, not blocking)

**Y1: Document parent-clock behavior in tool description**
The spawn_agent tool description should note that the parent session's maxSessionMinutes clock runs while the child executes. Workflow authors must configure the parent's timeout to be longer than the expected child duration.

**Y2: Document zombie session edge case**
The spawn_agent tool description should note that if runWorkflow() fails before the AgentLoop starts, a zombie session may exist in the store. Phase 2 will add cleanup.

**Y3: maxSubagentDepth source**
For Phase 1, default to 3 if `WorkflowTrigger.agentConfig?.maxSubagentDepth` is not set. Document in tool description.

---

## Recommended Revisions

1. Use `readonly spawnDepth?: number` on WorkflowTrigger (O1 -- design already incorporates)
2. Update `_preAllocatedStartResponse` JSDoc to list spawn_agent as a legitimate internal caller (O2)
3. Add `parentSessionId?: string` parameter to `buildInitialEvents()` and thread it into `session_created.data` (O3)
4. Add parent-clock behavior documentation to spawn_agent tool description (Y1)
5. Add zombie session documentation to spawn_agent tool description (Y2)
6. Use `trigger.agentConfig?.maxSubagentDepth ?? 3` as maxDepth (Y3)

---

## Residual Concerns

**RC1: Session tree query infrastructure deferred to Phase 2**
`parentSessionId` is written to the session store but no query path exists to read 'all children of session X'. The console DAG view cannot render the tree until Phase 2. This is by design -- Phase 1 writes the data; Phase 2 builds the reader.

**RC2: Zod strictness on session_created.data**
Confirmed that `z.object({})` uses strip mode (not strict). Extension with `parentSessionId?: z.string().optional()` is backward-compatible. Unverified by an actual migration run -- low risk but unvalidated.

**RC3: maxTotalAgentsPerTask guardrail deferred**
Phase 1 enforces depth only. Wide spawning is not caught by depth limits. Phase 2 adds the concurrency registry. For Phase 1, `maxSessionMinutes` on the parent session is the practical limit on total work done.
