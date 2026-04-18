# Implementation Plan: PR Review Coordinator

*Generated: 2026-04-18*

---

## Problem Statement

WorkTrain needs a coordinator script that can autonomously drive multi-PR code review: dispatch `mr-review-workflow-agentic` sessions for open PRs, wait for results, extract findings from session notes, route by severity (clean -> merge, minor -> fix-agent loop, blocking -> escalate), and produce a structured terminal output and report file.

---

## Acceptance Criteria

1. `worktrain run pr-review` CLI subcommand exists and prints usage when run without required args.
2. `worktrain run pr-review --workspace <path>` discovers open PRs via `gh pr list` and dispatches one `mr-review-workflow-agentic` session per PR.
3. Sessions are dispatched in parallel (spawn all, then await all) with a 20-minute per-session timeout.
4. For each session: a 2-call HTTP sequence extracts `recapMarkdown` from `GET /api/v2/sessions/:id/nodes/:nodeId`. Null recapMarkdown -> 'unknown' severity.
5. `parseFindingsFromNotes(markdown)` is a pure function that returns `Result<ReviewFindings, string>`. Two-tier: JSON block (`## COORDINATOR_OUTPUT`) first, keyword scan fallback.
6. Keyword scan: BLOCKING/CRITICAL/REQUEST CHANGES -> blocking; APPROVE/CLEAN/LGTM -> clean (only if no blocking keywords); MINOR/NIT only -> minor; otherwise -> unknown. Negation context check: `/\b(?:not|no|without)\b.{0,30}\bblocking\b/i` suppresses blocking classification.
7. Routing: clean -> queue for merge; minor -> spawn `coding-task-workflow-agentic` fix agent with goal `Fix review findings in PR #N: [finding summaries]`, re-review (max 3 passes); blocking/unknown -> escalate.
8. Serial merge: `gh pr merge --squash` one PR at a time. Merge failure -> escalate, no retry.
9. All 5 robustness rules enforced:
   - Rule 1: child session timeout hardcoded to 15 minutes (`agentConfig: { maxSessionMinutes: 15 }`) -- NOT computed
   - Rule 2: `spawnSession()` returning empty/null handle -> treat as error, escalate
   - Rule 3 (CLI adaptation): check `deps.now() - coordinatorStartMs > 70 * 60 * 1000` before each spawn; refuse if exceeded
   - Rule 4: two-tier notes parsing (JSON block first, keyword fallback, unknown -> blocking)
   - Rule 5: write `{ childSessionId, outcome, elapsedMs, severity }` JSON block to stderr/report before acting on results
10. Terminal output matches UX spec format (see `docs/discovery/coordinator-ux-discovery.md`).
11. Report file written to `./coordinator-pr-review-YYYY-MM-DD.md` in workspace.
12. `--dry-run` flag: prints what would be spawned/merged but makes no HTTP calls or git operations.
13. `--pr <number>` flag: reviews a single specified PR instead of discovering open PRs.
14. Unit tests cover all pure functions: `parseFindingsFromNotes`, `classifySeverity`, `buildFixGoal`, routing logic.
15. TypeScript compiles clean. All existing unit tests pass.

---

## Non-Goals

- Updating `mr-review-workflow.agentic.v2.json` to emit `## COORDINATOR_OUTPUT` block (follow-up)
- Generic coordinator framework or base class
- Modifying `worktrain spawn` or `worktrain await` CLI commands
- CI/CD integration or webhook triggers
- Multi-repo coordinator mode
- Retry logic for failed merges
- Configurable coordinator timeout (always 90 minutes in MVP)

---

## Philosophy-Driven Constraints

- `CoordinatorDeps` is a `readonly` interface -- all I/O injected, zero direct imports in coordinator core
- `parseFindingsFromNotes()` and `classifySeverity()` are pure functions (no I/O) returning `Result<T, E>`
- `ReviewSeverity = 'clean' | 'minor' | 'blocking' | 'unknown'` as a discriminated union with exhaustive switch
- All fetch calls include `AbortSignal.timeout(30_000)` to prevent hangs
- CLI wiring in `src/cli-worktrain.ts` (composition root); coordinator module has no commander dependency
- Validate workspace path (absolute, exists) at CLI entry; trust inside coordinator

---

## Invariants

1. Never merge when severity is `blocking`, `unknown`, `timeout`, `failed`, or `not_awaited`
2. Fix-agent loop: check `passCount >= MAX_FIX_PASSES (3)` BEFORE spawning fix agent
3. Child session timeout: hardcoded 15 minutes -- never LLM-computed or configurable from notes
4. `spawnSession()` returns `err()` on ECONNREFUSED, AbortError, or non-2xx -- never throws
5. Coordinator exits with code 1 if ANY PR resulted in an error (escalated due to error, not just blocking findings)
6. `coordinatorStartMs` set once at startup; Rule 3 check uses this immutable reference
7. Traceability JSON block written before acting on each session result

---

## Selected Approach

**Candidate B: HTTP-first with CoordinatorDeps interface**

- `src/coordinators/pr-review.ts` -- coordinator logic with typed deps interface
- `src/cli-worktrain.ts` -- `worktrain run pr-review` wiring
- `src/cli/commands/index.ts` -- export new command types
- `tests/unit/coordinator-pr-review.test.ts` -- pure function unit tests

Port discovery: copy pattern from `worktrain-spawn.ts` (bounded duplication, correct coupling direction).

**Runner-up:** Candidate A (subprocess model). Lost because it prevents AbortSignal timeout, has no Result types, and is untestable without exec mocking.

---

## Vertical Slices

### Slice 1: Types and pure functions
**File:** `src/coordinators/pr-review.ts` (types and pure functions only)

Define:
- `ReviewSeverity = 'clean' | 'minor' | 'blocking' | 'unknown'`
- `ReviewFindings { severity: ReviewSeverity; findingSummaries: string[]; raw: string }`
- `PrSummary { number: number; title: string; headRef: string }`
- `PrReviewOutcome { prNumber: number; severity: ReviewSeverity; merged: boolean; escalated: boolean; passCount: number; sessionHandles: string[] }`
- `CoordinatorResult { reviewed: number; approved: number; escalated: number; mergedPrs: number[]; reportPath: string }`
- `CoordinatorDeps { spawnSession, awaitSessions, getAgentResult, listOpenPRs, mergePR, writeFile, stderr, now, port }`

Pure functions:
- `parseFindingsFromNotes(notes: string | null): Result<ReviewFindings, string>`
- `classifySeverity(findings: ReviewFindings): ReviewSeverity`
- `buildFixGoal(prNumber: number, findings: ReviewFindings): string`
- `formatElapsed(ms: number): string` (e.g., "8:31")
- `discoverConsolePort(deps, portOverride?): Promise<number>` (copied from worktrain-spawn.ts)

**Done when:** `tsc --noEmit` passes on new file, pure functions compile.

### Slice 2: Coordinator core logic
**File:** `src/coordinators/pr-review.ts` (add `runPrReviewCoordinator` function)

```typescript
async function runPrReviewCoordinator(
  deps: CoordinatorDeps,
  opts: { workspace: string; prs?: number[]; dryRun: boolean; port?: number }
): Promise<CoordinatorResult>
```

Implements full pipeline:
1. List PRs (or use `opts.prs`)
2. Parallel spawn: for each PR, `deps.spawnSession()`
3. `deps.awaitSessions()` with 20m timeout
4. For each result: `deps.getAgentResult()` -> `parseFindingsFromNotes()` -> `classifySeverity()`
5. Route and accumulate outcomes
6. Fix-agent loop (max 3 passes per minor PR)
7. Serial merge for clean PRs
8. Write report via `deps.writeFile()`

**Done when:** `tsc --noEmit` passes, function compiles with full type coverage.

### Slice 3: Unit tests
**File:** `tests/unit/coordinator-pr-review.test.ts`

Test all pure functions:
- `parseFindingsFromNotes(null)` -> err
- `parseFindingsFromNotes('')` -> err
- `parseFindingsFromNotes('## COORDINATOR_OUTPUT\n```json\n...\n```')` -> ok with structured findings
- `parseFindingsFromNotes('APPROVE this change')` -> ok, severity 'clean'
- `parseFindingsFromNotes('This is not technically blocking but...')` -> NOT 'blocking'
- `parseFindingsFromNotes('BLOCKING: auth bypass')` -> severity 'blocking'
- `parseFindingsFromNotes('minor nit')` -> severity 'minor'
- `classifySeverity` with each severity variant
- `buildFixGoal(419, findings)` -> correct goal string
- Loop counter: 3 passes with persistent minor -> escalate

**Done when:** `npx vitest run tests/unit/coordinator-pr-review.test.ts` passes.

### Slice 4: CLI wiring
**Files:** `src/cli-worktrain.ts`, `src/cli/commands/index.ts`

Add `program.command('run pr-review')` to `src/cli-worktrain.ts` with:
- `--workspace <path>` (required)
- `--pr <number>` (optional, repeatable)
- `--dry-run` (flag)
- `--port <n>` (optional)

Wire real deps: `fetch` with AbortSignal.timeout, `execFile` for `gh`/`git`, lock file discovery, `path.join`, `os.homedir`, `fs.promises.writeFile`.

Export `WorktrainRunPrReviewCommandDeps` from `src/cli/commands/index.ts`.

**Done when:** `worktrain run pr-review --help` prints usage. `tsc --noEmit` clean.

### Slice 5: Integration smoke test (manual)
Run `worktrain run pr-review --workspace <path> --dry-run` against a real workspace with open PRs. Verify output format matches UX spec. Verify no HTTP calls made in dry-run mode.

---

## Test Design

**Unit tests (Slice 3):**
- Pure function tests only -- no HTTP, no exec calls
- Fake `CoordinatorDeps` implementing the interface (no mocking framework)
- Vitest, same pattern as existing `tests/unit/` tests
- Cover: all `parseFindingsFromNotes` input variants, `classifySeverity` exhaustiveness, loop counter boundary (`passCount = 2` vs `passCount = 3`)

**Integration test:** Manual dry-run smoke test (not automated in this PR).

---

## Risk Register

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `recapMarkdown` null for completed sessions | Low | null -> unknown -> escalate (conservative) |
| Keyword false positive (negated blocking) | Medium | Negation context check in parser |
| Fix agent runs but PR still fails re-review | Low | Max 3 passes, escalate after |
| Daemon not running at coordinator start | Medium | ECONNREFUSED -> clear error, exit 1 |
| Concurrent merge conflicts | Low | Serial merge + escalate on failure |
| `worktrain run` subcommand name conflicts | Low | Check commander for existing 'run' command |

---

## PR Packaging Strategy

**Branch:** `feat/coordinator-pr-review`
**One PR** covering all 4 slices (types + core + tests + CLI wiring).
PR description: explains the coordinator pattern, lists files changed, references UX spec and design docs.

---

## Philosophy Alignment per Slice

| Slice | Principle | Status |
|-------|-----------|--------|
| Slice 1 (types) | Explicit domain types | Satisfied -- `ReviewSeverity` discriminated union |
| Slice 1 (types) | Immutability by default | Satisfied -- all types readonly |
| Slice 2 (core) | Errors as data | Satisfied -- `parseFindingsFromNotes` returns Result |
| Slice 2 (core) | DI for boundaries | Satisfied -- all I/O via CoordinatorDeps |
| Slice 2 (core) | Validate at boundaries | Satisfied -- workspace validated in Slice 4 |
| Slice 3 (tests) | Prefer fakes over mocks | Satisfied -- fake CoordinatorDeps objects |
| Slice 4 (CLI) | YAGNI with discipline | Satisfied -- no speculative abstractions |
| All | Exhaustiveness | Satisfied -- switch on ReviewSeverity must be exhaustive |

---

## Follow-Up Tickets

1. Update `mr-review-workflow.agentic.v2.json` phase-6 to emit `## COORDINATOR_OUTPUT` JSON block for reliable coordinator parsing
2. Add `--max-runtime` flag to coordinator for configurable timeout (currently hardcoded 90 min)
3. Add automated integration test for coordinator with fake daemon
4. Add `worktrain run groom-prs` as second coordinator using same pattern

---

## Unresolved Unknowns: 0

All design questions answered. No open human-decision questions remain.

**planConfidenceBand: High**
