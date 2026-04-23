# Console-Daemon Separation Discovery

## Context / Ask

**Stated Goal (solution statement):** Enforce strict separation between WorkRail Console, WorkTrain Daemon, and WorkRail MCP Server so none imports from or calls another at runtime. Each reads shared state (filesystem) independently and is fully independently restartable. A specific candidate was floated: split console reads (port 3456) from daemon control (port 3200) at the browser level.

**Reframed Problem:** The daemon's embedded console server holds live references to daemon internals, creating tight coupling that prevents independent restart. The core need is to keep control actions (dispatch, steer, force-poll) available in the browser UI without the console server holding live daemon object references.

## Path Recommendation

**Path: `design_first`** -- The goal was stated as a solution (strict zero-import separation + split-by-port). Before researching the landscape, the right move is to verify the problem framing and understand what constraints make certain solutions harder or easier. The stated solution may be correct but could also be over-engineering -- or it may be missing a simpler invariant (e.g. "no shared object lifecycle" rather than "no shared imports").

Rationale over alternatives:
- `landscape_first` would map the current codebase without challenging whether the solution direction is right -- premature if the framing is off.
- `full_spectrum` is warranted when both landscape grounding AND reframing are needed; here the reframing already happened in Step 1 and the landscape research is bounded to a few specific files.

## Constraints / Anti-goals

**Core constraints:**
- WorkRail MCP Server must not be destabilized (used in production by others)
- Control actions (dispatch, steer, force-poll) must remain accessible from the browser UI
- `npx vitest run` must pass after any changes
- No major architectural surgery -- this is a WorkTrain (daemon) concern, not a WorkRail MCP concern

**Anti-goals:**
- Do not add features to the MCP server to support this separation
- Do not remove control functionality from the UI -- degrading gracefully when daemon is down is acceptable, but removing buttons permanently is not
- Do not create a new inter-process communication protocol (e.g. message bus, event sourcing) if simpler approaches work

## Primary Uncertainty

Does the console frontend (`console/src/`) assume a single origin for ALL API calls, or does it already have the plumbing to call different backends? This is the single biggest unknown that determines whether split-by-port is cheap or expensive.

## Known Approaches

1. **Split by port at browser level** (stated candidate): Console server (3456) is filesystem-only. Daemon HTTP server (3200) gets control endpoints. Browser frontend calls both ports. CORS on localhost allows this.
2. **Thin HTTP proxy on the console server**: Console server proxies control actions to the daemon's HTTP server (3200) when it's available. No frontend changes needed. But the console server now has a runtime dependency on the daemon's port -- soft coupling via HTTP.
3. **Lock-file / sidecar protocol**: Console server reads a daemon lock file to discover if the daemon is running and on which port, then proxies selectively. Already partially done (`daemon-console.lock`). Extension of existing pattern.
4. **Remove control actions from the console entirely**: Control actions (dispatch, steer, force-poll) are moved to a CLI (`worktrain dispatch`, `worktrain steer`). Browser UI becomes purely read-only. Simplest architecturally; may be too limiting for the owner's workflow.

## Stakeholders

- Project owner (Etienne): primary user of the daemon; cares about architectural cleanliness and independent restartability
- External WorkRail MCP users: must not be affected

## Artifact Strategy

This document is a **human-readable artifact** for tracking discovery findings and decisions. It is NOT the execution truth for the workflow. Execution truth lives in WorkRail's durable step notes and context variables. If a chat rewind occurs, this file may be stale -- consult the WorkRail session notes as authoritative.

## Capability Notes

- **Delegation (WorkRail Executor):** Available -- routines including `wr.routine-context-gathering`, `wr.routine-hypothesis-challenge`, `wr.routine-tension-driven-design` are accessible.
- **Web browsing:** Not applicable for this discovery (all sources are local codebase files).
- **Fallback:** All context gathering will be done directly by reading source files. No external research needed.

## Landscape Packet

### Key Source Files Read

**`src/trigger/daemon-console.ts`** (daemon's embedded console server, port 3456)
- Imports `V2ToolContext` from `../mcp/types.js`, `TriggerRouter`, `SteerRegistry`, `PollingScheduler` from daemon internals
- Calls `mountConsoleRoutes()` passing all four live daemon handles as optional params
- Writes `~/.workrail/daemon-console.lock` with `{ pid, port }` on startup
- The `StartDaemonConsoleOptions` interface explicitly declares `triggerRouter?`, `steerRegistry?`, `pollingScheduler?` as optional params

**`src/v2/usecases/console-routes.ts`** (shared route layer, 1079 lines)
- `mountConsoleRoutes()` accepts 10 parameters; the last 3 are daemon-specific: `triggerRouter?`, `steerRegistry?`, `pollingScheduler?`
- Three control endpoints depend on these optional params:
  - `POST /api/v2/auto/dispatch` -- requires `v2ToolContext` and optionally `triggerRouter`; falls back to direct `runWorkflow()` if no router
  - `GET /api/v2/triggers` -- returns empty list if no `triggerRouter`
  - `POST /api/v2/triggers/:id/poll` -- returns 503 if no `pollingScheduler`
  - `POST /api/v2/sessions/:id/steer` -- returns 503 if no `steerRegistry`
- All control endpoints already have 503 / empty-list fallbacks when daemon handles are absent
- The standalone console (`src/console/standalone-console.ts`) calls `mountConsoleRoutes()` with `undefined` for all three daemon params -- this is working today

**`src/console/standalone-console.ts`** (the already-correct standalone implementation)
- Zero imports from `src/daemon/` or `src/trigger/`
- Constructs its own infrastructure adapters (LocalDataDirV2, LocalSessionEventLogStoreV2, etc.)
- Calls `mountConsoleRoutes()` with only `consoleService` -- all daemon params are `undefined`
- Writes the same `daemon-console.lock` file as the daemon console
- **This file is already the correct architecture.** The daemon console is the problem, not the standalone console.

**`src/trigger/trigger-listener.ts`** (daemon HTTP server, port 3200)
- `TriggerListenerHandle` already exposes `router`, `steerRegistry`, `scheduler` as public fields
- These were designed to be passed to `startDaemonConsole()` by the caller
- The trigger listener's Express app (`createTriggerApp()`) only handles `POST /webhook/:triggerId` and `GET /health` -- no console routes
- Port 3200 has no console routes today

**`src/mcp/handlers/session.ts`** (`handleOpenDashboard`)
- Reads `~/.workrail/daemon-console.lock` to discover the console port -- soft coupling via filesystem, not imports
- Falls back to `DEFAULT_CONSOLE_PORT` (3456) if lock file is absent
- This is an acceptable soft coupling (filesystem read, not a module import)

**Console frontend (`console/src/api/hooks.ts`)**
- **ALL API calls use relative paths** (`/api/v2/sessions`, `/api/v2/auto/dispatch`, etc.)
- The frontend assumes a single origin -- it is a pure SPA served from whatever host serves the static files
- `dispatchWorkflow()` calls `POST /api/v2/auto/dispatch` -- this is the one control action the frontend currently makes
- `useTriggerList()` calls `GET /api/v2/triggers` with a 503 fallback to empty list
- Steer and force-poll are NOT called from the frontend yet (no UI for these)

### Critical Finding: The Architecture Already Exists

`src/console/standalone-console.ts` is already the correct standalone implementation. It has NO daemon imports. The `mountConsoleRoutes()` layer already handles the absence of daemon handles gracefully (503s and empty lists). The standalone console today returns 503 for dispatch, steer, and poll when daemon handles are absent.

The `daemon-console.ts` embedded console is redundant -- it does the same thing as `standalone-console.ts` but passes live daemon handles. When the daemon runs, both the standalone console AND the daemon-embedded console would serve on port 3456, causing a port conflict. The lock file mechanism means only one can run at a time.

**The actual question is: should the daemon start a console server at all, or should users always run `worktrain console` separately?**

### Vite Base URL Configuration

Console frontend is built with a Vite config. All API calls use relative URLs -- there is no `VITE_API_BASE_URL` or similar abstraction. The frontend is tightly bound to its origin server.

## Problem Frame Packet

### The Real Problem (Narrowed)

The problem is NOT that separation is impossible -- `standalone-console.ts` already achieves it. The problem is that `daemon-console.ts` was added as a convenience so users don't have to run `worktrain console` separately when the daemon is running. This convenience introduced the coupling.

The "split by port at browser level" option is only relevant IF the daemon keeps its embedded console AND the browser needs to reach daemon-specific endpoints. But the embedded console's only purpose was to add the control endpoints (dispatch, steer, poll) to the browser UI.

**The tensions to resolve:**
1. **Convenience vs. separation**: should users start the console separately, or should the daemon start it for them?
2. **Control endpoints**: if the standalone console is filesystem-only (per strict separation), dispatch/steer/poll return 503. Is this acceptable?
3. **Single origin assumption**: the frontend uses relative URLs -- any "split by port" approach requires frontend changes to reach daemon:3200 directly.

## Candidate Generation Setup

**Path: design_first -- Requirements for the candidate set:**

1. At least one candidate must meaningfully REFRAME the problem instead of just packaging the obvious options. The obvious options are "keep daemon-console.ts with fewer imports" and "add control routes to trigger-listener.ts". A reframing would question whether the daemon needs a console server at all.

2. Candidates must span a genuine range of tradeoff positions:
   - One that maximizes separation purity (even at cost of functionality)
   - One that minimizes user friction (even at cost of architectural purity)
   - One that addresses the real root cause (redundancy of daemon-console.ts given standalone-console.ts already exists)

3. Each candidate must state what happens to the control actions (dispatch, steer, poll) and whether the frontend needs changes.

4. Given the single-origin frontend constraint, any candidate that proposes split-by-port MUST account for the frontend work required.

**Candidates MUST NOT be generated solely from the problem statement. They must reflect the actual code constraints discovered:**
- `standalone-console.ts` already works correctly with no daemon imports
- `mountConsoleRoutes()` already has 503 fallbacks for all control endpoints
- The frontend uses relative URLs exclusively
- `TriggerListenerHandle` already exposes `router`, `steerRegistry`, `scheduler` publicly

## Candidate Directions

### Candidate A: Delete daemon-console.ts, make standalone-console.ts the only console server (Simplest / Reframing)

**One-sentence summary:** Delete `daemon-console.ts` and its call site in daemon startup; the standalone console (`worktrain console`) is the only console server, and dispatch returns 503 in the browser UI.

**Tensions resolved:**
- Separation: complete. Standalone console has zero daemon imports.
- No redundancy: one console server, no lock-file collision risk.

**Tensions accepted:**
- UX regression: users must run `worktrain console` separately when using the daemon.
- The dispatch button in the browser returns 503 when running via the standalone console (daemon handles absent).

**Boundary:** The daemon startup path (`src/cli/commands/worktrain-daemon.ts` or equivalent). Remove the `startDaemonConsole()` call and delete `daemon-console.ts`.

**Failure mode to watch for:** Users don't know they need to run `worktrain console` separately; the dispatch button 503s confusingly. Mitigation: improve the 503 message to say "Dispatch requires the daemon; run `worktrain console` while the daemon is running to enable this."

**Relation to existing patterns:** The standalone console already exists and works. This candidate follows the existing architecture -- it just removes the redundant coupled variant.

**Gains:** Zero code to write. daemon-console.ts (~220 lines) deleted. No lock-file ambiguity. Architecturally clean.
**Gives up:** Daemon no longer auto-starts the console. Dispatch from browser only works when running standalone console alongside daemon.

**Philosophy alignment:** "Architectural fixes over patches" (A). "YAGNI" (A). "Make illegal states unrepresentable" (A -- eliminates the ambiguous dual-console state).
**Philosophy conflict:** None.

**Scope:** Best-fit. Deletes ~220 lines, removes one call site in daemon startup.

---

### Candidate B: Move control endpoints to trigger-listener.ts (port 3200), update frontend to use absolute URLs for control actions

**One-sentence summary:** Add `POST /dispatch`, `POST /sessions/:id/steer`, `POST /triggers/:id/poll` and `GET /triggers` to the daemon's existing HTTP server (port 3200), update the frontend to call `http://localhost:3200/...` for these control actions while reading sessions from the standalone console's relative URLs.

**Tensions resolved:**
- Separation: complete for read paths. Console server (3456) stays filesystem-only.
- Control actions work from browser UI when daemon is running.
- Daemon HTTP server (3200) already binds; no new port needed.

**Tensions accepted:**
- Frontend complexity: all four control endpoints (dispatch, steer, poll, triggers list) need absolute URLs pointing at 3200.
- `fetch('http://localhost:3200/dispatch')` from a page served at `http://localhost:3456` requires CORS headers on 3200 (which trigger-listener.ts does not currently set up).
- Frontend must detect daemon unavailability (port 3200 unreachable) and disable control buttons.

**Boundary:** `src/trigger/trigger-listener.ts` (add routes) + `console/src/api/hooks.ts` (change URLs for control calls) + CORS middleware on trigger-listener.ts.

**Failure mode to watch for:** The frontend must gracefully handle ECONNREFUSED when fetching from port 3200 (daemon not running). React Query's retry behavior may cause confusing UX. Also: trigger-listener.ts currently only handles webhook traffic; adding console-API-style routes to it changes its purpose from "webhook receiver" to "daemon HTTP API". That scope change may introduce coupling in the other direction.

**Relation to existing patterns:** Departs from existing pattern. `createTriggerApp()` is a pure webhook receiver today. Adding console routes to it means `console-routes.ts` imports from `trigger-listener.ts` or vice versa -- new cross-boundary coupling.

**Gains:** Complete separation of console server from daemon. Dispatch works from browser.
**Gives up:** Frontend changes required for all control endpoints. CORS added to trigger-listener.ts. trigger-listener.ts's purpose changes.

**Philosophy alignment:** "Dependency injection for boundaries" (A -- control deps injected at port 3200). "Architectural fixes over patches" (partially A).
**Philosophy conflict:** "YAGNI" -- adding frontend URL-management infrastructure and CORS to a previously simple webhook receiver.

**Scope:** Too broad. Touches frontend, trigger-listener.ts, CORS config, and browser availability detection -- for a feature (live browser dispatch) that only the project owner uses.

---

### Candidate C: Thin HTTP proxy on standalone console -- forward control actions to daemon:3200

**One-sentence summary:** The standalone console server (3456) proxies `POST /api/v2/auto/dispatch`, steer, and poll to `http://127.0.0.1:3200` when the daemon is detected as running (via lock-file or health check), returning 503 when it is not.

**Tensions resolved:**
- Frontend: zero changes needed. All relative URLs continue to work.
- Separation: standalone-console.ts has no daemon object imports. The proxy is an HTTP call, not an import.
- Dispatch works from browser UI when daemon is running; returns 503 when not.

**Tensions accepted:**
- Soft coupling: the console server now has a runtime dependency on the daemon's port. It must know the daemon's HTTP address (port 3200 or `WORKRAIL_TRIGGER_PORT`).
- Proxy adds request latency and a new failure mode (daemon listening on 3200 but unhealthy).
- The lock file or a new `daemon.lock` file must record the daemon's control port, not just the console port.

**Boundary:** `src/console/standalone-console.ts` (add proxy routes using `http-proxy-middleware` or a simple `fetch` forward) + a new `daemon-control.lock` file that records the daemon's port 3200.

**Failure mode to watch for:** Proxy silently failing (fetch timeout) when daemon is slow, leaving the browser spinner indefinitely. Also: circular routing if someone configures the console and daemon on the same port.

**Relation to existing patterns:** Adapts the existing lock-file discovery pattern (`daemon-console.lock`). The session.ts `readConsoleLockPort()` already reads a lock file to find the console -- the same pattern works for finding the daemon.

**Gains:** Zero frontend changes. Clean server-side separation. Works with the existing relative-URL frontend.
**Gives up:** New runtime HTTP dependency from console to daemon. Proxy failure modes. New lock file convention.

**Philosophy alignment:** "Errors are data" (proxy failures should be explicit 503/504, not silent). "Validate at boundaries" (proxy validates daemon availability before forwarding).
**Philosophy conflict:** "Architectural fixes over patches" -- a proxy is a patch that hides the coupling rather than eliminating it.

**Scope:** Best-fit. Changes only `standalone-console.ts` (add 3 proxy routes) and daemon startup (write a daemon-control.lock). No frontend changes.

---

### Candidate D: Daemon spawns standalone-console as a subprocess (Reframing 2)

**One-sentence summary:** Instead of the daemon having an embedded console server, it spawns `worktrain console` as a child process, which starts the fully-decoupled standalone console on port 3456.

**Tensions resolved:**
- Separation: complete. The console server runs as a separate process with its own module scope. No daemon objects leak into the console process.
- Daemon convenience: users don't need to manually start the console -- the daemon starts it.
- Lock file works naturally: the child process writes the lock file as it does today.

**Tensions accepted:**
- Process management complexity: the daemon must wait for the console to start (port bound), handle crashes (restart or accept failure), and stop it on daemon shutdown.
- Dispatch from browser returns 503 (child process has no daemon handles). Unless Candidate C's proxy is also added.
- The `worktrain console` binary must be resolvable from the daemon process (path resolution, version alignment).

**Boundary:** Daemon startup code -- replace `startDaemonConsole()` call with `child_process.execFile('worktrain', ['console'])` and a port-wait loop.

**Failure mode to watch for:** Path resolution for `worktrain console` binary fails in some environments (e.g. npm global vs. local installs). Also: zombie child processes if daemon crashes without cleaning up.

**Relation to existing patterns:** Departs significantly. No subprocess management exists in the current daemon startup path. Would require substantial new error handling.

**Gains:** True process isolation. Console module scope is separate from daemon module scope.
**Gives up:** Process management complexity. Dispatch still 503s without Candidate C's proxy.

**Philosophy alignment:** "Make illegal states unrepresentable" (process boundaries enforce separation).
**Philosophy conflict:** "YAGNI" -- subprocess management is significant complexity for a feature (true process isolation) that achieves less than Candidate A at higher cost.

## Challenge Notes

_To be filled in Step 5 (hypothesis challenge)_

## Resolution Notes

### Final Direction: Candidate A (Delete daemon-console.ts) with amended 503 message

**Direction changed from review?** No. The review confirmed the selected direction and surfaced two concrete implementation details:

1. RC1 (no `worktrain dispatch` CLI): The original 503 message improvement referenced a CLI command that does not exist. The message must be updated to say something like "Browser dispatch requires the WorkTrain daemon context. Run `worktrain console` while the daemon is running to enable dispatch." No CLI reference.

2. RC2 (daemon log suggestion): The daemon startup log should add a hint line suggesting the user run `worktrain console` separately. Small addition to cli-worktrain.ts.

**What the review did NOT change:** The recommendation to delete daemon-console.ts remains correct. No RED findings. The ORANGE finding (503 message) and YELLOW findings (stale JSDoc, signal handler cleanup) are all implementation details, not direction changers.

**Confidence:** HIGH. The codebase evidence is unambiguous. standalone-console.ts is already the correct architecture.

## Decision Log

- 2026-04-21: Goal classified as solution_statement. Reframed to focus on live-reference coupling, not just import coupling. Path set to design_first.
- 2026-04-21: Final selection: Candidate A -- delete daemon-console.ts. Runner-up: Candidate C (HTTP proxy) as optional follow-on if owner needs live browser dispatch. No direction change from review. Review findings: ORANGE-O1 (503 message must be improved + no worktrain dispatch CLI exists), YELLOW-Y1 (stale JSDoc), YELLOW-Y2 (signal handler cleanup), YELLOW-Y3 (launchd docs).

## Final Summary

### Selected Direction: Candidate A -- Delete daemon-console.ts

**Problem:** `src/trigger/daemon-console.ts` is a redundant coupled server that imports live daemon handles (`TriggerRouter`, `SteerRegistry`, `PollingScheduler`). It prevents the systems from being independently restartable and creates a tight coupling that the project owner wants to eliminate.

**Key landscape finding:** `src/console/standalone-console.ts` ALREADY implements the target architecture -- zero daemon imports, filesystem-only, independently startable. `mountConsoleRoutes()` already has 503 fallbacks for all control endpoints when daemon handles are absent.

**Why Candidate A wins:** It deletes the root cause (the redundant coupled server) rather than patching it. The standalone console is already correct. Net result: ~220 lines deleted, zero lines written.

**Strongest alternative (Candidate C -- HTTP proxy):** Would become the recommendation if the owner needs live browser dispatch without running a separate console process. The proxy approach adds 3 routes to standalone-console.ts that forward control actions to daemon:3200 via HTTP fetch. Zero frontend changes needed.

**Why the runner-up lost:** It adds complexity (proxy routes, a new lock file convention, proxy failure modes) to solve a problem (browser dispatch returning 503) that may not be a real pain point for a single-owner workflow.

**Confidence: HIGH.** The codebase evidence is unambiguous.

**Residual risk:** The owner may use browser dispatch regularly. If so, Candidate C is the right follow-on after A.

### Implementation Plan (Candidate A)

Files to change:

1. **DELETE `src/trigger/daemon-console.ts`** (~220 lines)
2. **DELETE `tests/unit/daemon-console.test.ts`** (tests for deleted file)
3. **`src/cli-worktrain.ts` lines ~370-449:** Remove `startDaemonConsole` import, call, and `consoleHandle` variable; update signal handler to not call `consoleHandle.stop()`; add a log line like `[Daemon] Start the console with: worktrain console`
4. **`src/v2/usecases/console-routes.ts` line ~758:** Update the POST /api/v2/auto/dispatch 503 message to: "Browser dispatch requires the WorkTrain daemon context. Run 'worktrain console' while the daemon is running to enable dispatch."
5. **`src/trigger/trigger-listener.ts` JSDoc lines ~81-88:** Remove the stale reference to `startDaemonConsole` in the `steerRegistry` field JSDoc
6. **(Optional) `docs/configuration.md`:** Document that users must run `worktrain console` separately when running the daemon

### Pivot Condition

If the owner says "I use browser dispatch regularly and want it to work automatically" -- implement Candidate C (thin HTTP proxy in standalone-console.ts forwarding control actions to daemon:3200) as a follow-on after A.

### Design Documents

- `docs/design/console-daemon-separation-discovery.md` -- this file (discovery notes)
- `docs/design/design-candidates-console-daemon-separation.md` -- full candidate analysis with tradeoffs
- `docs/design/design-review-findings-console-daemon-separation.md` -- review findings (ORANGE/YELLOW)
