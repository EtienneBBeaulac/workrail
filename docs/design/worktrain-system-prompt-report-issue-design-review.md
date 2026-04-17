# WorkTrain: System Prompt Preamble + report_issue Tool -- Design Review Findings

## Tradeoff Review

| Tradeoff | Assessment |
|---|---|
| Tool name drift: preamble prose mentions `report_issue` | Acceptable. Prose is guidance, not tool registration. Agent uses the tools array. |
| JSONL write not unit-testable in isolation | **Resolved** by adding `issuesDirOverride?: string` to `makeReportIssueTool`. |
| No IssueStore class (YAGNI) | Acceptable. Coordinator doesn't exist in this PR. Extractable later. |
| Fatal severity doesn't abort the loop | Accepted limitation. Tool returns instructional text. Agent is told to stop. Recording the issue is the priority. |

---

## Failure Mode Review

| Failure Mode | Handling | Risk |
|---|---|---|
| Missing issues dir | `mkdir recursive` before appendFile (DaemonEventEmitter pattern) | Low |
| Preamble loses required test strings | Caught immediately by existing vitest assertions | Low (self-healing) |
| Agent ignores fatal severity and continues | Instructional return value. Can't force stop from inside tool without violating 'errors are data'. | Medium (accepted) |
| sessionId is process-local UUID not server ID | Consistent with all other tools in this file. Coordinator correlates via sessionId. | Low |

---

## Runner-Up / Simpler Alternative Review

**Part 1:** Inline preamble (runner-up) offers no advantages over the named constant. Candidate B dominates.

**Part 2:** IssueStore class (runner-up) offers `dirOverride` for isolated testing. A hybrid was adopted: add `issuesDirOverride?: string` parameter to `makeReportIssueTool` without extracting a full class. This resolves the testability weakness at negligible complexity cost.

**Simpler alternative (no dirOverride):** Technically satisfies acceptance criteria. Rejected because it violates 'prefer fakes over mocks' and departs from the established DaemonEventEmitter precedent for no benefit.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Immutability by default | Satisfied: `const BASE_SYSTEM_PROMPT`; readonly IssueReportedEvent fields |
| Make illegal states unrepresentable | Satisfied: `kind` and `severity` are literal union types |
| Exhaustiveness everywhere | Satisfied: new DaemonEvent variant triggers TS compile error on unhandled switch |
| Errors are data | Satisfied: report_issue returns string confirmation, never throws |
| YAGNI with discipline | Satisfied: no IssueStore class |
| Observability as a constraint | Satisfied: fire-and-forget, never blocks correctness |
| Prefer fakes over mocks | Satisfied (after hybrid): issuesDirOverride allows temp-dir testing |
| Document why not what | Satisfied: JSDoc on BASE_SYSTEM_PROMPT constant; WHY comments on void+catch |

---

## Findings

### Yellow (low-risk, note for implementer)

**Y1:** `BASE_SYSTEM_PROMPT` must include `'You are WorkRail Auto'`, `'## Your tools'`, and `'## Execution contract'` to preserve existing test assertions. The implementer must verify these strings survive the rewrite verbatim.

**Y2:** The new preamble's `## Your tools` section should list all 5 tools: `continue_workflow`, `Bash`, `Read`, `Write`, `report_issue`. If any tool is added/removed in the future, the preamble prose becomes stale. Accepted documentation-drift risk.

**Y3:** The `issuesDirOverride` parameter changes the signature of `makeReportIssueTool`. Wire it through `runWorkflow()` with `undefined` (production path). A test for the file write path should be added to `tests/unit/`.

---

## Recommended Revisions

1. **Add `issuesDirOverride?: string` to `makeReportIssueTool`** -- adopt the hybrid over inline-only. (Already decided above.)
2. **Use `void appendIssueAsync(...).catch(() => {})` idiom** -- identical to DaemonEventEmitter._append; don't await.
3. **IssueReportedEvent fields:** Use `readonly` on all fields; `issueKind` not `kind` for the payload (since `kind` is the discriminant `'issue_reported'`). Wait -- looking at the spec: the tool's input schema field is `kind` (the issue type), but the event discriminant is also `kind: 'issue_reported'`. Rename the payload field to `issueKind` in `IssueReportedEvent` to avoid shadowing, while keeping the JSON input schema field as `kind` (per spec).

---

## Residual Concerns

- **Fatal severity + agent continuation:** The design cannot enforce stopping. This is a known limitation of the instruction-based approach. The coordinator will need to detect "fatal issue recorded, then agent continued for N more steps" and flag it. Out of scope for this PR.
- **Issue file format:** The spec says 'JSON line' but doesn't specify the schema. The implementer should include all input fields plus `ts: Date.now()` and `sessionId` for correlation -- consistent with how daemon events are written.
