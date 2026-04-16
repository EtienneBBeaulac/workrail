# Design Review Findings: Merge PRs #397, #403, #392

**Date:** 2026-04-15
**Status:** Ready for main-agent

---

## Tradeoff Review

| Tradeoff | Status | Condition for Failure |
|---|---|---|
| Reactive conflict handling for #403/#392 | Acceptable | Detected via re-check of `--json mergeable` before each merge |
| Manual conflict resolution in workflow-runner.ts | Acceptable | Verified by grepping for key identifiers post-rebase |
| force-with-lease push on rebased branch | Acceptable | Fails safely if someone else pushed to the branch |

All tradeoffs pass review.

---

## Failure Mode Review

| Failure Mode | Design Coverage | Risk |
|---|---|---|
| Rebase silently drops timeout logic | Grep for `sessionTimeoutMs` or `maxTurns` post-rebase | Medium |
| Rebase silently drops concurrencyMode changes | Grep for `concurrencyMode` post-rebase | Medium |
| #403/#392 conflict after #397 merges | Re-check `--json mergeable` before each merge | Low |
| force-with-lease rejected (remote branch updated) | Stop and investigate; do not force | Low |

---

## Runner-Up / Simpler Alternative Review

No runner-up. The rebase + squash merge approach is the only viable path. Attempting to merge CONFLICTING #397 without rebasing would fail at GitHub's merge gate.

---

## Philosophy Alignment

| Principle | Status | Notes |
|---|---|---|
| NEVER push directly to main | Satisfied | Using `gh pr merge --squash` |
| Double-check before destructive actions | Satisfied | Checking mergeability before each step |
| Surface information, don't hide it | Satisfied | Reporting merge results and any skips |
| Errors are data | Satisfied | Stopping and reporting on any failure |

---

## Findings

### YELLOW: Post-rebase verification required

After rebasing `fix/gap-8-session-timeout`, the file `src/daemon/workflow-runner.ts` must be manually verified to contain both sides of the resolved conflict. Git's auto-merge may silently drop one side.

**Mitigation:** Grep for `sessionTimeoutMs` (GAP-8 side) and `concurrencyMode` (main side) after rebase completes.

---

### YELLOW: Mergeability re-verification required between PRs

After #397 merges, #403 and #392 both touch `workflow-runner.ts` and their MERGEABLE status is stale. Re-check before each merge.

---

## Recommended Revisions

None -- the design is correct as specified.

---

## Residual Concerns

- If #403 or #392 develop conflicts after #397 merges, the same rebase procedure applies. This is unlikely since the PRs touch different sections of `workflow-runner.ts` (GAP-8 adds timeout constants; GAP-2 adds session recap injection; #403 adds soul template support).
