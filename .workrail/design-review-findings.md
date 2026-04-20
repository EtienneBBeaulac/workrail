# Design Review Findings: queue-config separate file (fix/queue-config-separate-file)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## Tradeoff Review

| Tradeoff | Assessment | Notes |
|----------|------------|-------|
| Constant name `WORKRAIL_CONFIG_PATH` is slightly misleading | Acceptable | WHY comment block explicitly explains the separation; constant is not exported for external use |

---

## Failure Mode Review

| Failure Mode | Risk | Coverage |
|---|---|---|
| Future developer reverts path to config.json | Low | WHY comment is the guard |
| Test environment missing queue-config.json | None | loadQueueConfig() returns ok(null) on ENOENT; no tests rely on the file existing |
| Build breaks due to import changes | None | Only string constant and comments change |

**Most dangerous**: Future revert. Adequately mitigated by the WHY comment.

---

## Runner-Up / Simpler Alternative Review

- **Runner-up (rename constant)**: No elements worth borrowing. Scope exceeds the task boundary.
- **Simpler variant**: There is no simpler variant -- this is already the minimal possible change.

---

## Philosophy Alignment

**Satisfied**: document-why (WHY comment), architectural-fixes-over-patches, YAGNI, make-illegal-states-unrepresentable, validate-at-boundaries.

**No risky tensions**.

---

## Findings

### RED: None

### ORANGE: None

### YELLOW: None

---

## Recommended Revisions

None. Proceed with Candidate A as specified.

---

## Residual Concerns

None for this targeted fix.

---
---

# Design Review Findings: GitHub Issue Queue Poll Trigger (#4)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## Tradeoff Review

| Tradeoff | Assessment | Notes |
|----------|------------|-------|
| workflow-runner.ts touch for bot identity | Acceptable | 5-line block after worktree creation, guarded by optional field |
| `events:` bypass for github_queue_poll | Acceptable | Separate `else if` branch, does not touch existing isPollingProvider block |
| No PolledEventStore for queue poll | Acceptable | Queue-poll semantics are select-one-per-cycle, not at-least-once-per-event |
| JSONL append non-atomicity | Acceptable | Single-process daemon, one queue-poll trigger -- safe for MVP |
| DaemonRegistry optional injection | Acceptable | File scan is the primary check; registry is a fast-path optimization |

---

## Failure Mode Review

| Failure Mode | Risk | Coverage |
|---|---|---|
| FM1: events bypass breaks existing providers | Low | Separate else-if branch; isPollingProvider unchanged |
| FM2: idempotency returns 'clear' on parse error | **HIGH** | Must fold ALL errors to 'active'; requires explicit outer try/catch |
| FM3: concurrency cap checked after per-issue loop | Medium | Implementation order is explicit; must be enforced in code |
| FM4: H3 treated as maturity level | Low | Exclusion before scoring; design is explicit |
| FM5: not_implemented silently swallowed | Low | Logs error + returns; not silent |
| FM6: bot identity failure is non-fatal | Medium | Logs warning, session continues; commits have wrong author |
| FM7: rate limit not checked | Medium | Needs explicit check in adapter (same as github-poller.ts) |
| FM8: stale session file on readdir | Low | ENOENT folds to 'active'; safe by design |

**Most dangerous**: FM2. Implementation must have an outer `try/catch` that returns `'active'` for ANY error during idempotency scan, not just JSON parse errors.

---

## Runner-Up / Simpler Alternative Review

- **Runner-up (Candidate B: skip bot identity)**: No elements worth borrowing. Inferior -- violates determinism and pitch requirement.
- **Simpler variant**: No viable simpler approach for bot identity. Timing invariant (post-worktree) cannot be satisfied from scheduler layer.
- **Hybrid opportunity**: None identified. Making bot identity a triggers.yml field adds config complexity without benefit.

---

## Philosophy Alignment

**Satisfied**: errors-as-data, immutability, type safety, validate-at-boundaries, DI for boundaries, determinism, architectural-fixes-over-patches, exhaustiveness.

**Acceptable tension**: YAGNI vs. not_implemented scaffolding for non-assignee types (explicit pitch requirement).

**Risky tension**: Prefer-fakes-over-mocks vs. filesystem-dependent idempotency check. **Resolution**: Make `sessionsDir` parameter injectable (default: `DAEMON_SESSIONS_DIR`, overridable in tests).

---

## Findings

### RED: None

### ORANGE

**O1: Idempotency scan must fold ALL errors to 'active'**
Not just JSON parse errors -- ENOENT, permission errors, malformed structure, missing field. The outer catch must return `'active'`, never rethrow. If this is implemented incorrectly (e.g., only catching `SyntaxError`), FM2 occurs. Specific implementation requirement: `try { /* parse and check */ } catch { return 'active'; }` at the outer level of the per-file check.

**O2: `sessionsDir` must be injectable for tests**
The idempotency scan reads from `DAEMON_SESSIONS_DIR` (a hardcoded path to `~/.workrail/daemon-sessions/`). Tests that verify idempotency behavior need to write real files to a temp directory. Make `sessionsDir` an optional parameter defaulting to `DAEMON_SESSIONS_DIR`. This is a straightforward DI addition.

### YELLOW

**Y1: Rate limit check in queue poller**
The adapter must check `X-RateLimit-Remaining` from the GitHub Issues API response header (same pattern as `github-poller.ts` `checkRateLimit()`). Skip cycle if < 100. Not a design gap -- the pitch mentions it -- but needs explicit implementation.

**Y2: Bot identity failure logging**
If `git config user.name` fails after worktree creation, the failure should be logged as a WARNING (not error) and the session should continue. Commits will have wrong author, but session should not abort.

**Y3: H3 heuristic scope**
H3 checks `worktrain:in-progress` label. The pitch also mentions `worktrain:done` label as a skip reason. Verify the implementation covers both labels (or just `worktrain:in-progress` per pitch spec).

---

## Recommended Revisions

1. **Make `sessionsDir` injectable** in the idempotency check function -- pass as optional string parameter defaulting to `DAEMON_SESSIONS_DIR`.
2. **Outer try/catch for idempotency** -- catch block MUST return `'active'`, not throw or return `'clear'`.
3. **Rate limit check** -- add `checkRateLimit(response)` call in queue poller after issues list API response.
4. **H3 label check** -- check `worktrain:in-progress` label (per pitch heuristic table); `worktrain:done` is mentioned in the breadboard connections but not in the H3 heuristic table. Implement exactly as the H3 table specifies.

---

## Residual Concerns

- **workflow-runner.ts bot identity**: Small change, but in a large/critical file. Needs careful review after implementation.
- **TypeScript exhaustiveness**: After adding `github_queue_poll` to `PollingSource` union, any file with a switch on `pollingSource.provider` must handle the new arm. The `doPoll()` switch is the only such location identified. Verify during implementation.

---
---

# Design Review Findings: queue poll tasks route to FULL/IMPLEMENT not REVIEW_ONLY (fix/queue-routes-to-full-not-review)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## Tradeoff Review

| Tradeoff | Assessment | Notes |
|----------|------------|-------|
| Type-level protection deferred | Acceptable | No current caller constructs taskCandidate + triggerProvider: 'github_prs_poll' together. WHY comment encodes the invariant textually. Type-level fix is a future dedicated task. |
| JSDoc correction co-located with code fix | Required | The wrong JSDoc is the encoded assumption that caused the bug. Must be fixed atomically with the code change. |

---

## Failure Mode Review

| Failure Mode | Risk | Coverage |
|---|---|---|
| Future developer re-introduces taskCandidate-based inference | Low | JSDoc correction + WHY comment at fix site are the guards |
| PR poll path (github_prs_poll) broken by fix | None | PR poller passes triggerProvider directly, never sets taskCandidate. Unaffected. |
| Routing log signal githubPrsPollProvider changes | None | Signal will correctly be false for queue tasks (correctness improvement, not a risk) |

**Most dangerous**: Future re-introduction. Adequately mitigated by JSDoc fix and WHY comment.

---

## Runner-Up / Simpler Alternative Review

- **Runner-up (Candidate B: type-level split)**: One element worth borrowing - a textual WHY comment at the fix site to encode the invariant. Already incorporated into selected design.
- **Simpler variant**: Fix code only, skip JSDoc correction. Rejected - wrong JSDoc is the encoded assumption that caused the bug; leaving it wrong is worse than both wrong.

---

## Philosophy Alignment

**Satisfied**: architectural-fixes-over-patches, YAGNI, determinism, document-why, immutability.

**Acceptable tension**: make-illegal-states-unrepresentable vs. explicit scope constraint. The type-level fix is the right long-term approach but is explicitly out of scope for this hotfix.

**No risky tensions**.

---

## Findings

### RED: None

### ORANGE: None

### YELLOW

**Y1: WHY comment required at fix site**
The fix removes the wrong inference but a future developer could re-introduce it. A WHY comment at lines 288-290 explaining that `taskCandidate` comes from `github_queue_poll` not `github_prs_poll` is required to prevent recurrence.

---

## Recommended Revisions

1. Add a WHY comment at the fix site (lines 288-290) explaining the correct relationship between `taskCandidate`, `github_queue_poll`, and `github_prs_poll`.
2. Fix JSDoc on `taskCandidate` field (line 113) to remove the wrong statement "When present, the trigger provider is 'github_prs_poll'".
3. Add a test case verifying that `runAdaptivePipeline` with `taskCandidate` set and no `triggerProvider` routes to FULL (not REVIEW_ONLY).

---

## Residual Concerns

None. This is a one-line fix with clear correct behavior. All three recommended revisions are straightforward and do not require human decisions.
