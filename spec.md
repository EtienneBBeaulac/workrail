# Spec: worktrain run pr-review

*Canonical observable behavior specification. Do not edit to reflect implementation details.*

---

## Feature Summary

`worktrain run pr-review` is a CLI subcommand that autonomously reviews open GitHub PRs in a workspace using WorkRail workflow sessions, routes each PR to merge/fix/escalate based on review findings, and produces a terminal summary and markdown report.

---

## Acceptance Criteria

### AC1: CLI entry point
`worktrain run pr-review --help` exits 0 and prints usage including `--workspace`, `--pr`, `--dry-run`, `--port` flags.

**Verified by:** Running the CLI and checking exit code + output.

### AC2: Workspace validation
`worktrain run pr-review --workspace /nonexistent` exits 1 and prints an error to stderr containing 'does not exist' or 'must be an absolute path'.

**Verified by:** Running with bad workspace.

### AC3: Daemon not running
`worktrain run pr-review --workspace /valid/path` when no daemon is running on port 3456 exits 1 and prints to stderr: message containing 'daemon' or 'connect'.

**Verified by:** Running without daemon.

### AC4: No open PRs
When `gh pr list` returns zero PRs, coordinator exits 0 and prints `RESULT: 0 PRs reviewed, 0 approved, 0 escalated`.

**Verified by:** Unit test with fake `listOpenPRs` returning `[]`.

### AC5: Clean PR routing
When a review session returns findings with no blocking/critical issues, the PR is queued for merge. In non-dry-run mode, `gh pr merge --squash` is called for that PR.

**Verified by:** Unit test with fake `CoordinatorDeps` returning clean findings.

### AC6: Minor PR routing with fix loop
When a review returns minor-only findings, a fix agent (`coding-task-workflow-agentic`) is spawned, then the PR is re-reviewed. If the re-review is clean, the PR is merged.

**Verified by:** Unit test with fake deps: first review=minor, fix spawned, second review=clean, merge called.

### AC7: Fix loop terminates at 3 passes
When a PR has persistent minor findings after 3 fix-agent passes, the coordinator escalates (does NOT merge) and reports '3 passes exhausted'.

**Verified by:** Unit test with fake deps always returning minor.

### AC8: Blocking PR routing
When a review returns blocking or critical findings, the coordinator escalates without merging. Exit code is 1 if any PR was escalated due to error (not just blocking findings).

**Verified by:** Unit test with fake deps returning blocking findings.

### AC9: Unknown severity is safe
When `recapMarkdown` is null or unparseable, severity is 'unknown' and the PR is escalated (not merged).

**Verified by:** Unit test with `getAgentResult` returning null.

### AC10: Dry-run makes no mutations
`worktrain run pr-review --dry-run` makes no HTTP dispatch calls, no `gh pr merge` calls, and no `gh pr merge` calls. It prints what would happen.

**Verified by:** Unit test with dry-run flag; assert no spawnSession/mergePR calls.

### AC11: Traceability JSON written
Before acting on each session result, the coordinator writes a JSON block `{ childSessionId, outcome, elapsedMs, severity }` to the report.

**Verified by:** Check report file content after run.

### AC12: Report file created
A file `./coordinator-pr-review-YYYY-MM-DD.md` is written in the workspace directory after the run.

**Verified by:** File exists after successful run.

### AC13: Negation context not classified as blocking
A review containing 'this is not technically blocking' does NOT result in blocking classification.

**Verified by:** Unit test of `parseFindingsFromNotes` with negated blocking text.

### AC14: TypeScript compiles clean
`tsc --noEmit` passes with no new errors after implementation.

**Verified by:** Running tsc.

### AC15: Existing unit tests pass
`npx vitest run tests/unit/` passes with no regressions.

**Verified by:** Running vitest.

---

## Non-Goals

- Coordinator does not post GitHub comments or approve/reject PRs via `gh pr review`
- Coordinator does not modify any WorkRail workflow files
- Coordinator does not run if the daemon is not running
- Coordinator does not support repos other than the workspace's git remote

---

## External Interface Contract

```
worktrain run pr-review
  --workspace <path>   Required. Absolute path to git workspace.
  --pr <number>        Optional, repeatable. Review specific PR(s) only.
  --dry-run            Optional. Print actions without executing them.
  --port <n>           Optional. Override daemon console port (default: auto-discover).
```

**Exit codes:**
- 0: All reviewed PRs either merged or clean escalation (no errors)
- 1: Any PR escalated due to error, timeout, zombie session, or daemon unavailable

**Stdout:** Terminal summary in the format:
```
[1/3] Gathering open PRs...  done (0:02)
[2/3] Running reviews (N parallel)...
      PR #N worktrain spawn/await    done (M:SS)  CLEAN|MINOR|BLOCKING
[3/3] Processing results...
      PR #N  ->  queued for merge | spawning fix agent... | escalated

RESULT: N PRs reviewed, N approved, N escalated
Merged: PR #N, PR #M
Full report: ./coordinator-pr-review-YYYY-MM-DD.md
```

**Stderr:** Progress, warnings, errors. JSON traceability blocks per session.

---

## Edge Cases and Failure Modes

| Case | Expected behavior |
|------|-------------------|
| null recapMarkdown | severity=unknown, escalate |
| Session outcome='failed' | severity=unknown, escalate |
| Session outcome='timeout' | severity=unknown, escalate, do NOT count as error unless no result |
| Fix agent session fails | Escalate the PR, count fix attempt in pass count |
| `gh pr merge` fails | Escalate, no retry, report error in output |
| Daemon returns 503 | Exit 1, stderr: 'daemon not ready' |
| ECONNREFUSED | Exit 1, stderr: 'could not connect to daemon' |
| Fetch timeout (30s) | Return err, treat as daemon unavailable |
| Coordinator elapsed > 70min | Refuse new spawns, finish existing awaits |
| --pr flag with non-existent PR | `gh pr list` will return empty; coordinator reports 0 PRs |
