# Design Review Findings: worktrain trigger test dry-run command

## Tradeoff Review

### T1: failure() for 'no dispatch' (exit 1)
- Print all dry-run output via `deps.print()` before returning CliResult. CliResult carries only the exit code signal.
- Acceptable: spec explicitly specifies exit 1 for no-dispatch.
- Hidden assumption: resolve by printing a summary message before returning.

### T2: Code duplication with doPollGitHubQueue
- SCOPE LOCK on 3 heuristics documented in github-queue-poller.ts. Drift risk is low.
- Acceptable: dry-run is advisory, any drift is a documentation bug.

### T3: countActiveSessions inlined
- 3 lines: readdir + count .json files. Matches the private function in polling-scheduler.ts exactly.
- Acceptable: file-based sessions contract is stable.

### T4: pollGitHubQueueIssues wiring
- execute function builds GitHubQueuePollingSource from trigger.pollingSource (safe after provider validation).
- Deps interface has `pollGitHubQueueIssues: (config: GitHubQueueConfig)` -- the pollingSource is constructed internally and passed to the real function, not injected.

## Failure Mode Review

All failure modes covered:
- triggers.yml absent: err from loadTriggerConfig, clear error output
- triggerId not found: undefined from index.get(), clear error
- Non-queue trigger: provider check with specified error message
- No queue config: null from loadQueueConfig, clear error (not silent)
- GitHub API error: err from pollGitHubQueueIssues, clear error
- Sessions dir absent: countActiveSessions returns 0 (ENOENT = 0 active)
- Accidental dispatch: architecturally prevented -- no dispatch dep in interface

Highest-risk: FM4 (no queue config). Must print explicit error, not just '0 dispatch' summary.

## Runner-Up / Simpler Alternative Review

Runner-up (extract pick function) contributes one element worth borrowing: local `IssueDecision` type for the classification pass. Adopted as a local type within the execute function -- no exported helpers.

Simpler alternative (no deps interface) breaks testability. Not viable.

## Philosophy Alignment

Satisfied: immutability, errors as data, validate at boundaries, prefer fakes over mocks, determinism, document why.

Under tension (acceptable): compose with small functions (single 120-line function matches repo pattern).

## Findings

### Yellow (Minor)
- **Y1**: The `failure()` call for 'no dispatch' will produce a message via printResult(). The message field should be set to an empty string or skipped to avoid a confusing 'Error:' prefix in output. All output should go through `deps.print()` before the CliResult is returned.
- **Y2**: The spec shows `upstreamSpecUrl: (none)` in the output. This requires the execute function to run the same `extractUpstreamSpecUrl()` logic as the scheduler. This function is private in polling-scheduler.ts -- either inline it or import it. Best: inline a 2-line version.

No Red or Orange findings.

## Recommended Revisions

1. Before returning `failure()` for no-dispatch, print the summary via `deps.print()`. Return `failure('')` so printResult doesn't double-print.
2. Inline `extractUpstreamSpecUrl(body)` (2 lines) in the command file to produce the `upstreamSpecUrl` line in output.
3. Use `{ kind: 'success' }` (not failure) for the success path -- the spec says exit 0, which is the success CliResult.

## Residual Concerns

None material. The design is sound and matches established repo patterns.
