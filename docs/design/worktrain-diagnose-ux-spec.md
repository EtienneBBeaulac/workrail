# Design Spec: `worktrain diagnose <sessionId>`

**Date:** 2026-05-09
**Status:** Ready for implementation
**Related:** `docs/design/worktrain-diagnose-discovery.md` (architecture), `docs/design/design-review-findings-diagnose.md`

---

## 1. Design Decision

**Direction B (Failure Card) was chosen** over Direction A (labeled fields extension) and Direction C (progressive disclosure / one-liner).

Direction A fails the 30-second path: the operator must read all labeled fields to find the most important information, and there is no category label or suggested fix. Direction C is hard to parse cold, requires the operator to know about `--verbose`, and cannot fit a step timeline on one line.

Direction B's zoned layout with a color-coded diagnosis anchor delivers the fastest time-to-insight. The failure category (STUCK / TIMEOUT / CONFIG / ORPHANED) is the first thing the operator sees. Evidence and fix lines are below it. The step timeline shows WHERE execution stopped. Zone order was revised from the initial sketch based on reviewer findings (Zone 4 moved before Zone 3; Zone 1 reordered).

**`worktrain health <id>` also changes:** when a session is not in today's event log, it delegates to the same `parseDaemonEvents()` function and outputs the failure card, instead of returning "No events today."

---

## 2. Information Architecture

### Zone order (revised from initial sketch)

```
Zone 1 (header)        -- 1 line
Zone 2 (diagnosis)     -- 3-6 lines
Zone 4 (metrics)       -- 1 line         ← moved above Zone 3 (reviewer finding: Peak-End Rule)
Zone 3 (step timeline) -- variable lines  ← investigative detail, below the fold
```

**Rationale for Zone 4 above Zone 3:** Zone 3 is investigative context; Zone 4 metrics provide a compact cost summary. Ending on Zone 3 leaves the operator scanning a list. Ending on Zone 4 provides closure. Zone 3 is still present for "where did it stop" but is not between the fix and the summary.

### Content hierarchy

1. **Session identity + outcome** (Zone 1) -- answers "which session and what happened"
2. **Why it failed + what to do** (Zone 2) -- the primary goal, reached in <5 lines
3. **How bad was it** (Zone 4) -- compact cost summary; one line
4. **Where in the workflow** (Zone 3) -- investigative detail for deeper diagnosis

### Primary user path

1. Operator types `worktrain diagnose <id>` (or `worktrain health <id>` -- same output for cross-day sessions)
2. Eyes land on Zone 2 (color-coded category label in chalk.red/yellow/gray)
3. Reads evidence lines (tool name, args, or error message)
4. Reads suggested fix
5. Optionally scans Zone 3 for step-level confirmation
6. Uses `--json` flag if piping to another tool

---

## 3. Interaction Design

### Command invocations

- `worktrain diagnose <sessionId>` -- full failure card
- `worktrain diagnose <sessionId> --json` -- machine-readable JSON, full untruncated data
- `worktrain diagnose <sessionId> --ascii` -- Unicode glyphs replaced with ASCII equivalents
- `worktrain diagnose <sessionId> --since <N>` -- widen scan window beyond 7 days (future)
- `worktrain diagnose <sessionId> --verbose` -- include Zone 3 even when collapsed by default for long timelines (future)
- `worktrain health <id>` -- same output as diagnose for cross-day sessions; live summary for today's sessions

### Session ID matching

- Exact match tried first against `sessionId` and `workrailSessionId` fields
- Prefix match as fallback (minimum 6 chars)
- If multiple sessions match a prefix: error listing all matches, ask for more specific ID
- If match resolved from prefix: Zone 1 shows `→ sess_full-id-here (resolved from prefix)`
- Scan window: last 7 days of `~/.workrail/events/daemon/YYYY-MM-DD.jsonl`
- Event assembly: indexed by session ID across all files (not per-file) to handle cross-midnight sessions correctly

---

## 4. Layout and States

### Zone 1 -- Header

**Format:**
```
[CATEGORY]  sess_abc123  wr.discovery  Started: Wed 23:47  22m 14s  [STOPPED]
```

**Revised field order** (reviewer finding IA 1.1): category badge first, then session ID, then workflow, then timestamp, then duration, then process state.

**Fields:**
- `[CATEGORY]` -- colored badge: chalk.red for STUCK/error, chalk.yellow for timeout, chalk.gray for orphaned, chalk.green for success
- `sess_abc123` -- session ID (displayed as given; long IDs truncated to first 8 + `...` + last 6 chars for display, full ID in Zone 2)
- `wr.discovery` -- workflow ID
- `Started: Wed 23:47` -- wall-clock anchor (reviewer finding IA 5.1: critical gap in cross-day scenario)
- `22m 14s` -- duration
- `[STOPPED]` / `[RUNNING]` / `[UNKNOWN]` -- process state, separate from failure category (reviewer finding IA 5.2)

**Process state logic:**
- `session_completed` or `session_aborted` event found → `[STOPPED]`
- No terminal event + `daemon_heartbeat` events after last known event → `[RUNNING?]`
- No terminal event + no recent heartbeats → `[UNKNOWN]`

### Zone 2 -- Diagnosis

**Format (STUCK example):**
```
DIAGNOSIS: STUCK -- repeated tool call

  Tool: bash
  Args: "grep -r 'SessionManager' src/" ← 200 chars, truncated indicator if cut
  Fix:  bash called 3x with identical args. Shorten observation window in step 3 prompt.
```

**Format (CONFIG example):**
```
DIAGNOSIS: CONFIG -- invalid model ID

  Error: "400 The provided model identifier is invalid." (full text)
  Fix:   Fix agentConfig.model in triggers.yml -- use format provider/model-id
         e.g. amazon-bedrock/claude-sonnet-4-6
```

**Format (TIMEOUT example):**
```
DIAGNOSIS: TIMEOUT -- wall clock limit reached

  Limit:  30 minutes (maxSessionMinutes in triggers.yml)
  Steps:  2 completed, 5 remaining at timeout
  Fix:    Increase maxSessionMinutes or narrow workflow scope.
          wr.discovery typically needs 55 minutes; current limit is 30.
```

**Format (ORPHANED example):**
```
DIAGNOSIS: ORPHANED -- session ended without a completion event

  Last event: step_advanced (step 3, 22 minutes ago)
  Note: The daemon may have crashed or been killed mid-session.
  Fix:  Check daemon process: worktrain daemon --status
        If daemon is stopped, restart: worktrain daemon start
```

**Format (INFRA example):**
```
DIAGNOSIS: INFRA -- daemon stopped mid-session

  Reason: daemon_shutdown (graceful stop)
  Fix:    Session was interrupted by a daemon restart. Re-queue the trigger
          or run: worktrain spawn --workflow wr.discovery --goal "<original goal>"
```

**Format (SUCCESS):**
```
DIAGNOSIS: SUCCESS -- session completed normally

  No failure detected. Run worktrain health <id> to see session summary,
  or check step notes in the WorkRail console.
```

**Format (DEFAULT / unknown):**
```
DIAGNOSIS: UNKNOWN -- unrecognized failure type

  Raw event: {"kind":"session_completed","outcome":"error","detail":"quota_exceeded..."}
  Fix:       No automated fix available for this failure type.
             File an issue: https://github.com/anthropics/workrail/issues
```

**Truncation indicator:** When `detail` field is shown and it was truncated at 200 chars, append `(truncated at 200 chars -- full text in conversation log)`. Never silently show truncated text without indicating it.

**Fix language:** Assertive and falsifiable, not hedging. Cite specific observed evidence in the fix text when available (e.g., "bash called 3x with identical args" not "agent may be looping").

**Next-command pointer** (reviewer finding IA 2.3): every non-success Zone 2 ends with at least one concrete follow-up command the operator can run.

### Zone 4 -- Metrics (moved above Zone 3)

**Format:**
```
Turns: 31 (avg 43s each)  |  Steps: 2/7  |  Tool calls: 47 (3 failed, 6%)  |  Tokens: 84k in / 21k out
```

**Revised from initial:** Added token counts (available from `llm_turn_completed` events). Removed duration (already in Zone 1). Added `|` separators for scannability.

**"Turns" label clarification** (reviewer finding IA 4.3): Zone 4 label is `Turns` (LLM loop iterations). Zone 3 shows `(N turns)` per step in parentheses. The distinction is clear from context: Zone 3's turn counts are per-step, Zone 4's is total.

### Zone 3 -- Step Timeline (moved below Zone 4)

**Format:**
```
Step timeline:
  ✓  1. understand-task       3 turns
  ✓  2. explore-codebase      8 turns
  →  3. form-hypothesis      12 turns  [STOPPED]
  ·  4. form-candidates       (not reached)
  ·  5. adversarial-review    (not reached)
```

**Glyph key:**
- `✓` -- step completed (chalk.dim or gray -- must be subordinate to Zone 2 color)
- `→` -- terminal step (chalk.bold, NOT chalk.red -- avoids Von Restorff cancellation with Zone 2)
- `·` -- not reached (chalk.dim)

**Turn count on terminal step** (reviewer finding IA 5.4): always show turn count on the `→` step so the evidence corroborates Zone 2's diagnosis.

**Cap at 8 visible steps** (reviewer finding Edge 8): when workflow has >8 steps, show first 2, ellipsis `  ... (N steps) ...`, then last 3 including terminal step. Full list via `--verbose`.

**Empty Zone 3** (reviewer finding Edge 3): when stepAdvances=0 and the session never entered the agent loop, show:
```
Step timeline:
  (session terminated before first step)
```

**--ascii fallback:** `✓` → `[ok]`, `→` → `[->]`, `·` → `[ ]`

---

## 5. Failure Category Classification

**Classification logic (deterministic field-reading, no LLM):**

```
1. If no events found for session ID in last 7 days:
   → NOT_FOUND (distinct from ORPHANED)

2. If session_completed.outcome = 'success':
   → SUCCESS guard (skip all failure classification)

3. If no session_completed or session_aborted event:
   → ORPHANED
     Sub-case: if session_aborted present → INFRA (daemon stopped)
     Sub-case: if no terminal event at all → ORPHANED

4. If session_completed.outcome = 'error':
   a. If detail matches /400|model identifier|invalid/i → CONFIG
   b. If detail matches /aborted|SIGKILL|SIGTERM|network|ECONNRESET/i → INFRA
   c. Otherwise → DEFAULT (unknown)

5. If session_completed.outcome = 'timeout':
   a. If detail contains 'wall_clock' or stepAdvances = 0 → WORKFLOW (timeout)
   b. If detail contains 'max_turns' → WORKFLOW (turn limit)

6. If session_completed.outcome = 'stuck':
   a. If agent_stuck.reason = 'repeated_tool_call' → WORKFLOW (stuck/loop)
   b. If agent_stuck.reason = 'no_progress' → WORKFLOW (stuck/no progress)
   c. If agent_stuck.reason = 'stall' → INFRA (hung tool call)

7. Otherwise: → DEFAULT
```

**Suggested fixes per category:**

| Category | Suggested fix |
|---|---|
| CONFIG/invalid model | Fix `agentConfig.model` in triggers.yml (format: `provider/model-id`) |
| INFRA/daemon stop | Restart daemon; re-queue trigger |
| INFRA/stall | Identify last tool call; check for network or file lock issues |
| WORKFLOW/stuck loop | Cite tool name + args; review step prompt for observation loop |
| WORKFLOW/timeout wall_clock | Increase `maxSessionMinutes` or narrow workflow scope |
| WORKFLOW/timeout max_turns | Increase `maxTurns` or simplify workflow step |
| WORKFLOW/no progress | Step 1 prompt may be unclear; agent entered N turns with 0 advances |
| ORPHANED | Check daemon process; may have crashed |
| SUCCESS | No action needed |
| DEFAULT | Full raw event shown; link to file issue |

---

## 6. Edge States

| State | Behavior |
|---|---|
| Session not found (7-day window) | "Session not found in the last 7 days. Try --since 30 to widen the search, or check that the session ID is correct." |
| Session found via prefix, unique | Proceed; Zone 1 notes "resolved from prefix: sess_full-id" |
| Session found via prefix, multiple | Error: "Multiple sessions match 'abc1'. Specify more characters: sess_abc12, sess_abc14, ..." |
| Cross-midnight session | Handled transparently -- events assembled across file boundary by session ID |
| 0-turn session (died before agent loop) | Zone 3: "(session terminated before first step)"; Zone 2 fix tailored to config/error category |
| 20+ step workflow | Zone 3 capped at 8 visible; ellipsis with count; full list via --verbose |
| detail field truncated at 200 chars | Truncation indicator shown; Zone 2 notes "(truncated at 200 chars -- full text in conversation log)" |
| Successful session | SUCCESS guard fires before classification; friendly "no failure" output |
| ORPHANED (no terminal event) | Explicit Zone 2 ORPHANED template; last event timestamp shown; daemon check command |
| INFRA (session_aborted present) | Distinct from ORPHANED; shows graceful stop vs crash distinction |
| Unknown failure type | DEFAULT template with full raw event; link to file issue |
| Non-TTY (pipe/redirect) | chalk strips ANSI automatically; plain text layout remains readable |
| --ascii flag | Unicode glyphs replaced: ✓→[ok], →→[->], ·→[ ] |

---

## 7. Accessibility Requirements

1. **Color-not-only:** All category states carry both a chalk color AND a bracketed text label in Zone 1 and the `DIAGNOSIS:` label in Zone 2. No meaning is conveyed by color alone.

2. **Zone 3 status glyphs:** Three distinct glyphs for three states: `✓` (done), `→` (terminal), `·` (not reached). Do not use color alone to distinguish them. Zone 3 completed-step lines may use `chalk.dim` but the glyph must still be present.

3. **Zone 3 color constraint:** Zone 3 `→` marker must NOT use chalk.red. Use chalk.bold or chalk.white. Red is reserved for Zone 2's STUCK/error diagnosis only. Two red elements would cancel the Von Restorff Effect.

4. **`***` prefix:** Replaced with `DIAGNOSIS:` label. The `***` prefix is announced as "asterisk asterisk asterisk" by VoiceOver on Terminal.app.

5. **Plain-text pipe compatibility:** chalk v5 strips ANSI on non-TTY. The bracketed labels, `DIAGNOSIS:` prefix, and key-value format must be legible without color. Do not use color-only separators.

6. **Unicode fallback:** `--ascii` flag substitutes ASCII equivalents for all Unicode glyphs. The flag should also be activated when `TERM=dumb` or `NO_UNICODE=1` is set.

7. **JSON schema completeness:** The `--json` output must include all information present in the TTY view plus full untruncated `detail` and `toolArgs` fields. Define the TypeScript type for the JSON output before writing the TTY renderer. TTY view is a projection of the data model.

8. **Linear reading order:** Zones are strictly top-to-bottom, left-to-right. No box-drawing, no cursor repositioning, no multi-column layout.

---

## 8. Content -- All Labels and Copy

**Zone 1 template:**
`[{CATEGORY}]  {sessionId}  {workflowId}  Started: {dayAbbr} {HH:MM}  {duration}  [{processState}]`

**Zone 2 prefix:** `DIAGNOSIS: {CATEGORY} -- {reason}`

**Metric labels (Zone 4):** `Turns:` `Steps:` `Tool calls:` `Tokens:`
- "Turns" = LLM loop iterations (not workflow steps)
- "Steps" = workflow step advances (N completed / M total)
- "Tool calls" = total calls (N failed, X%)
- "Tokens" = Nk in / Mk out (thousands, rounded)

**Zone 3 header:** `Step timeline:`
**Zone 3 ellipsis:** `  ... ({N} steps omitted, use --verbose to see all) ...`
**Zone 3 empty state:** `  (session terminated before first step)`

**Not-found message:** `Session not found in the last 7 days. Use --since N to widen the search, or verify the session ID.`
**Prefix-ambiguous message:** `Multiple sessions match '{prefix}'. Be more specific: {list of full IDs}.`
**Prefix-resolved note:** `(resolved from prefix)`

**Truncation indicator:** `(truncated at 200 chars -- see conversation log for full text)`

---

## 9. Open Questions for Human Review

**Requires human visual judgment:**
1. Does the 4-zone layout feel right at actual terminal width (80/120 columns)? The spec assumes wrapping is minimal but visual density has not been tested in a real terminal.
2. Is `chalk.dim` for Zone 3 completed steps readable against the operator's terminal background? Some dark themes make dimmed text hard to read.
3. Does ending on Zone 3 (step timeline) feel like a satisfying conclusion, or does the output feel like it trails off? The spec moved Zone 4 before Zone 3 based on the Peak-End Rule finding, but this is a judgment call.
4. Should Zone 3 be hidden by default for sessions with ≤2 steps (minimal timeline value) and only shown for sessions with ≥3 steps? The spec shows it always; a designer with access to real failure examples would have better judgment here.

**Requires usability testing:**
5. Does the 30-second path actually work in practice? The spec assumes operators read top-to-bottom, but eye-tracking would confirm where attention lands.
6. Is "DIAGNOSIS: STUCK -- repeated tool call" the right phrasing? Or does "LOOP DETECTED: bash called 3x" communicate faster?
7. Is the `--verbose` flag discoverable enough, or should the collapsed Zone 3 include a hint: `(run --verbose to see full timeline)`?

**Implementation decisions not in this spec:**
8. Whether `worktrain health <id>` shows the failure card or the health summary for today's completed (not live) sessions. The spec says: failure card for cross-day; live summary for actively running. Today's completed sessions are a judgment call.
9. The exact `--since` flag interface (number of days? ISO date? relative string?).
10. Whether to add a `worktrain failures` aggregate command in the same pass (scoped out of this spec; see discovery doc for rationale).

---

## Reviewer Findings Addressed

| Finding | Zone | Severity | Resolution |
|---|---|---|---|
| No wall-clock anchor | Zone 1 | Critical | Added `Started: Wed 23:47` field |
| No process state indicator | Zone 1 | Critical | Added `[STOPPED]/[RUNNING]/[UNKNOWN]` badge |
| Category should precede session ID | Zone 1 | Major | Zone 1 field order revised |
| Zone 3 between fix and metrics | Layout | Major | Zone 4 moved above Zone 3 |
| No next-command pointer | Zone 2 | Major | Every non-success template includes a follow-up command |
| ORPHANED hollow fix | Zone 2 | Major | Full ORPHANED template with daemon check command |
| Zone 3 marker color cancels Zone 2 | Zone 3 | Major | Zone 3 `→` uses chalk.bold not chalk.red |
| Zone 4 ends on cost signals | Layout | Major | Zone 4 moved above Zone 3; Zone 3 is now the end |
| 0-turn session empty Zone 3 | Zone 3 | Major | Empty state sentinel: "(session terminated before first step)" |
| ORPHANED missing Zone 2 template | Zone 2 | Major | Full template specified |
| Truncation silent | Zone 2 | Major | Truncation indicator required |
| 20+ step timeline breaks layout | Zone 3 | Major | Cap at 8 visible steps; ellipsis with count |
| Prefix ambiguity | Matching | Major | Error listing all matches; no silent first-match |
| Success falls through to DEFAULT | Classification | Critical | SUCCESS guard before classification |
| Session not found unspecified | Matching | Critical | NOT_FOUND state distinct from ORPHANED |
| JSON schema undefined | --json | Critical | Full schema required; define before renderer |
| Cross-midnight assembly | Data pipeline | Critical | Cross-file assembly by session ID specified |
| *** prefix screen reader noise | Zone 2 | Minor | Replaced with `DIAGNOSIS:` label |
| Unicode fallback | Zone 3 | Minor | --ascii flag specified |
| Hedging fix language | Zone 2 | Minor | Assertive language; cite observed evidence |
| Turns vs Steps ambiguity | Zone 4 | Major | Label clarification in spec; turns = LLM iterations |
| Duration duplicated | Zone 1+4 | Minor | Duration in Zone 1; removed from Zone 4; tokens added instead |
| Stuck step missing turn count | Zone 3 | Minor | Turn count required on terminal step |
