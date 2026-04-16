# Implementation Plan: MCP Server Resilience

## 1. Problem Statement

The MCP server crashes silently from uncaught exceptions in tool handlers. The current architecture:
1. `registerFatalHandlers()` installs `process.on('uncaughtException')` -> `fatalExit()` -> `process.exit(1)`
2. Tool handler exceptions that escape `createHandler()`'s inner try/catch become unhandled rejections
3. `fatalExit()` calls `process.exit(1)` immediately -- no graceful shutdown, no HTTP server cleanup
4. Multiple bridges detect the crash simultaneously, all try to spawn a new primary within 300ms (shorter than startup time), causing a spawn storm

**Three root causes to fix:**
1. No outer try/catch at the MCP `CallToolRequestSchema` handler boundary
2. `fatalExit()` exits immediately without attempting graceful shutdown
3. Bridge jitter window (300ms) is shorter than primary startup time (~500-1000ms)

---

## 2. Acceptance Criteria

- [ ] An uncaught exception inside a tool handler does NOT crash the MCP server process
- [ ] The handler returns an MCP error response (`isError: true`, `code: INTERNAL_ERROR`) instead of killing the process
- [ ] The exception is logged to stderr before the error response is returned
- [ ] `fatalExit()` attempts graceful shutdown (HTTP server stop) before `process.exit(1)`
- [ ] Graceful shutdown has a hard timeout: `process.exit(1)` fires after at most 3s regardless of shutdown state
- [ ] Bridge jitter is 0-2000ms (was 0-300ms)
- [ ] Post-jitter health check uses 3 retries with 500ms base delay (was 1 retry)
- [ ] All existing tests pass
- [ ] New tests verify the outer try/catch returns `isError: true` for handler exceptions
- [ ] New tests verify `fatalExit()` calls the registered graceful shutdown fn and exits after it completes
- [ ] New tests verify `fatalExit()` still exits after 3s if shutdown fn hangs

---

## 3. Non-Goals

- Daemon-owns-the-console refactor (separate backlog item)
- Spawn lock file for cross-bridge coordination (probabilistic jitter reduction is sufficient for now)
- Automatic zombie cleanup (separate backlog item)
- Changing the primary election lock file mechanism
- Modifying the MCP SDK or its error handling behavior
- Making the process indestructible (truly fatal startup failures should still crash)

---

## 4. Philosophy-Driven Constraints

- **Errors are data**: Tool handler exceptions must be converted to `McpCallToolResult` values, not left as thrown exceptions.
- **Validate at boundaries**: The catch must be at the outermost dispatch boundary (`CallToolRequestSchema` handler), not buried inside individual handlers.
- **Dependency injection**: The graceful shutdown fn is injected into `fatal-exit.ts` via `registerGracefulShutdown()`. Transport entry points own their cleanup logic.
- **Determinism**: The graceful shutdown must have a bounded timeout. `process.exit(1)` must always fire, no exceptions.
- **Surface information**: Log to stderr before returning error response or before starting async shutdown.
- **YAGNI**: No speculative abstractions. No spawn lock file. No retry framework.

---

## 5. Invariants

- `fatalExit()` ALWAYS calls `process.exit(1)` eventually. The graceful shutdown path cannot prevent exit -- it can only delay it by at most `gracefulShutdownTimeoutMs` milliseconds.
- `fatalExit()` is re-entrant safe. A second call while shutdown is in progress is a no-op.
- The crash log write and stderr write happen SYNCHRONOUSLY, before any async work starts. They survive process death even if the async shutdown hangs.
- The outer try/catch in `server.ts` NEVER re-throws. It always returns a valid `McpCallToolResult`.
- `registerGracefulShutdown(null)` is always valid and clears the registered fn.

---

## 6. Selected Approach

**Candidate B (revised):** Outer try/catch at `CallToolRequestSchema` boundary + `registerGracefulShutdown()` in `fatal-exit.ts` + bridge jitter increase.

**Runner-up:** Candidate A (no graceful shutdown change) -- rejected because it satisfies only 2/3 task requirements.

**Why B:** The task explicitly asks for three things: (1) catch exceptions in tool handlers, (2) improve fatal-exit graceful shutdown, (3) increase bridge jitter. B satisfies all three. The added complexity (async path in `fatalExit()`) is bounded and safe due to the hard exit timer.

**Key design decisions (confirmed during review):**
- Graceful shutdown timeout: 3s (not 2s) -- `HttpServer.stop()` has an internal 5s `server.close()` timeout; 2s races with it
- Async pattern: dual-path `setTimeout` + `Promise.then` (not `Promise.race()`) -- simpler, equivalent semantics
- `registerGracefulShutdown()` accepts `null` to clear the fn (for test isolation)
- Shutdown fn called via `Promise.resolve().then(() => fn())` -- converts sync throws to rejected promises

---

## 7. Vertical Slices

### Slice 1: Outer try/catch in `server.ts`

**Scope:** `src/mcp/server.ts` only.

**Change:** Wrap the body of the `CallToolRequestSchema` handler (lines 437-468) in a try/catch. On catch: log to stderr, return `{content: [{type: 'text', text: JSON.stringify({code: 'INTERNAL_ERROR', message: '...'})}], isError: true}`.

**Acceptance:** A test that throws inside `withToolCallTiming()` returns `isError: true` without crashing the process.

**Philosophy:** Errors are data / Validate at boundaries.

---

### Slice 2: `registerGracefulShutdown()` in `fatal-exit.ts`

**Scope:** `src/mcp/transports/fatal-exit.ts` only.

**Change:**
- Add module-level mutable state: `let gracefulShutdownFn: (() => Promise<void>) | null = null` and `let gracefulShutdownTimeoutMs = 3000`
- Export `registerGracefulShutdown(fn: (() => Promise<void>) | null, timeoutMs?: number): void`
- Modify `fatalExit()` exit path:
  ```ts
  if (gracefulShutdownFn !== null) {
    process.stderr.write(`[FatalExit] Attempting graceful shutdown (${gracefulShutdownTimeoutMs}ms timeout)\n`);
    const fn = gracefulShutdownFn;
    const timeout = gracefulShutdownTimeoutMs;
    const hardExit = setTimeout(() => process.exit(1), timeout);
    void Promise.resolve()
      .then(() => fn())
      .catch(() => { /* shutdown errors must not block exit */ })
      .finally(() => {
        clearTimeout(hardExit);
        process.exit(1);
      });
  } else {
    process.exit(1);
  }
  ```

**Acceptance:**
- `fatalExit()` still exits with code 1 when no fn is registered (existing behavior)
- `fatalExit()` calls the registered fn when one is registered
- `fatalExit()` exits after 3s even if the fn hangs
- `registerGracefulShutdown(null)` clears the fn
- Existing `fatal-exit.test.ts` tests still pass (module state is reset via `vi.resetModules()`)

**Philosophy:** Dependency injection / Determinism (bounded timeout).

---

### Slice 3: Register graceful shutdown in transport entry points

**Scope:** `src/mcp/transports/stdio-entry.ts` and `src/mcp/transports/http-entry.ts`.

**Change:**
- In `stdio-entry.ts` `startStdioServer()`: after `composeServer()`, add:
  ```ts
  import { registerGracefulShutdown } from './fatal-exit.js';
  registerGracefulShutdown(async () => { await ctx.httpServer?.stop(); });
  ```
- In `http-entry.ts` `startHttpServer()`: after `composeServer()`, add:
  ```ts
  registerGracefulShutdown(async () => {
    await listener.stop();
    await ctx.httpServer?.stop();
  });
  ```
- Bridge does NOT register -- it has its own `performShutdown()` path

**Acceptance:** If `fatalExit()` fires in stdio or http transport, `ctx.httpServer?.stop()` is called before process exit.

---

### Slice 4: Bridge jitter increase

**Scope:** `src/mcp/transports/bridge-entry.ts` only.

**Changes:**
- Line 190: `await sleep(Math.random() * 300)` -> `await sleep(Math.random() * 2000)`
- `spawnPrimary()` post-jitter detection call: `detectHealthyPrimary(port, { retries: 1, fetch: deps.fetch })` -> `detectHealthyPrimary(port, { retries: 3, baseDelayMs: 500, fetch: deps.fetch })`

**Acceptance:**
- `DEFAULT_BRIDGE_CONFIG` is unchanged (jitter is not in the config, it's hardcoded in `spawnPrimary()`)
- Existing bridge tests pass
- Bridge.log should show fewer simultaneous `spawn_primary` events after a real crash

---

## 8. Test Design

### Slice 1 tests (new)

File: `tests/unit/mcp/server.test.ts` (create if not exists, or add to existing)

- **"CallToolRequestSchema handler catches exceptions and returns INTERNAL_ERROR"**: mock a handler that throws; verify the handler returns `{content: [...], isError: true}` without process crash
- **"CallToolRequestSchema handler catches exceptions and logs to stderr"**: verify `process.stderr.write` called with error info

### Slice 2 tests (add to `fatal-exit.test.ts`)

- **"registerGracefulShutdown registers a fn called by fatalExit"**: register fn, call `fatalExit()`, verify fn was called (mock fn as spy, mock setTimeout as immediate)
- **"registerGracefulShutdown(null) clears the fn"**: register fn, then null, verify fn not called
- **"fatalExit exits after timeout if shutdown fn hangs"**: register fn that never resolves; mock setTimeout to fire immediately; verify `process.exit(1)` called
- **"fatalExit handles sync throws in shutdown fn"**: register fn that throws synchronously; verify `process.exit(1)` still called
- Note: `vi.resetModules()` + dynamic import already resets module state between tests (confirmed by reading test file)

### Slice 4 tests (verify existing pass)

No new tests needed -- jitter value is not observable in unit tests (it uses `Math.random()`). The change is verified by bridge.log observation in production.

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDK already handles async handler rejections (outer try/catch redundant) | Medium | Low (harmless) | No action; defensive depth is acceptable |
| Graceful shutdown fn hangs; test mocking setTimeout fails | Low | Medium | Use `vi.useFakeTimers()` to advance timers in tests |
| Module state not reset in fatal-exit tests for new state | Low | Low | `vi.resetModules()` already used -- new state is reset automatically |
| 3s timeout races with HttpServer's 5s timeout in certain scenarios | Low | Low | Acceptable: 3s gives enough time for fast closes; hard exit fires for slow ones |
| Bridge jitter increase causes noticeable reconnect delay for users | Low | Low | 2s extra wait is acceptable for a dev tool; primary starts in <1s normally |

---

## 10. PR Packaging Strategy

**Single PR on branch `fix/mcp-server-resilience`.**

All 4 slices are related (MCP server resilience), small in scope (4 files changed, ~40 lines net), and have no unresolved dependencies between them. A single PR is cleaner and easier to review.

Commit sequence (logical order for review):
1. `feat(mcp): add registerGracefulShutdown to fatal-exit for clean teardown on crash`
2. `fix(mcp): catch unhandled tool handler exceptions at CallToolRequest boundary`
3. `fix(mcp): register graceful shutdown in stdio and http transport entry points`
4. `fix(mcp): increase bridge jitter to 2s to prevent spawn storms`

---

## 11. Philosophy Alignment Per Slice

### Slice 1 (outer try/catch in server.ts)
- **Errors are data** -> Satisfied: exceptions converted to `McpCallToolResult` values
- **Validate at boundaries** -> Satisfied: catch at outermost dispatch boundary
- **Surface information** -> Satisfied: log to stderr before returning error

### Slice 2 (registerGracefulShutdown in fatal-exit.ts)
- **Dependency injection** -> Satisfied: shutdown fn is injected, not hardcoded
- **Determinism** -> Satisfied: hard timeout guarantees bounded exit time
- **Immutability by default** -> Acceptable tension: mutable module state is documented and follows existing pattern
- **Compose with small pure functions** -> Acceptable tension: last-resort handlers are inherently impure

### Slice 3 (register shutdown in entry points)
- **Dependency injection** -> Satisfied: entry points own their teardown logic
- **YAGNI** -> Satisfied: minimal addition (one line per entry point)

### Slice 4 (bridge jitter increase)
- **YAGNI** -> Satisfied: surgical change to existing constant
- **Determinism** -> Neutral: jitter is random by design

---

## Estimated PR Count: 1

## Plan Confidence: High

All implementation details are fully specified. No unresolved unknowns that would materially affect implementation quality.

`unresolvedUnknownCount`: 0
