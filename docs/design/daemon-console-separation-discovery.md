# Daemon Console Separation -- Architectural Discovery

## About This Document

This is a **human-readable artifact** capturing the discovery process and findings. It is NOT execution memory -- the workflow's durable state lives in WorkRail session notes and context variables. This doc is for the owner to read when reviewing the recommendation or handing work to a coding agent.

---

## Context / Ask

The owner wants STRICT separation between the three WorkTrain/WorkRail systems: the MCP server, the daemon, and the console. Currently the daemon starts an embedded console server (`src/trigger/daemon-console.ts`) that holds live references to daemon internals. This creates a port conflict with the standalone console and prevents the standalone console from being the single independently-runnable console process.

**Stated goal (solution-statement):** Split by port -- standalone console on 3456 reads filesystem, daemon control endpoints move to port 3200.

**Reframed problem:** The daemon and standalone console fight over port 3456 because the daemon embeds a console that duplicates the standalone console's role while adding live daemon object wiring -- yet the browser UI only needs dispatch access, not the full daemon wiring.

---

## Path Recommendation

**Path: `landscape_first`**

The reframed problem is well-understood from source reading. The dominant need now is comparing the viable architectural approaches (eliminate daemon-console entirely, split-by-port, proxy approach) against the actual constraints in the codebase. We already have enough problem grounding from Step 1 -- the landscape of options is the open question.

*Why not `design_first`*: The problem is already well-scoped. We know what's wrong. We need to know which fix is least disruptive and most maintainable.

*Why not `full_spectrum`*: The goal was a solution-statement but we already reframed it in Step 1. We have clear success criteria. No further reframing is needed.

---

## Constraints / Anti-goals

**Constraints:**
- The MCP server (`src/mcp/`) must be touched as little as possible -- it is used in production by people other than the owner
- The standalone console must remain independently runnable (no daemon dependency)
- The daemon's control operations (dispatch, steer, poll) must remain HTTP-accessible
- The browser UI dispatch button must continue to work

**Anti-goals:**
- Do not add auth or multi-user features in this change
- Do not move the webhook receiver (port 3200) off its current role
- Do not break existing `worktrain console` command behavior
- Do not require changes to the frontend's Vite dev proxy config unless absolutely necessary

---

## Landscape Packet

### Current State Summary

Three separate server processes share port 3456 and a single lock file (`~/.workrail/daemon-console.lock`):

1. **`src/console/standalone-console.ts`** (`worktrain console`) -- already filesystem-only, no daemon coupling. Calls `mountConsoleRoutes()` with no daemon objects (all optional params omitted). This is the CORRECT target state.

2. **`src/trigger/daemon-console.ts`** (started by `worktrain daemon`) -- starts another Express server on port 3456 that calls `mountConsoleRoutes()` with live daemon objects. Competes directly with the standalone console. Is the source of the coupling problem.

3. **`src/mcp/server.ts` / HttpServer** -- legacy MCP server console, writes `dashboard.lock`. Mostly retired but still present in some code paths.

### Actual Cross-Boundary Imports (the violations)

**Violation 1: `src/v2/usecases/console-routes.ts` imports from `src/daemon/`**
```
import type { SteerRegistry } from '../../daemon/workflow-runner.js';
import { runWorkflow } from '../../daemon/workflow-runner.js';
```
This puts daemon types into the shared console route layer. `v2/usecases/` is supposed to be the shared middle layer used by both the standalone console and the daemon. The daemon bleeding into it is a layering violation.

**Violation 2: `src/trigger/daemon-console.ts` imports from `src/mcp/types.js`**
```
import type { V2ToolContext } from '../mcp/types.js';
```
The trigger system importing from the MCP system is a soft violation (type-only import, not a hard runtime dependency), but it creates invisible coupling between `src/trigger/` and `src/mcp/`.

**Violation 3: `src/v2/usecases/console-routes.ts` imports from `src/trigger/`**
```
import type { TriggerRouter } from '../../trigger/trigger-router.js';
import type { PollingScheduler } from '../../trigger/polling-scheduler.js';
```
The shared v2/usecases layer imports from the trigger system. The layering rule should be: v2/usecases knows nothing about trigger internals.

### How the Port/Lock System Works

- `daemon-console.lock` is the single file read by all CLI commands (`worktrain spawn`, `worktrain trigger poll`, `worktrain await`) to discover the running console port
- The standalone console writes this file when it starts
- The daemon-console ALSO writes this file when it starts (they compete)
- `worktrain spawn` calls `POST /api/v2/auto/dispatch` against the discovered port
- `worktrain trigger poll` calls `POST /api/v2/triggers/:id/poll` against the discovered port
- `src/mcp/handlers/session.ts` `handleOpenDashboard()` reads the lock file to construct the dashboard URL

### Vite Dev Proxy

`console/vite.config.ts` proxies `/api` to `http://localhost:3456`. The built frontend uses relative URLs. This means:
- In development: all frontend API calls go to port 3456 (via Vite proxy)
- In production: all frontend API calls go to the same origin (port 3456) via relative paths
- **There is no mechanism for the frontend to reach port 3200 today**

### What Endpoints Live Where

**Port 3456 (daemon-console / standalone-console) via `mountConsoleRoutes()`:**
- `GET /api/v2/sessions` -- session list (filesystem read)
- `GET /api/v2/sessions/:id` -- session detail (filesystem read)
- `GET /api/v2/sessions/:id/nodes/:nodeId` -- node detail (filesystem read)
- `GET /api/v2/sessions/:id/events` -- per-session SSE (reads daemon event log file)
- `GET /api/v2/workspace/events` -- workspace SSE (watches sessions dir)
- `GET /api/v2/worktrees` -- worktree list (git commands + filesystem)
- `GET /api/v2/workflows` -- workflow catalog (filesystem)
- `GET /api/v2/triggers` -- trigger list (requires `TriggerRouter` injection; returns [] without it)
- `POST /api/v2/auto/dispatch` -- dispatch workflow (requires `V2ToolContext` + optional `TriggerRouter`)
- `POST /api/v2/triggers/:id/poll` -- force poll (requires `PollingScheduler` injection; returns 503 without it)
- `POST /api/v2/sessions/:id/steer` -- inject text into running session (requires `SteerRegistry`; returns 503 without it)

**Port 3200 (trigger-listener) via `createTriggerApp()`:**
- `GET /health` -- health check
- `POST /webhook/:triggerId` -- webhook receiver

### Browser Frontend API Usage

Only three control endpoints are called from the browser:
- `POST /api/v2/auto/dispatch` -- called from `DispatchPane.tsx`
- `GET /api/v2/triggers` -- called from `DispatchPane.tsx` (trigger list display)
- All others are read-only data display

**Steer and poll have ZERO frontend callers.** They are programmatic coordinator APIs only.

### CLI Commands and Their Console Port Usage

| Command | What it calls | Port used |
|---------|--------------|-----------|
| `worktrain spawn` | `POST /api/v2/auto/dispatch` | Discovers from `daemon-console.lock`, default 3456 |
| `worktrain trigger poll <id>` | `POST /api/v2/triggers/:id/poll` | Discovers from `daemon-console.lock`, default 3200 |
| `worktrain await` | Reads lock file for URL construction | daemon-console.lock port |
| `src/mcp/handlers/session.ts` | Reads lock file for URL construction | daemon-console.lock port |

### Existing Approaches / Precedents

The codebase already has a clean precedent: the standalone console (`standalone-console.ts`) calls `mountConsoleRoutes()` with all optional daemon params omitted. The endpoints that need daemon objects return `503 Service Unavailable` gracefully when those objects are not injected. This is the "degradation without error" pattern already designed in.

### Option Categories

Three architectural approaches are viable (see Candidate Directions section).

### Contradictions

- The comment in `daemon-console.ts` says it is "designed to be called from the daemon startup path so the console stays up as long as the daemon process runs" -- but if the standalone console is running, the daemon's console conflicts with it.
- `worktrain-trigger-poll.ts` has `DEFAULT_POLL_PORT = 3200` as a "spec requirement" but then says "in practice, the daemon console writes daemon-console.lock (port 3456)" -- the spec says 3200 but reality is 3456. This inconsistency suggests the spec and implementation diverged.
- `v2/usecases/console-routes.ts` is supposed to be a shared middle layer but it imports from `src/daemon/workflow-runner.js`. This is an upward dependency from the shared layer to the application layer.

### Evidence Gaps

- It is unknown whether the owner intends to ever add steer/poll UI controls in the browser
- It is unknown whether the daemon is expected to run simultaneously with `worktrain console` (they compete for port 3456 today -- does the owner expect one to take priority?)

---

## Problem Frame Packet

### Users / Stakeholders

- **Primary user:** Project owner -- a single developer who runs daemon + console locally
- **Secondary users:** None for daemon/console. External users only interact with the MCP server.
- **Affected indirectly:** External MCP users if MCP server is destabilized by changes

### Jobs, Goals, and Outcomes

- Run `worktrain console` as a standalone process that works whether or not the daemon is running
- Run the daemon without it conflicting with the standalone console
- Browser dispatch button (`DispatchPane`) works when the daemon is running
- Coordinator scripts can call steer and poll APIs when the daemon is running
- `worktrain spawn`, `worktrain trigger poll`, `worktrain await` CLI commands continue to work

### Pains / Tensions / Constraints

1. **Port conflict pain:** Daemon starts on port 3456, preventing `worktrain console` from binding. Owner must choose: run daemon OR run console. Can't run both simultaneously today.

2. **Layering violation pain:** `src/v2/usecases/console-routes.ts` -- intended as a shared layer -- imports from `src/daemon/` and `src/trigger/`. This means any change to daemon or trigger internals could break the console routes, and the console routes cannot be reasoned about independently.

3. **Ownership ambiguity:** Both `daemon-console.ts` and `standalone-console.ts` write the same lock file and bind the same port. Neither "owns" the console definitively. CLI tools read whichever wrote last.

4. **Dispatch coupling tension:** The dispatch button requires a live `V2ToolContext` (for `executeStartWorkflow`) and optionally a `TriggerRouter` (for queue serialization). These objects only exist inside the daemon process. The standalone console cannot dispatch autonomously without them.

### Success Criteria

1. `worktrain console` binds port 3456, serves sessions, and never errors out just because the daemon is or isn't running
2. When the daemon is running AND the standalone console is running, both processes work without port conflict
3. `POST /api/v2/auto/dispatch` from the browser UI succeeds when the daemon is running
4. `POST /api/v2/sessions/:id/steer` and `POST /api/v2/triggers/:id/poll` remain functional for coordinator scripts
5. `worktrain spawn` and `worktrain trigger poll` continue to work
6. No imports cross from `src/v2/usecases/` into `src/daemon/` or `src/trigger/`
7. `npx vitest run` passes

### Assumptions

- The owner wants daemon and standalone console to coexist simultaneously (not be mutually exclusive)
- Steer and poll will remain coordinator-script-only APIs (no browser UI for them)
- The browser frontend will NOT be rewritten to support dual-port API calls

### Reframes / HMW Questions

1. **HMW eliminate the daemon's embedded console entirely?** Instead of the daemon starting its own console, the standalone console could be the only console. The daemon adds its control surface (dispatch, steer, poll) to port 3200 or a new dedicated port (3201). The standalone console proxies dispatch requests to the daemon port, or the dispatch button in the browser is disabled when the daemon port is unreachable.

2. **HMW make dispatch work without the daemon holding objects?** Instead of `mountConsoleRoutes()` holding a live `TriggerRouter` reference, the dispatch endpoint could make an HTTP POST to the trigger-listener on port 3200 (`/webhook/:triggerId`) or a new `/dispatch` endpoint on 3200. This decouples the console from the daemon's object graph.

3. **HMW minimize the change surface?** The cleanest path might be: (a) remove the daemon's console startup from `cli-worktrain.ts`, (b) move the three control endpoints (`dispatch`, `steer`, `poll`) OUT of `mountConsoleRoutes()` and into a separate `mountDaemonControlRoutes()`, (c) the daemon mounts both on port 3200 (alongside `/webhook`), (d) the standalone console mounts only `mountConsoleRoutes()`, (e) CLI tools discover which port has control endpoints via separate lock files.

### What Would Make This Framing Wrong

- If the owner DOES want to run daemon and standalone console as mutually exclusive alternatives (not simultaneously), then port conflict is not a bug but a feature -- and the real problem is just the import layering violations
- If the owner wants to add steer/poll browser UI, the "steer and poll are API-only" assumption is wrong and the design needs to account for cross-port browser calls
- If the owner wants NO changes to `worktrain spawn` and `worktrain trigger poll` behavior, any solution that moves dispatch/poll to a different port must preserve the lock file discovery mechanism exactly

---

## Candidate Directions

*(To be populated in Phase 1)*

---

## Challenge Notes

*(To be populated in Phase 2)*

---

## Resolution Notes

*(To be populated in Phase 2)*

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-21 | Goal reclassified as solution_statement | "Split by port" names a specific approach, not the problem |
| 2026-04-21 | Path = landscape_first | Problem is well-understood; option landscape is the open question |

---

## Final Summary

*(To be populated at end of workflow)*
