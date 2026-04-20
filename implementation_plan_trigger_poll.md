# Implementation Plan: worktrain trigger poll command

## 1. Problem Statement

When the daemon's queue poller is configured with a long interval (e.g. 5 minutes), there is no way to trigger an immediate poll without restarting the daemon. Adding `worktrain trigger poll <triggerId>` fires one poll cycle immediately without waiting for the interval, enabling faster iteration and manual testing.

## 2. Acceptance Criteria

- [ ] `worktrain trigger poll self-improvement` prints `[Poll] Forcing immediate poll cycle for trigger: self-improvement`
- [ ] The command POSTs to `http://127.0.0.1:<port>/api/v2/triggers/<triggerId>/poll`
- [ ] On success, prints the daemon's response (cycleRan, message) and exits 0
- [ ] If daemon is unreachable (ECONNREFUSED), prints clear error and exits 1
- [ ] `POST /api/v2/triggers/:triggerId/poll` returns 400 if trigger is not found
- [ ] `POST /api/v2/triggers/:triggerId/poll` returns 400 if trigger is not a `github_queue_poll` trigger with message "Trigger 'X' is not a queue poll trigger"
- [ ] `POST /api/v2/triggers/:triggerId/poll` returns 200 `{ success: true, data: { cycleRan: boolean, triggerId: string } }` on success
- [ ] `cycleRan: true` when a new poll cycle was actually started
- [ ] `cycleRan: false` when skip-cycle guard fired (previous poll still running)
- [ ] `--port` option overrides port discovery
- [ ] Port discovery reads `~/.workrail/daemon-console.lock`, defaults to 3200
- [ ] `npm run build` is clean
- [ ] `npx vitest run` no regressions

## 3. Non-Goals

- No changes to `src/mcp/` (explicitly excluded per task spec)
- No streaming of poll output (poll runs async in daemon, CLI just triggers it)
- No changes to the polling interval or interval behavior
- No `--json` output flag
- No support for non-queue poll trigger types beyond 400 response
- No new lock file for trigger listener port
- No changes to how scheduled polling works

## 4. Philosophy-Driven Constraints

- **DI for boundaries**: `WorktrainTriggerPollDeps` injectable interface, no direct fs/fetch imports in command
- **Errors are data**: `ForcePollResult` typed union, CliResult return, no throws
- **Validate at boundaries**: HTTP endpoint validates trigger type, forcePoll trusts valid trigger
- **Exhaustiveness**: Switch on ForcePollResult.kind must be exhaustive
- **Fakes over mocks**: Tests use fake PollingScheduler with captured state, not vi.mock()
- **Architectural fixes over patches**: Endpoint on daemon console (port 3456), not trigger-listener

## 5. Invariants

- `forcePoll` NEVER starts a new interval timer
- `forcePoll` runs at most one poll cycle synchronously (awaited)
- HTTP 400 for any non-`github_queue_poll` trigger
- HTTP 200 means the cycle was attempted (cycleRan indicates if it ran or was skipped by guard)
- Skip-cycle guard still applies: if poll is in flight, `cycleRan: false` is returned
- No changes to `src/mcp/` files

## 6. Selected Approach

**Candidate A: Endpoint on Daemon Console**

- `PollingScheduler.forcePoll(triggerId): Promise<ForcePollResult>` where `ForcePollResult = { kind: 'ok'; cycleRan: boolean } | { kind: 'not_found' } | { kind: 'wrong_provider'; provider: string }`
- forcePoll reads `this.polling.get(triggerId)` BEFORE calling `this.runPollCycle(trigger)` to determine if a new cycle was started
- Thread `pollingScheduler` through: `TriggerListenerHandle.scheduler` -> `StartDaemonConsoleOptions.pollingScheduler` -> `mountConsoleRoutes` 10th param
- `POST /api/v2/triggers/:triggerId/poll` in `console-routes.ts`
- New `src/cli/commands/worktrain-trigger-poll.ts` with injectable deps pattern
- New subcommand in `cli-worktrain.ts` under `triggerCommand` group

**Runner-up**: Endpoint on trigger-listener (simpler wiring, but breaks architectural separation)

## 7. Vertical Slices

### Slice 1: PollingScheduler.forcePoll()
**Files**: `src/trigger/polling-scheduler.ts`
**What**: Add `forcePoll(triggerId: string): Promise<ForcePollResult>` public method
**Done when**: Method exists, returns not_found for unknown triggers, wrong_provider for non-queue triggers, ok with cycleRan for queue triggers. Tests pass.

### Slice 2: Thread pollingScheduler through daemon console
**Files**: `src/trigger/trigger-listener.ts`, `src/trigger/daemon-console.ts`, `src/v2/usecases/console-routes.ts`
**What**: Add optional `scheduler` field to `TriggerListenerHandle`, `pollingScheduler` to `StartDaemonConsoleOptions`, and `pollingScheduler` param to `mountConsoleRoutes`. Add `POST /api/v2/triggers/:triggerId/poll` endpoint in console-routes.ts.
**Done when**: Endpoint exists, returns correct HTTP codes, build is clean.

### Slice 3: CLI command and wiring
**Files**: `src/cli/commands/worktrain-trigger-poll.ts` (NEW), `src/cli/commands/index.ts`, `src/cli-worktrain.ts`
**What**: Create injectable command, export it, wire it under `triggerCommand` group.
**Done when**: `worktrain trigger poll --help` shows the command. Build clean.

### Slice 4: Tests
**Files**: `tests/unit/polling-scheduler-force-poll.test.ts` (or add to existing), `tests/unit/worktrain-trigger-poll.test.ts`
**What**: Unit tests for forcePoll (ok/not_found/wrong_provider), CLI command (success, 400 errors, connection refused)
**Done when**: All tests green, `npx vitest run` passes.

## 8. Test Design

### polling-scheduler-force-poll tests (add to existing polling-scheduler.test.ts)
- `forcePoll('unknown')` returns `{ kind: 'not_found' }`
- `forcePoll('gitlab-trigger')` on non-queue trigger returns `{ kind: 'wrong_provider', provider: 'gitlab_poll' }`
- `forcePoll('queue-trigger')` when no poll in flight: runs one cycle, returns `{ kind: 'ok', cycleRan: true }`
- `forcePoll('queue-trigger')` when poll in flight: returns `{ kind: 'ok', cycleRan: false }` immediately

### worktrain-trigger-poll command tests
- Success: POST returns 200 cycleRan=true -> prints output, exits 0
- Success: POST returns 200 cycleRan=false -> prints skip message, exits 0
- Not found: POST returns 400 -> prints error, exits 1
- Wrong provider: POST returns 400 -> prints error, exits 1
- Connection refused: prints daemon not running error, exits 1

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Port confusion (3200 default vs 3456 actual) | Low | Medium | Lock file discovery returns 3456 in practice; clear error if connection fails |
| forcePoll hangs (GitHub network) | Low | Low | CLI has 30s timeout; daemon-side timeout is a known V1 limitation |
| Skip-cycle guard hides user intent | Low | Low | cycleRan field in response clearly communicates what happened |

## 10. PR Strategy

SinglePR: `feat/trigger-poll-command`

All 4 slices in one PR since they are tightly coupled (each slice enables the next).

Commit: `feat(cli): add worktrain trigger poll to force immediate queue poll`

## 11. Philosophy Alignment

| Principle | Slice 1 | Slice 2 | Slice 3 | Notes |
|---|---|---|---|---|
| DI for boundaries | satisfied | satisfied | satisfied | forcePoll injected via constructor; command uses deps |
| Errors are data | satisfied | satisfied | satisfied | ForcePollResult union; CliResult; HTTP result shape |
| Validate at boundaries | satisfied | satisfied | satisfied | HTTP validates trigger type |
| Exhaustiveness | satisfied | satisfied | satisfied | Switch on ForcePollResult.kind covers all 3 variants |
| Fakes over mocks | satisfied | n/a | satisfied | Tests use fake scheduler, not vi.mock() |
| Architectural fixes over patches | satisfied | satisfied | satisfied | Console, not trigger-listener |
| YAGNI | satisfied | satisfied | satisfied | Only what spec requires |
