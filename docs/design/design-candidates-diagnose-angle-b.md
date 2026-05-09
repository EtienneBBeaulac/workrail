# Design Candidates: Daemon Failure Diagnosis (Angle B)

**Date:** 2026-05-09
**Framing:** Operators have no fast path from "a session failed" to "here is the specific reason
and what to fix" -- they must manually correlate raw JSONL events across multiple files
requiring knowledge of the internal event schema.

**Persona:** Skeptical platform engineer who has seen observability tools built that nobody uses,
and who asks "what is the minimal change that actually helps" before anything else.

**Production context:**
- 125 real sessions: 50 timeout (40%), 10 error (8%), 2 stuck (1.6%), 37 success (29.6%),
  26 orphaned (no session_completed)
- `detail` field IS present on session_completed events (e.g. "400 The provided model identifier
  is invalid.")
- `agent_stuck.reason` and `agent_stuck.detail` are present
- `tool_call_failed.errorMessage` is present (up to 200 chars)
- `health` command reads today-only; breaks for prior-day sessions

---

**Riskiest assumption:** That daemon event log fields (`agent_stuck.toolName`,
`session_completed.detail`) are sufficient for actionable diagnosis without needing conversation
logs.

**Framing risk:** If the dominant problem is wrong outputs (bad code, wrong interpretation) not
failed sessions, a failure-diagnosis tool solves the wrong problem entirely. 37% of sessions DO
complete -- for those operators the problem is "the output was wrong" not "the session died."

---

## Approach 1 (p=0.60): Enhance `worktrain health` -- Cross-Day + Detail Field

**Name:** Health Command Upgrade

**Primary mechanism:** Extend the existing `runHealthSummary()` function to scan the last 7 days
of daily JSONL files instead of today-only, and surface the fields already present but currently
not displayed: `session_completed.detail`, `agent_stuck.reason/detail`, and
`tool_call_failed.errorMessage`.

**P1 -- cross-day coverage:** Scan `~/.workrail/events/daemon/` for the last N days (default 7)
in reverse chronological order, stop at first file that contains the requested sessionId. The
session's date can also be derived from the `startMs` field in `execution-stats.jsonl` for fast
targeting.

**P1 -- failure category signal:** Map `session_completed.outcome` + `detail` to three buckets:
- `config` -- HTTP 400 errors (invalid model, bad API key)
- `infra` -- SIGKILL on tool calls, network errors, daemon crash mid-session
- `workflow` -- stuck with repeated_tool_call, no_progress, 0 step advances after N LLM turns
Confidence is explicit: "HIGH" when outcome+detail are unambiguous, "LOW" when inferred from
proxy signals (e.g. timeout with 0 step advances = likely workflow authoring issue).

**P2 -- 30-second path with suggested fix:** Each category gets a one-line suggested fix appended
to the output:
- config: "Check agentConfig.model in the trigger or workflow definition"
- infra: "Check daemon logs around <timestamp>; consider restarting daemon"
- workflow: "The agent made <N> LLM turns without advancing a step -- check workflow prompts"

**P2 -- overnight-safe:** No daemon required; reads only static JSONL files.

**P3 -- extensible to quality inspection:** The multi-day scan naturally enables a future
`worktrain health --all --since 7d` aggregate view.

**Assumption this bets on:** The `detail` field plus outcome enum are sufficient for actionable
diagnosis in the majority of failure cases. This is directly verifiable: two of the 10 error
sessions have "400 The provided model identifier is invalid." as detail -- that IS the fix. For
timeouts, `detail` is absent, so the category inference falls back to proxy signals (step count,
stuck events), which is where confidence degrades.

**What if the assumption is wrong:** If detail is absent or uninformative for most failures (e.g.
timeout with no stuck events, just elapsed time), the "suggested fix" becomes a generic guess with
LOW confidence. The tool still helps -- cross-day coverage and the detail field are both net wins
-- but the 30-second diagnostic claim weakens to "sometimes."

**Minimal viable version:** Fix the today-only bug (scan last 7 days), and print `detail` and
`agent_stuck.reason` that are already parsed but currently not displayed. This is a ~30-line diff.

**Full version:** Add failure category classification with confidence indicator and suggested fix
line. Add `--since <N>d` flag. Total ~150-200 lines.

---

## Approach 2 (p=0.25): New `worktrain diagnose <sessionId>` Command

**Name:** Dedicated Diagnose Command

**Primary mechanism:** A new top-level CLI command that correlates all available data sources for
one session -- daemon event log (7 days), `execution-stats.jsonl`, crash sidecar JSON, and
conversation JSONL if present -- and emits a structured "failure card" to stdout.

**P1 -- cross-day coverage:** Reads from `execution-stats.jsonl` to find the session's start
date, then targets the exact daily log file. Falls back to scanning last 7 days if not found in
stats. No daemon required.

**P1 -- failure category signal:** Same three-bucket classification as Approach 1, but with
richer evidence: if the conversation JSONL exists, extract the last 2 LLM turns to show what the
agent was attempting. If the crash sidecar exists, include `goal` and `workspacePath`.

**P2 -- 30-second path with suggested fix:** The failure card format is:
```
Session: <id>    [TIMEOUT]
Workflow: wr.coding-task
Duration: 29m 12s
Category: WORKFLOW (confidence: MEDIUM)
Evidence: 41 LLM turns, 0 step advances, last tool: continue_workflow
Suggested fix: Workflow step prompt may not be specific enough; agent looped without advancing.
               Check the wr.coding-task step prompts for ambiguous completion criteria.
```

**P2 -- overnight-safe:** Reads static files only; daemon-independent.

**P3 -- extensible to quality inspection:** The same command can later accept `--aspect quality`
to check step notes in the WorkRail engine event log (`~/.workrail/data/sessions/`) rather than
failure signals.

**Assumption this bets on:** Operators will remember and use a new command name. The marginal
value of a separate command over an enhanced `health` command is that it can be designed for the
diagnosis use case from scratch (richer output, machine-readable `--json` mode) without
compromising the simpler health summary format.

**What if the assumption is wrong:** If the dominant problem is wrong outputs rather than failed
sessions, this command helps exactly 63% of the time (the non-success sessions). The 37% of
sessions that complete but produce wrong outputs are invisible to it. A new command also adds
discoverability friction -- operators must know to run it.

**Minimal viable version:** Same as Approach 1's minimal (fix cross-day, show detail), but
packaged as a new command with a failure-card output format and `--json` mode.

**Full version:** Correlate all 5 data sources. Machine-readable JSON output for piping into
other tools. `worktrain diagnose --all --since 7d` for aggregate view. Console integration.

---

## Approach 3 (p=0.08): Aggregate Failure Report -- `worktrain failures [--since N]`

**Name:** Failure Trend Report

**Primary mechanism:** Instead of diagnosing one session, scan all sessions across the last N days
of event logs and emit an aggregate report grouped by failure category and workflow -- designed to
surface systemic patterns rather than one-off failures.

**P1 -- cross-day coverage:** The core mechanism IS multi-day scanning -- it reads all daily files
in the date range and groups by sessionId, joining with execution-stats for duration.

**P1 -- failure category signal:** Same three-bucket classification, but reported as counts:
```
Failure summary (last 7 days, 125 sessions)

  TIMEOUT    50  (40%)
    wr.discovery:         35 sessions  avg 18m  -- consistently early (12-29m, not near limit)
    wr.coding-task:       15 sessions  avg 24m

  ERROR       10  (8%)
    config (invalid model): 2   detail: "400 The provided model identifier is invalid."
    infra (daemon crash):   8

  STUCK        2  (1.6%)
    repeated_tool_call:     2   toolName: continue_workflow

  ORPHANED    26 (20.8%)   [no session_completed event]
```

**P2 -- 30-second path with suggested fix:** The aggregate view immediately highlights the top
systemic issue -- 35 discovery sessions timing out at 12-29 min without hitting the ceiling. That
pattern is actionable ("adjust timeout or fix the discovery workflow") in a way that no
per-session view can reveal. Suggested fix appears at the category level, not the session level.

**P2 -- overnight-safe:** Reads static files only.

**P3 -- extensible to quality inspection:** Add `--aspect quality` to report step-advance rates,
average steps per session, and workflow completion rates alongside failure rates.

**Assumption this bets on:** The systemic pattern IS the real signal. In the production data, 35
of 50 timeout sessions are on `wr.discovery`, timing out at 12-29 min -- that is not random noise,
it is a design flaw. A per-session view hides this pattern; an aggregate view makes it obvious.

**Framing risk addressed:** This approach partially covers the framing risk. If wrong outputs (not
failed sessions) is the real problem, the aggregate report's success rate column (37%) immediately
surfaces that 63% of sessions are failing -- which is the prompt to investigate. The next step
would be different tooling (output quality inspection), but this report at least points at the
right question.

**What if the assumption is wrong:** If operators primarily need to debug one specific session
(e.g. a triggered session that just failed and needs immediate action), the aggregate view is too
slow and unfocused. They need a per-session view. This approach should be paired with Approach 1
or 2, not replace them.

**Minimal viable version:** `worktrain failures` with no options: scans last 7 days, groups by
outcome and workflowId, prints counts. ~100 lines.

**Full version:** `--since`, `--workflow`, `--json`, per-category suggested fixes, trend
comparison (this week vs last week). Aggregate view in console UI.

---

## Approach 4 (p=0.05): Output Quality Inspection -- Framing Risk Antidote

**Name:** Quality Inspection Mode

**Primary mechanism:** Instead of diagnosing failures, inspect the step notes of completed sessions
from the WorkRail engine event log (`~/.workrail/data/sessions/<sess_id>/events/*.jsonl`,
`node_output_appended` events) and surface sessions where the agent completed steps but with thin
or suspicious notes.

**Why this exists:** This directly addresses the framing risk. If the dominant problem is "sessions
complete but the output is wrong or unhelpful" (possible given 37% success rate, no data on output
quality), then all the failure-diagnosis tooling solves the wrong problem. This approach starts
from the 37% successful sessions and asks whether their outputs are trustworthy.

**P1 -- cross-day coverage:** Reads `~/.workrail/data/sessions/` directory which is not
date-partitioned -- sessions persist indefinitely. No cross-day problem exists here.

**P1 -- failure category signal:** N/A for failures. Instead, surfaces "quality signals": step
notes under 50 words (thin completion), step notes that are templated/boilerplate (copy-paste from
prompt), sessions that advanced through multiple steps in under 30 seconds each (suspiciously fast
for genuine work).

**P2 -- 30-second path with suggested fix:** Not applicable in the failure-diagnosis sense. The
30-second path is different: "this session completed, but 3 of 5 steps have notes under 50 words
-- review manually." Suggested action: inspect session in console.

**P2 -- overnight-safe:** Reads engine session store only; no daemon required.

**P3 -- extensible to quality inspection:** This IS the quality inspection approach. It is the
starting point for a quality tier.

**Assumption this bets on:** The framing risk is real -- some operators are more concerned about
output quality than session failures. This is a strong bet and a bold claim given the production
data shows 63% non-success sessions. But the 37% success rate means 46 sessions "succeeded" --
if even 20% of those produced genuinely wrong output, that is ~9 sessions that operators might
care more about than the 50 timeouts.

**What if the assumption is wrong:** If operators primarily care about failed sessions (the strong
prior given the 40% timeout rate), this approach is entirely orthogonal to their need. It should
not replace Approach 1/2/3; it is additive for later.

**Minimal viable version:** `worktrain health <sessionId> --aspect quality` that reads the engine
session store and summarizes step note lengths. ~80 lines.

**Full version:** Quality scoring per session. Aggregate quality dashboard. Integration with
console session detail view. Comparison across workflows.

---

## Approach 5 (p=0.02): Push-Based Failure Cards via Daemon Outbox

**Name:** Push Failure Notifications

**Primary mechanism:** When a session ends with a non-success outcome, the daemon writes a
structured "failure card" JSON to `~/.workrail/outbox.jsonl` (the existing outbox) and optionally
to a new `~/.workrail/failure-cards/` directory, so operators see failure details without pulling
-- the failure comes to them.

**Why this is low probability:** It requires daemon involvement, which contradicts the P2
overnight-safe criterion (if the daemon is what failed or was stopped, push-based cards may not
be written). It also assumes operators watch the outbox, which is a pull mechanism anyway. This is
architecturally cleaner (the daemon knows when sessions fail) but practically weaker.

**P1 -- cross-day coverage:** The failure card is written at failure time and persists
indefinitely in `failure-cards/`. Cross-day access is built in because you read a file, not a
log.

**P1 -- failure category signal:** The daemon emits the card with category + evidence + detail at
failure time, when all context is in memory. No reconstruction from logs required. This is the
most reliable classification -- no inference from proxy signals.

**P2 -- 30-second path with suggested fix:** `worktrain failures` reads failure cards and
displays the newest N. The card format is already structured -- no log scanning at read time.
Sub-second display.

**P2 -- overnight-safe:** Fails this criterion. If the daemon crashes (infra failure category),
the failure card may never be written. The most important failure type (daemon crash) is also the
one this approach is blind to.

**P3 -- extensible to quality inspection:** The card format can include a quality tier: emit a
card when a session completes but with low step-advance rate or thin notes. The daemon has this
context already.

**Assumption this bets on:** That the daemon is alive when sessions fail. This is wrong for the
"daemon stopped mid-session" case (8 of 10 error sessions in the production data). The very
failures that are hardest to diagnose are the ones where the daemon was not alive to write the
card.

**What if the assumption is wrong:** The 8 daemon-crash-mid-session errors produce no failure
cards. The 50 timeouts would produce cards. The 2 stuck sessions would produce cards. Coverage is
partial. This approach should be an enhancement on top of log-based diagnosis (Approach 1/2/3),
not a replacement.

**Minimal viable version:** On `session_completed` with non-success outcome, append a structured
JSON failure card to `~/.workrail/failure-cards/<sessionId>.json`. ~50 lines in the daemon's
session lifecycle handler.

**Full version:** `worktrain failures` reads and displays failure cards. Console integration shows
failure cards inline in the session detail view. Push notification via desktop notification API.

---

## Comparison Matrix

| Criterion | Approach 1 | Approach 2 | Approach 3 | Approach 4 | Approach 5 |
|---|---|---|---|---|---|
| P1: cross-day (7d, no daemon) | YES | YES | YES | YES (no date partition) | PARTIAL (daemon crash blind spot) |
| P1: failure category signal | YES | YES | YES (aggregate) | N/A (quality) | YES |
| P2: 30-second path | YES | YES | YES (systemic) | DIFFERENT | YES (sub-second) |
| P2: overnight-safe | YES | YES | YES | YES | NO |
| P3: extensible to quality | YES | YES | YES | IS quality | YES |
| Addresses framing risk | NO | NO | PARTIAL | YES | PARTIAL |
| Implementation footprint | SMALL | MEDIUM | MEDIUM | MEDIUM | LARGE (daemon change) |
| Risk if riskiest assumption wrong | Degrades gracefully (LOW confidence shown) | Same | Pattern still visible | N/A | Cards not written for worst cases |

---

## Recommendation

**Start with Approach 1** (Health Command Upgrade). The cross-day bug is a genuine breakage --
sessions from yesterday cannot be inspected at all. The `detail` field already contains the
actionable error message for the two most recent error sessions. Fixing those two things is a
~30-line diff that materially helps today.

**Add Approach 3** (Aggregate Failure Report) second, because the production data reveals a
pattern that no per-session view can surface: 35 of 50 timeouts are on a single workflow at
12-29 min. That is a systemic fix, not a one-off session diagnosis.

**Defer Approach 4** (Quality Inspection) until there is evidence that wrong outputs are a real
operator pain point. Do not build observability tooling for a problem that has not been
confirmed.

**Defer Approach 5** (Push Cards) until Approaches 1 and 3 are shipping and the daemon's
reliability is high enough that push-based guarantees are trustworthy.
