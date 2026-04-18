# WorkTrain Notifications: Implementation Plan

---

## 1. Problem Statement

WorkTrain daemon silently starts and finishes sessions. Unless the user watches the console or tails a log, they have no awareness that work happened. This plan implements macOS native notifications (via `osascript`) and a generic webhook channel, firing on session completion (success/error/timeout/delivery_failed). Config lives in `~/.workrail/config.json`.

---

## 2. Acceptance Criteria

- When `WORKTRAIN_NOTIFY_MACOS=true` in `~/.workrail/config.json` and `process.platform === 'darwin'`, a macOS notification appears after every root-level session completes (success, error, timeout, or delivery_failed).
- When `WORKTRAIN_NOTIFY_WEBHOOK=<url>` in `~/.workrail/config.json`, an HTTP POST is sent to that URL after every root-level session completes.
- Notification fires for both webhook-triggered sessions (`route()`) and console-dispatched sessions (`dispatch()`).
- A failed notification (osascript crash, network error) never affects the workflow result and never causes the daemon to throw.
- Child sessions spawned via `spawn_agent` do NOT fire user notifications.
- If both `WORKTRAIN_NOTIFY_MACOS` and `WORKTRAIN_NOTIFY_WEBHOOK` are absent or false/empty, zero overhead (no NotificationService constructed).
- If `WORKTRAIN_NOTIFY_MACOS=true` but `process.platform !== 'darwin'`, a `console.warn` is logged once at daemon startup and notifications are skipped.
- If `WORKTRAIN_NOTIFY_WEBHOOK` is set to a non-URL value, a `console.warn` is logged once at startup and webhook channel is disabled.
- All new behavior is unit-testable via injected fakes (no test mocks of child_process or global fetch needed).

---

## 3. Non-goals

- Linux/Windows OS notifications (`notify-send`, PowerShell toast)
- Slack/Discord/Teams/email first-class channel integrations
- Mobile push notifications
- Outbox.jsonl integration
- Per-trigger notification config (global-only for MVP)
- Retry logic for webhook delivery
- Notification batching or debouncing
- Child session notifications (spawn_agent sub-tasks)

---

## 4. Philosophy-driven Constraints

- `notify()` returns `void` (not `Promise<void>`). Async work is detached via `void this._doNotify(...).catch(() => {})`. TypeScript rejects `await` on void -- fire-and-forget is type-enforced.
- `execFileFn` (for osascript) and `fetchFn` (for HTTP POST) are injected constructor parameters. Tests use fakes, never mock child_process or global fetch.
- `NotificationService` is immutable after construction. All config is resolved in the constructor.
- All async errors are swallowed unconditionally inside NotificationService. Logging via `console.warn` is the only observability.
- macOS platform check and webhook URL validation happen at construction time (validate at boundaries, trust inside).

---

## 5. Invariants

1. `notify()` never throws, never propagates errors, never affects `WorkflowRunResult`.
2. `notify()` fires only from `TriggerRouter` (not inside `runWorkflow()` or `spawn_agent` child sessions).
3. osascript is invoked via `execFile` (never `exec`). No shell injection risk.
4. Webhook is a global config channel, not per-trigger.
5. All 4 `WorkflowRunResult._tag` variants (`success`, `error`, `timeout`, `delivery_failed`) are notifiable.
6. `delivery_failed` notification message body is distinct: "session completed but result delivery failed".

---

## 6. Selected Approach

**NotificationService class** in `src/trigger/notification-service.ts`. Optional-injection into `TriggerRouter` constructor. Follows `DaemonEventEmitter` optional-injection pattern exactly.

**Runner-up:** Inline in TriggerRouter. Lost on testability and single-responsibility. No strengths worth borrowing.

**Rationale:** TriggerRouter is the only call site that processes root-level sessions exclusively (child sessions use `runWorkflow()` directly). NotificationService follows `DaemonEventEmitter` precedent -- same pattern, same contract, same rationale. Clean separation of concerns. Injected fakes eliminate test mocking burden.

---

## 7. Vertical Slices

### Slice 1: NotificationService core + config keys

**Scope:**
- `src/trigger/notification-service.ts` -- new file
- `src/config/config-file.ts` -- add 2 allowed keys
- `src/trigger/__tests__/notification-service.test.ts` -- new test file

**Done when:**
- `NotificationService` constructor accepts `{ macOs: boolean, webhookUrl?: string, execFileFn?: ExecFileFn, fetchFn?: FetchFn }`
- `notify(result: WorkflowRunResult, goal: string): void` is implemented
- macOS channel: calls `execFileFn('osascript', ['-e', `display notification "..." with title "WorkTrain"`], { timeout: 5000 })`
- Webhook channel: POSTs `{ event: 'session_completed', workflowId, outcome, detail, goal, timestamp }` to webhookUrl with 30s AbortController
- Platform guard: if macOs=true and platform !== darwin, logs warn at construction and skips osascript
- URL validation: if webhookUrl is provided but not a valid URL, logs warn at construction and disables webhook channel
- Unit tests cover: success fires both channels; error/timeout/delivery_failed each fire; macOS-on-linux is guarded; invalid webhook URL is disabled; failed osascript does not throw; failed webhook does not throw; injected fake execFileFn receives correct args
- `WORKTRAIN_NOTIFY_MACOS` and `WORKTRAIN_NOTIFY_WEBHOOK` are in `ALLOWED_CONFIG_FILE_KEYS`

### Slice 2: TriggerRouter injection

**Scope:**
- `src/trigger/trigger-router.ts` -- add optional `notificationService?` param to constructor; call in `route()` and `dispatch()`

**Done when:**
- `TriggerRouter` constructor accepts optional `notificationService?: NotificationService` (7th param position or via an options bag -- check existing param order)
- `route()` calls `this.notificationService?.notify(result, trigger.goal)` after `runWorkflowFn()` resolves and before `maybeRunDelivery()`
- `dispatch()` calls `this.notificationService?.notify(result, workflowTrigger.goal)` after `runWorkflowFn()` resolves
- Existing TriggerRouter tests are unaffected (new param is optional, defaults to undefined)
- New test verifies notify() is called with the correct result and goal in both route() and dispatch() paths

### Slice 3: trigger-listener.ts wiring

**Scope:**
- `src/trigger/trigger-listener.ts` -- read config values and inject NotificationService

**Done when:**
- After reading `~/.workrail/config.json`, `trigger-listener.ts` reads `WORKTRAIN_NOTIFY_MACOS` and `WORKTRAIN_NOTIFY_WEBHOOK`
- If either is set, constructs `NotificationService` and injects into `TriggerRouter`
- If neither is set, `notificationService` is undefined (no overhead)
- Manual integration test: set `WORKTRAIN_NOTIFY_MACOS=true` in config.json, start daemon, trigger a session, verify notification appears on macOS

---

## 8. Test Design

**Unit tests (Vitest, fakes):**

`notification-service.test.ts`:
- success result fires macOS notification with title "WorkTrain" and body containing workflowId and "completed"
- error result fires notification with "failed" in body
- timeout result fires notification with "timed out" in body
- delivery_failed result fires notification with "delivery failed" in body (distinct from generic error)
- macOS=true + platform=darwin: execFileFn called with correct args
- macOS=true + platform=linux: execFileFn NOT called, console.warn emitted at construction
- webhookUrl set + valid URL: fetchFn called with correct URL and JSON body
- webhookUrl set + invalid URL: fetchFn NOT called, console.warn emitted at construction
- execFileFn throws: notify() does not throw, error is swallowed
- fetchFn rejects: notify() does not throw, error is swallowed
- fetchFn returns non-2xx: notify() does not throw, console.warn emitted

`trigger-router.test.ts` additions:
- route() with notificationService: notificationService.notify() called with correct WorkflowRunResult and goal after workflow completes
- dispatch() with notificationService: same
- route() without notificationService: no error (undefined?.notify() is safe)

**Integration test (manual):**
- `WORKTRAIN_NOTIFY_MACOS=true` in config.json -> trigger a session -> verify macOS notification appears
- `WORKTRAIN_NOTIFY_WEBHOOK=https://httpbin.org/post` -> trigger a session -> verify POST received

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| osascript stall | Low | Low | execFile timeout: 5000ms |
| Webhook timeout | Low | Low | AbortController 30s |
| Future accidental await on notify() | Low | Medium | notify() returns void (not Promise<void>) |
| macOS permission denied | Medium | Low | errors swallowed, user sees nothing |
| Wrong TriggerRouter param position | Low | Low | Check existing param order before editing |

---

## 10. PR Packaging Strategy

**SinglePR** on branch `feat/daemon-notifications`. All 3 slices in one PR -- they are cohesive and none makes sense without the others. Slices are committed sequentially so the diff is reviewable.

---

## 11. Philosophy Alignment

| Principle | Status | Note |
|---|---|---|
| DI for I/O boundaries | Satisfied | execFileFn and fetchFn injected |
| Immutability by default | Satisfied | NotificationService immutable post-construction |
| Errors are data | Satisfied | async errors logged then discarded at boundary |
| Validate at boundaries | Satisfied | URL and platform validated at construction |
| YAGNI | Satisfied | No retry, no per-trigger, no Slack |
| Make illegal states unrepresentable | Tension | macOS-on-Linux is representable via config; mitigated by construction-time guard |
| Single-responsibility | Satisfied | TriggerRouter routes; NotificationService notifies |
| Prefer fakes over mocks | Satisfied | execFileFn and fetchFn are injectable fakes |

---

## 12. Metrics

- `implementationPlan`: complete
- `slices`: 3 (NotificationService core, TriggerRouter injection, trigger-listener wiring)
- `estimatedPRCount`: 1
- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
- `followUpTickets`: Linux `notify-send` support, per-trigger notification config, webhook retry
