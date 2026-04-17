# Implementation Plan: WorkTrain System Prompt Preamble + report_issue Tool

## Problem Statement

The WorkTrain daemon's system prompt preamble is thin (15 lines) and relies on the soul file for behavioral guidance. This leaves unattended agents without explicit direction on self-directed reasoning, the oracle hierarchy, or what to do when things go wrong. Additionally, there is no structured way for agents to record issues/errors for a future auto-fix coordinator -- failures either go unrecorded or end up buried in step notes.

---

## Acceptance Criteria

1. `buildSystemPrompt()` output contains a richer preamble (~55 lines) that:
   - Opens with "You are WorkRail Auto, an autonomous agent..." (existing test assertion preserved)
   - Includes `## Your tools` section listing all 5 tools (existing test assertion)
   - Includes `## Execution contract` section (existing test assertion)
   - Adds `## What you are`, `## Your oracle`, `## Self-directed reasoning`, `## The workflow is the contract`, `## Silent failure is the worst outcome`, `## Tools are your hands not your voice`, `## You don't have a user` sections
   - All existing `workflow-runner-system-prompt.test.ts` tests pass without modification

2. `makeReportIssueTool(sessionId, emitter?, issuesDirOverride?)` is exported from `workflow-runner.ts`:
   - Tool name: `report_issue`
   - Input schema accepts: `kind` (5-value literal enum), `severity` (4-value literal enum), `summary` (string, required), `context` (string, optional), `toolName` (string, optional), `command` (string, optional), `suggestedFix` (string, optional), `continueToken` (string, optional)
   - `execute()` appends one JSON line to `~/.workrail/issues/<sessionId>.jsonl` (or `issuesDirOverride/<sessionId>.jsonl` in tests) -- fire-and-forget (void+catch)
   - `execute()` emits a `DaemonEventEmitter` event with `kind: 'issue_reported'`
   - For non-fatal severity: returns `"Issue recorded (severity=<severity>). Continue with your work unless this is fatal."`
   - For fatal severity: returns `"FATAL issue recorded. Call continue_workflow with notes explaining the blocker, then the session will end."`
   - Wired into `runWorkflow()` tools array

3. `IssueReportedEvent` is added to `DaemonEvent` union in `daemon-events.ts`:
   - `kind: 'issue_reported'`, `sessionId: string`, `issueKind` (5-value literal union), `severity` (4-value literal union), `summary: string`, `continueToken?: string`

4. `npm run build` succeeds (no TS errors)
5. `npx vitest run` passes (all existing tests + new tests)

---

## Non-Goals

- No auto-fix coordinator implementation
- No IssueStore class (YAGNI -- extract when coordinator needs it)
- No changes to `soul-template.ts`, `triggers.yml`, or `src/v2/`
- No changes to the soul file template/default
- No changes to AgentLoop behavior (fatal severity does not abort the loop)
- No async changes to `buildSystemPrompt()` (must remain synchronous and pure)

---

## Philosophy-Driven Constraints

- `buildSystemPrompt()` must remain a pure, synchronous function (no I/O, no side effects)
- All `DaemonEvent` variants must use `readonly` fields only
- `IssueReportedEvent.issueKind` and `.severity` must be literal union types (not `string`)
- JSONL write must be fire-and-forget: `void appendIssueAsync().catch(() => {})`
- `mkdir({ recursive: true })` before every appendFile (handles missing dir silently)
- `issuesDirOverride` parameter for test isolation (mirrors DaemonEventEmitter constructor)

---

## Invariants

1. `buildSystemPrompt()` is pure and synchronous -- verified by existing tests calling it directly
2. `'You are WorkRail Auto'` is present in `buildSystemPrompt()` output -- verified by test L29
3. `'## Your tools'` is present in `buildSystemPrompt()` output -- verified by test L30
4. `'## Execution contract'` is present in `buildSystemPrompt()` output -- verified by test L32
5. All `DaemonEvent` variants use `readonly` fields -- verified by TS compiler
6. `DaemonEvent` union is exhaustive -- TS compiler enforces at every switch site
7. `report_issue.execute()` never throws -- returns `AgentToolResult` always
8. JSONL write never blocks `execute()` return -- `void` Promise

---

## Selected Approach + Rationale

**Part 1:** Module-private `BASE_SYSTEM_PROMPT` string constant defined above `buildSystemPrompt()`. The function uses it as the start of the lines array. Rationale: named constant is readable as a document; testable via `buildSystemPrompt()` output; follows `soul-template.ts` precedent for stable-content constants.

**Part 2:** `makeReportIssueTool(sessionId, emitter?, issuesDirOverride?)` inline tool factory following the exact shape of `makeReadTool`/`makeWriteTool`. Private `appendIssueAsync()` helper for JSONL write. `issuesDirOverride` for test isolation (hybrid of inline factory + runner-up's dirOverride). Rationale: YAGNI -- no IssueStore class until coordinator exists; hybrid resolves testability without over-engineering.

**Runner-up:** IssueStore class (Candidate B). Lost to YAGNI -- one caller, no coordinator yet.

---

## Vertical Slices

### Slice 1: Create feature branch
- Create `feat/worktrain-system-prompt-and-report-issue` from current main
- Verify clean state

### Slice 2: Add IssueReportedEvent to daemon-events.ts
- Add `IssueReportedEvent` interface
- Add to `DaemonEvent` union
- Verify TS compiles

### Slice 3: Replace buildSystemPrompt() preamble
- Define `BASE_SYSTEM_PROMPT` constant above `buildSystemPrompt()`
- Replace lines 1087-1108 to use the constant
- Verify all existing system-prompt tests pass

### Slice 4: Implement makeReportIssueTool
- Add private `appendIssueAsync()` helper
- Add `makeReportIssueTool()` factory
- Wire into `runWorkflow()` tools array

### Slice 5: Tests
- Add tests for `makeReportIssueTool` -- verify JSONL write with temp dir, verify event emitted, verify return strings, verify fatal vs non-fatal
- Verify all existing tests still pass

### Slice 6: Build + full test run
- `npm run build` -- zero errors
- `npx vitest run` -- all pass

### Slice 7: PR
- Commit with conventional commit message
- Open PR to main

---

## Test Design

### Existing tests (must pass unchanged)
- `tests/unit/workflow-runner-system-prompt.test.ts` -- all 11 tests
- `tests/unit/daemon-events.test.ts` -- all existing tests

### New tests to add
File: `tests/unit/workflow-runner-report-issue.test.ts`

Test cases:
1. `makeReportIssueTool` -- returns correct tool name and description
2. `execute()` with non-fatal severity -- returns confirmation string with severity
3. `execute()` with fatal severity -- returns FATAL message
4. `execute()` -- writes JSON line to issuesDirOverride/<sessionId>.jsonl
5. `execute()` -- written JSON contains kind, severity, summary, ts, sessionId
6. `execute()` -- creates dir if it doesn't exist (mkdir recursive)
7. `execute()` -- emits `issue_reported` event via emitter
8. `execute()` -- optional fields (context, toolName, command, suggestedFix, continueToken) present in JSON when provided
9. `execute()` -- does not throw when write fails (fire-and-forget)

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| BASE_SYSTEM_PROMPT missing required test strings | Low | High (CI break) | Include `'You are WorkRail Auto'`, `'## Your tools'`, `'## Execution contract'` explicitly; tests catch immediately |
| IssueReportedEvent `issueKind` vs tool input `kind` confusion | Low | Medium (runtime behavior ok, TS shape wrong) | Use `issueKind` in event interface; keep `kind` in input schema |
| Silent JSONL write failure not caught in tests | Low | Low (fire-and-forget is intentional) | issuesDirOverride isolates write path; test case #9 verifies no throw |
| Agent ignores fatal severity | Medium | Medium (tokens wasted) | Out of scope; coordinator detects post-hoc |

---

## PR Packaging Strategy

Single PR: `feat/worktrain-system-prompt-and-report-issue`
- All 3 files changed: `src/daemon/workflow-runner.ts`, `src/daemon/daemon-events.ts`, `tests/unit/workflow-runner-report-issue.test.ts`
- Commit message: `feat(console): richer daemon system prompt and report_issue tool`

Wait -- scope is `daemon`, not `console`. Correct commit message:
`feat(mcp): richer daemon system prompt and report_issue tool for auto-fix coordinator`

Actually these are daemon changes. The allowed scopes from CLAUDE.md are: `console`, `mcp`, `workflows`, `engine`, `schema`, `docs`. The daemon lives under `mcp` in this codebase (daemon is part of the WorkRail server). Use scope `mcp`.

---

## Philosophy Alignment Per Slice

### Slice 2 (daemon-events.ts)
- Exhaustiveness everywhere -> satisfied (new union variant, TS enforces handling)
- Make illegal states unrepresentable -> satisfied (literal unions for issueKind/severity)
- Immutability by default -> satisfied (readonly fields)

### Slice 3 (BASE_SYSTEM_PROMPT)
- Functional core, imperative shell -> satisfied (buildSystemPrompt remains pure)
- Immutability by default -> satisfied (const)
- Document why not what -> satisfied (JSDoc on constant)
- YAGNI with discipline -> satisfied (no speculative additions)

### Slice 4 (makeReportIssueTool)
- Observability as a constraint -> satisfied (fire-and-forget, never blocks)
- Errors are data -> satisfied (execute() returns AgentToolResult, never throws)
- Prefer fakes over mocks -> satisfied (issuesDirOverride for tests)
- YAGNI with discipline -> satisfied (no IssueStore class)
- Exhaustiveness everywhere -> satisfied (return value handles all severity levels)

### Slice 5 (tests)
- Prefer fakes over mocks -> satisfied (temp dir, no fs mocking)
- Determinism -> satisfied (all test writes go to unique temp dirs)

---

## Summary

- `estimatedPRCount`: 1
- `planConfidenceBand`: High
- `unresolvedUnknownCount`: 0
- `followUpTickets`: Extract IssueStore class when auto-fix coordinator is built
