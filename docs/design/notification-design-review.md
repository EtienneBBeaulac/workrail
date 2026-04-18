# WorkTrain Notifications: Design Review Findings

Concise findings for the implementation agent.

---

## Tradeoff Review

All accepted tradeoffs are sound under realistic conditions:

- **Global-only config** -- acceptable for single-user local daemon. Additive per-trigger config is possible without touching NotificationService.
- **No retry on webhook** -- best-effort delivery matches DaemonEventEmitter contract. Acceptable.
- **No Linux/Windows** -- webhook is the universal channel. Linux `notify-send` is additive.
- **Fire-and-forget errors swallowed** -- `console.warn` inside catch provides minimal observability. Correct for observability infrastructure.

---

## Failure Mode Review

All failure modes covered:

| Failure mode | Mitigation | Risk |
|---|---|---|
| osascript stall | execFile `timeout: 5000` + SIGKILL | Low |
| Webhook unreachable | AbortController 30s + catch/warn/swallow | Low |
| Webhook non-2xx | res.ok check + warn + swallow | Low |
| Invalid webhook URL | URL.canParse at construction, warn + treat as absent | Low |
| macOS permission denied | osascript exits non-zero, caught and swallowed | Low |
| Future accidental await | notify() returns void (not Promise<void>) -- TypeScript rejects await | None |

No high-risk failure modes.

---

## Runner-Up / Simpler Alternative Review

- **Runner-up (inline in TriggerRouter):** no strengths worth borrowing. Loses on testability and single-responsibility.
- **Simpler (module-level function instead of class):** viable but class matches DaemonEventEmitter precedent, enables constructor-time URL validation, and makes injection cleaner in tests.
- **Hybrid:** none warranted. Selected approach already is the pattern-following hybrid.

---

## Philosophy Alignment

All CLAUDE.md principles satisfied:

- DI for I/O boundaries: execFileFn and fetchFn injected
- Immutability: NotificationService immutable post-construction
- Errors are data: async errors logged, discarded at boundary
- YAGNI: MVP scope only

Minor tensions (acceptable):
- macOS-on-Linux: runtime guard (`process.platform === 'darwin'`) rather than type-level. Acceptable for config flags.

---

## Findings

**No Red or Orange findings.** Design is implementation-ready.

**Yellow (informational):**

- Y1: `notify()` should return `void` (not `Promise<void>`) to make the fire-and-forget contract type-enforced. Async work is detached via `void this._doNotify(...).catch(...)` inside a sync method -- exactly as DaemonEventEmitter does.
- Y2: osascript execFile call should use `timeout: 5000` option (ms). Do not use the shell timeout command -- execFile handles this natively.
- Y3: The `delivery_failed` outcome notification message should distinguish 'session completed, result delivery failed' from 'session failed'. Both are error states but from the user's perspective they are different actions.
- Y4: Config-load warning: if `WORKTRAIN_NOTIFY_MACOS=true` but `process.platform !== 'darwin'`, log one `console.warn` at construction time (not on every notify() call).

---

## Recommended Revisions

None to the architecture. Implement as designed:

1. `src/trigger/notification-service.ts` -- NotificationService class, void notify(), macOS + webhook channels
2. `src/trigger/trigger-router.ts` -- add optional `notificationService?` constructor param; call `notificationService?.notify(result, trigger.goal)` in route() after runWorkflowFn() and `notificationService?.notify(result, workflowTrigger.goal)` in dispatch() after runWorkflowFn()
3. `src/config/config-file.ts` -- add WORKTRAIN_NOTIFY_MACOS and WORKTRAIN_NOTIFY_WEBHOOK to ALLOWED_CONFIG_FILE_KEYS
4. `src/trigger/trigger-listener.ts` -- read the two config values, construct NotificationService if either is set, inject into TriggerRouter
5. `src/trigger/__tests__/notification-service.test.ts` -- unit tests with injected fakes

---

## Residual Concerns

None material. Design is sound and implementation-ready.
