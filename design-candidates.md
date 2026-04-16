# Design Candidates: Merge PRs #397, #403, #392

**Date:** 2026-04-15
**Status:** Ready for main-agent review

---

## Problem Understanding

### Core Tensions

1. **Order dependency**: Merging #397 changes main, which affects whether #403 and #392 remain cleanly mergeable. Must merge sequentially and re-verify mergeability before each step.

2. **Conflict resolution in workflow-runner.ts**: PR #397 is CONFLICTING because main advanced (concurrencyMode support, hono bump) after the branch was cut. The conflict must keep both sides -- dropping either the GAP-8 timeout logic or main's concurrencyMode changes would be wrong.

3. **Stale mergeability**: GitHub reports #403 and #392 as MERGEABLE against current main. After #397 lands, this assessment is stale -- both also touch `workflow-runner.ts`, so conflicts could emerge.

### What Makes This Hard

- `workflow-runner.ts` is a 1097-line central orchestration file. A wrong conflict resolution could silently break daemon behavior.
- `git rebase -Xours` or `-Xtheirs` would silently drop one side's changes -- must resolve manually or verify auto-resolution keeps both.
- After each merge, must re-verify the next PR is still cleanly mergeable before proceeding.

### Likely Seam

The rebase conflict in `src/daemon/workflow-runner.ts` for #397 is the only real technical challenge. Everything else is sequential execution.

---

## Philosophy Constraints

- **Double-check before destructive actions**: Verify `--json mergeable` before and after each merge.
- **Surface information, don't hide it**: Report what merged and what (if anything) was skipped.
- **Errors are data**: If a merge fails or a rebase has unresolvable conflicts, stop and report rather than proceeding blindly.
- **NEVER push directly to main**: Merging via `gh pr merge --squash` is the correct path. Force-with-lease push is only to the PR branch.

---

## Impact Surface

- `src/daemon/workflow-runner.ts` -- touched by all three PRs
- `src/trigger/trigger-router.ts`, `trigger-store.ts`, `trigger/types.ts` -- #397 only
- `src/v2/usecases/console-routes.ts` -- #397 only
- `src/cli-worktrain.ts`, `cli.ts`, `cli/commands/`, `config/config-file.ts`, `daemon/soul-template.ts` -- #403 only

---

## Candidates

### Candidate 1 (only viable approach): Rebase + squash merge in order

**Summary:** Checkout `fix/gap-8-session-timeout`, rebase onto `origin/main`, resolve conflicts by keeping both sides, push with `--force-with-lease`, then squash-merge all three PRs in order (#397, #403, #392), pulling main and re-verifying mergeability between each.

**Tensions resolved:**
- Order dependency: sequential execution with re-verification
- Conflict resolution: manual inspection ensures both sides kept
- Stale mergeability: re-check after each merge before proceeding

**Tensions accepted:** Minor risk that #403/#392 develop new conflicts after #397 lands; handled by re-checking mergeability.

**Boundary solved at:** The rebase conflict in `workflow-runner.ts` -- the only real seam.

**Why that boundary is the best fit:** There is no alternative seam for this task.

**Failure mode:** Conflict resolution drops one side's changes. Mitigation: grep for `sessionTimeoutMs` and `concurrencyMode` after rebase.

**Repo-pattern relationship:** Follows exactly. All merges in this repo are squash merges (evidenced by PR number parentheticals throughout git log).

**Gains:** Clean linear history, atomic per-PR changes, minimal risk.

**Losses:** Nothing -- no alternatives exist.

**Scope judgment:** Best-fit.

**Philosophy fit:** Honors all relevant principles. No conflicts.

---

## Comparison and Recommendation

Only one candidate. Proceeding with rebase + squash merge in order.

---

## Self-Critique

**Strongest counter-argument:** None. The approach is dictated by the task.

**Assumption that would invalidate this:** If #403 or #392 develop unresolvable conflicts after #397 lands, they would also need rebasing. This is detected by re-checking `--json mergeable` before each merge.

**Pivot conditions:** If #403 or #392 show CONFLICTING after #397 merges, apply the same rebase procedure.

---

## Open Questions for the Main Agent

None. The task is fully specified and the approach is unambiguous.
