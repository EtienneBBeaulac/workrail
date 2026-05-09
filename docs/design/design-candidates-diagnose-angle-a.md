# Design Candidates: Session Failure Diagnosis (Angle A)

**Problem:** Operators have no fast path from "a session failed" to "here is the specific reason and what to fix." They must manually correlate raw JSONL events across multiple files requiring knowledge of the internal event schema.

**Focus angle:** Anchor every candidate to the ideal end state -- build the best achievable designs if effort and scope were no constraint, then assess which parts are actually achievable now.

**Persona:** Pragmatic senior CLI tooling engineer who has built observability tools for distributed systems and knows the difference between a pretty dashboard and a tool that actually saves debugging time.

**Date:** 2026-05-09

---

## Candidates

---

### Approach 1 (p=0.70): `worktrain diagnose` -- Pull-Based Failure Card Command

**Primary mechanism:** New `worktrain diagnose <sessionId>` command that scans all daily JSONL files from the last 7 days, classifies the session into a failure category using a deterministic decision tree, and prints a compact "failure card" with step timeline, category, evidence, and a suggested fix -- without requiring any knowledge of internal event schemas.

**How it addresses each criterion:**

- **P1 cross-day coverage:** Scans all `YYYY-MM-DD.jsonl` files from `now - 7d` to today. Session lookup is ID prefix match across all files. Works with daemon stopped -- reads files directly. No today-only constraint.
- **P1 failure category signal:** Decision tree classifies into the 11 documented categories using exact field paths: `session_completed.detail` for error text, `agent_stuck.reason` + `toolName` + `argsSummary` for stuck, `outcome=timeout` + `detail` text for wall_clock vs max_turns. Each category maps to a specific evidence line in the output.
- **P2 30-second path:** Output is a single failure card: session metadata, step timeline (count + which step it stopped at via last `step_advanced` before terminal event), failure category headline, 2-3 lines of specific evidence, one-line suggested fix for the 3 most common categories (config/invalid-model -> "fix agentConfig.model in triggers.yml"; stuck/repeated-tool-call -> "review step prompt for ambiguous observation loop"; timeout/wall-clock -> "increase maxSessionMinutes or narrow scope"). No raw JSON exposed.
- **P2 overnight-safe:** Pure file read. No daemon dependency. Works at 9am on sessions that ran at 2am. Files are indefinitely retained.
- **P3 extensibility:** Read path is a single `parseDaemonEvents(sessionId, daysBack)` function returning a typed session event array. Same function can later be called to surface step notes from the WorkRail session store by joining on `workrailSessionId`.

**Tradeoffs / risks:**

- Two separate commands (`health` for live sessions, `diagnose` for post-mortem) may confuse operators -- they have to know which to use. Mitigated by having `health` detect past-day sessions and suggest `diagnose`.
- The `detail` field from `session_completed` is truncated to 200 chars in the event log. For long stack traces this may be insufficient. Conversation log fallback is deferred.
- Decision tree must be maintained as new failure categories emerge. A new `outcome` value silently falls through to "unknown" unless the tree is exhaustive -- mitigated with a default "see raw event: `<session_completed line>`" fallback.
- Cross-day scan reads up to 7 JSONL files per call. At typical event volumes this is fast (files are small). At scale (many daemon sessions), this needs a session-indexed lookup -- deferred.

**Leaves for later:**

- Conversation log fallback for truncated error messages
- Aggregate view (pattern across multiple sessions)
- Push-based auto-diagnosis after each failure
- Console inline integration
- Session index for fast lookup without full-file scans

---

### Approach 2 (p=0.45): Enhance `worktrain health` -- Cross-Day Repair + Field Surfacing

**Primary mechanism:** Instead of a new command, fix `worktrain health <sessionId>` to scan the last N days of event logs and surface the three fields it currently discards (`session_completed.detail`, `agent_stuck.toolName`/`argsSummary`, timeout subtype), keeping the operator's existing muscle memory intact.

**How it addresses each criterion:**

- **P1 cross-day coverage:** Replace the single-date `readFileSync` with a loop over `[now-7, ..., today]` JSONL files. First file containing the session ID wins; if not found in today's log, retry backward. This is a surgical 15-line change to `runHealthSummary`.
- **P1 failure category signal:** Add three surface-only changes to `runHealthSummary`: (a) print `session_completed.detail` when non-null; (b) print `agent_stuck.toolName` + `argsSummary` next to each stuck warning; (c) parse `detail` for "wall_clock" vs "max_turns" string markers. No new decision tree, just stop discarding fields.
- **P2 30-second path:** Partial -- output still uses the existing health summary format (counts, durations), which is harder to parse than a dedicated failure card. But the most actionable fields (error message, stuck tool name) are now visible. Operator still needs to read and interpret; no suggested fix is generated.
- **P2 overnight-safe:** Yes -- same as Approach 1, once the cross-day scan is added.
- **P3 extensibility:** Limited. `runHealthSummary` is an imperative accumulator that prints as it goes. Adding step notes from the WorkRail session store or conversation log would require a significant refactor of the output model. The function is not designed for composition.

**Tradeoffs / risks:**

- "Enhance health" sounds small but the P2 gap (no suggested fix, no failure category label) means the operator still interprets raw data. The output says "1 stuck signal: continue_workflow, argsSummary=..." but does not say "likely looping on observation -- review step prompt." The 30-second path is a stretch.
- `runHealthSummary` prints directly to stdout as it scans -- the output model makes it hard to restructure or add a failure card header without rewriting the function. Risk: the fix becomes a patch that makes `health` slightly less broken but still not good.
- Operator confusion if `health` and a future `diagnose` produce different output for the same session.
- Backward-compat: `health` is advertised as a "live session" tool. Adding cross-day reads subtly changes its contract -- it would now sometimes show completed sessions that the operator did not know existed.

**Leaves for later:**

- Suggested fix generation
- Failure category labeling
- Conversation log access
- Aggregate views
- Separation between "live session summary" (health) and "post-mortem diagnosis" (diagnose)

---

### Approach 3 (p=0.08): Push-Based Failure Outbox -- Auto-Diagnosis After Every Session

**Primary mechanism:** Rather than a pull command, wire a `FailureDiagnoser` into the daemon's session completion path: after every non-success `session_completed` event, the daemon classifies the failure, generates a failure card, and appends it to `~/.workrail/outbox.jsonl`. The existing `worktrain inbox` command surfaces it. The operator runs nothing -- diagnosis is delivered.

**How it addresses each criterion:**

- **P1 cross-day coverage:** Trivially satisfied -- the diagnosis is written at session end, not at query time. The outbox is appended indefinitely. An operator reading the inbox at 9am sees failures from overnight sessions.
- **P1 failure category signal:** The daemon has full event context at session end -- no cross-file scan needed. It can classify with complete information: `agent_stuck.toolName`, `session_completed.detail`, timeout subtype are all in-process values, not reconstructed from JSONL. This is actually more reliable than any post-hoc scan.
- **P2 30-second path:** Zero seconds -- the failure card is already written. `worktrain inbox` shows it immediately. If the outbox currently has no sessionId linkage (noted gap in landscape), fix that here: write `sessionId` into each outbox entry.
- **P2 overnight-safe:** This is the best overnight story of all candidates -- the outbox IS the overnight feedback loop. No polling, no manual command.
- **P3 extensibility:** The outbox format can be extended to include step notes and artifacts from the WorkRail session store at write time (daemon has workrailSessionId available). Quality inspection becomes a second outbox entry kind alongside failure cards.

**Tradeoffs / risks:**

- **Requires daemon to be running at session end.** If the daemon is SIGKILL'd mid-session, no failure card is written. The pull-based approaches (1, 2) are more reliable for crash scenarios.
- **Daemon code path.** Adding diagnosis logic to `src/daemon/` touches load-bearing infrastructure. A bug in the classifier could crash the daemon -- mitigated with try/catch, but the blast radius is higher than a pure CLI command.
- **Outbox coupling.** The outbox currently has no sessionId. Fixing that is a prerequisite -- it is not a one-liner. `worktrain inbox` may show unrelated outbox entries alongside failure cards.
- **Retroactive diagnosis is impossible.** Sessions that already ran (yesterday, last week) have no cards. Approach 1 handles those; this approach does not.
- **Two sources of truth.** Operators must know: for past sessions use `worktrain diagnose`; for future sessions use `worktrain inbox`. The combination requires documentation and two mental models.

**Leaves for later:**

- Pull-based fallback for pre-push-era sessions and crash scenarios
- Console inline display
- Retroactive diagnosis of historical sessions
- Aggregation across failure cards

---

### Approach 4 (p=0.04): Indexed Session Store -- Pre-Built Failure Index at Daemon Shutdown

**Primary mechanism:** At daemon shutdown (or on a background timer), build a compact failure index at `~/.workrail/data/failure-index.jsonl` by scanning the most recent N days of event logs and writing one classified record per non-success session. CLI commands read the index, not the raw JSONL. The index is the diagnostic API.

**How it addresses each criterion:**

- **P1 cross-day coverage:** The index covers whatever window was scanned when it was built. A 7-day scan at shutdown produces a 7-day-coverage index. Stale if daemon has not run recently, but the index file persists.
- **P1 failure category signal:** Index records are pre-classified: `{ sessionId, outcome, category, evidence: { toolName?, detail?, stuckReason?, timeoutType? }, suggestedFix, ts }`. Consumers (CLI, console) read typed records, not raw events. This is the cleanest consumer-facing API of all candidates.
- **P2 30-second path:** `worktrain diagnose` reads one index file instead of scanning 7 JSONL files. Sub-second lookup even at large scales. Output is as clean as Approach 1.
- **P2 overnight-safe:** Index is written at daemon shutdown (graceful stop writes it) and on a 1-hour timer. Sessions that ran and completed while the daemon was up are indexed. Crash scenarios (SIGKILL) may miss recent sessions -- fallback is the same cross-day scan from Approach 1.
- **P3 extensibility:** Index schema can add `qualityNote: string` and `artifactCount: number` later. Read path is stable.

**Tradeoffs / risks:**

- **Stale index problem.** The index is only as fresh as the last write. Between daemon runs, or if the daemon crashes, the index may not include recent sessions. Any consumer must fall back to live JSONL scan for sessions not in the index. Two code paths are required.
- **Build complexity vs. read simplicity tradeoff.** The index writer must be maintained alongside the event schema. Every new `DaemonEvent` variant needs a corresponding update to the index builder. With a small team this is sustainable; at scale it becomes a maintenance burden.
- **Daemon coupling for writes.** The index builder runs inside the daemon process (at shutdown or on timer). The CLI cannot rebuild the index without running the daemon. An operator on a fresh machine who has the JSONL files but no daemon cannot build the index.
- **Over-engineering for a single operator.** The existing landscape note is clear: primary user is one operator. A pre-built index is the right architecture for a multi-team observability product; for a single operator it may be premature.

**Leaves for later:**

- CLI-side fallback scan for stale/missing index
- Console read path for the index
- Index compaction for very long-running deployments
- Push notification from index to outbox

---

### Approach 5 (p=0.03): Conversation Log Mining -- LLM-Free Heuristic Extraction from Full Turn Logs

**Primary mechanism:** Rather than relying solely on structured daemon events, read `~/.workrail/daemon-sessions/<sessionId>-conversation.jsonl` (the full LLM turn log) and extract failure signals heuristically: look for repeated assistant tool_use blocks with identical inputs, look for the last tool_result text for error strings, look for the session's final assistant message to extract the agent's own stated reason for stopping. Present these alongside the daemon event log summary.

**How it addresses each criterion:**

- **P1 cross-day coverage:** Conversation logs are per-session files (not daily files), so no cross-day scan is needed. Lookup is by sessionId directly. But: conversation logs are deleted on success -- this approach only works for failed sessions, which is the target case.
- **P1 failure category signal:** This is the richest signal of all candidates. The conversation log contains: exact error messages (not truncated to 200 chars), the full repeated tool call sequence, the agent's final reasoning text. For the stuck/repeated-tool-call category, it can show the agent's actual thinking ("I need to keep trying this command until...") which no daemon event carries.
- **P2 30-second path:** Strong for failure categories where the agent stated the reason in its final turn (end_turn stop_reason with a message like "I cannot proceed because..."). Weaker for timeout cases where the agent simply ran out of time -- the log shows the last turns but no terminal reasoning.
- **P2 overnight-safe:** Yes -- conversation logs are files, daemon not required.
- **P3 extensibility:** The conversation log read path can surface step notes from `node_output_appended` WorkRail engine events directly, making it the single source for both failure diagnosis and quality inspection.

**Tradeoffs / risks:**

- **Conversation logs can be 80-400KB.** Parsing them for diagnosis adds latency and memory compared to the structured event log. Must be selective: read only the last N turns rather than the full log, and only if the structured event log does not resolve the category.
- **Conversation logs are deleted on success.** This approach is a complement to structured event log analysis, not a replacement. It handles the "I need more context" case, not the first-pass diagnosis.
- **Format dependency.** The conversation log format is the Anthropic Messages API format (array of `{ role, content }` objects). Any change to how the daemon serializes turns (e.g., switching to a different model API) would break extraction.
- **The riskiest assumption in the problem statement is tested directly here.** If daemon event log fields (200-char truncated errors, `agent_stuck.toolName`) are sufficient for the 3 most common failure categories, conversation log mining is unnecessary complexity. Evidence: the 3 categories (`timeout stepCount=0`, `stuck/repeated_tool_call`, `config/invalid-model`) are all fully diagnosable from daemon events alone. This approach adds complexity for edge cases.
- **Not a standalone solution.** Without cross-day daemon event scanning (Approach 1/2), the operator still cannot find the session. Conversation log mining is a depth-of-diagnosis feature, not a discoverability feature.

**Leaves for later:**

- Fallback trigger: only read conversation log when structured events are inconclusive
- Configurable turn depth for conversation log parsing
- Sanitization before display (conversation logs may contain sensitive code or credentials)
- Integration with Approach 1 as an optional `--deep` flag

---

## Comparison Table

| Criterion | Approach 1 (diagnose cmd) | Approach 2 (fix health) | Approach 3 (push outbox) | Approach 4 (failure index) | Approach 5 (convo log) |
|---|---|---|---|---|---|
| P1: cross-day coverage | Yes -- 7-day file scan | Yes -- same scan | Trivially (written at end) | Index covers window | Yes -- per-file |
| P1: failure category signal | Yes -- decision tree | Partial -- fields exposed | Best -- in-process context | Yes -- pre-classified | Best -- full text |
| P2: 30-second path | Yes -- failure card format | No -- raw counts format | Zero seconds (inbox) | Yes -- index read | Partial (end_turn only) |
| P2: overnight-safe | Yes | Yes | Yes -- this is the vision | Mostly (staleness risk) | Yes |
| P3: extensible to quality | Yes (join on workrailSessionId) | No (imperative printer) | Yes (add second entry kind) | Yes (extend schema) | Yes (shared read path) |
| Works on crashed sessions | Yes | Yes | No | Partial | Yes (if log survived) |
| Daemon dependency | None | None | Yes (for future sessions) | Yes (for index build) | None |
| Retroactive | Yes | Yes | No | Partial | Yes (if log survived) |
| Implementation complexity | Medium | Low | High | High | Medium |

---

## Observations

**The three most common failure categories are fully diagnosable from the structured daemon event log alone.** Conversation log mining (Approach 5) and the pre-built failure index (Approach 4) add complexity without solving the core problem faster.

**Cross-day coverage is the single most impactful fix.** Every approach that adds it immediately makes the tool useful for the overnight-safety criterion. The fix is a loop over daily files -- identical code regardless of which approach is chosen.

**Approaches 1 and 2 are on a spectrum, not opposed.** Approach 2 (fix health) is Approach 1 with the failure card format stripped out. The difference is whether `runHealthSummary` is refactored to emit structured data with a suggested fix, or just gets three new print statements. The refactor cost is low; the operator experience difference is significant.

**Approach 3 (push outbox) is the vision-aligned endgame** but requires two prerequisites: (a) fixing the outbox-to-sessionId correlation gap, and (b) Approach 1 as a retroactive fallback. It should be built on top of Approach 1, not instead of it.

**Riskiest assumption confirmed safe:** The 11-category failure taxonomy shows all three dominant categories (`config/invalid-model`, `stuck/repeated-tool-call`, `timeout`) are diagnosable from `session_completed.detail` and `agent_stuck.*` alone -- no conversation log required for the common path.
