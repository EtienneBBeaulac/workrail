# Design Candidates: worktrain trigger test dry-run command

## Problem Understanding

### Core Tensions
1. **Exit code semantics vs CliResult semantics**: The spec requires exit 1 when no issues would dispatch. But `CliResult.failure` is semantically an 'error'. Using it for 'no dispatch' is a semantic mismatch -- acceptable because the spec explicitly says this is useful for scripting.
2. **Real API calls in a 'dry-run' command**: The command makes real GitHub API calls and reads real session files. The dry-run label refers to 'no dispatch', not 'no I/O'. Invariant: the command never writes anything (no sessions, no labels, no logs).
3. **Code duplication vs. coupling**: The queue picker logic already exists in `polling-scheduler.ts::doPollGitHubQueue`. Duplicating it in the test command is the right choice because the scheduler's implementation is tightly coupled to PollingScheduler internals (router, store, intervals). Extracting a shared utility would increase coupling.
4. **countActiveSessions encapsulation**: Private function in polling-scheduler.ts. Inline equivalent (3 lines: count .json files in sessions dir) rather than expose as a module export.

### Likely Seam
`WorktrainTriggerTestDeps` interface is the real seam. Everything injectable, nothing hardcoded.

### What Makes It Hard
- The queue picker skip logic has several conditions (excludeLabels, in-progress label, sess_ pattern, idempotency, maturity) -- all must be mirrored accurately.
- Exit code convention (failure = no dispatch) is counter-intuitive but explicitly specified.
- `loadQueueConfig` uses the 'label' type; the spec needs the config to be shaped as `GitHubQueueConfig` with the trigger's `source.repo` and `source.token` merged in. The real `pollGitHubQueueIssues` takes a `GitHubQueuePollingSource` + `GitHubQueueConfig` separately -- these come from different config sources.

## Philosophy Constraints
- Immutability by default -- all deps interfaces readonly
- Errors are data -- CliResult return, never throw
- Validate at boundaries -- all input validation at start of execute function
- Prefer fakes over mocks -- injectable deps enable tests without real I/O
- YAGNI -- implement exactly what's specified
- Compose with small pure functions -- slight tension: the execute function is moderately long (~100 lines) but this matches existing repo patterns (spawn command)

## Impact Surface
- `src/cli/commands/index.ts` -- new export added
- `src/cli-worktrain.ts` -- new `trigger` command group added (no mutations to existing commands)
- `tests/unit/worktrain-trigger-test.test.ts` -- new test file

## Candidates

### Candidate A: Minimal inline approach
Single `executeWorktrainTriggerTestCommand` function, all logic inline, no extracted helpers. Mirrors the `executeWorktrainSpawnCommand` pattern.

- **Summary**: One function, loop over issues, print results, return CliResult.
- **Tensions resolved**: YAGNI, simplicity, minimal surface area
- **Tensions accepted**: logic duplication with doPollGitHubQueue is explicit
- **Boundary**: everything in one function
- **Failure mode**: function is ~120 lines but matches existing repo pattern (spawn is ~120 lines)
- **Repo pattern**: follows exactly
- **Gains**: easy to read, no abstraction overhead
- **Give up**: if skip logic changes, manual update required
- **Scope**: best-fit
- **Philosophy**: honors YAGNI, immutability, errors as data

### Candidate B: Extract pick logic as separate exported function
A `runQueuePick(issues, config, deps)` function returns `Array<{issue, decision, reason}>`. `executeWorktrainTriggerTestCommand` calls it and prints.

- **Summary**: Separate pick function + print function orchestrated by execute.
- **Tensions resolved**: testability of pick logic independently
- **Tensions accepted**: extra type + function, slight over-engineering
- **Boundary**: pick logic separated from I/O via intermediate result type
- **Failure mode**: intermediate type that never gets reused elsewhere
- **Repo pattern**: departs slightly (existing commands don't extract intermediate types)
- **Gains**: pick logic independently testable
- **Give up**: YAGNI violation -- spec test cases test execute function behavior, not pick logic
- **Scope**: slightly broad
- **Philosophy**: honors 'compose with small pure functions' more strongly; mild conflict with YAGNI

## Comparison and Recommendation

**Recommendation: Candidate A** -- single `executeWorktrainTriggerTestCommand` function following the exact deps interface specified.

Rationale:
- All 5 spec test cases test execute function behavior (print output, exit code), not internal structure
- `executeWorktrainSpawnCommand` is ~120 lines with no extracted helpers and is perfectly readable
- The skip conditions are well-named intermediate variables, making the logic clear
- Philosophy: YAGNI wins over 'compose with small functions' here because no evidence of reuse

## Self-Critique
- **Strongest counter-argument**: The pick loop has ~5 conditions. A future extension (e.g., add a new skip reason) means touching the same inline block twice (execute function + test). With Candidate B's extract, only the pick function changes.
- **Pivot condition**: If a second command needed queue pick logic (e.g., `worktrain trigger preview`), Candidate B would be immediately justified.
- **Narrower option**: Could avoid the `trigger` command group entirely and name the command `worktrain trigger-test`. Lost because the spec explicitly shows the `trigger` subcommand group.
- **Assumption that would invalidate**: If the spec's test cases actually verify intermediate state (they don't -- all tests check print output and exit codes).

## Open Questions for Main Agent
1. The spec's `loadTriggerConfig` dep returns `Result<TriggerIndex, string>` but `TriggerIndex` is not a named export -- it's `Map<string, TriggerDefinition>`. Use the concrete type directly.
2. The `pollGitHubQueueIssues` function requires a `GitHubQueuePollingSource` (from trigger) AND a `GitHubQueueConfig` (from config.json). The dry-run must wire these from the correct sources. The trigger's `pollingSource` provides repo+token; `loadQueueConfig()` provides the queue filter type.
3. The maturity description strings in the output ('has acceptance criteria') should match the actual `describeMaturityReason()` logic from polling-scheduler.ts.
