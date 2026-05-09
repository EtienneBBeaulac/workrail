# Challenge Notes: Diagnose Command vs. Health Command Upgrade

**Date:** 2026-05-09
**Task:** Adversarial review of Candidate 2 (new `worktrain diagnose` command). Construct the strongest case that Candidate 1 (Health Command Upgrade) is better.

---

## Pre-Mortem: Candidate 2 will fail if...

### 1. The `detail` field already contains the exact fix signal, making the decision tree redundant

The `detail` field in `session_completed` events carries precisely formatted strings:
- For errors: `result.message.slice(0, 200)` -- e.g. `"400 The provided model identifier is invalid"`
- For timeouts: `signal.reason` -- literally `"wall_clock"` or `"max_turns"` (not human text, a bare enum string)
- For stuck: `signal.reason` -- literally `"repeated_tool_call"`, `"no_progress"`, `"stall"`

This means Candidate 1's "surface 3 discarded fields" change IS the decision tree for 8 of 11 failure categories. The categories `config/invalid-model`, `timeout/wall-clock`, `timeout/max-turns`, `stuck/repeated-tool-call`, `stuck/no-progress`, `stuck/stall`, `config/aborted-daemon-stop`, and `tool/engine-failure` are all fully classified by reading `outcome` + `detail` + `agent_stuck.reason` -- fields that `runHealthSummary()` already parses but discards. Candidate 2's decision tree is not a new abstraction; it is the same field-reading logic wrapped in a new data structure. If the decision tree is the main value claim, and the decision tree is ~50 lines of field-reading, the new command over the patched function is a thin wrapper. The design specification (`parseDaemonEvents()` is reusable) is the actual justification -- but see pre-mortem #3.

**Classification: structural** -- questions whether the decision tree is a new contribution or just a rename of what Candidate 1 adds.

---

### 2. The 200-char truncation on `detail` makes the "specific evidence" claim hollow for the one category where it matters most

For `tool/engine-failure`, `detail` is `result.message.slice(0, 200)`. For error sessions where the LLM returns a long API error (e.g. `"anthropic.BadRequestError: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The provided model identifier 'claude-sonnet-4-5-20251022' is not supported...\"}`), the 200-char truncation may cut off precisely the "what model identifier you used" information -- which is the actionable part. Candidate 2's failure card would display a truncated error and call it "specific evidence." Candidate 1 has the same truncation limitation but doesn't claim to surface "specific evidence" as a design goal.

More concretely: if the `tool/engine-failure` category fires because a tool's output filled a 200K context window (and the resulting LLM error is verbose), the failure card shows a partial error string that looks like evidence but omits the identifier. Candidate 2 will fail when operators are confronted with failure cards that claim specificity but deliver truncated strings.

**Classification: structural** -- exposes a gap between the "specific evidence" claim and what the event log actually contains. Resolving it requires conversation log fallback (explicitly deferred).

---

### 3. `parseDaemonEvents()` extensibility requires the session store correlation layer to be built before it becomes genuinely reusable

Candidate 2 claims `parseDaemonEvents()` is "reusable for quality inspection, aggregate views, and push-based auto-write later." But quality inspection requires joining daemon events with WorkRail session store events (`node_output_appended` events under `~/.workrail/data/sessions/<sess_id>/events/`). The join key is `workrailSessionId`. That join is not part of `parseDaemonEvents()` -- it requires a second reader and a correlation layer. Aggregate views require iterating across ALL sessions in the date range, not just one session. Push-based auto-write requires wiring `parseDaemonEvents()` into the daemon's session completion path, which is a daemon code change.

None of these are free. `parseDaemonEvents()` is reusable in the same sense that any data-parsing function is reusable: yes, you can call it from multiple places. The specific claim that it is "the foundation for quality inspection" is only true if quality inspection is also daemon-event-log-only. It is not: quality inspection requires the WorkRail session store, which `parseDaemonEvents()` does not touch.

Meanwhile, `runHealthSummary()` is an imperative accumulator, but it is already in the composition root with all the file I/O wired up. Refactoring it into a pure `parseDaemonEvents(sessionId, daysBack) -> SessionEventSummary` is the same refactor whether it happens inside Candidate 1 or Candidate 2. Candidate 2 does not have a structural advantage here; it just does that refactor as part of implementing the new command.

**Classification: structural** -- the extensibility claim assumes a second correlation layer that is not in scope for either candidate.

---

## Strongest Case for Candidate 1 (Health Command Upgrade)

### The actual fix is 30-50 lines; the framing is 200

The discovery doc (`worktrain-diagnose-discovery.md`, "Core tension" section) states: "The fix is surfacing data, not collecting more." This is exactly what Candidate 1 does. The specific failures that make `worktrain health` useless today are:
1. Today-only scan (breaks for 100% of past-day sessions)
2. `session_completed.detail` discarded (the actual error message is already in the event)
3. `agent_stuck.toolName`/`argsSummary` discarded (the loop tool is already in the event)
4. Timeout subtype discarded (`detail` field contains `"wall_clock"` or `"max_turns"` literally)

All four are one-liner additions to `runHealthSummary()`. The cross-day scan is a `for (let d = 0; d < 7; d++)` loop over daily files. The three field additions are three new `process.stdout.write()` calls in the `session_completed` and `agent_stuck` switch cases.

After these changes, `worktrain health sess_abc` outputs:
```
Session: sess_abc    [TIMEOUT]
Workflow: wr.coding-task
Duration: 22m 41s
Timeout reason: wall_clock (max session minutes reached)
LLM turns: 43 (avg 31.7s each)
Step advances: 0
Tool calls: 87 (2 failed, 2.3% failure rate)
Issues reported: 0
Last activity: continue_workflow "ct_..." 847s ago

*** WARNING: 43 turns with 0 step advances (possible stuck)
```

This is the 30-second path for the `timeout/wall-clock + no step advances` case -- which is the dominant failure mode (50 of 125 real sessions, specifically the wr.discovery sessions timing out at step 1). No decision tree needed. The operator sees "0 step advances, wall_clock timeout" and knows immediately: the workflow is not completing step 1.

### Candidate 1 preserves the operator's existing mental model

`worktrain health <sessionId>` is the command operators already run. After Candidate 1, it works for all sessions from the past 7 days and surfaces the three most actionable fields. Operators do not need to remember a new command name, check a help page, or learn that "health is for live sessions, diagnose is for dead ones."

Candidate 2 explicitly acknowledges this as a risk: "Two separate commands...may confuse operators." The mitigation proposed ("health detects past-day sessions and suggests diagnose") means health still needs the cross-day scan to detect that it should redirect. At that point, health is doing most of the work anyway -- just to tell the operator to run a different command.

### The failure card format is a surface improvement, not a correctness improvement

Candidate 2's primary UX claim is the failure card format -- a structured output with "category headline, 2-3 lines of specific evidence, one-line suggested fix." Candidate 1 also claims to add a one-line suggested fix per category. The difference is layout: a labeled "Category: CONFIG/INVALID-MODEL" header versus "Suggested: fix agentConfig.model" appended to the existing health summary.

Both tell the operator the same thing. The failure card is more readable, but it is not more accurate. For a single operator running ~100 sessions/week, the readability improvement is real but not a decision factor that justifies a new command's maintenance burden.

### The operator is one person

The discovery doc explicitly states: "Primary stakeholders: A single operator (Etienne) who runs the daemon against his own projects." A single-person system does not benefit from the defensive API design of a new command (`parseDaemonEvents()` as a stable contract, `--json` mode for piping into other tools). These are the right design choices for a team-maintained platform. For a single operator with full codebase access, "just add three print statements" is the right design choice. Candidate 2 is architecturally correct for a product; Candidate 1 is the right scope for a personal tool.

---

## Finding-by-Finding Analysis

### Finding 1: Decision tree maintenance burden

The decision tree must be updated when new failure categories emerge. `orphaned/crash` has no `session_completed` event -- the decision tree must detect absence of terminal event. `delivery_failed` is entirely invisible in the event log (noted in the landscape packet: "entirely invisible in event log"). Candidate 2's tree would need to handle this via absence detection, not presence detection. This is a correctness gap in the design specification, not an implementation detail.

Candidate 1 does not have a decision tree, so it never goes wrong for categories it does not know about -- it shows the raw `outcome` field and the operator sees `delivery_failed` directly. The tree's default fallback ("see raw event") is exactly what Candidate 1 already does.

**Classification: tactical** -- the tree can be written to handle this correctly; it requires explicit coverage of the two invisible/absence-based categories in the specification.

---

### Finding 2: The "two commands" problem is real, not just a UX concern

`worktrain health` still exists after Candidate 2 ships. The discovery doc says health "should detect past-day sessions and suggest diagnose." This means:
- Health needs the cross-day scan (Candidate 1's core change)
- Health needs to classify the session as "past-day" vs "live"
- If past-day, health tells the operator to run diagnose

So health gets a partial version of Candidate 1's changes, and diagnose gets the full version. Two code paths, one for each command, both reading the same files, both implementing overlapping logic, both needing to be maintained. This is a duplication smell. If the answer is "just merge health into diagnose eventually," then the transition cost is non-zero and the intermediate state (two commands with different outputs for the same session) is confusing.

**Classification: structural** -- questions whether the two-command architecture is an improvement over the single-command architecture.

---

### Finding 3: `orphaned/crash` category -- Candidate 2 performs worse than Candidate 1

For `orphaned/crash` (no `session_completed` event, sidecar may survive), Candidate 1 shows `[UNKNOWN]` status with all the health metrics it collected, which is actually useful -- the operator can see "43 turns, 0 step advances, last tool was X 3 days ago." Candidate 2's decision tree classifies this as `orphaned/crash` and outputs a failure card with that label. But the failure card format is defined by `session_completed` fields -- when there is no terminal event, the card has a headline but no evidence lines. "orphaned/crash -- see crash recovery logs" is less useful than the raw health metrics Candidate 1 shows.

The 11-category taxonomy check: **for `orphaned/crash`, Candidate 2 is strictly worse than Candidate 1.** The health summary's accumulation model (count every event, show metrics regardless of terminal event) is a better fit for sessions with no terminal state than the failure card's "classify and explain" model.

Similarly, `stuck/notify-only` (agent_stuck present but outcome=success) is a non-failure. The failure card concept does not apply -- there is no failure to classify. Candidate 1 shows the stuck warning alongside the SUCCESS status, which is the right output. Candidate 2 is undefined for this case.

**Classification: structural** -- exposes a category where the failure card format actively degrades output quality relative to the health summary format.

---

### Finding 4: `parseDaemonEvents()` extensibility check

To extend `parseDaemonEvents()` to aggregate views: requires a new outer loop over all session IDs in the date range, not just one session. This is a different call signature (`parseDaemonEvents(daysBack) -> SessionEventSummary[]`), not just a reuse of the same function. The current spec defines a per-session reader.

To extend to quality inspection: requires reading `~/.workrail/data/sessions/<sess_id>/events/*.jsonl` (WorkRail session store) and joining on `workrailSessionId`. This is an entirely different data source. `parseDaemonEvents()` does not touch the session store, so there is nothing to reuse in that direction.

To extend to push-based auto-write: requires wiring the function into `finalizeSession()` in `src/daemon/runner/finalize-session.ts`. That is a daemon code change, not a CLI code change. The `parseDaemonEvents()` function as specified is a CLI-side reader -- it cannot be called from inside the daemon without a dependency inversion.

The extensibility claim holds only in the weakest sense: the function is a typed wrapper over file reading. You can call any well-typed function from multiple places. The specific downstream uses cited (quality inspection, aggregate views) require non-trivial additional work that is not part of the `parseDaemonEvents()` abstraction.

**Classification: structural** -- the extensibility claim is not supported by the specific downstream uses cited. Calling `parseDaemonEvents()` "the foundation" is aspirational, not architectural.

---

### Finding 5: The "category headline" adds value for config/invalid-model and not much else

For 2 of the 10 real error sessions, the category `CONFIG/INVALID-MODEL` with suggested fix "fix agentConfig.model in triggers.yml" is immediately actionable. This is the strongest case for the failure card format -- it maps a raw 200-char error string to a human-readable label and a specific file to edit.

For the 50 timeout sessions, the category `TIMEOUT/WALL-CLOCK` with suggested fix "increase maxSessionMinutes or narrow scope" is exactly as actionable as Candidate 1's "Timeout reason: wall_clock. Suggested: increase maxSessionMinutes or narrow scope." The label does not add information.

For the 26 orphaned sessions, the failure card is undefined (no terminal event). Candidate 2 is worse here.

Net: the failure card format adds concrete value for ~1.6% of sessions (the config/invalid-model cases). For the dominant failure mode (40% timeout), it adds label aesthetics but not diagnostic depth.

**Classification: surface** -- the label is a presentation improvement, not a correctness improvement.

---

### Finding 6: Candidate 1's `runHealthSummary()` refactoring gap is overstated

Both design candidates (Angle A and Angle B) note that `runHealthSummary()` is "an imperative accumulator that prints as it goes" and would be hard to extend. This is correct. But the specific extension path needed (add three field printouts, add cross-day scan) does NOT require restructuring the accumulator. The three fields are addable in the existing switch statement without touching the output model:

```typescript
case 'agent_stuck':
  stuckCount++;
  lastStuckReason = obj['reason'] as string;
  lastStuckTool = obj['toolName'] as string | undefined;
  lastStuckArgs = obj['argsSummary'] as string | undefined;
  break;
case 'session_completed':
  sessionOutcome = obj['outcome'] as string;
  sessionDetail = obj['detail'] as string | undefined;  // NEW: one line
  isLive = false;
  break;
```

And then at print time:
```typescript
if (sessionDetail) process.stdout.write(`Detail: ${sessionDetail}\n`);
if (lastStuckTool) process.stdout.write(`Stuck tool: ${lastStuckTool} -- ${lastStuckArgs ?? ''}\n`);
```

The cross-day scan is a pre-loop that concatenates file contents. The imperative model is not a problem for these additions. The refactoring concern is valid for the extensibility use cases (quality inspection, aggregate view), but those are deferred in both candidates.

**Classification: tactical** -- the P3 extensibility gap is real but does not affect P1/P2 criteria, which are what matter now.

---

## Conclusion

**Does the challenge materially weaken Candidate 2?**

Yes, on two structural findings:

1. **The failure card format is worse than the health summary for `orphaned/crash` and `stuck/notify-only`** (25% of real sessions are orphaned, and stuck-but-successful sessions exist). Candidate 2 cannot handle absence-of-terminal-event as well as an accumulator that counts all events regardless of terminal state. The 11-category taxonomy check reveals a concrete case where Candidate 2 is worse.

2. **The two-command architecture creates a maintenance burden that neither candidate acknowledged as a cost.** If health must partially implement Candidate 1's cross-day scan to redirect to diagnose, the implementation cost is the union of both candidates' changes, not just Candidate 2's.

**Does the challenge strengthen Candidate 1?**

Yes, on scope:

The three real fixes (`cross-day scan`, `surface detail`, `surface agent_stuck.toolName`) are self-contained 30-50 line changes. Candidate 1's minimal version IS the 30-second path for the two dominant failure modes (timeout/wall-clock + stuck/repeated-tool-call). The failure card format's main contribution (labeled category + suggested fix) can be added to the health output without a new command.

**Where Candidate 2 is still stronger:**

The failure card format is genuinely cleaner for the config/invalid-model case. The `--json` flag (if added) is the right machine-readable interface if scripts need to consume this output. If the operator population grows beyond one person, or if `diagnose` gets consumed by a coordinator that routes sessions to auto-fix loops, the structured output contract is the right investment. Candidate 2 is the right long-term architecture; Candidate 1 is the right now-architecture.

**Recommended resolution:**

Implement Candidate 1's changes (cross-day scan + 3 surfaced fields + per-category suggested fix) inside `runHealthSummary()`. When the output model needs to change for machine readability or quality inspection, do that refactor then -- with a concrete downstream consumer to validate the API. Do not build `parseDaemonEvents()` speculatively.
