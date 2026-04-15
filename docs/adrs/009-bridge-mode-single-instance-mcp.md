# ADR 009: Bridge Mode for Single-Instance MCP Server

**Status:** Accepted and Implemented  
**Date:** 2026-04-14  
**PR:** EtienneBBeaulac/workrail#350 (cross-project lock guard), #353 (bridge resilience)

---

## Context

### The problem

WorkRail's MCP server uses a single global lock file (`~/.workrail/dashboard.lock`) to
coordinate which process owns the dashboard and session management. The lock's reclaim
logic unconditionally kills the owner on version mismatch (`shouldReclaimLock` in
`HttpServer.ts`).

In practice, multiple `npx @exaudeus/workrail` processes start independently:
- One per open Claude Code session (HTTP transport, port 3100)
- One per firebender worktree session (stdio transport)
- One per Cursor / Windsurf MCP connection

When firebender opens a worktree with a different npx-cached version, it starts a fresh
workrail process. That process reads the lock, sees a version mismatch, and sends SIGTERM
to the running primary — killing it for all connected clients. Port 3100 goes dark.

Root cause: the lock reclaim strategy was designed for single-session upgrades, not
multi-client concurrent use.

### Why a simple fix wasn't enough

Two obvious patches were evaluated and rejected or supplemented:

**Option A — cross-project guard only (PR #350):** Add a check to `shouldReclaimLock`
that skips reclaim when the existing lock belongs to a different project. This stops the
kill, but still leaves N competing server processes running — each consuming memory,
each capable of locking resources.

**Option B — sidecar `workflow-tags.json` per managed source:** Requires both a workrail
code change AND a common-ground distribution change to deliver value. Two-step rollout;
ships as Option A interim fix meanwhile.

**Chosen: bridge mode** — secondary instances detect a healthy primary and start as a
thin stdio↔HTTP proxy instead. One server, N lightweight bridges. No lock competition.

---

## Decision

### Architecture

```
IDE/firebender (stdio) ←→ WorkRail bridge ←→ primary WorkRail (:3100 HTTP)
                                                     ↑
                           Claude Code (HTTP) ────────
                           Cursor (HTTP)      ────────
```

**Primary:** one workrail process, HTTP transport, owns the dashboard lock, serves all
sessions. Started as the first workrail instance or after bridge-triggered respawn.

**Bridge:** any subsequent stdio workrail start that finds a healthy primary. Wires
`StdioServerTransport` and `StreamableHTTPClientTransport` together at the SDK Transport
interface level. Stateless — carries no session state itself.

**Auto-detection:** `mcp-server.ts` checks `http://localhost:3100/workrail-health` before
the transport switch. If `{service:"workrail"}` is returned, starts as a bridge. Uses
`/workrail-health` (not `/mcp`) to distinguish WorkRail from any other HTTP server on
the port.

### Primary death + automatic respawn

When the primary dies, all bridges detect `httpTransport.onclose`. Each bridge:

1. Runs `reconnectWithBackoff` with exponential backoff (250ms → 32s, up to 8 attempts).
2. If primary comes back: reconnects silently. IDE client never knows.
3. If exhausted and respawn budget remains: spawns a new primary via
   `child_process.spawn(process.execPath, [process.argv[1]])` with
   `WORKRAIL_TRANSPORT=http`. Jitter (0–300ms) + post-jitter detection check reduces
   stampede when multiple bridges exhaust simultaneously.
4. Restarts reconnect loop with decremented respawn budget.
5. If budget exhausted: shuts down cleanly.

**Why bridges don't exit on primary death:** HTTP-mode IDE clients (Claude Code, Cursor,
Windsurf) do NOT restart the MCP command on disconnect — only pure stdio clients do.
Exiting would leave HTTP clients permanently disconnected. The bridge must self-heal.

**Respawn budget semantics:** `maxRespawnAttempts` (default 3) is a per-death-cycle
budget, NOT a lifetime budget. Each time the primary closes the connection, `t.onclose`
reseeds the budget. A long-running bridge that survives multiple crashes over hours gets
3 spawn attempts per crash. The budget is a rapid-crash guard, not a lifetime cap.

### Tool calls during reconnect

Rather than silently dropping messages (causing MCP timeouts and agent hangs), the bridge
returns an immediate JSON-RPC error with human-readable instructions: retry in a few
seconds; if persistent, tell the user to check the workrail terminal and run `/mcp`.

### Defense-in-depth: cross-project lock guard

`shouldReclaimLock` in `HttpServer.ts` has an additional guard (added in PR #350):
a live process whose lock carries a different `projectId` is never killed, regardless
of version mismatch. This covers the case where bridge detection fails (primary briefly
unresponsive during the detection window) and a secondary accidentally starts as a full
server.

---

## Key files

| File | Role |
|------|------|
| `src/mcp/transports/bridge-entry.ts` | Bridge implementation — detection, reconnect, spawn, state machine |
| `src/mcp/transports/http-entry.ts` | Adds `/workrail-health` endpoint for detection |
| `src/mcp-server.ts` | Auto-detection before transport switch |
| `src/infrastructure/session/HttpServer.ts` | Cross-project lock guard in `shouldReclaimLock` |
| `tests/unit/mcp/transports/bridge-entry.test.ts` | Unit tests — 30 cases covering all state paths |

---

## Design invariants

**ConnectionState is a sealed discriminated union.** No boolean flags. The `reconnecting`
variant carries `respawnBudget` so all relevant state travels together. State transitions
are explicit and exhaustive.

**`t.onclose` is idempotent.** If a reconnect loop is already running, a second close
event is a no-op. Prevents concurrent loops from a rapidly-flapping connection.

**`handleReconnectOutcome` is a named, exported, testable function.** All state
transitions after `reconnectWithBackoff` resolves go through this function. Callers
switch exhaustively on `ReconnectOutcome`.

**Single shutdown path.** All shutdown triggers (stdin close, stdout error, SIGINT,
SIGTERM, SIGHUP, budget exhausted) funnel to `performShutdown(reason)`.

**Injectable side effects.** `SpawnLike` and `FetchLike` are injected, not called
directly. Tests use injected fakes — no `vi.stubGlobal`, no real child processes.

**`child_process` uses dynamic `await import()`**, not `require()`. This module compiles
to ESM where `require` is not defined.

---

## Known limitations and gaps

**`process.exit` is not injectable.** `performShutdown` calls `process.exit(0)` directly.
Testing the full shutdown path would require restructuring the entire process lifecycle
model. Accepted as YAGNI.

**Spawn uses `process.argv[1]`** (the current script path). This is correct when workrail
is run via `npx @exaudeus/workrail` — `argv[1]` points to the cached script. It would be
wrong if the process was started without a script path (e.g. as a Node.js REPL). Guarded
with a null check that logs and skips spawn.

**`Math.random()` jitter in `spawnPrimary` is non-deterministic.** This intentionally
prevents spawn stampede when multiple bridges exhaust simultaneously. The jitter is
bounded (0–300ms) and documented. Tests work around it by mocking `fetch` to resolve
immediately regardless of jitter timing.

**The initial `connectionState` is `'reconnecting'`** before the first connection attempt
completes. It is immediately overwritten to `'connected'` on success, and the
`reconnecting` state is only used for message routing — never observed externally during
initial startup. A dedicated `'connecting'` variant would be more precise but is YAGNI.

**Multiple bridges may spawn concurrently** if jitter doesn't fully prevent stampede.
Only one will win the lock election; others go to legacy mode (port 3457+). Harmless but
wasteful. Post-jitter detection check mitigates this in the common case.

**Bridges cannot promote themselves to primary in-process.** When a bridge needs to
become primary, it spawns a new OS process rather than transitioning in-place. In-process
promotion would require `server.connect()` on an already-started `StdioServerTransport`,
which the MCP SDK does not support (throws on second `start()` call).

---

## Alternatives considered and rejected

**Sidecar `workflow-tags.json` per managed source** — solves tag discovery but not the
kill problem. Orthogonal to bridge mode.

**LaunchAgent/systemd supervisor** — keeps the primary alive via OS-level process
supervision. Effective but requires out-of-band setup by the user; not self-contained.
Could complement bridge mode in the future.

**In-process bridge-to-primary promotion** — when all reconnects fail, transition the
current process to a full server using the existing `StdioServerTransport`. Rejected
because `StdioServerTransport.start()` throws if called twice, and patching around SDK
internals violates the "use libraries intentionally" principle.

**Longer reconnect window / infinite retries** — extend the reconnect window so long that
the primary respawns via external means (OS supervisor) before the bridge gives up.
Rejected because it relies on external setup the user may not have. Bridge-spawned
respawn is self-contained.
