# Session Metrics Attribution -- Design Review Findings

*Review findings for the selected direction: Candidate 2 (`run_completed` event with startGitSha, endGitSha, gitBranch, agentCommitShas, captureConfidence)*

---

## Tradeoff Review

| Tradeoff | Assessment | Condition for Reversal |
|----------|-----------|----------------------|
| Agent compliance convention for 'high' confidence | Acceptable. No in-engine enforcement possible given §18.2 shallow-merge lock. Authoring docs + step prompt mitigate. | If consumers build automated decisions on 'high' confidence -- migrate to typed artifact contract enforcement |
| Accumulation problem deferred to convention | Acceptable IF step prompt explicitly says "include ALL commit SHAs made during this session." Without explicit prompt, adoption is near-zero. | If compliance measurement shows <50% full-list reporting for multi-commit sessions -- ship commit_sha_appended event type |
| 'low' confidence tier deferred to Phase 2 | Acceptable. Concurrent session detection requires cross-session I/O not available at AdvanceCorePorts level. | If production misattribution incidents occur on shared branches -- prioritize Phase 2 session summary provider injection |
| durationSeconds deferred | Acceptable. Event envelope has no timestamps. | If event timestamps are added -- add durationSeconds retroactively (backward-compatible field addition) |
| Multi-run sessions use last-run-wins | Acceptable. Engine model prevents multiple completions per session (fork/rewind happens before completion). | If multi-completion sessions are possible in a future engine variant |

---

## Failure Mode Review

| Failure Mode | Design Coverage | Missing Mitigation | Risk |
|-------------|----------------|-------------------|------|
| Partial SHA list produces silently incomplete 'high' confidence | Not covered at schema level. captureConfidence 'high' only requires non-empty SHAs, not complete set. | Consumers SHOULD cross-check agentCommitShas.length against git rev-list startSha..endSha count. Document as consumer convention. | MEDIUM -- silent partial attribution, not false attribution of other sessions' work |
| workspacePath absent -- endGitSha null | Covered. captureConfidence 'none' is valid graceful state. startGitSha also null if no observation_recorded events. run_completed still records completion fact. | None needed | LOW |
| Multi-run sessions (fork/rewind) | Engine model prevents it: fork/rewind happens before completion, so only one run reaches 'complete'. | Document the invariant in the event schema comment. | LOW |
| workspacePath present but not a git repo | Covered. resolveWorkspaceAnchors returns null anchors for non-git paths. endGitSha null, captureConfidence 'none'. | None needed | LOW |

---

## Runner-Up / Simpler Alternative Review

**From runner-up (Candidate 1):** No elements worth borrowing. Candidate 1 is strictly dominated by Candidate 2 -- the only thing it does differently is omit agentCommitShas. The incremental cost of including agentCommitShas is trivial and the gain (durable SHA record, 'high' confidence path) is meaningful.

**Simpler variant:** Not possible without dropping an acceptance criterion. Every field in the final schema satisfies a specific criterion.

**Candidate 3 (reframe / projection-only):** Valid as a companion (a `projectSessionGitAttributionV2` projection is needed regardless of which candidate ships). Not sufficient as a standalone solution because endGitSha is not capturable without a new event kind.

**Hybrid found during analysis:** Add `gitBranch: string | null` to `run_completed.data` for consumer convenience. Makes the event self-contained for branch-aware analytics. No join against `observation_recorded` events needed. Small gain, zero cost. **INCLUDED in final schema.**

---

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Immutability by default | Satisfied -- run_completed is immutable once appended |
| Errors are data | Satisfied -- captureConfidence is a first-class field |
| Validate at boundaries, trust inside | Satisfied -- sha1 regex validation on agentCommitShas at Zod boundary |
| Functional/declarative | Satisfied -- new projection is a pure fold |
| Make illegal states unrepresentable | Partial -- superRefine enforces high-implies-non-empty, but not completeness (external git access required) |
| Exhaustiveness everywhere | Satisfied -- discriminated union update is complete; existing projections use default: ignore (forward compat) |
| Architectural fixes over patches | Tension -- accumulation problem solved by convention (not architecture). Accepted with deferral condition. |
| YAGNI | Satisfied -- durationSeconds absent, 'low' confidence absent |
| Type safety as first line of defense | Partial -- format validation only, not semantic verification. Acceptable for advisory data. |

---

## Findings

### RED (Blocking)

None.

### ORANGE (Important -- Must Address Before Ship)

**O1: Step prompt convention is required, not optional**
The 'high' confidence tier is meaningless without a step prompt that explicitly instructs: "Include ALL commit SHAs made during this session in your final continue_workflow context_set, not just commits from the current step." Without this, the design's primary differentiator over Candidate 1 is functionally dead. This prompt template MUST be included in `docs/authoring-v2.md` as a required deliverable alongside the code changes.

**O2: Consumer cross-check convention must be documented**
Consumers relying on 'high' confidence SHOULD cross-check `agentCommitShas.length` against `git rev-list startGitSha..endGitSha --count`. If counts diverge, treat as 'medium' regardless of stored confidence. This cross-check detects partial-list compliance. Must be documented in the design doc and any consumer-facing API docs.

### YELLOW (Advisories -- Can Be Addressed in Follow-Up)

**Y1: Console UI must label confidence levels clearly**
Display labels: 'high' = "agent-reported (verified sha1 format)", 'medium' = "approximate (branch-scoped diff)", 'none' = "no git context". Do not display 'high' as "verified" without qualifying it as agent-reported.

**Y2: Document multi-run session invariant in event schema**
Add a comment to the `run_completed` event Zod schema: "One per completed run. In normal operation, at most one run per session completes (fork/rewind creates a new run before the original completes). For sessions with multiple completed runs (unusual), consumers should use the latest `run_completed` event by eventIndex."

**Y3: Track Phase 2 measurement criteria**
Before Phase 2 (concurrent session detection) is scheduled, measure: (a) actual same-branch concurrent session rate, (b) agent compliance rate for full-list reporting. Phase 2 is only justified if same-branch concurrency rate is >5% of sessions.

---

## Recommended Revisions

**Required (before ship):**

1. Add `gitBranch: string | null` to `run_completed.data` -- makes event self-contained, no downstream impact.

2. Add `superRefine` cross-field invariant: `captureConfidence === 'high'` requires `agentCommitShas.length > 0`.

3. Add sha1 format validation on `agentCommitShas` entries: `z.string().regex(/^[0-9a-f]{40}$/)`.

4. Pre-resolve `endGitSha` in `continue-advance.ts` BEFORE calling `executeAdvanceCore`. Pass `endGitSha: string | null` as a parameter through to `buildSuccessOutcome`. Do NOT add a new port -- this is a simple parameter threading change.

5. Guard `run_completed` emission with `newEngineState.kind === 'complete'` check inside `buildSuccessOutcome`.

6. Update `docs/authoring-v2.md` with the full-accumulated-list step prompt template.

**Optional (can follow up):**

7. Add `projectSessionGitAttributionV2` pure projection that surfaces `run_completed` data into a typed DTO for console and analytics consumers.

8. Extend `ConsoleSessionSummary` with optional `gitAttribution: SessionGitAttribution | null` field.

---

## Residual Concerns

1. **The riskiest assumption in the design:** Agent compliance with the full-list convention. The design's primary differentiator (per-session disambiguation via agentCommitShas) only works if agents consistently send the full accumulated list. Measurement should begin after ship.

2. **The missing consumer:** No specific consumer of `run_completed` has been identified yet. The console dashboard and external analytics are assumed. Before Phase 2 investment, validate that at least one consumer actually needs the per-session granularity.

3. **Schema drift risk:** The `observation_recorded.key` enum (`git_branch`, `git_head_sha`, `repo_root_hash`, `repo_root`) is already closed. If a future need arises to add a new observation key (e.g., `git_remote_url`), the same Zod update burden will recur. The `run_completed` event with its embedded `gitBranch` and `startGitSha` reduces (but doesn't eliminate) the need for new observation keys.
