# Design Review Findings: WorkRail Local Dev Environment Setup

> Raw investigative material for the main agent. Not a final decision.

## Tradeoff Review

**Manual server restart per build:** Acceptable. Build + restart cycle is ~10-20 seconds total. Criterion requires changes in under 2 minutes. Margin is large. Hidden assumption: tsc --watch incremental builds stay fast. Watch for this if codebase grows substantially.

**Two terminals required (watch + server):** Acceptable. Within the 3-5 tab setup described in CLAUDE.md. No criterion about terminal count.

**Port conflict on restart:** Partially handled. Server scans 3100-3199 but Claude config is hardcoded to 3100. If old process still occupies 3100, server binds to 3101 and Claude can't reconnect. Mitigation: `pkill` in `dev:mcp` script before starting. This must be included in the implementation.

## Failure Mode Review

**Port conflict (FM1 - MEDIUM):** Recoverable. Mitigation: `pkill -f 'dist/mcp-server.js' 2>/dev/null; sleep 0.5;` prefix in `dev:mcp` script. Without this, user must manually kill the old process. Not catastrophic but an annoying footgun.

**Config override semantics (FM2 - LOW-MEDIUM):** Unverified. Using `.mcp.json` (additive) instead of `.claude/settings.json` avoids the ambiguity of same-name server merge behavior. If Claude Code gives project `.mcp.json` precedence over global `settings.json` for same server name `workrail`, the setup works cleanly. If not, rename to `workrail-dev` in `.mcp.json` to avoid collision - user then has two workrail instances active (harmless but confusing).

**Tool call during restart window (FM3 - LOW):** Graceful. MCP SDK returns connection error, Claude surface it as tool error. User retries. Conversation not killed.

**Highest-risk failure mode:** FM2 (config override semantics) - most uncertain and could cause confusing behavior (two active workrail servers). Mitigated by using `.mcp.json` with consistent naming.

## Runner-Up / Simpler Alternative Review

**Runner-up (nodemon auto-restart):** Not ready. YAGNI - validate manual restart friction first. Two useful elements pulled into C2: (1) `pkill` cleanup before restart, (2) `--noEmitOnError` for tsc --watch to ensure only complete compilations emit to dist/.

**Simpler (stdio + local dist, C1):** Fails session safety. EPIPE crash is confirmed and happens on multi-agent use independent of deliberate restarts. C1 is not a viable floor.

**Hybrid (shell wrapper script):** Rejected. `pkill` inline in npm script is sufficient for solo dev. Extra file without benefit.

## Philosophy Alignment

**Satisfied:**
- Architectural fixes over patches (HTTP transport eliminates session coupling; EPIPE not patched, bypassed)
- YAGNI (no new deps; nodemon deferred)
- Determinism (explicit, reproducible 2-file setup)
- Type safety (compiled dist/, not tsx interpreted)
- Document why (design doc explains rationale)

**Tensions (both acceptable):**
- `Validate at boundaries`: `.mcp.json` override precedence unverified - acceptable because observable and reversible
- `Errors are data`: `pkill` uses shell exit codes - acceptable for dev-only tooling script

## Findings

### ORANGE: Config override semantics unverified
The assumption that project `.mcp.json` shadows global `settings.json` for the same server name `workrail` has not been empirically validated. Risk: both npm-published workrail AND local HTTP workrail are loaded simultaneously. Impact: confusing duplicate tool registration. Recovery: rename local server to `workrail-dev` in `.mcp.json`.

**Recommended action:** Observe at first use. If both servers appear in `/mcp` menu, use `workrail-dev` name in `.mcp.json`.

### YELLOW: Port conflict footgun without mitigation
Without `pkill` in the `dev:mcp` script, restarting the server after it was previously started will attempt to bind port 3100. If the old process is still in cleanup, the new one binds to 3101+. Claude cannot reconnect.

**Recommended action:** Include `pkill -f 'dist/mcp-server.js' 2>/dev/null; sleep 0.5;` in the `dev:mcp` script.

### YELLOW: tsc --watch may emit partial dist/ on errors
Without `--noEmitOnError`, `tsc --watch` emits partial output when there are compilation errors. If the user restarts the server after a build with errors, the server runs partially-compiled code.

**Recommended action:** Update the watch script to `tsc --watch --noEmitOnError` (or add `--noEmitOnError` to tsconfig.json).

## Recommended Revisions

1. **`.mcp.json` modification** (use instead of `.claude/settings.json` to avoid config merge ambiguity):
   ```json
   {
     "mcpServers": {
       "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
       "workrail": { "type": "http", "url": "http://localhost:3100/mcp" }
     }
   }
   ```

2. **`package.json` scripts addition** (with port-cleanup and session tools):
   ```json
   "dev:mcp": "pkill -f 'dist/mcp-server.js' 2>/dev/null; sleep 0.5; WORKRAIL_TRANSPORT=http WORKRAIL_ENABLE_SESSION_TOOLS=true node dist/mcp-server.js"
   ```

3. **tsconfig update** (add `noEmitOnError: true` to tsconfig.build.json or the watch-used tsconfig):
   Prevents partial dist/ writes on compilation errors.

4. **CLAUDE.md dev loop documentation:**
   ```
   ## Local Dev Loop
   - Terminal 1: npm run watch (auto-recompiles; only emits on success)
   - Terminal 2: npm run dev:mcp (HTTP server on port 3100; Ctrl+C and re-run after each build)
   - Claude Code: started from workrail repo; uses local HTTP server (see .mcp.json)
   - After a build: kill Terminal 2 server, wait 1s, restart
   ```

## Residual Concerns

1. **Auto-reconnect behavior on server restart:** Changelog evidence confirms Claude Code auto-reconnects to HTTP/SSE MCP servers. However, the specific behavior when the server is killed and restarted on the same port (vs connection drop/reconnect on same persistent server) is slightly different. The `Fixed MCP tool calls hanging indefinitely when SSE connection drops mid-call and exhausts reconnection attempts` entry suggests reconnect is automatic but may have retry limits. If Claude Code stops trying after N attempts, the user may need to use `/mcp reconnect` manually.

2. **`noEmitOnError` and existing tsconfig:** The current `tsconfig.build.json` and base tsconfig may or may not already have `noEmitOnError`. Check before adding to avoid duplicate config.

3. **Workrail `.mcp.json` entry conflicts with production use:** When developing workrail and running Claude Code from the workrail repo, the `.mcp.json` HTTP entry will be used instead of the global npm-published workrail. This means the local dev workrail handles its own workflow sessions during dev. This is intentional (eating your own dogfood) but worth being aware of.
