# Design Review Findings: MCP Server Resilience

> Concise, actionable findings for the implementation agent.

---

## Tradeoff Review

| Tradeoff | Verdict | Condition That Changes It |
|---|---|---|
| 2s->2s jitter + reconnect latency | Acceptable | Only revisit if bridge.log shows >5s reconnect times impacting users |
| New mutable state in fatal-exit.ts | Acceptable | Must be documented with same comment pattern as existing mutable state |
| Async event loop active during 3s shutdown | Acceptable | Bounded by hard exit timer; no correctness risk |
| Graceful shutdown timeout (2s) vs HTTP server's own 5s timeout | **Needs fix** | Increase to 3s so shutdown fn has a real chance to complete |

---

## Failure Mode Review

| Failure Mode | Coverage | Gap | Severity |
|---|---|---|---|
| Shutdown fn hangs | Hard exit timer | None | Covered |
| SDK already handles handler rejections | Try/catch is harmless redundancy | None | Covered |
| 2s jitter + primary startup >2s | 3-retry post-jitter detection | If startup >5.5s, second spawn still possible (exits cleanly with EADDRINUSE) | Low |
| Shutdown fn throws synchronously | `Promise.resolve().then(() => fn())` | Must be implemented correctly (not bare `fn()`) | Must not miss |
| Double-registration in tests | Last-writer-wins + null-clear support | `registerGracefulShutdown(null)` needed for test reset | Medium |
| withToolCallTiming throws | Outer try/catch covers it | One timing observation lost (observability only) | Low |

---

## Runner-Up / Simpler Alternative Review

**Candidate A (no graceful shutdown):** Satisfies 2/3 task requirements. Not recommended -- the task explicitly asks for graceful shutdown improvement.

**Simplified async path:** Replace `Promise.race()` with dual-path `setTimeout` + `Promise.then`. This is strictly simpler and achieves the same semantics:

```ts
if (gracefulShutdownFn !== null) {
  const fn = gracefulShutdownFn;
  const hardExit = setTimeout(() => process.exit(1), gracefulShutdownTimeoutMs);
  void Promise.resolve()
    .then(() => fn())
    .catch(() => {})
    .finally(() => {
      clearTimeout(hardExit);
      process.exit(1);
    });
} else {
  process.exit(1);
}
```

**Recommendation:** Use the simplified dual-path approach. It is easier to reason about than `Promise.race()` and makes the `clearTimeout` + `process.exit(1)` sequencing explicit.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Errors are data | Satisfied -- outer try/catch converts throws to structured error values |
| Validate at boundaries | Satisfied -- catch at outermost dispatch boundary |
| Dependency injection | Satisfied -- shutdown fn is injected via `registerGracefulShutdown()` |
| Surface information | Satisfied -- crash log + stderr write before any async work |
| YAGNI | Satisfied -- no speculative abstractions |
| Immutability by default | Acceptable tension -- mutable state follows existing documented pattern |
| Determinism | Acceptable tension -- bounded by hard exit timer (O(seconds)) |
| Small pure functions | Acceptable tension -- last-resort handlers are inherently impure |

---

## Findings

### Red (must fix before implementing)

None.

### Orange (must address, affects correctness)

**O1: Graceful shutdown timeout must be 3s, not 2s.**
`HttpServer.stop()` has an internal 5s `server.close()` timeout. A 2s outer timeout races with the first 2s of that timeout, meaning the HTTP server never actually calls `server.close()` in time. Use 3s to give the shutdown fn a real chance, while still guaranteeing process exit within a bounded window.

**O2: `registerGracefulShutdown()` must accept `null` to clear the registered fn.**
Signature: `registerGracefulShutdown(fn: (() => Promise<void>) | null, timeoutMs?: number): void`. Required for test isolation. Without this, tests that call `fatalExit()` after a previous test registered a fn will try to call the stale fn.

**O3: Shutdown fn must be called via `Promise.resolve().then(() => fn())`, not `fn()` directly.**
Synchronous throws from `fn()` must be converted to rejected promises before the `.catch(() => {})` can handle them. A bare `fn()` call that throws synchronously escapes the catch and propagates as an uncaught exception. This would re-enter `fatalExit()`, which the re-entrancy guard handles -- but it also means the hard exit timer fires without the cleanup completing. Use `Promise.resolve().then(() => fn())` to convert sync throws to rejected promises.

### Yellow (should address, affects quality)

**Y1: Update `design-candidates.md` graceful shutdown timeout from 2s to 3s.**
The design document says 2s; implementation should use 3s per finding O1.

**Y2: Add test-reset documentation to `fatal-exit.ts` module comment.**
The existing tests manage `fatalHandlerActive` state -- document that tests must also manage `gracefulShutdownFn` state via `registerGracefulShutdown(null)` after each test that registers a fn.

**Y3: Log a warning in `fatalExit()` when graceful shutdown is attempted.**
Something like `[FatalExit] Attempting graceful shutdown (${timeoutMs}ms timeout)` on stderr before starting the async path. This makes the behavior visible in crash scenarios.

---

## Recommended Revisions

1. Use 3s timeout (not 2s) for `gracefulShutdownTimeoutMs` default.
2. `registerGracefulShutdown(fn: (() => Promise<void>) | null, timeoutMs?: number): void` -- null clears.
3. Async path: `Promise.resolve().then(() => fn()).catch(() => {}).finally(...)` -- not bare `fn()`.
4. Use dual-path `setTimeout` + `Promise.then` approach (simpler than `Promise.race()`).
5. Add stderr log line in `fatalExit()` when entering the graceful shutdown path.
6. Update `fatal-exit.test.ts` to call `registerGracefulShutdown(null)` in `afterEach`.

---

## Residual Concerns

1. **SDK error handling behavior**: We don't know if the MCP SDK converts async handler rejections to protocol errors. The outer try/catch is defensive and harmless if redundant. No action needed, but worth confirming empirically after implementation.

2. **Bridge spawn storm with >3 bridges**: Increasing jitter to 2s handles the observed 3-4 bridge case. If the deployment grows to 10+ bridge processes, the probabilistic coordination may break down. The spawn lock file (Candidate C) would be the fix. File this for future if needed.

3. **Test isolation for module-level state in `fatal-exit.ts`**: Both the existing `fatalHandlerActive`/`registeredTransport` and the new `gracefulShutdownFn` require test cleanup. The test file should use `vi.resetModules()` or explicit `registerGracefulShutdown(null)` calls.
