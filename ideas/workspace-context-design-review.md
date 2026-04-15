# Design Review Findings: Workspace Context UX

## Tradeoff Review

| Tradeoff | Acceptable? | Condition where it fails |
|---|---|---|
| git description adoption is low | Yes -- conditional render means zero visual regression | If empty subtitle creates visual noise (mitigated: conditional render) |
| goal is optional | Yes -- status quo for sessions without it | Near-zero adoption after Phase 2 -- escalation: make required |
| Phase 2 (workflow prompts) deferred | Yes -- platform fix ships independently | Phase 2 never ships -- mitigated by same-cycle commitment |

## Failure Mode Review

| Failure Mode | Coverage | Risk |
|---|---|---|
| Agents skip goal | Partial (tool description + Phase 2 prompts) | Medium -- status quo, not regression |
| Git descriptions never set | Full (conditional render) | Low -- invisible absence |
| New workflows skip goal prompt | Partial (no automated enforcement) | Low-Medium -- workflow authoring guide |

**Highest risk**: Agents skip goal. Mitigation: strong tool description + Phase 2 workflow prompts + CLAUDE.md update.

## Runner-Up / Simpler Alternative

Candidate A (goal only) is a strict subset of B. No elements to borrow.
A simpler B (defer git description) is Candidate A. Already considered and rejected (25-line cost is acceptable).
No hybrid opportunity.

## Philosophy Alignment

All principles satisfied or under acceptable tension only.
YAGNI slight tension on git description -- justified by near-zero cost when unused.
No blocking violations.

## Findings

**Yellow: goal adoption not enforced at schema level**
Optional field with no schema constraint. Agents may skip it. Mitigation exists (tool description, CLAUDE.md, Phase 2 prompts) but is norm-level, not schema-level.
Severity: Yellow (acceptable -- breaking change would be required to enforce).

**Yellow: Phase 2 workflow prompts need to ship in same cycle**
If Phase 2 drifts, adoption depends entirely on agents reading the tool description.
Severity: Yellow (acceptable -- commit to Phase 2 in same release).

## Recommended Revisions

1. Tool description for `goal` should be as strong as `workspacePath` description --
   explain it populates the card headline immediately and recommend it strongly.
2. Add `goal` recommendation to CLAUDE.md / system prompt so agents always have it
   in context.
3. Phase 2 workflow prompt updates: add `goal` to coding-task Phase 0, mr-review
   Phase 0b, and wr.discovery Phase 0 in the same PR or the next one.
4. Add `goal` to the workflow authoring checklist (workflow-for-workflows intake).

## Residual Concerns

- Git branch description is not a widely-known git feature. Consider adding a
  brief mention in the console tooltip or the WorkRail docs.
- Long-term: if adoption of `goal` stays near-zero after 3 months, escalate to
  required with a migration guide.
