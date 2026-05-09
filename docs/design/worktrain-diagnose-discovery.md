# Design: WorkTrain Session Observability / Diagnose Command

**Status:** Discovery in progress
**Date:** 2026-05-09

---

## Context / Ask

**Stated goal:** Design a `worktrain diagnose` command that helps operators understand why a daemon session failed to progress through a workflow.

**Stated goal was a solution statement.** Reframed problem below.

**Reframed problem:** Operators have no fast path from "a session failed" to "here is the specific reason and what to fix." They must manually correlate raw JSONL events across `~/.workrail/events/daemon/*.jsonl` and `~/.workrail/daemon-sessions/*-conversation.jsonl`, requiring knowledge of the internal event schema.

**Operator pain (observed from production data):**
- 6,495 sessions recorded, 98% zero-step (test noise)
- Real sessions: 125 started, 99 completed -- 50 timeouts, 10 errors, 2 stuck, 37 success
- Discovery sessions timing out at 12-29 min (not hitting 55-min ceiling) -- stopped making progress early
- Recent errors: `400 The provided model identifier is invalid` (bad agentConfig.model), `aborted` (daemon stopped mid-session)
- `worktrain health <sessionId>` exists but reads from today's daemon event log only -- fails for past-day sessions
- The question "why did nothing happen today" has no answer without manual log inspection

---

## Path Recommendation

**`landscape_first`**

Rationale: The problem is technically bounded. We know exactly what data exists (`daemon event log`, `execution-stats.jsonl`, `conversation.jsonl`, existing `health` command). The dominant risk is building the wrong abstraction over good data, not solving the wrong problem. Landscape grounding (what information is available, what commands already exist, what failure categories emerge from real data) produces better candidates than pure design speculation.

**`design_first` was considered** but rejected: goalWasSolutionStatement=true would normally bias toward it, but the reframed problem is clear and specific. The stated solution (`worktrain diagnose`) is likely correct -- the question is what exactly it should do and where it lives.

---

## Constraints / Anti-goals

**Constraints:**
- Must work without daemon running (reads files directly)
- Must work for sessions from at least 7 days back
- Must not require knowledge of internal event types
- Execution stats + daemon event log are the primary sources; conversation logs are secondary (large, may be pruned)
- Must fit within the existing `worktrain` CLI structure

**Anti-goals:**
- Not a full monitoring dashboard (that's the console)
- Not real-time streaming (that's a separate problem and a bigger scope)
- Not a replacement for `worktrain health` (which is still useful for live sessions)
- Not an LLM-powered analysis (deterministic read + format only)

---

## Rigor / Ambitiousness / Domain

- `rigorMode`: STANDARD
- `solutionAmbitiousness`: best_fit
- `problemDomain`: software

---

## Landscape Packet

### Data Sources (synthesized from parallel research)

| Source | Path | Key diagnostic fields | Retention | Critical gap |
|---|---|---|---|---|
| Daemon event log | `~/.workrail/events/daemon/YYYY-MM-DD.jsonl` | All event kinds, per-turn tool calls, `agent_stuck` with toolName+argsSummary, `session_completed` with outcome+detail | Indefinite (daily files) | Today-only in existing CLI; 200-char truncation on tool args/errors |
| Execution stats | `~/.workrail/data/execution-stats.jsonl` | sessionId, workflowId, outcome, stepCount, durationMs | Indefinite append-only | No error message, no step detail, no tool info |
| Conversation log | `~/.workrail/daemon-sessions/<id>-conversation.jsonl` | Full LLM turns, full tool params/results, agent reasoning | Deleted on success; persists on failure | Never read by any existing CLI command; can be 250KB+ |
| Crash sidecar | `~/.workrail/daemon-sessions/<id>.json` | continueToken, goal, workflowId, workspacePath, worktreePath | Deleted on success | No failure reason; token opaque |
| WorkRail session store | `~/.workrail/data/sessions/<sess_id>/events/*.jsonl` | step notes (node_output_appended), advance_recorded, context_set | Indefinite | Not read by any CLI diagnostic command |
| Outbox | `~/.workrail/outbox.jsonl` | stuck kind, message, reason, issueSummaries | Indefinite | No sessionId link -- cannot correlate to a specific session |
| daemon.stderr.log | `~/.workrail/logs/daemon.stderr.log` | Crash backtraces, startup errors | Unbounded, no rotation | No session ID context per line |

### Existing CLI coverage gaps

`worktrain health <sessionId>`:
- **Today-only** -- sessions from any prior day return "No events found"
- Does not surface `detail` field from `session_completed` (the actual error message)
- Does not surface `timeout reason` (wall_clock vs max_turns look identical)
- Does not read `agent_stuck.toolName` / `agent_stuck.argsSummary` -- shows "1 stuck signal" with no actionable detail
- Does not read conversation log (full error text, agent reasoning)
- `delivery_failed` outcome entirely invisible (never written to event log)
- No per-step timing, no token usage, no sequence of tool calls

`worktrain logs`: same today-only constraint; no conversation log access.

### Failure category taxonomy (11 categories)

| Category | Key identifying signal | Operator action |
|---|---|---|
| config / invalid model | `session_completed detail="400 The provided model identifier is invalid"` | Fix `agentConfig.model` in triggers.yml |
| config / aborted (daemon stop) | `session_aborted reason=daemon_shutdown|daemon_killed` | Check why daemon was stopped |
| tool / engine failure | `tool_call_failed` events + `session_completed outcome=error` | Read tool name + error message |
| timeout / wall clock | `outcome=timeout detail~wall_clock` | Increase `maxSessionMinutes` or narrow workflow scope |
| timeout / max turns | `outcome=timeout detail~max_turns` | Increase `maxTurns` or simplify workflow |
| stuck / repeated_tool_call | `agent_stuck.reason=repeated_tool_call` + toolName/argsSummary | Review workflow step prompt; likely agent looping on observation |
| stuck / no_progress | `agent_stuck.reason=no_progress`, stepAdvances=0 at 80% turns | Step 1 prompt unclear or impossible |
| stuck / stall | `agent_stuck.reason=stall`, hung tool_call with no completion | Identify hanging tool; check network/file lock |
| orphaned / crash | No `session_completed`; sidecar survives restart | Check crash recovery logs |
| delivery_failed | (entirely invisible in event log) | Check callbackUrl config |
| stuck / notify_only | `agent_stuck` present but `session_completed outcome=success` | Check outbox.jsonl |

### Precedents
- `worktrain health`: exists, session-level summary, broken cross-day
- `worktrain logs`: exists, event stream formatter, broken cross-day
- No tool reads the conversation log or WorkRail session store for failure diagnosis

### Key contradictions / tensions
1. The richest diagnostic source (conversation JSONL) is the largest -- any tool reading it must be selective
2. Cross-day lookup is the most common use case but entirely broken in existing tools
3. `agent_stuck` events already carry the exact diagnosis data (toolName, argsSummary) but `runHealthSummary` discards it
4. The outbox has no sessionId -- stuck notifications cannot be correlated back to a session without timestamp-based heuristics

### Evidence gaps
- No data on how often operators actually use `worktrain health` today
- Unknown: whether step-name resolution (matching `step_advanced` to workflow node labels) is feasible without loading the compiled workflow schema

---

## Problem Frame Packet

**Primary stakeholders:** A single operator (Etienne) who runs the daemon against his own projects, debugs failures himself, and needs fast answers without needing to know internal file formats.

**Job to be done:** After a session fails, determine within 30 seconds: what happened, why, and what to change (if anything) to prevent recurrence.

**Core tension:** The data needed for diagnosis already exists in the event log, but the only tool that reads it (`worktrain health`) is both too narrow (today-only) and too shallow (discards the most useful fields like `agent_stuck.toolName`, `session_completed.detail`). The fix is surfacing data, not collecting more.

**Secondary tension:** Conversation logs are the richest diagnostic source (full agent reasoning) but are large, unindexed, and potentially sensitive. A good tool must be selective about when to read them.

**Pains:**
- Session runs for 22 minutes, times out, `worktrain health sess_abc` returns "No events today" if it was yesterday
- Session shows `outcome=stuck` but `worktrain health` says "1 stuck signal" with no toolName, no argsSummary, no actionable detail
- Error sessions show "outcome=ERROR" with no error message -- must manually grep JSONL to find `400 The provided model identifier is invalid`
- Systemic pattern (all discovery sessions timing out at step 2) not visible without writing a custom script

**Success criteria:**
1. Any non-success session from the last 7 days: determine root cause in <30 seconds
2. Output distinguishes config problems / workflow problems / infra problems
3. Stuck sessions show the exact tool + args that triggered the repeat loop
4. Timeout sessions show whether it was wall_clock or max_turns
5. Error sessions show the actual error message, not just "error"
6. Works without daemon running; reads files directly

**Framing risk / falsification condition:** If the primary failure mode is agents that produce wrong outputs (bad code, wrong interpretation) rather than sessions that fail to complete, then a diagnostic tool focused on failure mechanics is solving the wrong problem. Evidence: 37 of 99 real sessions succeeded -- 37% success rate suggests many sessions DO complete but may be producing wrong outputs. If that's the dominant problem, observability of completion quality (step notes, artifacts) matters more than failure diagnosis. **This would change the tool's priority but not its design** -- the same tooling that surfaces failure mechanics also surfaces step notes and artifacts for quality inspection.

**HMW questions:**
- HMW make the existing `worktrain health` command useful across days instead of only today?
- HMW surface the 3 most actionable fields (stuck toolName, error message, timeout reason) without operator having to know they exist?

---

## Decision Criteria

**Abstract principles at play:**
- Diagnosis should require zero knowledge of internal file formats or event schemas -- the tool is the schema
- Actionability over completeness: a 3-field summary with a suggested fix beats a 30-field dump
- Cross-day access is a hard requirement, not a nice-to-have -- a tool that only works today has no diagnostic value
- The right seam: enhance existing commands that operators already know vs. new command with better discoverability

**Decision criteria (priority order):**

1. **(P1 / compatibility) Cross-day coverage** -- works for sessions from the past 7 days, daemon not running
2. **(P1 / compatibility) Failure category signal** -- distinguishes config / workflow / infra failures with specific evidence (error message, stuck toolName, timeout reason)
3. **(P2 / quality-aspirational) 30-second operator path** -- from nothing to actionable root cause without reading raw JSONL; measured by: does the output contain a suggested fix for the 3 most common failure categories?
4. **(P2 / vision-aligned) Overnight-safe feedback loop** -- WorkTrain's vision is overnight autonomous operation. A diagnostic tool must work the next morning on sessions that ran and failed while the operator slept. Candidates that require the daemon to be running or sessions to be recent fail this criterion.
5. **(P3 / quality-aspirational) Extensibility to quality inspection** -- the same read path that surfaces failure mechanics can surface step notes and artifacts. Candidates that foreclose this with their data model are penalized.

**Riskiest remaining assumption:** That reading only the daemon event log (not conversation logs) is sufficient for the 3 most actionable failure categories. Evidence: agent_stuck events carry toolName/argsSummary; session_completed carries detail. If these fields are truncated in ways that make them unintelligible, conversation log fallback becomes necessary for the stuck/repeated case.

**Ideal end state reminder:** Push-based failure cards with step timeline, failure category + evidence, suggested fix, optional systemic aggregate view, console inline integration.

**candidateCountTarget:** 3 (STANDARD rigor)

## Candidate Directions

*(Generated via two parallel executors -- Angle A: ideal end-state anchor; Angle B: riskiest assumption anchor. Synthesized below.)*

### Candidate 1: Fix `worktrain health` (Health Command Upgrade)
**Primary mechanism:** Extend `runHealthSummary()` to scan the last 7 days of daily JSONL files instead of today-only, and surface 3 fields already captured but currently discarded: `session_completed.detail` (the actual error message), `agent_stuck.toolName`/`argsSummary`, and timeout subtype (wall_clock vs max_turns). Add one-line suggested fix per failure category.

- Smallest footprint: ~30-50 line diff to `runHealthSummary()` in `src/cli-worktrain.ts`
- Operator muscle memory preserved -- same command they already know
- P2 gap: no failure card format, no step timeline; operator still interprets raw counts + surfaced fields
- P3 gap: `runHealthSummary()` is an imperative accumulator that prints-as-it-goes; extending to quality inspection would require a significant refactor
- Bets on: `session_completed.detail` and `agent_stuck.toolName/argsSummary` being sufficient (the 200-char truncation is fine for the 3 dominant categories)

### Candidate 2: New `worktrain diagnose <sessionId>` command (Pull-Based Failure Card)
**Primary mechanism:** New command that scans 7 days of JSONL event files, classifies the session into a failure category using a deterministic decision tree, and prints a compact failure card: step timeline, category headline, specific evidence, suggested fix. Backed by a typed `parseDaemonEvents()` function that is reusable for quality inspection later.

- Cleaner output format: failure card > numeric summary for 30-second path
- New `parseDaemonEvents()` function is the composable foundation for quality inspection, aggregate view, push-based auto-write
- Higher implementation cost than Candidate 1 but not large (new command + parser function)
- Both executors independently landed this as the preferred full-fledged solution
- Decision tree must cover all 11 failure categories with a default fallback
- Cross-executor insight: `health` should remain for live sessions and detect past-day sessions, then suggest `diagnose`

### Candidate 3: `worktrain failures [--workflow <id>] [--days N]` (Aggregate Fleet View)
**Primary mechanism:** New command that scans all sessions in the execution stats + event logs over N days and groups by outcome + workflow, surfacing systemic patterns ("35 of 50 timeouts are on wr.discovery at step 2"). This is the only approach that reveals problems invisible to per-session views.

- Addresses the framing risk: if 37% sessions succeed but with wrong outputs, an aggregate view shows the pattern across completions too (step notes from WorkRail session store)
- Does NOT solve the per-session root cause question -- complements Candidates 1 and 2
- Cross-executor insight: Angle B specifically called this out as the unique contribution of the aggregate approach that neither Candidate 1 nor 2 provides

### Merged / collapsed
- Angle A's Approach 3 (push-based outbox auto-write) and Angle B's Approach 5 (push-based failure cards) share the same primary mechanism. Merged. Deferred -- daemon code path has higher blast radius; fails hard cases (crashed sessions produce no cards). Best layered on top of Candidate 2 after the pull-based version proves itself.
- Angle A's Approach 5 (conversation log mining) and Angle B's "deep mode" both reduce to: optional `--deep` flag on Candidate 2 that reads conversation log for the stuck/repeated case. Deferred.

---

## Challenge Notes

**Challenge executor:** external WorkRail Executor running `routine-hypothesis-challenge` (Rung 2 -- same-family with steelmanning instructions). Output: `docs/design/challenge-notes-diagnose.md`.

**Leading candidate challenged:** Candidate 2 (Pull-Based Failure Card).

**Findings:**

| Finding | Classification | Action |
|---|---|---|
| Decision tree redundancy -- `session_completed.detail` already contains the classification signal; Candidate 2 wraps field-reading in a prettier structure. Candidate 1 achieves same classification by printing same fields. | structural (partial) | Accept: Candidate 2's value is the OUTPUT FORMAT and suggested-fix layer, not the classification logic. Scope down the claim. |
| Orphaned/crash (20% of real sessions) -- no `session_completed` means no headline evidence; Candidate 1's accumulator is MORE informative here. | structural | Candidate 2 must handle orphaned sessions explicitly: show collected metrics + "session ended without completion event -- daemon may have crashed." |
| `parseDaemonEvents()` extensibility is aspirational, not architectural -- each downstream use needs different correlation layers. | tactical | Scope down the extensibility claim to "better foundation than imperative accumulator." |
| Two-command confusion (`health` vs `diagnose`). | tactical | `worktrain health` should detect prior-day sessions and print: "Session not found in today's log. Run: worktrain diagnose <id>" |

**Pre-mortem (3 specific failure conditions):**
1. The `detail` field is truncated at 200 chars -- for long API error messages (verbose stack traces), the actionable part is cut off. Failure card shows truncated "specific evidence" that is falsely precise.
2. Orphaned sessions (no `session_completed`) -- 20% of real sessions -- produce a weaker output than Candidate 1 unless handled explicitly.
3. The suggested-fix mapping (11 categories → 1-line fix) must be maintained as new failure categories are added. A category added without a corresponding fix entry silently falls through to "no fix available."

**Challenge quality observed:** structural (two findings that modify the implementation)

**Net verdict from challenge:** Candidate 2 remains the leading candidate. The challenge weakened two implementation claims but did not break the fundamental argument (failure card format + overnight-safe + extensible foundation). Candidate 1 is the right minimal fix if Candidate 2 is out of scope, but Candidate 2 is the right full design.

---

## Resolution Notes

**Selected direction:** Candidate 2 -- New `worktrain diagnose <sessionId>` command (Pull-Based Failure Card)

**Selection tier:** `confident_recommendation` -- structural challenge resolved without breaking leading candidate; fresh-context executor confirmed independently (4 PASSes vs C1's 2).

**Criteria scores (from fresh-context executor):**

| Criterion | C1 Health Upgrade | C2 diagnose cmd | C3 failures cmd |
|---|---|---|---|
| P1 cross-day | PASS | PASS | PASS |
| P1 failure signal | PARTIAL | **PASS** | FAIL |
| P2 30-sec path | PARTIAL | **PASS** | FAIL |
| P2 overnight-safe | PASS | PASS | PASS |
| P3 extensibility | FAIL | PARTIAL | PARTIAL |

**Why C2 won:** Only candidate that passes both P1 criteria fully AND both P2 criteria. The failure card format is the only approach that delivers the 30-second operator path without interpretation.

**Why C1 lost:** Passes cross-day but the failure signal is weaker (fields surfaced, no category label) and the 30-second path is not achieved. The orphaned/crash incidental advantage is not a criterion. Footprint advantage doesn't compensate for missing both P2 criteria.

**Why C3 lost:** Fails P1 failure signal and P2 30-second path entirely. Useful as a complement (Candidate 3 should be built as a follow-on), not a replacement.

**Quality ceiling check vs idealEndState:** C2 delivers the per-session failure card with overnight-safe pull access. Falls short of: push-based auto-write (deferred -- daemon code path, fails crashed sessions), aggregate/systemic pattern view (Candidate 3, build next), console inline integration (deferred). Shortfall is justified by MVP CLI scope.

**Trigger for switching to runner-up (C1):** If `worktrain diagnose` is blocked from being added as a new command, C1's 30-50 line patch to `runHealthSummary` is the minimum viable improvement. Also if orphaned/crash explicit handling proves too complex to implement cleanly.

**Accepted tradeoffs:**
- New command means operators must learn `worktrain diagnose` -- mitigated by `health` detecting prior-day sessions and redirecting
- "Decision tree" is trivial field-reading, not a classification engine -- value is in the output format and suggested-fix layer
- Extensibility is a better foundation, not plug-and-play -- scoped down

**Implementation requirements from challenge:**
1. Orphaned/crash sessions (20% of real sessions) must be handled explicitly: show all collected metrics + "Session ended without a completion event. The daemon may have crashed or been stopped mid-session."
2. Suggested-fix mapping must have an explicit default fallback (e.g. "See raw event: <session_completed line>") to avoid silent fallthrough on new failure categories
3. `worktrain health` should detect prior-day sessions (ID not found in today's log) and print a redirect hint

---

## Decision Log

- 2026-05-09: Path chosen as `landscape_first`. Rationale: bounded technical problem, existing infrastructure well-understood, dominant risk is wrong abstraction not wrong problem.
- 2026-05-09: `rigorMode=STANDARD` -- CLI tooling decision, not core architectural change.
- 2026-05-09: `solutionAmbitiousness=best_fit` -- scope constrained by CLI context; push-based auto-diagnosis and real-time streaming noted as ideal but deferred.

---

## Final Summary

**Recommendation:** Build `worktrain diagnose <sessionId>` as a new CLI command backed by a new `parseDaemonEvents(sessionId, daysBack)` typed function. Simultaneously update `worktrain health <id>` to delegate to `parseDaemonEvents()` for cross-day sessions (outputting a failure card instead of returning "No events today").

**Confidence band:** high

**What to build (implementation spec):**

1. `parseDaemonEvents(sessionId: string, daysBack: number): SessionDiagnostic` -- pure function, reads all `~/.workrail/events/daemon/YYYY-MM-DD.jsonl` files from `now - daysBack` to today, matches by `sessionId` or `workrailSessionId` prefix, returns a typed structure with: outcome, detail, stuck signals (reason/toolName/argsSummary), step advance count, LLM turn count, tool call counts, duration, terminal event type.

2. `worktrain diagnose <sessionId>` -- new command. Calls `parseDaemonEvents()`. Prints failure card:
   - Header: `Session <id> [CATEGORY] workflow=<id> duration=<d>`
   - Category line: one of CONFIG / WORKFLOW / INFRA / ORPHANED based on outcome + detail
   - Evidence: 2-3 lines with specific field values (error message, stuck toolName + argsSummary, timeout subtype)
   - Suggested fix: one-line actionable fix for CONFIG and WORKFLOW categories; "Check daemon logs around <timestamp>" for INFRA; "Daemon may have crashed or been stopped mid-session" for ORPHANED
   - Metrics block: always shown (turns, step advances, tool calls, duration)

3. `worktrain health <id>` hybrid: when session not found in today's log, call `parseDaemonEvents()` and output failure card. Must ship in the same pass as `diagnose`.

4. Failure categories (field-reading, not LLM):
   - CONFIG: `outcome=error` + `detail` contains "400" or "model" or "invalid"
   - WORKFLOW: `outcome=stuck` OR (`outcome=timeout` + `stepAdvances=0`)
   - INFRA: `outcome=error` + `detail` contains "aborted" or SIGKILL/network patterns
   - ORPHANED: no `session_completed` or `session_aborted` event found (show collected metrics + "session ended without a completion event")
   - DEFAULT fallback: show raw `session_completed` line + "No automated fix suggestion available"

5. Orphaned/crash explicit sub-cases:
   - `session_aborted` present → "Daemon was stopped or restarted mid-session"
   - No terminal event at all → "Session may have crashed or been orphaned"

6. Unit tests: one per failure category asserting the correct category label and suggested fix string. Prevents silent regression when new `WorkflowRunResult` variants are added.

**Runner-up (fallback if new command is blocked):** Candidate 1 -- extend `runHealthSummary()` with 7-day scan + surface `session_completed.detail`, `agent_stuck.toolName/argsSummary`, timeout subtype. ~30-50 line diff. Achieves cross-day coverage and failure signal but not the 30-second path (no category label or suggested fix).

**Deferred (not in scope):**
- Aggregate fleet view (`worktrain failures`) -- build next; answers "which workflow fails most"
- Push-based auto-write to outbox after each failure -- layer on top after CLI version proves itself
- Conversation log `--deep` flag -- for stuck/repeated cases where 200-char argsSummary is insufficient
- Console inline integration

**Residual risks:**
- `detail` field string format is not a typed enum -- silent breakage if engine changes the format. Mitigated by unit tests.
- 200-char truncation on `detail` affects edge-case verbose errors (not dominant categories). Mitigated by "(truncated)" note.

## Decision Log

- 2026-05-09: Path chosen as `landscape_first`. Bounded technical problem; dominant risk is wrong abstraction not wrong framing.
- 2026-05-09: `rigorMode=STANDARD` -- CLI tooling decision.
- 2026-05-09: `solutionAmbitiousness=best_fit` -- push-based auto-diagnosis and real-time streaming noted as ideal but deferred.
- 2026-05-09: Candidate 2 (worktrain diagnose) selected over Candidate 1 (health upgrade). C2 earns both P2 criteria; C1 misses both. C3 (aggregate fleet view) fails P1 failure signal and P2 30-second path -- complements but doesn't replace C2.
- 2026-05-09: Hybrid adopted: `worktrain health` delegates to `parseDaemonEvents()` for cross-day sessions. Eliminates two-command confusion.
- 2026-05-09: All design review findings were tactical. Direction unchanged. Confidence band: high.
