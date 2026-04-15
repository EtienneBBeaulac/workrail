# Design: WorkRail Local Dev Environment Setup

> This is raw investigative material for the main agent. It is not a final decision.
> Execution truth lives in WorkRail session notes. This document is for human readability.

## Problem Understanding

### Core Tensions

1. **Session continuity vs iteration speed**: The fastest change cycle (rebuild + restart server) is
   incompatible with session continuity in stdio mode. HTTP transport resolves this architecturally,
   but only if Claude Code auto-reconnects after server restart - which is unverified.

2. **Local dev config vs production config**: Need local `dist/` for dev, but must not break
   `npx @exaudeus/workrail` for other projects. Project-level `.claude/settings.json` `mcpServers`
   solves this - but the override semantics (same server name, project vs global) are unverified.

3. **Zero new deps vs automation quality**: Simplest fix (no new tools) requires manual server restart
   after each build. Adding nodemon or tsx automates this but introduces dependencies.

4. **stdio correctness vs dev ergonomics**: stdio is the standard MCP transport but is session-coupled
   AND has a confirmed EPIPE bug. HTTP is non-standard for dev but provides session decoupling.

### What Makes It Hard

1. **The auto-reconnect assumption is unverified.** Claude Code's behavior when an HTTP MCP server
   restarts mid-session cannot be determined from code inspection alone. A probe is required.

2. **Config override semantics are unverified.** Whether project-level `.claude/settings.json`
   `mcpServers` overrides the same key in global settings (for the same server name `workrail`) when
   Claude Code is started from within the workrail repo has not been tested.

3. **Root cause is confirmed but non-patchable.** The MCP SDK `StdioServerTransport.start()` registers
   error listeners ONLY on stdin, never stdout. EPIPE on stdout -> unhandled stream error ->
   `process.exit(1)`. Confirmed by prior bug investigation (sess_wrlporvrlv7kv5njoix5isc6gi).
   Cannot be fixed without patching `@modelcontextprotocol/sdk`.

### Likely Seam

Two change surfaces, both non-source:
1. `~/git/personal/workrail/.claude/settings.json` - new file, project-scoped MCP override
2. `~/git/personal/workrail/package.json` - new `dev:mcp` script (adapts existing `web:dev`)

No source code changes required.

### Naive Solution and Why It's Insufficient

**Naive**: Add `node /path/to/dist/mcp-server.js` to project-level `.claude/settings.json`.
- Eliminates npm round-trip: YES
- Solves EPIPE crash: NO (stdio mode still crashes on pipe break)
- Preserves production config: YES
- **Insufficient**: Fails the session safety criterion - EPIPE still kills the session.

## Philosophy Constraints

Relevant principles from `CLAUDE.md`:

- **Architectural fixes over patches**: HTTP transport (decouples lifecycle) > suppressing EPIPE errors
- **YAGNI with discipline**: Don't add tsx/nodemon until manual HTTP restart is proven insufficient
- **Validate at boundaries**: HTTP reconnect behavior must be probed at the actual Claude Code boundary
- **Determinism over cleverness**: Explicit setup (two config changes) over a clever shell script
- **Type safety**: Compiled JS (dist/) preserves type correctness; tsx interpreted mode does not

**No philosophy conflicts found.** Recommended approach honors all five relevant principles.

## Impact Surface

- `package.json` `scripts`: adding `dev:mcp` - no dep changes, no behavioral change for other scripts
- `.claude/settings.json` (new file): only affects Claude Code sessions started from workrail repo root
- Production `~/.claude/settings.json`: UNCHANGED - global config still points to npm package
- `tsc --watch`: already exists - no change needed
- Other repos: unaffected - project-level settings only apply when Claude Code CWD is inside the repo

## Candidates

### Candidate 1: Local dist via stdio (simplest possible change)

**Summary:** Point project `.claude/settings.json` at `node dist/mcp-server.js` (local compiled JS,
stdio transport) instead of `npx @exaudeus/workrail`.

**Tensions resolved:**
- No npm publish round-trip

**Tensions accepted:**
- Session still killed on server crash/restart (EPIPE bug persists)
- stdio remains session-coupled by design

**Boundary solved at:** `~/git/personal/workrail/.claude/settings.json` (new file, `command: node`,
`args: ["/Users/etienneb/git/personal/workrail/dist/mcp-server.js"]`)

**Why this boundary:** Narrowest change - routes Claude to local dist without touching global config.

**Failure mode:** EPIPE on stdout crashes process, kills Claude session. Happens on any multi-agent
operation after 60s timeout or concurrent writes. Not hypothetical - confirmed by bug investigation.

**Repo pattern:** Follows - uses existing `dist/mcp-server.js` entry point unchanged.

**Gains:** Zero deps. Zero new infrastructure. No npm publish. Simple.

**Gives up:** Session safety (still crashes on EPIPE). Cannot rebuild mid-session without losing state.

**Impact surface:** Only affects Claude Code sessions started from workrail repo.

**Scope judgment:** Too narrow - solves the npm publish problem but not the session safety problem.
Evidence: EPIPE bug is confirmed by source code inspection + empirical proof from prior investigation.

**Philosophy fit:**
- Honors YAGNI
- Conflicts with 'architectural fixes over patches' (EPIPE crash is unaddressed)

---

### Candidate 2: HTTP transport + project-level config + manual server restart (recommended)

**Summary:** Add `dev:mcp` script to `package.json` (HTTP transport mode) and configure
`~/git/personal/workrail/.claude/settings.json` with `type: http, url: http://localhost:3100/mcp`,
adapting the existing `web:dev` script pattern.

**Config file:**
```json
// ~/git/personal/workrail/.claude/settings.json
{
  "mcpServers": {
    "workrail": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

**Script addition to package.json:**
```json
"dev:mcp": "WORKRAIL_TRANSPORT=http WORKRAIL_ENABLE_SESSION_TOOLS=true node dist/mcp-server.js"
```

**Dev loop:**
- Terminal 1: `npm run watch` (tsc --watch, auto-recompiles on TS change)
- Terminal 2: `npm run dev:mcp` (HTTP server; restart manually after each build)
- Claude Code: connects via HTTP; session survives server restarts

**Tensions resolved:**
- Session safety: HTTP decouples server lifetime from Claude Code session
- No npm publish round-trip: uses local `dist/mcp-server.js`
- Production config untouched: override scoped to workrail repo only

**Tensions accepted:**
- Manual server restart required after each build (tsc --watch doesn't trigger restart)
- HTTP reconnect behavior unverified (must validate with probe before committing)

**Boundary solved at:** Two minimal config changes - no source code touched.

**Why this boundary is best fit:** Both seams separate 'what the server runs' from 'how the client
connects'. `package.json` script encapsulates the HTTP transport invocation. `.claude/settings.json`
scopes the HTTP config to the workrail repo specifically.

**Failure mode:** If Claude Code 2.1.104 does NOT auto-reconnect after HTTP server restart, user must
manually re-init Claude session after each restart. Session history is preserved; but active tool calls
in progress would fail. Marginal improvement over Candidate 1 in that scenario.

**Repo pattern:** Adapts `web:dev` script - which already uses `WORKRAIL_ENABLE_SESSION_TOOLS=true node
dist/mcp-server.js` but is missing `WORKRAIL_TRANSPORT=http`. The `.mcp.json` at repo root already
shows `type: http` for GitHub Copilot, proving Claude Code reads project-level HTTP MCP configs.

**Gains:**
- Session safety (EPIPE no longer kills Claude session)
- No new dependencies
- Production config unchanged
- Easy to evolve to Candidate 3 if manual restart is too slow

**Gives up:**
- Manual server restart per build cycle (~2-5 extra seconds)
- Auto-reconnect behavior unverified (probe required)

**Impact surface:** Two file changes (new `.claude/settings.json`, one new script in `package.json`).
Zero source changes. Zero production impact.

**Scope judgment:** Best-fit. Satisfies all 5 decision criteria. Changes are minimal and reversible.

**Philosophy fit:**
- Honors 'architectural fixes over patches' (HTTP decouples lifecycle; EPIPE no longer relevant)
- Honors YAGNI (no new deps)
- Honors 'validate at boundaries' (explicit probe step before committing)
- Honors 'determinism' (explicit, reproducible setup)

---

### Candidate 3: HTTP transport + nodemon auto-restart on dist/ change

**Summary:** Add `nodemon` as a dev dependency with a `dev:mcp:watch` script that watches `dist/`
and auto-restarts the HTTP server whenever `tsc --watch` recompiles.

**Script:**
```json
"dev:mcp:watch": "WORKRAIL_TRANSPORT=http WORKRAIL_ENABLE_SESSION_TOOLS=true nodemon --watch dist --ext js --delay 2 --exec 'node dist/mcp-server.js'"
```

**Dev loop:**
- Terminal 1: `npm run watch` (tsc --watch)
- Terminal 2: `npm run dev:mcp:watch` (nodemon watching dist/, auto-restarts after compile)
- Claude Code: connects via HTTP; changes take effect automatically

**Tensions resolved:**
- Session safety (same as Candidate 2)
- No npm publish (same as Candidate 2)
- Manual restart eliminated: nodemon auto-restarts after tsc emits to dist/

**Tensions accepted:**
- New dev dependency (nodemon)
- Race condition: nodemon may fire before tsc completes writing all files; `--delay 2` mitigates

**Boundary solved at:** Same as Candidate 2 plus `package.json` dep addition.

**Failure mode:** Race condition between tsc and nodemon - if nodemon restarts the server while tsc
is still writing files, the server starts with a partial dist/. `tsc --noEmitOnError` reduces risk
(only emits when full compilation succeeds) but does not eliminate race on multi-file changes.

**Repo pattern:** Departs from existing patterns (no watch tooling in this project). Common externally.

**Gains:** Fully automated dev loop. TypeScript change -> live in Claude in ~5-15 seconds.

**Gives up:** One new dev dependency. Race condition complexity. More moving parts to debug.

**Impact surface:** `package.json` dep + script. No source changes.

**Scope judgment:** Slightly too broad for first iteration - better to validate Candidate 2 works
before automating it. Evidence: unknown whether manual restart friction will be a real problem.

**Philosophy fit:**
- Conflicts with YAGNI (adding nodemon before validating need)
- Partially conflicts with 'determinism' (race condition is non-deterministic)

## Comparison and Recommendation

### Recommendation: Candidate 2

**Summary of reasoning:**
Candidate 2 is the only option that satisfies all 5 decision criteria. It uses HTTP transport
(the architectural fix) without adding dependencies (YAGNI). The manual restart overhead is ~5 seconds
per build cycle - acceptable given the alternative is losing the entire Claude session.

**Versus Candidate 1:** C1 fails session safety. The EPIPE crash is confirmed and inevitable under
multi-agent use. C1 does not solve the core problem - it only eliminates the npm round-trip.

**Versus Candidate 3:** C3 is the right upgrade path if C2's manual restart proves too slow, but
YAGNI says don't add the dep until that friction is confirmed. C3 also introduces a race condition.

**Convergence signal:** All candidates that use HTTP transport (C2, C3) are structurally the same.
The only difference is automation level. This convergence is honest - HTTP transport IS the fix.

### Self-Critique

**Strongest argument against C2:** The HTTP auto-reconnect assumption is UNVERIFIED. If Claude Code
2.1.104 does not auto-reconnect after HTTP server restart, the benefit of C2 over C1 is:
- C2: session history preserved, no EPIPE kill, but still requires manual Claude re-init
- C1: session killed, restart Claude, session history lost

In the worst case, C2 is marginally better but the session still needs human intervention after
each server restart. The probe MUST be done first.

**Why C1 lost:** EPIPE doesn't only happen on deliberate restarts - it happens on multi-agent
concurrent writes and 60s timeouts. C1 makes the source of crashes less obvious (was it EPIPE or
was it a bug in my new code?) without solving the core problem.

**What would make C3 justified:** If the user does >5 manual restarts per dev session, or if builds
take >30 seconds making the round-trip feel expensive. Evaluate after 1-2 weeks of using C2.

**Pivot conditions:**
- C2 -> C3: Manual restart friction confirmed unacceptable in practice
- C2 -> C1: HTTP transport has unexpected Claude Code compatibility issues
- C2 -> investigate proxy layer: Claude Code doesn't auto-reconnect but full session continuity is required
- Any -> re-triage: MCP SDK fixes the stdout EPIPE bug (would make stdio viable again)

## Open Questions for the Main Agent

1. **CRITICAL - Validate before implementing:** Does Claude Code 2.1.104 `type: http` MCP transport
   auto-reconnect to a server that has restarted on the same port? Validation procedure:
   - Start HTTP server: `WORKRAIL_TRANSPORT=http node dist/mcp-server.js`
   - Configure `.claude/settings.json` with `type: http, url: http://localhost:3100/mcp`
   - Start Claude Code in workrail repo; confirm workrail MCP tools are available
   - Kill the HTTP server process (`Ctrl+C` in Terminal 2)
   - Restart the server: `WORKRAIL_TRANSPORT=http node dist/mcp-server.js`
   - Try a workrail MCP tool call in Claude Code - does it work without restarting Claude?

2. **Config override semantics:** Does project-level `.claude/settings.json` `mcpServers.workrail`
   actually override (replace) the global `~/.claude/settings.json` `mcpServers.workrail` entry when
   Claude Code is started from the workrail repo? Or does it ADD alongside the global entry?
   - If it replaces: Candidate 2 works as designed
   - If it adds alongside: Two `workrail` MCP servers may conflict; may need to use a different name
     (e.g., `workrail-dev`) and `CTRL+K` to select which one

3. **Port conflict management:** If a previous `dev:mcp` process is still alive when you restart,
   port 3100 is taken. The server scans up to 3199, but Claude config is hardcoded to 3100.
   Consider adding `pkill -f 'dist/mcp-server.js'` to the `dev:mcp` script, or document as a
   known manual step.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-13 | Chose `landscape_first` path | Problem concrete; key unknown is HTTP transport reconnect behavior |
| 2026-04-13 | Recommended C2 over C1 | HTTP decouples lifecycle; stdio EPIPE confirmed unfixable without SDK patch |
| 2026-04-13 | Deferred nodemon (C3) | YAGNI - validate manual restart friction before adding dep |
| 2026-04-13 | HTTP auto-reconnect assumption resolved | Claude Code changelog confirms auto-reconnect for HTTP/SSE MCP servers |
| 2026-04-13 | Use .mcp.json not .claude/settings.json | Avoids config merge ambiguity; .mcp.json is established project-scoped format |
| 2026-04-13 | Added pkill prefix to dev:mcp script | Prevents port 3100 conflict footgun on server restart |
| 2026-04-13 | Recommend noEmitOnError for watch | Prevents partial dist/ writes on compilation errors |
| 2026-04-13 | Finalized C2 as recommendation | High confidence; all failure modes have mitigations; 1 residual gap (config override semantics, observable at first use) |

## Final Recommendation

**Direction:** Candidate 2 - HTTP transport + project-level `.mcp.json` override + manual restart

**Confidence: HIGH**

### What to do (in order)

1. **Update `.mcp.json`** at `~/git/personal/workrail/.mcp.json`:
   ```json
   {
     "mcpServers": {
       "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
       "workrail": { "type": "http", "url": "http://localhost:3100/mcp" }
     }
   }
   ```

2. **Add `dev:mcp` script to `package.json`**:
   ```json
   "dev:mcp": "pkill -f 'dist/mcp-server.js' 2>/dev/null; sleep 0.5; WORKRAIL_TRANSPORT=http WORKRAIL_ENABLE_SESSION_TOOLS=true node dist/mcp-server.js"
   ```

3. **Verify `noEmitOnError` in tsconfig** (add to `tsconfig.json` or `tsconfig.build.json` if not present):
   ```json
   "noEmitOnError": true
   ```

4. **Dev loop (document in CLAUDE.md):**
   - Terminal 1: `npm run watch` (tsc --watch, auto-recompiles)
   - Terminal 2: `npm run dev:mcp` (HTTP MCP server; Ctrl+C + re-run after each build)
   - Claude Code: started from workrail repo; uses local HTTP server via `.mcp.json`

5. **Validation probe at first use:**
   - Start Terminal 2 with `npm run dev:mcp`
   - Start Claude Code in workrail repo; verify workrail tools are available
   - Kill Terminal 2 (Ctrl+C), wait 1s, restart with `npm run dev:mcp`
   - Try a workrail tool call - should reconnect automatically (confirmed by changelog)
   - Check `/mcp` menu: should show one `workrail` entry (local HTTP), not two

### Residual Risk

**Config override semantics (LOW-MEDIUM):** Whether project `.mcp.json` `workrail` entry shadows the global `~/.claude/settings.json` `workrail` entry is unverified. Observable at first use via `/mcp` menu. Recovery: rename to `workrail-dev` in `.mcp.json` if both servers appear.

### Runner-up

**Candidate 3 (nodemon)** is the upgrade path if manual restart friction proves unacceptable after 1-2 weeks of use. Requires `npm install -D nodemon` and a `dev:mcp:watch` script.
