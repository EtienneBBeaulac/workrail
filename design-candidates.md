# Design Candidates: GitHub + GitLab Polling Trigger Implementation

## Problem Understanding

### Core Tensions

**1. Type safety vs. backward compatibility in `pollingSource`**
`GitLabPollingSource` has no `provider` discriminant field. The polling-scheduler test passes
`pollingSource: { provider: 'gitlab_poll', ... }`, which fails TypeScript. The clean fix --
adding `provider: 'gitlab_poll'` to `GitLabPollingSource` and `provider: 'github_poll'` to the
new `GitHubPollingSource`, updating `TriggerDefinition.pollingSource` to
`GitLabPollingSource | GitHubPollingSource` -- is what the TODO comment in `types.ts` calls for
("migrate to discriminated union at adapter #2"). Doing it now is correct. The only
consequence is that `trigger-store.ts` must emit `provider: 'gitlab_poll'` when building
`pollingSource` objects.

**2. `concurrencyMode` required field vs. test helpers that omit it**
`TriggerDefinition.concurrencyMode` is `readonly concurrencyMode: 'serial' | 'parallel'`
(currently required). Both `makePollingTrigger()` and `makeWebhookTrigger()` in the scheduler
test omit it. `PollingScheduler` never reads `concurrencyMode` (it calls
`TriggerRouter.dispatch()`, not `route()`), so the field is irrelevant to the scheduler's
logic. TypeScript will flag missing required fields once the source files exist. Fix: make
`concurrencyMode` optional (`readonly concurrencyMode?: 'serial' | 'parallel'`). The
trigger-store still always writes it; the router defaults to `'serial'` when absent. No
runtime behavior change.

**3. At-least-once delivery ordering**
The test "records event IDs AFTER dispatch" explicitly names this invariant. Recording before
dispatching and then crashing silently drops events (at-most-once). Recording after dispatching
guarantees at-least-once: if the record write crashes, recovery will re-dispatch the same
events. The `doPoll` implementation must dispatch first, then record -- never the reverse.

**4. Skip-cycle guard: flag must reset in `finally`**
If `doPoll` throws and the `polling` Map entry is not reset, the trigger is permanently locked
out of future polls. The `polling` Map key must be cleared in a `finally` block, not at the end
of the success path.

### Likely Seam

`src/trigger/` module boundary. Four new files:
- `src/trigger/adapters/github-poller.ts`
- `src/trigger/adapters/gitlab-poller.ts`
- `src/trigger/polled-event-store.ts`
- `src/trigger/polling-scheduler.ts`

Minimal changes to existing files:
- `src/trigger/types.ts` -- add `GitHubPollingSource`, add `provider` discriminant to
  `GitLabPollingSource`, widen `pollingSource` to union, make `concurrencyMode` optional
- `src/trigger/trigger-store.ts` -- add `provider: 'gitlab_poll'` to `pollingSource`
  construction (one field, no logic change)

### What Makes This Hard

1. **`provider` discriminant** -- easy to miss that `trigger-store.ts` must emit the field
   after adding it to the type; TypeScript catches it but the error isn't obvious
2. **`finally` block for flag reset** -- silently permanent lockout if omitted
3. **Dispatch-before-record ordering** -- easy to swap for cleanliness; wrong semantics
4. **PR `updated_at` client-side filter** -- strictly greater-than, not greater-than-or-equal
   (test "includes PRs with updated_at exactly equal to since" expects 0 results)
5. **Rate limit guard** -- must return `ok([])` (empty, not error) with `console.warn`; must
   happen after the HTTP response is received, before filtering
6. **`concurrencyMode` optional** -- if left required, TypeScript rejects valid test helpers

---

## Philosophy Constraints

Sources: `AGENTS.md` (workspace).

| Principle | Constraint on this implementation |
|---|---|
| Errors are data | `Result<T,E>` from `src/runtime/result.ts` -- NOT neverthrow (v2 infra uses neverthrow; trigger/ uses runtime/result.ts) |
| Make illegal states unrepresentable | Discriminated union on `pollingSource` -- enforces provider-specific field sets at compile time |
| Immutability by default | All new interfaces use `readonly`; all parameters injected |
| Validate at boundaries | `PolledEventStore.load()` returns fresh state on ENOENT / corrupt JSON / schema mismatch -- never propagates errors |
| Dependency injection for boundaries | `FetchFn` injected in pollers; `WORKRAIL_HOME` injected in store constructor; avoids hidden global state |
| YAGNI with discipline | Don't extract `interpolateGoalTemplate` to a utils file -- no second consumer exists yet |
| Small, focused changes | `trigger-store.ts` change is one field addition; no logic change |
| Document "why", not "what" | Inline comments on `finally` guard, dispatch-before-record ordering, rate limit behavior |

No conflicts between stated philosophy and repo patterns.

---

## Impact Surface

**Files changed (existing)**:
- `src/trigger/types.ts` -- `GitLabPollingSource` gains `provider: 'gitlab_poll'`; new
  `GitHubPollingSource` added; `TriggerDefinition.pollingSource` widens to union;
  `TriggerDefinition.concurrencyMode` becomes optional
- `src/trigger/trigger-store.ts` -- add `provider: 'gitlab_poll'` to `pollingSource`
  construction block; no logic change

**Files unchanged (verified)**:
- `src/trigger/trigger-router.ts` -- `interpolateGoalTemplate` already exported; no change
- `src/trigger/trigger-listener.ts` -- does NOT start `PollingScheduler`; not touched (non-goal)
- `src/trigger/trigger-store.ts` tests -- no test checks `pollingSource.provider`; no regression
- `src/trigger/trigger-router.ts` tests -- always supply `concurrencyMode`; `?` on the field
  doesn't break any passing test

**TypeScript contract**:
- `npx tsc --noEmit` is currently clean; must remain clean after changes
- Making `concurrencyMode` optional does not break `trigger-router.ts` (reads it with
  `trigger.concurrencyMode === 'parallel'` which evaluates to `false` when `undefined`)

**Consumers of `pollingSource`**:
- `trigger-store.ts` (builds it) -- one-line fix
- `polling-scheduler.ts` (reads it) -- new file, will narrow on `provider`
- No other production consumers exist

---

## Candidates

### Candidate 1 (only viable candidate): Implement source files + discriminated union

**Summary**: Add `provider` discriminant to polling source types, make `concurrencyMode`
optional, update `trigger-store.ts` to emit the discriminant, and implement the 4 source files
exactly as specified by the tests.

**Tensions resolved**:
- Type safety: discriminated union on `pollingSource` makes provider-specific field sets
  unrepresentable in the wrong context
- `concurrencyMode` type error: making it optional unblocks test helpers without changing
  runtime behavior
- At-least-once ordering: `doPoll` dispatches then records
- Skip-cycle guard: `finally` block resets `polling` Map entry

**Tensions accepted**:
- `polling-scheduler.ts` imports `interpolateGoalTemplate` from `trigger-router.ts` -- peer
  import within the same flat module, no circular dependency, acceptable

**Boundary solved at**: `src/trigger/` module only. No changes outside this directory.

**Why this boundary is the best fit**: All new code and all affected code lives in `src/trigger/`.
The type change (`concurrencyMode` optional) only relaxes a constraint; no consumer currently
depends on it being required at runtime. The discriminant addition is what the `types.ts` TODO
explicitly asks for.

**Failure mode**: Forgetting `provider: 'gitlab_poll'` in `trigger-store.ts`'s pollingSource
construction block. TypeScript catches it immediately (the union type requires the discriminant).
No silent runtime risk.

**Repo pattern**: Follows exactly.
- `Result<T,E>` from `runtime/result.ts`: same as `delivery-client.ts`
- Atomic write (writeFile tmp + rename): same as `v2/infra/local/session-store/index.ts` and
  `keyring/index.ts`, adapted to plain `node:fs/promises` (trigger/ module style)
- Injectable `FetchFn`: same pattern as `delivery-client.ts` uses global `fetch`
- `WORKRAIL_HOME` injection: follows how `trigger-store.ts` accepts workspace paths

**Gain**: All 4 failing test files pass; TypeScript remains clean; discriminated union ready
for scheduler to narrow on `provider`; `concurrencyMode` optional allows test helpers to be
concise.
**Give up**: Nothing.

**Impact surface beyond the task**: None. `trigger-listener.ts` wiring of `PollingScheduler`
is a follow-up. `trigger-store.ts` parsing for `github_poll` is a follow-up.

**Scope judgment**: Best-fit. Exactly what the tests require. Nothing speculative.

**Philosophy fit**: Honors all 8 principles listed above. No conflicts.

---

### Candidate 2 (rejected): Extract `interpolateGoalTemplate` to `trigger-utils.ts`

**Summary**: Move `interpolateGoalTemplate` from `trigger-router.ts` to a new shared
`src/trigger/trigger-utils.ts` before implementing the scheduler, eliminating the
scheduler-to-router import.

**Tensions resolved**: Reuse-vs-coupling (scheduler doesn't import router).
**Tensions accepted**: YAGNI -- adds infrastructure for a non-problem.

**Why it loses**:
- `src/trigger/` is a flat internal module, not a published package. Peer imports between
  files in the same directory are standard and have zero architectural weight.
- No circular dependency exists: `trigger-router.ts` does not import `polling-scheduler.ts`.
- No other file currently needs `interpolateGoalTemplate` besides the router and (soon) the
  scheduler. Two consumers does not justify a shared module.
- "YAGNI with discipline" explicitly argues against this.

**Scope judgment**: Too broad. Adds a file with no current second consumer. Justified only if
a third file needs the same function.

---

## Comparison and Recommendation

**Recommendation: Candidate 1.**

Candidate 2 solves a problem that does not exist. The only meaningful design decision is
Candidate 1 vs. "leave `concurrencyMode` required and add it to the test helpers." The test
helpers are the spec -- if they don't set `concurrencyMode`, the type must accommodate that.
Making it optional is the correct structural fix; the router's runtime behavior is unchanged.

---

## Self-Critique

**Strongest counter-argument against Candidate 1**: Making `concurrencyMode` optional weakens
the invariant that `trigger-store.ts` establishes: "the default must be explicit in the
TriggerDefinition so the router never needs a runtime fallback" (comment in trigger-store.ts
line 731). If `concurrencyMode` can be `undefined` on `TriggerDefinition`, a trigger created
outside `trigger-store.ts` (like in a test helper) could reach `TriggerRouter.route()` without
a value, and the router would need a fallback. The router currently reads
`trigger.concurrencyMode === 'parallel'` -- `undefined === 'parallel'` is `false`, so it
defaults to `'serial'` implicitly. This is safe but silently implicit. The right answer: make
it optional in the type but document that the router defaults to `'serial'` on `undefined`.

**Narrower option that lost**: Not adding the `provider` discriminant -- just leaving
`pollingSource` as `GitLabPollingSource` and having the scheduler do a runtime `provider`
check. Loses: doesn't satisfy the test's TypeScript (pollingSource includes `provider` field
not in the current type), and the `types.ts` TODO explicitly calls for the migration now.

**Broader option that would need evidence**: Full refactor of `TriggerDefinition` to a
discriminated union keyed on `provider` (generic vs gitlab_poll vs github_poll). Would be
justified if the provider-specific fields diverged significantly across more than 3 providers.
Current evidence: only 2 polling source types, and they share structure. Not justified yet.

**Assumption that would invalidate this design**: If `PollingScheduler` were intended to be
wired into `trigger-listener.ts` in this same PR. It is not -- that's explicitly a non-goal.
If that assumption is wrong, `trigger-listener.ts` changes would be needed here too.

---

## Open Questions for the Main Agent

None. The tests define the contract completely. The type changes are dictated by TypeScript
errors that will surface once the source files exist. Implement Candidate 1.
