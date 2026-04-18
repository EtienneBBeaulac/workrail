# MCP Server Disconnect Discovery

## Context / Ask

The WorkRail MCP server keeps dying/disconnecting during active Claude Code sessions.
Bridges report repeated reconnects. Claude Code sessions are interrupted. The symptom:
"it restarts constantly."

Goal: identify root cause, supporting evidence, and recommended investigation path.

---

## Path Recommendation

**landscape_first** -- the problem is primarily one of understanding what is happening
(reading logs, reading code, tracing the crash chain), not of reframing a problem
definition. The code and logs give direct evidence of what is actually crashing.

Rationale over alternatives:
- `design_first` would be appropriate if the problem statement were ambiguous. It is not: we
  have crash logs with stack traces.
- `full_spectrum` would be appropriate if the landscape might be hiding a deeper structural
  question. The landscape already reveals a clear structural flaw (EPIPE crashing the server
  before the stdio guard fires), so spectrum-wide reframing is not needed.

---

## Constraints / Anti-goals

- Do not change the MCP client protocol (Claude Code).
- Do not affect session data integrity.
- Do not change the bridge/primary topology for now.
- Anti-goal: do not add speculative defenses if the real crash path is already identified.

---

## Landscape Packet (landscape_first pass)

### What runs

When Claude Code uses WorkRail there are two possible server topologies:

**Single process (first session):**
```
Claude Code (IDE) --stdio--> WorkRail stdio server (stdio-entry.ts)
                              + embedded HttpServer (dashboard / MCP HTTP port 3100)
```

**Multi-session (bridge mode):**
```
Claude Code --stdio--> WorkRail bridge (bridge-entry.ts)
                       --> HTTP --> WorkRail primary (http-entry.ts, port 3100)
```

### What the crash.log shows

Every entry in `~/.workrail/crash.log` (Apr 16-18, 2026) is the same pattern:

```json
{
  "transport": "stdio",
  "uptimeMs": 750-2100,
  "label": "Uncaught exception",
  "message": "write EPIPE",
  "stack": "Error: write EPIPE\n    at afterWriteDispatched...\n    at console.error (node:internal/console/constructor:444:26)\n    at HttpServer.<method> ..."
}
```

**Key observations:**
1. Every crash is `transport=stdio` -- the MCP stdio primary is dying, not a bridge.
2. Uptime is 750-2100ms -- these processes live less than 2 seconds.
3. The crash is always `write EPIPE` thrown by `console.error()` inside `HttpServer`.
4. The offending call sites across different crashes:
   - `HttpServer.reclaimStaleLock` (line 432, 436 in compiled dist)
   - `HttpServer.printBanner` (line 577 in compiled dist)
   - `HttpServer.start` (line 348)
5. All crashes point to the **installed npm global** (`/opt/homebrew/lib/node_modules/@exaudeus/workrail/dist/...`), not the local dev build.

**This means Claude Code is running the globally-installed WorkRail binary, not the local dev build.**

### What the bridge.log shows

The bridge.log for Apr 18 shows a repeating pattern:
```
reconnected -> budget_exhausted (budgetUsed: 8) -> spawn_lock_acquired -> spawn_primary
```

This happens across PIDs 76729, 83046, 96836, 28962 -- multiple bridges repeatedly
exhausting their full 8-reconnect budget before entering spawn mode. Each cycle takes
~90 seconds, matching the "constant restarts" symptom.

The bridges are correctly detecting primary death and attempting to respawn. The problem
is the primary keeps dying immediately after spawning.

### Root cause chain

1. Claude Code (IDE) spawns a WorkRail stdio process (the global npm binary).
2. The process starts, begins the `HttpServer.start()` / `tryBecomePrimary()` / `reclaimStaleLock()` path.
3. **Before** `wireStdoutShutdown()` fires (or even before `server.connect(transport)` is called), the HttpServer attempts writes via `console.error()`.
4. If Claude Code has already closed the stdio pipe (e.g. rapid reconnect, MCP restart), stdout/stderr are already broken.
5. `console.error()` calls `console.value()` (Node internals) which does a synchronous socket write to stderr.
6. The write throws `EPIPE` as an uncaught exception.
7. `registerFatalHandlers()` was already called, so the `uncaughtException` handler fires and calls `fatalExit()`.
8. `fatalExit()` writes to crash.log and calls `process.exit(1)`.
9. The primary dies. The bridge detects the death and restarts it. Loop.

### Why `wireStdoutShutdown()` doesn't save it

`wireStdoutShutdown()` guards `process.stdout` against EPIPE. But:
- The EPIPE is on `process.stderr` (from `console.error()`), not `process.stdout`.
- The crash happens inside `HttpServer.start()`, which is called from `composeServer()`, which is called before `wireStdoutShutdown()` is even registered.

The guard only covers `stdout` and is registered after `composeServer()` completes. HttpServer's
`console.error()` calls during startup (in `printBanner`, `reclaimStaleLock`, `start`) race
against a broken stderr pipe.

### Why it affects only the global install

The local dev build has some functions already converted to `process.stderr.write()` with
try/catch (e.g. `printBanner` at line 918 in the source). But the global npm binary
(`/opt/homebrew/lib/node_modules/@exaudeus/workrail`) is an older compiled version that still
uses `console.error()` in those paths -- confirmed by the crash stack pointing to line numbers
that don't match the current source.

**This is a version skew issue.** The local source has partially fixed the pattern but
the globally-installed binary has not been rebuilt/reinstalled.

### Secondary finding: `console.error()` in `setupPrimaryCleanup`

Even in the current source, `setupPrimaryCleanup()` still uses `console.error()` at line
799 (`[Dashboard] Primary shutting down (sync cleanup)`) and line 810. These are inside
signal handlers that can fire when stderr is already broken. They are not yet guarded.

---

## Problem Frame Packet

**The real question**: Is this a deployment/version issue (global binary is stale) or a
latent code bug that will resurface even after updating?

**Answer**: Both.

- **Immediate cause**: The globally-installed `@exaudeus/workrail` is an older build that has
  not received the `process.stderr.write()` hardening applied to the source. Reinstalling from
  the current source would eliminate the known crashes.

- **Latent bug**: Even in the current source, `setupPrimaryCleanup()` still uses
  `console.error()` in synchronous signal/exit handlers. Any signal arriving while stderr
  is broken will crash the process. This was not caught because `setupPrimaryCleanup()` runs
  after `wireStdoutShutdown()` -- but `wireStdoutShutdown()` only covers stdout, not stderr.

- **Deeper structural issue**: The stdio-entry.ts + HttpServer pattern calls `HttpServer.start()`
  as part of `composeServer()`, which happens before any I/O guards are installed. Any
  `console.error()` call inside that synchronous startup path is unguarded against a
  pre-broken stderr pipe.

---

## Candidate Directions

### Direction A -- Rebuild and reinstall the global binary (immediate fix)

Rebuild the compiled dist from the current source (which has most `process.stderr.write()`
hardening applied) and reinstall with `npm install -g`. This eliminates the known crash
paths in `printBanner`, `reclaimStaleLock`, and `start()`.

**Risk**: Does not address the remaining `console.error()` calls in `setupPrimaryCleanup`.
**Effort**: Low (5 min).

### Direction B -- Audit and convert all remaining `console.error()` calls in HttpServer startup/signal paths

A systematic grep for `console.error` in `HttpServer.ts` and `shutdown-hooks.ts` inside
paths that run before the process is fully started or inside signal handlers. Convert each
to `try { process.stderr.write(...); } catch { /* ignore */ }`.

**Risk**: Low. Well-established pattern already used elsewhere in the codebase.
**Effort**: Medium (1-2 hours).

### Direction C -- Guard stderr itself against EPIPE (parallel to stdout guard)

Add a `process.stderr.on('error', ...)` handler in `registerFatalHandlers()` or
`wireStdoutShutdown()` that swallows EPIPE without crashing. This would make the guard
transport-agnostic and prevent any future `console.error()` from causing a fatal crash.

**Risk**: Must be careful not to suppress genuine stderr errors. Only EPIPE/ERR_STREAM_DESTROYED
should be swallowed (same as the stdout guard).
**Effort**: Low (30 min). High leverage.

**Recommended direction**: C first (systemic fix, low effort), then B (belt-and-suspenders
for existing calls), then A (deploy).

---

## Challenge Notes

- The symptom ("restarts constantly") was actually the bridge correctly doing its job
  (reconnecting + respawning). The bridge is healthy. The primary is the patient.
- The crash.log is the primary diagnostic tool here. Without it, this would have been
  very hard to trace.
- The version skew between the global install and the local source obscured the fact that
  some of these fixes were already partially applied.

---

## Resolution Notes

**Root cause (precise)**: `process.stderr.write()` emits an `'error'` event (not a thrown exception) when the stderr pipe is broken (EPIPE). No error event listener exists on `process.stderr`. Node.js escalates the unhandled stream error to `uncaughtException`. `registerFatalHandlers()` catches it and calls `fatalExit()`. The process exits within 750-2100ms of every spawn.

**Why try/catch is ineffective**: The `try { process.stderr.write(...); } catch {}` wrappers already present in `HttpServer.ts` do NOT prevent the crash. Stream error events are asynchronous events, not synchronous throws. A try/catch only catches thrown exceptions. The only effective protection is `process.stderr.on('error', ...)`.

**Why Claude Code cannot receive a local fix**: `claude_desktop_config.json` uses `npx -y @exaudeus/workrail` which fetches the published npm latest version. Any fix must be published to npm. Immediate workaround: change the config to point to the local build.

---

## Decision Log

- Chose `landscape_first` because crash logs give direct evidence, not ambiguity.
- Did not delegate to subagents because all source files and logs fit in context.
- No web access needed; all evidence is local.
- Selected Candidate B (wireStderrShutdown extracted function) over A (inline guard) because: testable via DI, consistent with wireStdoutShutdown pattern, architecturally principled.
- Candidate C (converting console.error calls in HttpServer) is now confirmed OPTIONAL: the stderr event listener protects all stderr writes including those from console.error. try/catch wrappers are security theater for stream errors.
- Key insight from challenge phase: try/catch does not intercept stream 'error' events. This was validated by inspecting line 436 of the global binary (inside try/catch, yet still in the crash.log stack trace).

---

## Final Summary

**The MCP server keeps restarting because the stderr pipe has no error listener.**

When Claude Code reconnects rapidly, the stdio pipe closes before `HttpServer.start()` completes. When `HttpServer.start()` (or `reclaimStaleLock`, `printBanner`, `setupPrimaryCleanup`) writes to stderr while the pipe is broken, `process.stderr` emits an `'error'` event. No listener handles it. Node.js converts it to `uncaughtException`. `registerFatalHandlers()` calls `fatalExit()`. Process exits. Bridge detects death, respawns. Loop.

**The fix** (Candidate B): Add `wireStderrShutdown()` to `shutdown-hooks.ts` (mirror of `wireStdoutShutdown()`), call it in `stdio-entry.ts` BEFORE `composeServer()`. This is 15-20 lines following an existing pattern.

**Immediate workaround**: Change `~/Library/Application Support/Claude/claude_desktop_config.json` `command` from `npx` / args `["-y", "@exaudeus/workrail"]` to point at the local dev build's `dist/index.js` while the fix is being prepared for publish.

**Confidence**: High. The crash mechanism is precisely confirmed by crash.log stack traces, source inspection, and the Node.js stream error event model.

**Files to change**:
1. `src/mcp/transports/shutdown-hooks.ts` -- add `wireStderrShutdown()`
2. `src/mcp/transports/stdio-entry.ts` -- call `wireStderrShutdown()` before `composeServer()`
3. Publish to npm as a patch release

**Supporting artifacts**:
- `docs/design/mcp-server-disconnect-candidates.md` -- full candidate analysis
- `docs/design/mcp-server-disconnect-review.md` -- review findings and residual concerns
