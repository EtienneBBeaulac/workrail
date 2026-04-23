# Design Candidates: `worktrain trigger poll` Command

## Problem Understanding

### Core Tensions
1. **Scope vs thread-through**: The `PollingScheduler` lives in `trigger-listener.ts` but the control-plane API lives in `console-routes.ts` (daemon console, port 3456). Connecting them requires threading `pollingScheduler` through 3 layers.
2. **Private method access**: `runPollCycle` and `doPollGitHubQueue` are private. `forcePoll` (new public method on `PollingScheduler`) calls `runPollCycle` from inside the class - no visibility change needed.
3. **Port ambiguity**: Spec says "defaults to 3200" but `/api/v2/` lives on port 3456. Resolution: endpoint on console (3456), lock file discovery returns 3456, CLI uses 3200 as final fallback.

### Likely Seam
`PollingScheduler.forcePoll()` is the core seam. Everything else is wiring. The `doPollGitHubQueue` logic already exists.

### What Makes It Hard
- `forcePoll` must validate trigger type before calling the poll (400 for non-queue triggers).
- Deciding whether `forcePoll` returns a typed Result or throws. Best: return a typed Result so the HTTP handler can map it to 400 vs 200.
- The skip-cycle guard in `runPollCycle`: if a poll is already running, `forcePoll` returns immediately (not an error, just a no-op for now). Acceptable behavior.

## Philosophy Constraints

From `CLAUDE.md`:
- **Dependency injection for boundaries**: inject external effects
- **Errors are data**: represent failure as values (Result/Either)
- **Validate at boundaries, trust inside**: HTTP handler validates trigger type, forcePoll trusts it
- **Prefer fakes over mocks**: tests use fake objects, captured state arrays
- **Architectural fixes over patches**: don't add management APIs to the event-input layer

## Impact Surface

Files that must stay consistent if we thread `pollingScheduler`:
- `TriggerListenerHandle` interface (trigger-listener.ts) - adding optional `scheduler` field
- `StartDaemonConsoleOptions` (daemon-console.ts) - adding optional `pollingScheduler` field
- `mountConsoleRoutes` signature (console-routes.ts) - adding optional `pollingScheduler` param
- All callers of `mountConsoleRoutes` (only `daemon-console.ts` in production; test files use it differently)

## Candidates

### Candidate A: Endpoint on Daemon Console (Recommended)

**Summary**: Add `POST /api/v2/triggers/:triggerId/poll` to `console-routes.ts` (port 3456), thread `pollingScheduler` through `TriggerListenerHandle` -> `StartDaemonConsoleOptions` -> `mountConsoleRoutes`.

- **Tensions resolved**: Architectural consistency (all /api/v2/ on console), clean separation of concerns
- **Tensions accepted**: 3-layer signature extension
- **Boundary**: `console-routes.ts` - same as all other management APIs (/api/v2/triggers GET, /api/v2/auto/dispatch POST, /api/v2/sessions/:id/steer POST)
- **Why best fit**: Follows exact same pattern as `triggerRouter` and `steerRegistry` threading. Both were added to `TriggerListenerHandle`, `StartDaemonConsoleOptions`, and `mountConsoleRoutes` in that order.
- **Failure mode**: Daemon console not running (but `worktrain daemon` always starts both, see cli-worktrain.ts lines 367-446)
- **Repo pattern**: Follows - identical to how triggerRouter was added
- **Gain**: Consistent architecture, single port for all management
- **Give up**: 3 extra function params
- **Scope**: Best-fit
- **Philosophy**: Honors 'validate at boundaries', 'DI for boundaries', 'architectural fixes over patches'

### Candidate B: Endpoint on Trigger Listener (Simpler, Narrower)

**Summary**: Add `POST /triggers/:triggerId/poll` directly to `createTriggerApp()` in `trigger-listener.ts`, access scheduler via closure in `startTriggerListener`.

- **Tensions resolved**: Zero thread-through, minimal files changed
- **Tensions accepted**: Breaks /api/v2/ namespace consistency, mixes concerns
- **Boundary**: `trigger-listener.ts` createTriggerApp()
- **Why NOT best fit**: createTriggerApp currently only handles event input (webhooks). Adding management here violates separation of concerns and requires callers to know 2 ports.
- **Failure mode**: Long-term: two ports for management operations
- **Repo pattern**: Departs from established pattern
- **Gain**: 2 fewer files changed
- **Give up**: Architectural consistency, clean separation of event-input vs control-plane
- **Scope**: Too narrow
- **Philosophy**: Conflicts with 'architectural fixes over patches'

## Comparison and Recommendation

**Recommendation: Candidate A**

The thread-through pattern for `triggerRouter` and `steerRegistry` is proven and the seam is identical. Adding `pollingScheduler` to the same chain is consistent with the codebase's architectural decisions. Candidate B is simpler but sets a bad precedent by mixing event-input (webhook routing) with control-plane management.

Port concern: The spec's "defaults to 3200" is likely referring to a fallback value. Since `worktrain daemon` always starts both listener (3200) and console (3456), and the console writes `daemon-console.lock`, port discovery will naturally return 3456 in practice. The 3200 default only matters as a "last resort" fallback.

## Self-Critique

**Strongest counter-argument**: If someone runs only the trigger listener without the daemon console (possible in tests or custom setups), the poll endpoint is unavailable. However, looking at production startup code (cli-worktrain.ts), both are always started together.

**Pivot condition**: If `mountConsoleRoutes` proves difficult to extend (e.g., strict TypeScript signature incompatibilities), fall back to Candidate B.

**Assumption that would invalidate**: If `mountConsoleRoutes` is called from multiple places we haven't checked. Verified: only called from `daemon-console.ts` in production.

## Open Questions for the Main Agent

1. Should `forcePoll` await the poll cycle (synchronous HTTP response) or fire-and-forget? Spec says "Return 200 when complete" - so it should AWAIT.
2. Should `forcePoll` skip if a poll is already running (current skip-cycle behavior) or wait/queue? For simplicity: run the same `runPollCycle` which already handles the skip-cycle guard and logs a warning. Acceptable.
3. `PollingScheduler.forcePoll` return type: `Promise<{ kind: 'ok' } | { kind: 'not_found' } | { kind: 'wrong_provider'; provider: string }>` or just throw? Use Result-like union for clean HTTP mapping.
