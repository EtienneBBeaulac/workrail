# WorkRail MCP Server Stdio Simplification -- Design Candidates

**Status:** Discovery only. No code changes. For review by the main agent before implementation begins.
**Date:** 2026-04-19
**Scope:** Remove primary election (DashboardLock, tryBecomePrimary, bindWithPortFallback), bridge mechanism (bridge-entry.ts, reconnect cycles, spawn storm), and HTTP dashboard serving from the MCP server. The standalone worktrain console (PR #512, merged) now owns the UI.

---

## Problem Understanding

### Background

The bridge/primary-election system was built to solve one problem: "only one process should serve the console UI on port 3456." When multiple Claude Code windows open against the same repo, each spawns a `workrail` stdio process. Without coordination, all would try to bind port 3456 for the dashboard. The solution: the first instance becomes the HTTP primary; all subsequent instances become bridges that forward JSON-RPC over the primary's HTTP endpoint.

PR #512 merged `worktrain console` as a standalone process that reads session files directly and has zero coupling to the MCP server. That change removed the reason the bridge/election system exists. The coordination problem is solved at the infrastructure layer (console is independent). The MCP server can now be pure stdio.

### Core tensions

**T1: Clean architectural removal vs behavioral backward compatibility**

`sessionTools` is enabled by default (`WORKRAIL_ENABLE_SESSION_TOOLS=true` in the generated config template). This means most users have it on. The `create_session` tool returns `dashboardUrl`, built from `httpServer.getBaseUrl()`. The `open_dashboard` tool calls `httpServer.openDashboard()`, which uses the `open` npm package to launch a browser. Removing `HttpServer` from the MCP server makes `dashboardUrl` return `null` and kills browser-open. This is a visible API contract change -- not dangerous, but requiring a migration note and potentially a `feat:` or `fix:` commit tag.

**T2: Self-referential risk**

The MCP server running in this repo is the tool executing this workflow. Any code change that breaks `src/mcp-server.ts` or transport initialization will kill the active session. This demands smallest-first slices with green tests between each. The bridge, tombstone, and HttpServer are interdependent in subtle ways (tombstone is only written when `ctx.httpServer?.getPort()` is non-null; bridge reads tombstone). Removing just one leaves the others in an inconsistent state.

**T3: Two HTTP servers with similar names, different purposes**

There are two completely different HTTP servers in this codebase:
- `src/mcp/transports/http-entry.ts` + `src/mcp/transports/http-listener.ts`: the **MCP protocol over HTTP** transport for bot services and daemon (`WORKRAIL_TRANSPORT=http`). This is correct infrastructure and must stay.
- `src/infrastructure/session/HttpServer.ts`: the **Express dashboard server** with primary election on port 3456. This is what needs to go.

A naive "remove HttpServer" that conflates these would break the bot-service HTTP transport and `tests/integration/mcp-http-transport.test.ts`.

**T4: `sessionTools` feature coherence after losing its HTTP half**

`SessionManager` (filesystem-based session CRUD) and `HttpServer` (dashboard serving) are co-gated by a single `requireSessionTools()` guard that checks `ctx.sessionManager !== null && ctx.httpServer !== null`. After removal, `SessionManager` still works. Only `open_dashboard` and the `dashboardUrl` in `create_session` depend on `HttpServer`. The guard bundles capabilities that should be separate.

### What makes this hard

1. **Tombstone write is conditional on HttpServer port.** `stdio-entry.ts` does `if (ctx.httpServer?.getPort() != null) writeTombstone(port, pid)`. If HttpServer is removed before tombstone code is cleaned up, the tombstone never writes -- which is fine since bridges are also gone, but leaves dead code.

2. **`cli.ts` cleanup command resolves `DI.Infra.HttpServer`.** The `workrail cleanup` CLI command calls `httpServer.fullCleanup()` (lsof/netstat to kill processes on ports 3456-3499). After removing the token, the DI resolution crashes. The command must be simplified or removed in the same PR that removes the DI token.

3. **DI smoke test resolves every registered token.** `tests/smoke/di-container.smoke.test.ts` iterates all `DI.*` symbols and resolves them. Removing `DI.Infra.HttpServer`, `DI.Config.DashboardMode`, `DI.Config.BrowserBehavior` from `tokens.ts` means those tokens simply no longer appear in the loop. The test automatically shrinks -- no manual update needed.

4. **`worktrain-spawn.ts` reads `dashboard.lock` as a fallback.** After HttpServer removal, `dashboard.lock` is never written, so the fallback always returns null. The code already handles this gracefully (ENOENT caught, falls through to default port 3456). No behavioral change, but the fallback is now permanently dead code.

5. **`open_dashboard` is not called from any bundled workflow** (verified: `grep -rn "open_dashboard" workflows/` returns nothing). It's a UX tool, not a workflow primitive. The behavioral degradation is real but low-impact.

6. **The `open` npm package is used only by `HttpServer.ts`.** Removing `HttpServer.ts` also removes the only usage of the `open` package. This is a welcome dependency reduction.

### Likely real seam

The primary seam for the bridge removal is `mcp-server.ts` `main()` -- the 28-line auto-bridge block that probes port 3100 and conditionally starts bridge mode.

The primary seam for HttpServer removal is `ToolContext.httpServer: HttpServer | null` in `src/mcp/types.ts`. Removing this field from the type produces TypeScript errors at every callsite (handler, server, transport entry points), making the full blast radius immediately visible and compiler-verified. This is the correct seam: it uses type-system enforcement rather than grep-and-hope.

---

## Philosophy Constraints

Principles from AGENTS.md and daemon-soul.md that directly constrain the design:

| Principle | Constraint |
|---|---|
| Architectural fixes over patches | Remove the root cause (HttpServer from MCP). Don't add a feature flag to paper over it. |
| Make illegal states unrepresentable | `ToolContext.httpServer: HttpServer | null` is an illegal state post-removal. The field should not exist. |
| YAGNI with discipline | `DashboardHeartbeat`, `DashboardLockRelease`, `DashboardLock` interface, `BrowserBehavior`, tombstone, bridge reconnect state machine -- all YAGNI once console is standalone. |
| Keep interfaces small and focused | `ToolContext` has a capability it no longer needs. `requireSessionTools()` gates two unrelated capabilities together. |
| Determinism over cleverness | The 150ms zombie-bridge stdin probe, the spawn coordinator lock, the jitter in `spawnPrimary()`, the tombstone fast-path -- all eliminated. Startup becomes deterministic. |
| Validate at boundaries, trust inside | Post-simplification: transport mode is resolved once at startup from env vars. No runtime probing mid-boot. |
| Errors are data | `bridge-entry.ts` uses a callback-based `performShutdown`. The retained code uses DI-injected `ShutdownEvents` with discriminated-union events. The bridge's pattern is inferior and goes away. |
| Never push to main directly | Implementation must be on feature branches with PRs. Design-only here. |

**Conflicts found:**

1. `src/v2/` is listed as a protected file tree (AGENTS.md). The console routes (`src/v2/usecases/console-routes.ts`) are called from `src/mcp/server.ts` via `ctx.httpServer.mountRoutes()`. Removing that call is in `src/mcp/server.ts`, which is NOT protected. The `console-routes.ts` function itself does not change. No conflict once scoped correctly.

2. "Dependency injection for boundaries" suggests the `http://localhost:3456` URL used in the degraded `open_dashboard` and `dashboardUrl` should be injected rather than hardcoded. Counter-argument: 3456 is the established documented default; injecting a rarely-changed constant adds complexity. The constant can be defined once in a shared location (`DEFAULT_CONSOLE_PORT = 3456`) rather than injected via DI.

---

## Impact Surface

Paths, consumers, and contracts that must stay consistent after the change:

| Surface | Impact | Required action |
|---|---|---|
| `src/mcp/transports/http-entry.ts` | MCP protocol over HTTP (bot services). Must NOT be removed. | Keep unchanged |
| `src/mcp/transports/http-listener.ts` | Used by `http-entry.ts`. Must NOT be removed. | Keep unchanged |
| `src/mcp/index.ts` | Exports `startHttpServer`. Must stay (public library export). | Keep unchanged |
| `mcp-server.ts` public API | Exports `startBridgeServer`, `detectHealthyPrimary`. Must be removed along with bridge-entry.ts. | Remove re-exports |
| `worktrain-spawn.ts` | Reads `dashboard.lock` as fallback. After removal: fallback misses but doesn't crash. | Dead code; can remove in follow-up |
| `worktrain-await.ts` | Same pattern as spawn. | Same |
| `cli.ts` cleanup command | Resolves `DI.Infra.HttpServer`. Must be updated when token is removed. | Simplify or remove command |
| `NodeProcessSignals` comment | Says "HttpServer.setupPrimaryCleanup() and wireShutdownHooks() both call on()". After removal, only wireShutdownHooks() calls on(). | Update comment |
| `tests/integration/mcp-http-transport.test.ts` | Tests MCP-over-HTTP (not dashboard). Keep. | Keep unchanged |
| `tests/unit/mcp/http-listener.test.ts` | Tests `createHttpListener` and `bindWithPortFallback`. Keep (needed for bot-service transport). | Keep unchanged |
| DI smoke test | Iterates all DI tokens. Removing tokens makes them disappear from iteration automatically. | No change needed |
| `WORKRAIL_DASHBOARD_PORT`, `WORKRAIL_DISABLE_UNIFIED_DASHBOARD` env vars | Written into user config by `workrail init`. After HttpServer removal, these become ignored. | Document deprecation in release notes |
| Schema consistency test | Imports `openDashboardTool`. The tool definition stays, just its behavior changes. | No change needed |
| `sessionTools` feature flag description | Currently says "and HTTP dashboard server". After removal, this is inaccurate. | Update description string |

---

## Candidates

### Candidate 1: Bridge out, HttpServer simplified (no election)

**Summary:** Remove the bridge, tombstone, and auto-primary detection; strip election machinery from inside `HttpServer` but keep HttpServer starting on port 3456 for sessionTools users.

**Structural changes:**
- Delete `bridge-entry.ts`, `primary-tombstone.ts`, `bridge-events.ts`
- Remove 28-line auto-bridge block from `mcp-server.ts` main()
- Remove bridge re-exports from `mcp-server.ts`
- Remove tombstone calls from `stdio-entry.ts`
- In `HttpServer.ts`: delete `tryBecomePrimary()`, `reclaimStaleLock()`, `shouldReclaimLock()`, `setupPrimaryCleanup()`, `startLegacyMode()`, `DashboardLock` interface, heartbeat, lock file logic, `fullCleanup()`. Replace `start()` with direct `startAsPrimary()`.
- Delete `DashboardHeartbeat.ts`, `DashboardLockRelease.ts`
- Remove `DI.Config.DashboardMode`, `DI.Config.BrowserBehavior` from container
- Update/delete relevant tests

**Tensions resolved:** T2 (safe first PR), T3 partially (bridge confusion removed)
**Tensions accepted:** T1 (port contention between windows persists), T4 (sessionTools still bundled with HttpServer)

**Boundary:** `mcp-server.ts` main() entry point and HttpServer internals

**Why that boundary:** Safest single-PR boundary; no API surface changes; HttpServer still starts and serves `dashboardUrl`

**Failure mode:** Multiple Claude windows each start an un-elected HttpServer on port 3456. With no lock, the first wins; others fall through to legacy ports (3457+). Each window binds a port unnecessarily.

**Repo pattern relationship:** Follows "direct removal without flags" pattern for the bridge. Adapts existing HttpServer structure by stripping internals.

**Gains:** Bridge complexity entirely gone (~1400 lines). MCP server starts deterministically. No more 150ms probe delay.
**Gives up:** Port contention between Claude windows is still an ongoing concern. `dashboard.lock` still written by the simplified HttpServer (no election, but still a lock file that worktrain-spawn could use as fallback).

**Scope judgment: too narrow.** Removes bridge (correct) but leaves the architectural remnant (HttpServer bound to a port for every Claude window). Does not satisfy the backlog requirement: "remove HttpServer starting as part of the MCP server." C1 is best understood as Slice A of C2 without committing to Slice B.

**Philosophy:**
- Honors: "Architectural fixes over patches" (removes bridge root cause), "Determinism" (no probe delay), "YAGNI" (election machinery deleted)
- Conflicts with: "Make illegal states unrepresentable" (`ToolContext.httpServer` field remains), backlog explicit requirement

---

### Candidate 2: Two sequential PRs -- bridge removal then HttpServer removal (recommended)

**Summary:** PR-A removes the bridge and tombstone. PR-B removes `HttpServer` from MCP server startup entirely, degrades `open_dashboard` to return a static `http://localhost:3456` URL, and removes `httpServer` from `ToolContext`.

**Structural changes (PR-A: bridge removal):**
- Delete `src/mcp/transports/bridge-entry.ts`
- Delete `src/mcp/transports/primary-tombstone.ts`
- Delete `src/mcp/transports/bridge-events.ts`
- `src/mcp-server.ts`: Remove 28-line auto-bridge block (lines 90-117). Remove imports of `startBridgeServer`, `detectHealthyPrimary`, `waitForStdinReadable`, `STDIO_CLIENT_PROBE_MS`. Remove re-exports of those 3 names.
- `src/mcp/transports/stdio-entry.ts`: Remove `writeTombstone`/`clearTombstone` imports and their 3 call sites. Keep `ctx.httpServer?.stop()` in shutdown hook (HttpServer still starts in PR-A state).
- `src/mcp/transports/http-entry.ts`: Remove `writeTombstone`/`clearTombstone` imports and their 2 call sites.
- Delete `tests/unit/mcp/transports/bridge-entry.test.ts` (638 lines)
- Delete `tests/unit/mcp/transports/primary-tombstone.test.ts` (85 lines)
- Delete `tests/unit/mcp/stdin-probe.test.ts` (covers `waitForStdinReadable`)
- Update `tests/unit/mcp-server.test.ts`: remove assertions about bridge-entry.ts existence and startBridgeServer import

**Structural changes (PR-B: HttpServer removal from MCP server):**
- `src/mcp/types.ts`: Remove `readonly httpServer: HttpServer | null` field from `ToolContext`. Remove `import type { HttpServer }` from the file.
- `src/mcp/server.ts` `createToolContext()`: Remove `httpServer = container.resolve(DI.Infra.HttpServer)` block and the entire `if (featureFlags.isEnabled('sessionTools'))` block that gates it. Remove `sessionManager` from the function too -- it's resolved via the same flag. Simplify to: always resolve `sessionManager` when `sessionTools` is enabled, never resolve `httpServer`. Remove console routes mount block (`if (ctx.v2 && ctx.httpServer ...)`). Remove `ctx.httpServer?.finalize()`.
- `src/mcp/handlers/session.ts`: Rewrite `requireSessionTools()` to check only `ctx.sessionManager !== null`. Rewrite `handleCreateSession`: `const dashboardUrl = 'http://localhost:3456' + '?session=' + input.sessionId` (static, no httpServer call). Rewrite `handleOpenDashboard`: return `{ url: 'http://localhost:3456' }` with a note "Run 'worktrain console' to start the dashboard UI". Remove `httpServer` usage.
- `src/di/container.ts` `registerServices()`: Remove `HttpServer` import and registration. Remove `DI.Infra.HttpServer` from `registerServices()`.
- `src/di/container.ts` `registerConfig()`: Remove `DI.Config.DashboardMode` and `DI.Config.BrowserBehavior` registrations.
- `src/di/container.ts` `startAsyncServices()`: Remove entire `if (flags.isEnabled('sessionTools'))` block. The function becomes a shell that sets `asyncInitialized = true`.
- `src/di/tokens.ts`: Remove `HttpServer: Symbol(...)`, `DashboardMode: Symbol(...)`, `BrowserBehavior: Symbol(...)`.
- `src/config/app-config.ts`: Remove `ValidatedConfig.dashboard` subtree (`mode`, `browserBehavior`, `port`). Remove `DashboardMode`, `BrowserBehavior`, `DashboardPort` type exports. Remove `WORKRAIL_DISABLE_UNIFIED_DASHBOARD` and `WORKRAIL_DASHBOARD_PORT` from `EnvVarsSchema`.
- `src/config/feature-flags.ts`: Update `sessionTools` description to "(session store only; use 'worktrain console' for the dashboard UI)". Remove "HTTP dashboard server" from description.
- `src/cli.ts`: Remove the `cleanup` command block entirely (it resolved `DI.Infra.HttpServer`). Or: print a deprecation notice. Remove `import type { HttpServer }` and the `DI.Infra.HttpServer` resolve call.
- `src/mcp/transports/stdio-entry.ts`: Simplify `onBeforeTerminate` to `async () => {}` (no httpServer to stop). Remove `ctx.httpServer?.stop()`.
- `src/mcp/transports/http-entry.ts`: Remove `ctx.httpServer?.stop()` from both shutdown hook usages.
- `src/infrastructure/session/HttpServer.ts`: **Deleted** (~1000 lines)
- `src/infrastructure/session/DashboardHeartbeat.ts`: **Deleted**
- `src/infrastructure/session/DashboardLockRelease.ts`: **Deleted**
- `src/infrastructure/session/index.ts`: Remove those three exports
- `src/runtime/adapters/node-process-signals.ts`: Update comment removing reference to `HttpServer.setupPrimaryCleanup()`
- Delete `tests/integration/unified-dashboard.test.ts` (206 lines)
- Delete `tests/integration/process-cleanup.test.ts` (HttpServer-dependent portions)
- Delete `tests/unit/http-server-stop-idempotency.test.ts` (147 lines)
- Update `tests/unit/mcp-server.test.ts`: remove HttpServer-related assertions, add assertion that `ctx.httpServer` field does not exist in `ToolContext`
- Update `tests/smoke/di-container.smoke.test.ts`: no change needed (auto-shrinks when tokens removed)

**Total lines deleted across both PRs:** approximately 2000 lines deleted, ~150 lines changed.

**Tensions resolved:** All four. T1: `dashboardUrl` stays functional (static URL instead of null). T2: PR-A is safe; PR-B doesn't touch transport logic. T3: `infrastructure/session/HttpServer.ts` gone, no naming confusion. T4: `sessionTools` gates `SessionManager` only; `requireSessionTools()` checks one thing.

**Tensions accepted:** Static `http://localhost:3456` in `handleCreateSession` and `handleOpenDashboard` is wrong if user runs worktrain console on a different port. Low probability (custom port requires explicit `--port` flag); documented assumption.

**Boundary:** `ToolContext.httpServer` field in `src/mcp/types.ts`. Removing this field is the correct seam: TypeScript propagates errors to all callsites, making the blast radius explicit and compiler-enforced.

**Why that boundary is best fit:** The field represents a capability that no longer exists. Removing it from the capability record (ToolContext) makes the absence unrepresentable-as-present. Every other change follows as a consequence of this type change.

**Failure mode:** Hardcoded `http://localhost:3456` is wrong if user runs `worktrain console --port 4000`. The URL is then a dead link. Mitigation path: read `~/.workrail/daemon-console.lock` in the handler for the actual port. This is a one-shot async file read -- doable in a follow-up PR if the issue is reported.

**Repo pattern relationship:** Follows the established "just remove it" pattern for refactors (no intermediate flag). Adapts the existing `requireSessionTools()` guard to check one capability instead of two. The static URL constant follows the existing `DEFAULT_MCP_PORT = 3100` pattern in `mcp-server.ts`.

**Gains:** ~2000 lines of coordination machinery deleted. No port contention between Claude windows. No `dashboard.lock`, no `spawn-coordinator-*.lock`, no `primary.tombstone`. MCP server starts in ~50ms instead of 150ms+. `sessionTools` remains functional. `open` npm package dependency removed. DI container loses three tokens.
**Gives up:** `open_dashboard` no longer auto-launches a browser (the `open` npm package call is the only usage). `dashboardUrl` is a static hint rather than a guaranteed-live URL. `workrail cleanup` command is removed.

**Impact beyond immediate task:** `worktrain-spawn.ts` and `worktrain-await.ts` lose the `dashboard.lock` fallback permanently -- they gracefully fall through to default port 3456 without it. This is the correct behavior. The fallback lines can be removed as a chore PR later.

**Scope judgment: best-fit.** Exactly matches the backlog requirements. Two PRs are the right granularity: PR-A is the high-value, low-risk change; PR-B is the deeper structural change that benefits from PR-A being validated first.

**Philosophy:**
- Honors: "Architectural fixes over patches", "Make illegal states unrepresentable" (httpServer field removed), "YAGNI with discipline" (all dead code deleted), "Determinism over cleverness" (startup has one path), "Keep interfaces small and focused" (ToolContext shrinks), "Errors are data" (bridge's callback-based shutdown is gone)
- Conflicts with: "Dependency injection for boundaries" for the hardcoded port constant. Counter: this is a well-known default value, not a behavioral policy. A `DEFAULT_CONSOLE_PORT` constant in a shared location is sufficient.

---

### Candidate 3: Rip-all-at-once behind a `WORKRAIL_SIMPLE_STDIO` feature flag

**Summary:** A single PR adds a `WORKRAIL_SIMPLE_STDIO` feature flag. When set, `mcp-server.ts` short-circuits to `startStdioServer()` and `startAsyncServices()` skips HttpServer. All bridge/HttpServer code remains for one release cycle as the flag is graduated to default-on.

**Structural changes:**
- Add `simplestdio` flag to `feature-flags.ts`
- Add 3-line conditional at top of `mcp-server.ts` main()
- Add 3-line conditional in `startAsyncServices()`
- No deletions yet

**Tensions resolved:** T2 only (the migration window reduces self-referential risk during rollout)
**Tensions accepted:** T1 (two API codepaths), T3 (both HTTP servers still exist), T4 (feature still bundled)

**Boundary:** Feature flag

**Failure mode:** The flag is never defaulted to `true` and never cleaned up. Becomes permanent dead-with-flag code. The codebase already has flags with `since: '0.6.0'` that show this pattern is a real risk.

**Repo pattern relationship:** Departs. There is NO existing pattern of using a feature flag to gate the removal of code. Every refactor in the git log (including PR #512) removes code directly. This candidate invents a new anti-pattern.

**Gains:** Theoretically reversible within one release cycle.
**Gives up:** Two codepaths to test and maintain. Adds complexity before reducing it. Flag cleanup requires a follow-up PR. Goes against the established direct-removal pattern.

**Scope judgment: too broad in the wrong dimension.** Adds complexity (flag + two codepaths) while doing less structural work. Not broader in the sense of "more value" -- broader in the sense of "more surface area for the same outcome."

**Philosophy:**
- Honors: "Graceful degradation ladders" (migration window) -- but this principle applies to user-facing capability degradation, not internal refactor sequencing
- Conflicts with: "YAGNI with discipline", "Architectural fixes over patches", repo direct-removal pattern

---

## Comparison and Recommendation

### Tension resolution matrix

| | C1 (bridge out, HttpServer simplified) | C2 (two PRs: bridge + HttpServer) | C3 (flag-gated) |
|---|---|---|---|
| T1: removal vs compat | Accepts (port contention persists) | Resolves (static URL degrades gracefully) | Half-resolves (flag window) |
| T2: self-referential risk | Resolves (small first PR) | Resolves (PR-A safe; PR-B doesn't touch transport) | Accepts (one large PR) |
| T3: HTTP naming confusion | Partial (bridge gone; HttpServer still starts) | Resolves (only MCP-transport HTTP remains) | Accepts (both servers persist) |
| T4: sessionTools coherence | Accepts (still bundled) | Resolves (guard checks one thing) | Accepts (both codepaths) |

### Recommendation: Candidate 2

C2 is the only candidate that satisfies the explicit backlog requirement in full and resolves all four tensions.

The two-PR sequencing is not a compromise. PR-A (bridge removal) is the high-value, low-risk change: it eliminates the 28-line non-deterministic entry point and ~800 lines of reconnect state machine. PR-B (HttpServer removal) is the structural completion: it makes the absence of dashboard HTTP serving unrepresentable in the type system and deletes ~1200 more lines. Both PRs are independently reviewable, independently deployable, and leave the system in a consistent state.

C1 is rejected because it leaves the port-contention problem and contradicts the explicit backlog design. It is best understood as PR-A of C2, not a complete design.

C3 is rejected because it invents an anti-pattern (removal-gate flags) with no precedent in this repo and adds complexity in exchange for a migration window that is not needed (the behavioral changes in C2 are mild and documented).

---

## Self-Critique

### Strongest argument against C2

The static `http://localhost:3456` URL in `handleCreateSession` and `handleOpenDashboard` is an assumption, not a guarantee. A user who runs `worktrain console --port 4000` gets a stale URL. The `open_dashboard` tool used to work (it opened a browser to the live server). After C2, it returns a URL to a server that may not be running.

Counter: the existing behavior already has this problem -- if `HttpServer` failed to start (port exhaustion in legacy mode), `dashboardUrl` was already `null`. The static URL is strictly better than null. The correct fix (read `daemon-console.lock` to discover the actual port) can be added in a focused follow-up PR without blocking the simplification.

### Why C1 loses

C1 removes the most disruptive code (the bridge state machine) without touching the sessionTools API surface. But it is not a complete design: it leaves HttpServer running in each Claude window, still binding port 3456, still writing `dashboard.lock`, still being resolved from DI. The backlog says "remove HttpServer starting as part of the MCP server." C1 does not do that. It is PR-A of C2, not a standalone design.

### What broader scope would require

A fully correct `handleOpenDashboard` that reads `daemon-console.lock` to discover the actual port and returns a live URL would require:
- One async `fs.readFile` call in the handler
- A fallback to port 3456 if the lock is absent
- A test for the lock-read path

This is approximately 20 lines of code added to PR-B. It is the right long-term behavior. Whether it belongs in PR-B or a follow-up PR is a question of scope appetite. Including it in PR-B makes PR-B slightly larger but produces a more correct `handleOpenDashboard`.

### Assumption that would invalidate C2

If operators call `/api/v2/sessions` directly on the MCP server's port (rather than on the worktrain console port) in production workflows or automation, removing console route mounting from the MCP server breaks them. Evidence check: `worktrain-spawn.ts` already prefers `daemon-console.lock` (worktrain console) over `dashboard.lock` (MCP server) -- the standalone console is already the canonical API source. No bundled workflow calls `/api/v2/sessions`. No documentation describes calling the MCP server's dashboard port directly. This assumption holds unless an operator has built private tooling against the MCP server's dashboard endpoint, which would be undocumented and fragile already.

---

## Open Questions for the Main Agent

1. **`handleOpenDashboard` lock-file read in PR-B or follow-up?** Reading `daemon-console.lock` to discover the actual console port makes `handleOpenDashboard` return a live URL instead of a best-effort static constant. ~20 lines. Does this belong in PR-B or a separate chore PR?

2. **`workrail cleanup` command: remove or degrade?** The `cleanup` command's implementation (lsof/netstat to kill processes on 3456-3499) becomes meaningless after HttpServer removal. Two options: (A) remove the command entirely, (B) print a deprecation notice saying "Use 'worktrain console' to manage the console UI." Option A is cleaner; Option B is kinder to users who had `workrail cleanup` in scripts.

3. **`WORKRAIL_DASHBOARD_PORT` and `WORKRAIL_DISABLE_UNIFIED_DASHBOARD` env vars:** These appear in the generated config template (`workrail init` writes them to `~/.workrail/config.json`). After removal, they are silently ignored. Should a startup warning be emitted when these env vars are set but HttpServer no longer uses them? Or just silently ignore them and document in the release notes?

4. **`http-listener.ts` tests:** `tests/unit/mcp/http-listener.test.ts` tests `createHttpListener` and `bindWithPortFallback`. These are still needed (for bot-service HTTP transport). The test file should be reviewed to confirm none of its tests are about dashboard election behavior vs MCP transport behavior. A quick scan should confirm they test `createHttpListener` lifecycle only.

5. **PR-B commit type:** Removing `open_dashboard` auto-open behavior and changing `dashboardUrl` from a live URL to a static constant are MCP tool contract changes. Under the release policy, this counts as a breaking change defaulting to `minor`. The PR title should be `feat(mcp): ...` or `fix(mcp): ...` rather than `chore(mcp): ...` to ensure semantic-release creates a release entry with the change documented.

---

## Final Summary

**Review date:** 2026-04-17
**Review doc:** `docs/design/stdio-simplification-design-review.md`

### Selected Direction: Candidate 2 (two sequential PRs)

C2 is the only candidate that satisfies the explicit backlog requirement and resolves all four tensions. PR-A (bridge removal) is the high-value, low-risk change: ~800 lines deleted, deterministic startup, no 150ms probe delay. PR-B (HttpServer removal) is the structural completion: `ToolContext.httpServer` field deleted, ~1200 more lines removed, `sessionTools` remains functional with degraded (but acceptable) `open_dashboard` behavior.

### Why Alternatives Lost

- C1 is PR-A of C2, not a complete design. It leaves HttpServer running in every Claude window and contradicts the backlog requirement.
- C3 invents a removal-gate feature flag anti-pattern with no repo precedent.

### Confidence Band: HIGH

All four tensions resolved. No RED or ORANGE findings in review. Two YELLOW items, both with clear mitigations.

### Additive Revisions to C2

1. Include `daemon-console.lock` read in PR-B's `handleOpenDashboard` (~20 lines) -- resolves Open Question 1.
2. Use `DEFAULT_CONSOLE_PORT = 3456` named constant, not a bare literal.
3. PR-B commit type: `feat(mcp)` (MCP tool contract change -- resolves Open Question 5).

### Resolved Open Questions

- OQ1: Lock-file read belongs in PR-B, not a follow-up.
- OQ2: Remove the `cleanup` command entirely with a clear release note.
- OQ3: Emit a startup warning when `WORKRAIL_DASHBOARD_PORT` or `WORKRAIL_DISABLE_UNIFIED_DASHBOARD` are set.
- OQ4: Scan `tests/unit/mcp/http-listener.test.ts` before PR-B to confirm no dashboard-election tests before deletion decisions.
- OQ5: PR-B is `feat(mcp)`.

### Next Actions

1. Start PR-A: delete `bridge-entry.ts`, `primary-tombstone.ts`, `bridge-events.ts`; remove 28-line auto-bridge block from `mcp-server.ts`; remove tombstone call sites.
2. After PR-A merges and CI is green, start PR-B: remove `ToolContext.httpServer` field, delete `HttpServer.ts`, update DI container, update `handleCreateSession`/`handleOpenDashboard` with static URL + lock-file read.
