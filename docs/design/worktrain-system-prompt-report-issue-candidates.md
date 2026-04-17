# WorkTrain: System Prompt Preamble + report_issue Tool -- Design Candidates

## Problem Understanding

### Core Tensions

1. **Preamble richness vs. existing test assertions** -- The current `buildSystemPrompt()` preamble is ~15 lines (identity, tools, execution contract, session state). The new spec replaces it with ~55 lines covering oracle hierarchy, self-directed reasoning, workflow-as-contract, silent failure, and tools-as-hands. The existing tests assert specific strings (`'You are WorkRail Auto'`, `'## Your tools'`, `'## Execution contract'`) must be present. The new content must include those strings or the tests break.

2. **report_issue write durability vs. fire-and-forget contract** -- The JSONL file must be written reliably enough for a future coordinator to read it, but a disk-full or permission error must never interrupt the agent session. Resolution: same void+catch pattern as `DaemonEventEmitter`.

3. **Purity of buildSystemPrompt vs. tool name references in prose** -- The new preamble mentions `report_issue` by name in the "silent failure" section. If the tool name ever changes, the system prompt text becomes stale. This is an accepted documentation-drift risk; tool names are stable identifiers.

4. **YAGNI (no coordinator yet) vs. extractability (coordinator coming soon)** -- The auto-fix coordinator that will read the issue JSONL doesn't exist. Building a dedicated `IssueStore` class now is speculative. However, the file write must still work for the coordinator when it arrives.

### Likely Seam

- **Preamble:** `buildSystemPrompt()` lines 1086-1108 in `src/daemon/workflow-runner.ts`. This is the correct seam -- pure function, all callers go through it.
- **report_issue tool:** The tools array in `runWorkflow()` at lines 1318-1323. New tool factory `makeReportIssueTool()` slots in here.
- **DaemonEvent union:** `src/daemon/daemon-events.ts` -- add `IssueReportedEvent` + extend union.

### What Makes This Hard

- Existing test assertions constrain the new preamble content -- `'## Your tools'` and `'## Execution contract'` must survive the rewrite.
- `report_issue.execute()` must be fire-and-forget for the JSONL write. Junior devs would `await` it directly and let I/O errors propagate.
- `IssueReportedEvent` fields must be typed as literal union strings (not `string`), otherwise illegal kind/severity values are representable at compile time.

---

## Philosophy Constraints

From `/Users/etienneb/CLAUDE.md` and `~/.workrail/daemon-soul.md`:

- **Exhaustiveness everywhere** -- `DaemonEvent` must remain a discriminated union; new variant must follow the pattern
- **Make illegal states unrepresentable** -- `kind` and `severity` on IssueReportedEvent must be literal unions, not strings
- **YAGNI with discipline** -- don't build IssueStore class until the coordinator needs it
- **Observability as a constraint** -- fire-and-forget writes must never block correctness
- **Document 'why' not 'what'** -- JSDoc on BASE_SYSTEM_PROMPT explaining why it's a constant
- **Immutability by default** -- all DaemonEvent interfaces use `readonly` fields
- **Functional core, imperative shell** -- buildSystemPrompt is pure; JSONL write is at the shell boundary

---

## Impact Surface

- `tests/unit/workflow-runner-system-prompt.test.ts` -- 3 assertions on preamble content that must pass after rewrite
- `tests/unit/daemon-events.test.ts` -- existing event tests; adding a new event kind must not break exhaustiveness checks
- Any future TypeScript code that does `switch (event.kind)` on `DaemonEvent` -- must handle `'issue_reported'` or get a compile error (desired)
- `runWorkflow()` tools array -- adding `makeReportIssueTool` here; `sessionId` and `emitter` are already in scope
- The `BASE_SYSTEM_PROMPT` constant mentions the tool by name -- documentation drift if tool is renamed later

---

## Candidates

### Part 1: New Preamble

#### Candidate A -- Inline replacement (no constant)
- **Summary:** Replace the 4-item preamble lines directly in the `lines` array inside `buildSystemPrompt()`.
- **Tensions resolved:** Existing tests still pass (required strings included). **Accepted:** Preamble not readable in isolation; harder to document with JSDoc.
- **Boundary:** Inside `buildSystemPrompt()`, same as today.
- **Failure mode:** If session state tag position shifts, tests break. Manageable.
- **Repo pattern:** Departs -- existing code has no named constant but the soul-template.ts extraction is a precedent.
- **Gains:** No indirection. **Losses:** Not visible as a document; can't be verified without calling buildSystemPrompt.
- **Scope:** Too narrow.

#### Candidate B -- Named `BASE_SYSTEM_PROMPT` constant (recommended)
- **Summary:** Extract the static preamble into `export const BASE_SYSTEM_PROMPT: string` defined above `buildSystemPrompt()`. The function uses it as the first element of the lines array. JSDoc explains why it's a constant vs inline.
- **Tensions resolved:** Preamble visible as a document; existing test assertions pass; honors 'Document why not what'.
- **Accepted:** Slight indirection; tool name drift risk (prose mentions `report_issue`).
- **Boundary:** Module-scoped constant, not exported (callers use `buildSystemPrompt`). Dynamic content (session state, soul, workspace) remains in the function.
- **Failure mode:** If a future author edits `BASE_SYSTEM_PROMPT` and removes `'## Your tools'` or `'## Execution contract'`, tests catch it immediately.
- **Repo pattern:** Follows soul-template.ts precedent (constant for stable content, function for dynamic assembly).
- **Gains:** Readable, documentable, testable in isolation. **Losses:** None significant.
- **Scope:** Best-fit.
- **Philosophy:** Honors 'Immutability by default' (const), 'Document why not what' (JSDoc), 'Determinism' (pure function unchanged).

---

### Part 2: report_issue Tool

#### Candidate A -- Inline tool factory with private async helper (recommended)
- **Summary:** `makeReportIssueTool(sessionId: string, emitter?: DaemonEventEmitter): AgentTool` -- custom inline JSON schema (no schemas param), `execute()` fires a void Promise for the JSONL write (same pattern as DaemonEventEmitter), emits `issue_reported` event, returns string confirmation. A module-level private `appendIssueAsync()` function handles the actual fs writes to keep execute() clean.
- **Tensions resolved:** Fire-and-forget (never blocks), type-safe kind/severity, YAGNI (no IssueStore class), natural tool-factory shape.
- **Accepted:** Less isolated unit-testability for the JSONL write path (no dirOverride). Extractable later.
- **Boundary:** Tool factory in `workflow-runner.ts` alongside make*Tool siblings. Private helper in same file.
- **Failure mode:** JSONL write fails silently. Accepted -- same contract as DaemonEventEmitter.
- **Repo pattern:** Follows tool factory pattern exactly (name, description, inputSchema, label, execute).
- **Gains:** Simple, correct, consistent with existing code. **Losses:** JSONL write not unit-testable in isolation today.
- **Scope:** Best-fit.
- **Philosophy:** Honors 'YAGNI with discipline', 'Exhaustiveness everywhere' (literal unions), 'Make illegal states unrepresentable', 'Observability as a constraint'.

#### Candidate B -- Dedicated `IssueStore` class (parallel to DaemonEventEmitter)
- **Summary:** Extract a class `IssueStore` with `append(sessionId, issue)` and `dirOverride` for tests. Injected into `makeReportIssueTool`. Separate file or same file.
- **Tensions resolved:** Full unit-testability with dirOverride, separation of concerns.
- **Accepted:** Over-engineering for current scope (coordinator doesn't exist). YAGNI violated.
- **Boundary:** New abstraction layer. Only one caller today.
- **Failure mode:** Premature abstraction; adds complexity with no current benefit.
- **Repo pattern:** Matches DaemonEventEmitter exactly -- but DaemonEventEmitter was built when multiple callers needed it immediately.
- **Gains:** Testable in isolation, clean interface for future coordinator. **Losses:** Speculative complexity today.
- **Scope:** Too broad (no coordinator in this PR).
- **Philosophy:** Conflicts with 'YAGNI with discipline'. Honors 'Prefer fakes over mocks'.

---

## Comparison and Recommendation

### Part 1
Candidate B (BASE_SYSTEM_PROMPT constant) dominates on every axis. Not a close call.

### Part 2
Candidate A (inline tool factory) wins on YAGNI. The only real loss is JSONL write isolation in tests -- acceptable since the write is purely observational (fire-and-forget), not correctness-affecting.

**If the auto-fix coordinator were being built in this PR**, Candidate B would be justified. It isn't.

---

## Self-Critique

### Part 1 strongest counter-argument
'The constant is 55 lines and clutters the file.' Counter: it's in a clearly labeled `## System prompt` section. A 55-line constant is readable. The alternative (55 lines of array items with string literals) is worse. Not a real objection.

### Part 2 strongest counter-argument
'DaemonEventEmitter is a class -- to be consistent, IssueStore should also be a class.' True in the abstract. But DaemonEventEmitter was built when the event stream was a first-class concern. Issue recording is secondary observability for a future feature. The consistency argument applies when there are multiple callers, not one.

### Pivot conditions
- **Part 2:** If the coordinator PR is planned for this sprint, extract IssueStore now to save rework later.
- **Part 1:** If the BASE_SYSTEM_PROMPT constant is exported and used in tests directly, add it to the test file's import.

---

## Open Questions for the Main Agent

1. Should `BASE_SYSTEM_PROMPT` be exported (for tests to import directly) or left module-private? Current test assertions only check the output of `buildSystemPrompt()`, so private is sufficient.
2. Should `IssueReportedEvent` include `continueToken` (for coordinator to resume)? The spec says optional -- include it as `readonly continueToken?: string`.
3. The new preamble's `## Your tools` section should list `report_issue` -- does it also list `Bash`, `Read`, `Write`, `continue_workflow`? Yes, for completeness.
