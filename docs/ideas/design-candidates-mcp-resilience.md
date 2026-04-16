# Design Candidates: MCP Server Resilience

> Raw investigative material for the implementation agent. Honest analysis over polished presentation.

---

## Problem Understanding

### Core Tensions

1. **Catch-all vs. let-it-crash**: A server should catch tool handler exceptions and keep running (MCP server = long-lived service). But truly corrupt state (startup failure, unrecoverable invariant violation) should exit. The same `registerFatalHandlers()` currently handles both cases identically with `process.exit(1)`. The tension: distinguishing "exception inside one tool call" from "exception in global process state".

2. **Graceful shutdown vs. simplicity**: Adding a graceful shutdown path to `fatalExit()` adds complexity (timeout, async path, potential for the shutdown itself to hang). The current synchronous path is simple and guaranteed to terminate. The tension: correctness (clean teardown) vs. reliability (always exits).

3. **Spawn storm prevention vs. reconnect latency**: Increasing jitter reduces the probability of spawn storms at the cost of longer reconnect delays after a real crash. With 2s jitter, a crashed primary means the user waits ~2s longer per bridge before the first spawn attempt. But with 300ms, all bridges race simultaneously.

4. **Tool handler catch vs. SDK internals**: Adding try/catch at the `setRequestHandler` callback level may interact with how the MCP SDK dispatches errors. If the SDK already catches rejected promises and handles them as protocol errors, the wrapper is redundant. If it doesn't, the try/catch is essential.

### Likely Seam / Real Problem Location

- **Tool handler exceptions**: the seam is `server.ts` line 437, the `setRequestHandler(CallToolRequestSchema, ...)` callback. The symptom (process.exit) is in `fatal-exit.ts`, but the fix belongs at the dispatch boundary. The `createHandler()` try/catch is a second inner layer -- good to have, but the outer layer is missing.
- **`registerFatalHandlers()` aggression**: the seam is `fatal-exit.ts` lines 143-145. The fix is not to remove the handler but to make it less catastrophic for exceptions that could have been caught earlier.
- **Spawn storm**: the seam is `bridge-entry.ts` line 190. The fix is surgical: increase the sleep duration and the post-jitter detection retries.

### What Makes This Hard

1. The MCP SDK's error handling behavior for async handler rejections is not documented -- it may or may not convert them to protocol errors.
2. The graceful shutdown path in `fatalExit()` introduces a new failure mode: if `shutdown()` hangs, the process never exits. The timeout must be hard.
3. The spawn storm is a distributed coordination problem -- purely local fixes (jitter) reduce it statistically but can't eliminate it without cross-process coordination (a spawn lock file).
4. A junior developer would add try/catch in `createHandler()` (already done) and declare victory, missing the outer `setRequestHandler` boundary and the `withToolCallTiming()` gap.

---

## Philosophy Constraints

**From `~/CLAUDE.md`:**
- **Errors are data** -- represent failure as values, not exceptions. `createHandler()` already does this; the gap is at the MCP SDK dispatch layer.
- **Validate at boundaries, trust inside** -- the `CallToolRequestSchema` handler is the outermost boundary. Add the catch there.
- **Dependency injection for boundaries** -- the graceful shutdown callback registered via `registerGracefulShutdown()` follows this; transport entry points own their teardown logic.
- **YAGNI with discipline** -- don't add complexity that isn't needed (e.g., spawn lock file is out of scope).
- **Surface information, don't hide it** -- if something unexpected happens, log it to stderr and crash.log.

**Conflicts:**
- `fatalExit()` uses `process.exit(1)` immediately -- this is at odds with "errors are data" but the comments explain why (re-entrancy risk, sync crash log). For truly uncaught process-level exceptions, crash is correct. The conflict: should EVERY uncaught exception crash? No -- tool handler exceptions should not.
- The mutable module state in `fatal-exit.ts` (`fatalHandlerActive`, `registeredTransport`) conflicts with "immutability by default" but is documented as intentional (last-resort handlers). Any new mutable state must follow the same documented pattern.

---

## Impact Surface

**Files that must change:**
- `src/mcp/server.ts` -- add try/catch around `CallToolRequestSchema` handler
- `src/mcp/transports/fatal-exit.ts` -- add `registerGracefulShutdown()` + async path
- `src/mcp/transports/bridge-entry.ts` -- increase jitter, increase post-jitter retries

**Files that must stay consistent:**
- `src/mcp/transports/stdio-entry.ts` -- should call `registerGracefulShutdown()` to register `ctx.httpServer?.stop()`
- `src/mcp/transports/http-entry.ts` -- same, register `listener.stop()` + `ctx.httpServer?.stop()`
- `src/mcp/transports/bridge-entry.ts` -- no graceful shutdown needed (bridge has its own `performShutdown()`)
- `tests/unit/mcp/transports/fatal-exit.test.ts` -- needs updating for new exports and async path

**Contracts that must remain consistent:**
- `fatalExit(label, reason)` signature -- unchanged
- `registerFatalHandlers(transport)` -- unchanged
- `logStartup(transport, extra?)` -- unchanged
- `McpCallToolResult` shape returned by the new outer catch -- must match `{content: [{type: 'text', text: '...'}], isError: true}`

---

## Candidates

### Candidate A: Minimal Surgical Fix

**Summary:** Add a single try/catch around the `CallToolRequestSchema` handler body in `server.ts`, increase bridge jitter from `Math.random() * 300` to `Math.random() * 2000`, increase post-jitter detection retries from 1 to 3. Do not change `fatalExit()`.

**Tensions resolved:** Catches tool handler exceptions before they become unhandled rejections. Reduces spawn storm probability (~6x reduction).
**Tensions accepted:** `fatalExit()` still calls `process.exit(1)` immediately for non-handler exceptions. No graceful shutdown.

**Boundary solved at:** `server.ts` `CallToolRequestSchema` async callback -- the outermost handler boundary.

**Why this boundary is the best fit:** This is where unhandled rejections originate for tool calls. Catching here prevents the rejection from ever reaching the `process.on('unhandledRejection')` handler.

**Failure mode:** If the MCP SDK has its own error-catching logic that this interferes with (unlikely). If the exception happens in `withToolCallTiming()` itself (not the handler), the catch still fires but returns a generic error with no timing observation -- acceptable.

**Repo-pattern relationship:** Directly adapts `createHandler()`'s try/catch pattern (lines 174-186 of `handler-factory.ts`) one level up. Same pattern, same boundary philosophy.

**Gains:** Minimal diff, minimal risk, directly addresses the primary failure mode.
**Gives up:** No graceful shutdown improvement. Task requirement 2 ("improve fatal-exit to attempt graceful shutdown") is not satisfied.

**Scope judgment:** Too narrow -- satisfies 2/3 task requirements.

**Philosophy fit:** Honors "errors are data", "validate at boundaries". Does not honor the explicit graceful shutdown request.

---

### Candidate B: Full Task Coverage -- Outer Catch + Graceful Shutdown + Jitter

**Summary:** Same outer catch as A. Additionally: export `registerGracefulShutdown(fn: () => Promise<void>, timeoutMs: number): void` from `fatal-exit.ts`. `fatalExit()` becomes: write crash log (sync) -> write stderr (sync) -> if fn registered: `Promise.race([fn().catch(() => {}), sleep(timeoutMs)]).finally(() => process.exit(1))` else `process.exit(1)`. Transport entry points (stdio, http) call `registerGracefulShutdown()` after composing the server. Bridge doesn't register one (it has its own `performShutdown()`). Increase jitter as in A.

**Tensions resolved:** All three. Catches tool handler exceptions. Adds bounded graceful shutdown (2s timeout guarantees termination). Reduces spawn storm.
**Tensions accepted:** Adds complexity (timeout, new mutable state, new export). The async path in `fatalExit()` is new territory vs. the existing synchronous design.

**Boundary solved at:**
- Outer tool handler catch: `server.ts` (same as A)
- Graceful shutdown: `fatal-exit.ts` -- module-level `let gracefulShutdownFn: (() => Promise<void>) | null = null`; new export `registerGracefulShutdown(fn, timeoutMs)`. The `fatalExit()` body gains an async branch protected by `Promise.race()`.

**Why this boundary is the best fit:** `fatal-exit.ts` is explicitly the last-resort handler for all transports. Adding shutdown registration here means all transports benefit. The re-entrancy guard already prevents double-entry into `fatalExit()`.

**Failure mode:** If the graceful shutdown fn throws synchronously (before the promise chain starts), it escapes the `Promise.race()`. Fix: wrap the `fn()` call itself in try/catch: `Promise.race([Promise.resolve().then(() => fn()).catch(() => {}), sleep(timeoutMs)])`. The outer `finally` with `process.exit(1)` is the ultimate guarantee.

**Repo-pattern relationship:** Extends `fatal-exit.ts` with the injection pattern seen in `bridge-entry.ts` (injectable deps). New module-level mutable state follows the existing documented pattern (`fatalHandlerActive`, `registeredTransport`).

**Gains:** Satisfies all task requirements. Graceful shutdown means HTTP server closes cleanly on crash. Lock file gets released. Dashboard doesn't leave stale state.
**Gives up:** More complex. Risk of the async path behaving unexpectedly under V8 inspector (mitigated by the `Promise.race()` + timeout guarantee).

**Scope judgment:** Best-fit -- matches all three explicit asks in the task.

**Philosophy fit:** Honors "errors are data", "dependency injection for boundaries", "determinism" (timeout guarantees termination). Minor tension with "immutability by default" (new mutable state -- documented and necessary).

---

### Candidate C: Spawn Lock File for Coordination

**Summary:** Add a `~/.workrail/spawn.lock` file written atomically (`wx` flag) by the first bridge that attempts a spawn. Other bridges check for this lock and skip spawning if it is < 5s old. Same jitter increase as A/B. Adapted from `HttpServer.tryBecomePrimary()` / `reclaimStaleLock()`.

**Tensions resolved:** Eliminates spawn storms by construction. Even with very short jitter, only one bridge holds the spawn lock at a time.
**Tensions accepted:** Adds a new file-system artifact, new cleanup path, more complex.

**Boundary solved at:** `bridge-entry.ts` `spawnPrimary()` -- before the post-jitter check.

**Failure mode:** If the spawn lock is never cleaned up (spawner crashes before cleanup), subsequent spawns are blocked for 5s. Mitigated by the TTL check.

**Scope judgment:** Too broad -- the task says "increase bridge jitter to prevent spawn storms". C solves a broader coordination problem not specified in the task. Current bridge.log data shows 3-4 spawns within ~500ms; 2s jitter is sufficient to prevent this pattern.

**Philosophy fit:** Honors "make illegal states unrepresentable" (spawn storm becomes impossible). Violates YAGNI for this task scope.

---

## Comparison and Recommendation

### Comparison Matrix

| Criterion | A (minimal) | B (full) | C (lock file) |
|---|---|---|---|
| Catches tool handler exceptions | Yes | Yes | No |
| Graceful shutdown on fatal exit | No | Yes | No |
| Reduces spawn storm | Yes (~6x) | Yes (~6x) | Eliminates |
| Task requirements satisfied | 2/3 | 3/3 | 0/3 |
| Complexity | Low | Medium | High |
| Risk | Low | Low-medium | Medium |
| Reversibility | Easy | Easy | Harder |
| Repo pattern consistency | Direct | Extended | Adapted |

### Recommendation: Candidate B

B satisfies all three explicit task requirements. The graceful shutdown addition is bounded, safe, and reversible. The `Promise.race()` + hard `process.exit(1)` in `finally` preserves the termination guarantee. The new mutable state in `fatal-exit.ts` follows the existing documented pattern.

**Concrete implementation:**

1. `src/mcp/server.ts`, `CallToolRequestSchema` handler: wrap entire async body in try/catch; on catch, log to stderr and return `{content: [{type: 'text', text: JSON.stringify({code: 'INTERNAL_ERROR', message: '...'})}], isError: true}`.

2. `src/mcp/transports/fatal-exit.ts`:
   - Add `let gracefulShutdownFn: (() => Promise<void>) | null = null` and `let gracefulShutdownTimeoutMs = 2000` at module level.
   - Export `registerGracefulShutdown(fn: () => Promise<void>, timeoutMs?: number): void`.
   - In `fatalExit()`, after the crash log write + stderr write, before `process.exit(1)`:
     ```ts
     if (gracefulShutdownFn !== null) {
       const fn = gracefulShutdownFn;
       Promise.race([
         Promise.resolve().then(() => fn()).catch(() => {}),
         new Promise<void>(resolve => setTimeout(resolve, gracefulShutdownTimeoutMs)),
       ]).finally(() => process.exit(1));
     } else {
       process.exit(1);
     }
     ```

3. `src/mcp/transports/stdio-entry.ts`: after `composeServer()`, call `registerGracefulShutdown(async () => { await ctx.httpServer?.stop(); }, 2000)`.

4. `src/mcp/transports/http-entry.ts`: after `composeServer()`, call `registerGracefulShutdown(async () => { await listener.stop(); await ctx.httpServer?.stop(); }, 2000)`.

5. `src/mcp/transports/bridge-entry.ts`: increase jitter from `Math.random() * 300` to `Math.random() * 2000`. Increase post-jitter detection: `detectHealthyPrimary(port, { retries: 3, baseDelayMs: 500, fetch: deps.fetch })`.

---

## Self-Critique

**Strongest counter-argument against B:**
The existing `fatalExit()` comments explicitly explain why it's synchronous (V8 inspector re-entrancy). Adding an async `Promise.race()` path means Node.js's event loop continues running during the grace period, which could allow other callbacks to fire (including re-entrant `fatalExit()` calls). The re-entrancy guard (`fatalHandlerActive`) is set synchronously at the top, so this is safe -- a second call returns immediately. But the concern is valid: the async path is new territory in a module explicitly designed to be synchronous.

**Narrower option (A) why it lost:**
Satisfies 2/3 requirements. The task description explicitly asks for "improve fatal-exit to attempt graceful shutdown". Leaving this out would be an incomplete implementation.

**Broader option (C) what evidence would be required:**
C would be justified if bridge.log showed many `spawn_primary` events from the same timestamp even with 2s jitter. Current data shows 3-4 spawns within ~500ms -- 2s jitter prevents this. Only justify C if post-B bridge.log still shows storms.

**Assumption that would invalidate B:**
If the MCP SDK already wraps async `setRequestHandler` callbacks and converts rejections to protocol errors, the outer try/catch in `server.ts` is redundant (harmless). More critically: if the actual production crashes come from somewhere outside tool handler context (timer callbacks, startup code), then neither A nor B prevents them. The crash.log shows only `fatal-exit.test.ts` interference in the visible entries -- we don't have evidence of production handler crashes. The fixes are defensive and correct regardless.

---

## Open Questions for the Main Agent

1. Should `registerGracefulShutdown()` in `fatal-exit.ts` allow _replacing_ a previously registered fn (last-writer-wins), or should it throw on double-registration? The transport entry points call `composeServer()` once, so double-registration shouldn't happen in production -- but for tests, last-writer-wins is safer.

2. The bridge process has its own `performShutdown()` that handles cleanup. Should the bridge also call `registerGracefulShutdown()`, or does its own shutdown path make this redundant? Recommendation: bridge should NOT register -- its `performShutdown()` is already called before `process.exit(0)`.

3. For the outer try/catch in `server.ts`: should it use the same `errNotRetryable('INTERNAL_ERROR', ...)` pattern as `createHandler()`, or a simpler static error response? Recommendation: match `createHandler()` for consistency.
