# WorkTrain Status Briefing -- Design Review Findings

> Raw review material for main-agent synthesis. Selected direction: Candidate A (CLI formatter over SessionSummaryProviderPort).

---

## Tradeoff Review

| Tradeoff | Accepted? | When it fails | Mitigation |
|----------|-----------|---------------|------------|
| No 'recently completed' section | YES | User checks status minutes after session completes; sees empty list with no context | Suggest `worktrain logs` in status output footer |
| No queue state | YES | User has 0 active sessions and is uncertain whether anything is pending | N/A -- queue.jsonl does not exist; nothing to read |
| No step count ('of N') | YES | User sees step name but has no sense of % complete on long tasks | Fast follow: read workflow catalog for total step count |
| Two status command variants coexist | CONDITIONAL | User types `worktrain status` expecting session ID prompt | Rename existing command to `worktrain health <id>` as part of same PR |

---

## Failure Mode Review

| Failure Mode | Handled? | Risk | Notes |
|-------------|----------|------|-------|
| Port wiring from CLI context | YES (factory pattern) | LOW | `createStandaloneSessionSummaryProvider(dataDir)` instantiates 4 concrete adapters without DI container |
| sessionTitle null for sessions without goal | YES (formatter fallback) | LOW | Fall back to workflowId as display name |
| Sessions from multi-day spans not visible | YES | LOW | `enumerateSessionsByRecency` scans full sessions directory, not today-only; filter `isComplete = false` handles active-only |

**Highest-risk failure mode:** Port wiring (factory pattern). Risk is LOW but unverified. Recommend verifying adapter transitive deps during implementation sprint planning.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate B):** Nothing to borrow beyond the `StatusBriefingV1` typed intermediate, which is already included in Candidate A's recommendation.

**Simpler variant (format directly to strings):** Would satisfy all success criteria identically. Rejected because the typed intermediate (`StatusBriefingV1`) costs < 30 minutes and prevents duplication when `worktrain talk` is implemented.

**Even simpler variant (call HTTP API from CLI):** Fails on daemon-required criterion. Worse than selected design.

**Conclusion:** Selected design is the minimum useful shape. No hybrid improvements needed.

---

## Philosophy Alignment

| Principle | Status | Notes |
|-----------|--------|-------|
| Errors are data (neverthrow) | SATISFIED | `buildStatusBriefing()` returns `Result<StatusBriefingV1, BriefingError>`; individual session failures skipped gracefully |
| Explicit domain types over primitives | SATISFIED | `StatusBriefingV1`, `ActiveSessionBriefing` -- not ad-hoc strings |
| Compose small pure functions | SATISFIED | `buildStatusBriefing()` pure, formatter separate, port wiring in CLI |
| Validate at boundaries, trust inside | SATISFIED | Validation at port boundary; pure function trusts `HealthySessionSummary` |
| DI for boundaries | SATISFIED | Port injected into CLI command |
| Immutability by default | SATISFIED | Reading append-only event store |
| Architectural fixes over patches | SATISFIED | Uses v2 projection layer; does not extend daemon-log-reading pattern |
| YAGNI with discipline | SATISFIED | No HTTP route, no queue, no completion index; `StatusBriefingV1` type is a minimal seam not speculative infrastructure |
| Make illegal states unrepresentable | MILD TENSION | `goal: string \| null` -- null is not illegal but a discriminated union would be more explicit |
| Type safety as first line of defense | MILD TENSION | Null `sessionTitle` requires defensive null handling; type system enforces it but the caller must pattern-match |

---

## Findings

### Yellow

**Y1: Goal field type could be more explicit**
`ActiveSessionBriefing.goal: string | null` is acceptable but `{ kind: 'set'; value: string } | { kind: 'not_set' }` would be more explicit per the 'make illegal states unrepresentable' principle. Low severity -- the null is handled either way, but the discriminated union makes the null case named and intentional.

**Y2: Command naming collision risk**
Existing `worktrain status <sessionId>` and new `worktrain status` (no args) would be disambiguated by commander.js argument presence, but help text and documentation will be confusing. Renaming the existing command to `worktrain health <id>` is a 5-minute change that removes this confusion entirely. Recommend including in the same PR.

**Y3: Step count is absent**
'Step 4 of 8' is significantly more useful than 'phase-3-implement' for understanding how far along a session is. The workflow catalog is queryable. This should be added as a fast follow (not MVP blocker) since it requires one additional read operation per active session.

---

## Recommended Revisions

1. **Include:** Rename `worktrain status <id>` to `worktrain health <id>` in the same PR as the new `worktrain status` aggregate command. (5 minutes, prevents naming confusion)
2. **Consider:** Use `{ kind: 'set'; value: string } | { kind: 'not_set' }` for the goal field in `ActiveSessionBriefing`. (15 minutes, clearer semantics)
3. **Fast follow:** Add workflow catalog read to `buildStatusBriefing()` to include step count ('step 3 of 8'). (1-2 hours, significant UX improvement)

---

## Residual Concerns

1. **`worktrain talk` timeline unclear:** If talk is within 2 sprints, the HTTP API route (Candidate B) should be built now rather than after the fact. This is context-dependent -- the user should confirm.
2. **Port factory complexity unverified:** The `createStandaloneSessionSummaryProvider(dataDir)` factory is conceptually straightforward but not implemented. Transitive adapter dependencies could add complexity. Low risk but should be verified at sprint start.
3. **Recently completed sessions:** The MVP has no 'recently completed' section. This is the most user-visible gap in the backlog spec's vision. A daemon-log scan for `session_completed` events from the last 24 hours is a feasible addition in Sprint 2.
