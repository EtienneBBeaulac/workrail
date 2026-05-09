# Implementation Plan: `worktrain diagnose`

## 1. Problem Statement

`worktrain health <sessionId>` only reads today's daemon event log, returns "No events today" for any prior-day session, and discards the most useful diagnostic fields (`session_completed.detail`, `agent_stuck.toolName/argsSummary`, timeout subtype). Operators have no fast path from "a session failed" to "why and what to fix."

## 2. Acceptance Criteria

- `worktrain diagnose <sessionId>` prints a failure card within 30 seconds for any session from the last 7 days
- Output contains: zone 1 (session ID, category badge, workflow, started timestamp, duration, process state), zone 2 (DIAGNOSIS label + evidence + suggested fix), zone 4 (metrics), zone 3 (step timeline, capped at 8)
- `worktrain health <id>` falls back to diagnose output when session not found in today's log
- `--json` flag outputs machine-readable JSON with full untruncated fields
- `--ascii` flag replaces Unicode glyphs with ASCII equivalents
- All 6 failure categories produce non-empty, actionable output: CONFIG / WORKFLOW / INFRA / ORPHANED / SUCCESS / DEFAULT
- Success sessions produce a friendly "no failure" card, not DEFAULT
- NOT_FOUND produces a clear "not found in last 7 days" message
- Multiple prefix matches produce an error listing all matches

## 3. Non-Goals

- `--since` flag to widen scan beyond 7 days
- `--verbose` flag for full Zone 3 timeline
- `worktrain failures` aggregate fleet view
- Conversation log `--deep` flag
- Console inline integration
- Push-based outbox auto-write after each failure
- Refactoring `runHealthSummary()` (unchanged)

## 4. Philosophy Constraints

- `parseDaemonEvents()` must be a pure function: no I/O, no side effects, injected readFile dep
- `DiagnosticResult` must be a discriminated union (not a plain object with string fields)
- Renderer functions (`formatDiagnosticCard`, `formatDiagnosticJson`) are pure
- No LLM calls anywhere in this feature
- No exceptions thrown -- all error paths return a DiagnosticResult value

## 5. Invariants

- `parseDaemonEvents()` reads ALL daysBack files and collects events per sessionId, then checks for prefix collisions BEFORE classifying: if >1 distinct full sessionId matches the given prefix, return `{ kind: 'AMBIGUOUS', candidates: string[] }` -- never merge event streams from two different sessions
- `parseDaemonEvents()` reads ALL daysBack files before classifying (never stop on first file with a match -- cross-midnight sessions require full scan)
- Malformed JSONL lines: skip-and-continue (no throw, no Result wrapping -- just skip the line)
- SUCCESS guard fires before any failure classification
- NOT_FOUND is distinct from ORPHANED (separate DiagnosticResult variant)
- Zone 3 `→` marker must not use `chalk.red` (reserved for Zone 2 STUCK/error) -- unit test required
- `--json` output includes ALL fields from parsed events with NO additional CLI-layer truncation (note: daemon event log already truncates `detail` and `argsSummary` at 200 chars at write time; the JSON output cannot recover original text beyond what the log contains -- this is a known gap, not a CLI bug)
- `worktrain health` cross-day delegation ships in the same commit as diagnose; today's live-session output uses `runHealthSummary()` (unchanged); cross-day sessions use `formatDiagnosticCard()` -- two visually distinct formats by design, explicitly documented

## 6. Selected Approach

**New module:** `src/cli/commands/worktrain-diagnose.ts`
- `DiagnosticResult` discriminated union: `NOT_FOUND | SUCCESS | CONFIG_ERROR | WORKFLOW_STUCK | WORKFLOW_TIMEOUT | INFRA_ERROR | ORPHANED | DEFAULT`
- `parseDaemonEvents(sessionId, eventsDir, daysBack, readFile)` -- pure function
- `formatDiagnosticCard(result, opts: {chalk, ascii})` -- pure renderer, returns string
- `formatDiagnosticJson(result)` -- pure JSON serializer

**Updated:** `src/cli-worktrain.ts`
- Add `worktrain diagnose <sessionId>` command (with `--json`, `--ascii` flags)
- Update `worktrain health` action: if session not in today's log, call `parseDaemonEvents()` and output failure card

**Runner-up rejected:** inline in `cli-worktrain.ts` -- pure functions too complex to replicate in tests.

## 7. Vertical Slices

### Slice 1: Core module + parseDaemonEvents() + unit tests
**Files:** `src/cli/commands/worktrain-diagnose.ts` (new), `tests/unit/cli-worktrain-diagnose.test.ts` (new)
**Done when:** `npx vitest run tests/unit/cli-worktrain-diagnose.test.ts` passes; all 6 categories + NOT_FOUND + SUCCESS tested

### Slice 2: formatDiagnosticCard() renderer
**Files:** `src/cli/commands/worktrain-diagnose.ts` (extend)
**Done when:** renderer tests pass for all zone templates; Zone 3 capping verified; --ascii substitution verified

### Slice 3: CLI wiring -- worktrain diagnose command
**Files:** `src/cli-worktrain.ts`
**Done when:** `worktrain diagnose --help` shows correct usage; command registered and imports diagnose module

### Slice 4: worktrain health cross-day delegation
**Files:** `src/cli-worktrain.ts`
**Done when:** health command falls back to parseDaemonEvents() when today's log has no match; today's live session behavior unchanged

### Slice 5: --json and --ascii flags
**Files:** `src/cli-worktrain.ts`, `src/cli/commands/worktrain-diagnose.ts`
**Done when:** `--json` outputs valid JSON with untruncated fields; `--ascii` replaces glyphs

## 8. Test Design

**File:** `tests/unit/cli-worktrain-diagnose.test.ts`

Tests for `parseDaemonEvents()`:
- Returns NOT_FOUND when no events in any file
- Returns SUCCESS for `session_completed outcome=success`
- Returns CONFIG_ERROR for `outcome=error detail="400 The provided model identifier is invalid"` -- asserts specific string pattern
- Returns WORKFLOW_STUCK for `agent_stuck reason=repeated_tool_call` -- asserts toolName and argsSummary propagated
- Returns WORKFLOW_TIMEOUT for `outcome=timeout`
- Returns INFRA_ERROR for `session_aborted reason=daemon_shutdown`
- Returns ORPHANED for sessions with events but no terminal event
- Returns DEFAULT for `outcome=error` with unrecognized detail -- asserts raw event line is included in result
- Cross-midnight: session start in file N, terminal event in file N+1 -- correct classification (NOT ORPHANED)
- Prefix ambiguity: two sessions share prefix -- returns AMBIGUOUS with both candidates listed (asserts message contains both session IDs)
- Prefix exact match: one session, prefix resolves to it -- returns correct result
- Malformed JSONL line: skipped silently, rest of file parsed correctly -- no throw

Tests for `formatDiagnosticCard()`:
- Zone 3 (step timeline) capped at 8 steps with ellipsis for 12-step workflow
- Zone 3 empty state sentinel for 0-step session: "(session terminated before first step)"
- `--ascii` flag substitutes glyphs: `✓`→`[ok]`, `→`→`[->]`, `·`→`[ ]`
- Truncation indicator present when `detailTruncated=true` in DiagnosticResult
- Zone 3 `→` marker does NOT contain chalk.red ANSI code (explicit color test)

## 9. Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Cross-midnight session misclassified as ORPHANED | High | Full-scan across all files before classifying |
| Detail string pattern changes silently | Medium | Unit tests assert specific string patterns |
| chalk import fails in new module | Low | output-formatter.ts already uses chalk v5 in same build |

## 10. PR Strategy

Single PR. All slices in one commit (or squashed). Branch: `feat/etienneb/worktrain-diagnose`.

## 11. Philosophy Alignment

| Principle | Status |
|---|---|
| Functional core, imperative shell | Satisfied -- parseDaemonEvents() pure; CLI action is shell |
| Errors are data | Satisfied -- DiagnosticResult is a value, never throws |
| Exhaustiveness everywhere | Satisfied -- discriminated union with assertNever on DEFAULT |
| Validate at boundaries | Satisfied -- session ID matching and file parsing at CLI boundary |
| YAGNI with discipline | Satisfied -- deferred items stay deferred |
| Compose with small pure functions | Satisfied -- three separate pure functions |
| Make illegal states unrepresentable | Tension -- detail field is opaque string; accepted as boundary artifact |
