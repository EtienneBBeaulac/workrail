# WorkTrain User Notifications: Design Candidates

Raw investigative material for the main implementation agent. Honest analysis over polished presentation.

---

## Problem Understanding

**What is being asked:** fire user-facing notifications (macOS native, generic webhook) when the WorkTrain daemon completes a session or encounters a problem. Config via `~/.workrail/config.json`.

**Tensions:**

1. **Fire-and-forget vs. correctness guarantee** -- notifications involve async I/O (osascript subprocess, HTTP POST). They must never delay semaphore release, affect the workflow result, or propagate errors upward. Solution: `notify()` is void/sync, async work is detached in a void Promise that unconditionally swallows all errors (DaemonEventEmitter model).

2. **Global config vs. per-trigger config** -- the simplest and most consistent design is global config (`~/.workrail/config.json`). Per-trigger config is additive later. Per YAGNI: global-only for MVP.

3. **Child session isolation** -- `spawn_agent` calls `runWorkflow()` directly for child sessions. If notifications fire from inside `runWorkflow()`, sub-agent completions notify the user. The correct seam is at the top-level dispatch boundary (TriggerRouter), not inside the workflow executor.

4. **Platform detection** -- osascript is macOS-only. If `WORKTRAIN_NOTIFY_MACOS=true` on Linux, the call fails silently (or logs a warning). Runtime `process.platform === 'darwin'` guard required.

**Likely seam:** `TriggerRouter.route()` and `TriggerRouter.dispatch()` -- after `runWorkflowFn()` returns. This is the only call site that: (a) has a complete `WorkflowRunResult`, (b) is called only for root-level sessions, (c) already has the pattern for injected optional behaviors.

**What makes this hard:** The child session problem. A junior developer would add notifications inside `runWorkflow()` and flood the user with sub-agent notifications. The correct boundary is `TriggerRouter` because it is the external dispatch surface.

---

## Philosophy Constraints

From `CLAUDE.md` and repo patterns:

- **Errors-as-data:** `notify()` swallows all async errors internally (never returns a Result -- it is observability, not delivery). The webhook channel can log the error; it must not propagate.
- **DI for I/O boundaries:** `execFileFn` (for osascript) and `fetchFn` (for webhook HTTP) are injected constructor parameters, allowing test fakes without mocking child_process or global fetch.
- **Immutability by default:** `NotificationService` is immutable after construction. Config is a plain readonly struct passed to the constructor.
- **YAGNI:** No retry logic, no per-trigger config, no Slack/email integrations.
- **Single-responsibility:** TriggerRouter dispatches; NotificationService notifies. Not mixed.

**Conflicts:** None. CLAUDE.md and repo patterns align.

---

## Impact Surface

Files that must remain consistent after this change:

- `src/trigger/trigger-router.ts` -- gains one optional constructor param (`notificationService?`)
- `src/trigger/trigger-listener.ts` -- constructs `NotificationService` from config and injects
- `src/config/config-file.ts` -- gains 2 new allowed keys: `WORKTRAIN_NOTIFY_MACOS`, `WORKTRAIN_NOTIFY_WEBHOOK`
- `src/trigger/__tests__/trigger-router.test.ts` -- existing tests should be unaffected (new param is optional); new tests verify notify() is called with correct args

No breaking changes to public types or existing behavior.

---

## Candidates

### Candidate 1: Inline notification in TriggerRouter

**Summary:** Add `notifyMacOs: boolean` and `notifyWebhookUrl: string | undefined` constructor params to TriggerRouter. After `runWorkflowFn()` returns in `route()` and `dispatch()`, call `execFile('osascript', [...])` and/or `fetch(webhookUrl, {...})` inline. Errors caught and swallowed.

- **Tensions resolved:** fire-and-forget (detached void Promise), child isolation (TriggerRouter boundary). Accepts: single-responsibility violation.
- **Boundary:** TriggerRouter -- correct for child isolation.
- **Failure mode:** TriggerRouter test suite must mock execFile and fetch; future channels (Slack, Linux) bloat the class.
- **Repo pattern:** departs from optional-injection pattern (emitter, execFn are injected services, not bare params).
- **Gains:** smallest diff, no new files.
- **Losses:** testability burden, extensibility, single-responsibility.
- **Scope:** too narrow -- makes future channels harder.
- **Philosophy:** violates DI (no injection seam for osascript/fetch in tests), single-responsibility.

---

### Candidate 2: New NotificationService class (recommended)

**Summary:** `NotificationService` class in `src/trigger/notification-service.ts`. Constructor: `{ macOs: boolean, webhookUrl?: string, execFileFn?: ExecFileFn, fetchFn?: FetchFn }`. Method: `notify(result: WorkflowRunResult, goal: string): void` -- fire-and-forget. TriggerRouter gets optional `notificationService?: NotificationService` constructor param. `trigger-listener.ts` constructs it from config. Tests inject fakes.

- **Tensions resolved:** all 4. Fire-and-forget via detached void Promise. Child isolation via TriggerRouter boundary. DI for testability. Platform detection inside `notify()`.
- **Boundary:** NotificationService owns notification; TriggerRouter owns routing. Clean split.
- **Why this boundary is best fit:** mirrors `DaemonEventEmitter` exactly -- same optional-injection, same fire-and-forget contract, same "observability must never affect correctness" invariant.
- **Failure mode:** if the void Promise is not truly detached (e.g., `await notify()` accidentally holds the semaphore). Must verify the pattern. Low risk given DaemonEventEmitter precedent.
- **Repo pattern:** directly follows `DaemonEventEmitter` (daemon-events.ts) and `execFn` injection (trigger-router.ts, delivery-client.ts).
- **Gains:** clean seam, testable with fakes, extensible (future channels are additive), follows all repo conventions.
- **Losses:** one new file (negligible).
- **Scope:** best-fit.
- **Philosophy:** honors DI, errors-as-data, immutability, single-responsibility, YAGNI. No conflicts.

---

### Candidate 3: DaemonEventEmitter subscriber (rejected)

**Summary:** Add subscriber pattern to `DaemonEventEmitter`. On `session_completed` events, a `NotificationService` listener fires notifications.

- **Critical failure:** `session_completed` fires for all `runWorkflow()` calls including child sessions spawned by `spawn_agent`. Violates child isolation invariant -- users get flooded with sub-agent notifications.
- **Additional problem:** `DaemonEventEmitter` is an append-only JSONL logger, not a pub/sub bus. Adding subscriber semantics is a disproportionate architectural change.
- **Scope:** too broad.
- **Rejected.**

---

## Comparison and Recommendation

| Tension | Candidate 1 | Candidate 2 | Candidate 3 |
|---|---|---|---|
| Fire-and-forget | resolved | resolved | resolved |
| Child session isolation | resolved | resolved | **violated** |
| Testability | weak | strong | n/a |
| Extensibility | poor | good | n/a |
| Repo pattern fit | departs | follows | departs |

**Recommendation: Candidate 2 (NotificationService).**

Reasons: follows the exact DaemonEventEmitter optional-injection precedent, clean single-responsibility boundary, strong testability via injected fakes, extensible for future channels without touching TriggerRouter. Cost is one small new file.

---

## Self-Critique

**Strongest counter-argument against Candidate 2:** Candidate 1 is a smaller diff with no new files. If notifications are low-priority and never extended, NotificationService is over-engineered. YAGNI could justify inline.

**Why Candidate 1 still loses:** The testability argument is concrete and immediate. TriggerRouter already has complex semaphore/delivery/autoCommit logic. Adding osascript/fetch inline makes the test suite harder now. NotificationService is one small file -- the cost is negligible.

**Broader option that might be justified:** A `NotificationBus` with channel registration and routing (like an EventEmitter). Only justified if multiple channels need independent retry, priority, or filtering. No evidence of that in the backlog.

**Invalidating assumption:** If console-dispatched sessions (via `dispatch()`) should NOT notify the user (because they are interactive). Currently both `route()` and `dispatch()` are treated the same. If this is wrong, `notify()` gains a `source?: 'webhook' | 'console'` parameter and gates on it.

---

## Open Questions for the Main Agent

1. Should `dispatch()` (console-initiated) fire notifications the same as `route()` (webhook/poll)? Current assumption: yes -- both are daemon-executed sessions the user cannot directly observe.
2. What message format for the macOS notification? Suggested: title = "WorkTrain", subtitle = workflowId, body = human-readable outcome + goal snippet.
3. What JSON payload for the webhook POST? Suggested: `{ event: "session_completed", workflowId, outcome: "success"|"error"|"timeout"|"delivery_failed", detail: string, goal: string, timestamp: ISO8601 }`.
4. Should `delivery_failed` generate a distinct notification message vs. plain `error`? Suggested: yes -- "session succeeded but result delivery failed" is a different user action than "session failed".
