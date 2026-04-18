# WorkRail MCP Server Stdio Simplification -- Implementation Plan

**Status:** Design complete. PR-A changes already implemented in working tree. PR-B ready for planning.
**Date:** 2026-04-19
**Scope:** Remove primary election (DashboardLock, tryBecomePrimary, bindWithPortFallback), bridge mechanism (bridge-entry.ts), and HTTP dashboard serving from the MCP server. The standalone worktrain console (PR #512, merged) now owns the UI.

**Design docs:**
- Candidates: `docs/design/stdio-simplification-design-candidates.md`
- Review findings: `docs/design/stdio-simplification-design-review.md`
- PR-A candidates: `docs/design/bridge-removal-pr-a-candidates.md`
- PR-A implementation plan: `docs/design/bridge-removal-pr-a-implementation-plan.md`
- This document: overall implementation plan with PR slices

---

## About This Document

This file is a **human-readable reference artifact** for the implementation plan. It is not execution memory.

- **Execution truth** lives in the WorkRail session notes and context variables (durable across chat rewinds)
- **This document** is for a developer reading the plan before or during implementation
- If a chat rewind occurs, the session notes and context survive; this file may be regenerated from them
- Do not treat the presence or absence of this file as a gate on execution state

---

## Capability Assessment (2026-04-19)

This session was a WorkRail Auto daemon session. Available tools: `continue_workflow`, `Bash`, `Read`, `Write`, `report_issue`.

- **Delegation (WorkRail Executor subagents):** unavailable -- no delegation/spawn tool present in session tool list
- **Web browsing:** unavailable -- no web fetch tool present in session tool list
- **Fallback path:** all design work performed directly by the main agent using filesystem tools and codebase analysis. Sufficient for a design-only session with pre-existing candidate and review docs.

No capability-dependent path was taken. The delegation gap does not affect output quality.

---

## Landscape Packet (verified 2026-04-19)

### Current state

**Branch:** `feat/mcp-simplify-remove-bridge` (checked out, ahead of origin/main)

**PR-A changes already live in working tree (unstaged):**
- `src/mcp/transports/bridge-entry.ts` -- deleted
- `src/mcp/transports/bridge-events.ts` -- deleted
- `src/mcp/transports/primary-tombstone.ts` -- deleted
- `src/mcp-server.ts` -- simplified to 37 lines (was 132); auto-bridge block and all bridge imports removed
- `src/mcp/transports/stdio-entry.ts` -- tombstone call sites removed
- `src/mcp/transports/http-entry.ts` -- tombstone call site at line 103 needs verification (see Contradiction C1)
- Bridge test files deleted: `stdin-probe.test.ts`, `bridge-entry.test.ts`, `primary-tombstone.test.ts`
- `triggers.yml` -- modified (protected file; must NOT be committed with PR-A)

**Build status:** `npm run build` passes. One pre-existing perf test flakiness (pre-existing on main, not caused by PR-A changes).

### What remains for PR-B

- `src/infrastructure/session/HttpServer.ts` (1211 lines) -- still present
- `ToolContext.httpServer: HttpServer | null` field -- still in `src/mcp/types.ts`
- `ctx.httpServer` usages in `src/mcp/server.ts` (lines 91, 95, 200, 299, 309, 325)
- `requireSessionTools()` gates on `ctx.httpServer` in `session.ts`
- `DI.Infra.HttpServer`, `DI.Config.DashboardMode`, `DI.Config.BrowserBehavior` tokens
- `ValidatedConfig.dashboard` subtree and env vars in `app-config.ts`
- `cleanup` command in `cli.ts` (lines 210-224)

### Contradictions

**C1 (MEDIUM):** `http-entry.ts:103` has `writeTombstone(boundPort, process.pid)` -- verify whether this was removed in the working tree or remains. Must be resolved before PR-A commit.

**C2 (MINOR):** `mcp-server-disconnect` design track exists but is orthogonal; no scope conflict.

### Evidence gaps

1. `daemon-console.lock` format -- confirmed: JSON `{ pid: number, port: number }` (read from `src/trigger/daemon-console.ts:13` and `src/console/standalone-console.ts:13`). Gap is now closed.
2. `process-cleanup.test.ts` scope -- needs scan before PR-B.
3. `http-entry.ts` tombstone verification -- needs check before PR-A commit.

---

## Problem Frame Packet

### Stakeholders

**Primary:**
- **Etienne (project owner):** wants a simpler, deterministic MCP server startup. The coordination machinery adds ~2300 lines of complexity that now has no purpose. Primary goal: clean deletion without regression.
- **Workflow authors using `sessionTools`:** currently rely on `create_session` returning a `dashboardUrl` and `open_dashboard` opening a browser tab. After PR-B, both behaviors change: URL becomes static (still useful), auto-open disappears (UX loss). These authors are the only people exposed to a visible behavior change.

**Secondary:**
- **Bot-service operators using MCP-over-HTTP transport:** must not be affected. `http-entry.ts` and `http-listener.ts` are explicitly preserved.
- **Future daemon sessions (including this one):** the MCP server runs the workflow engine that's being modified. A broken build during PR implementation kills the active session.

### Jobs and Outcomes

| Stakeholder | Job | Desired outcome |
|---|---|---|
| Project owner | Delete dead coordination code | ~2300 lines gone, startup deterministic, no port contention |
| Workflow authors | Track session progress via dashboard | `dashboardUrl` still returned (static URL is sufficient for copy-paste); `open_dashboard` still responds (returns URL, no auto-open) |
| Bot-service operators | Connect AI agents via HTTP transport | MCP-over-HTTP transport unchanged |
| Users who set `WORKRAIL_DASHBOARD_PORT` | Configure dashboard port | Get a clear deprecation warning rather than silent no-op |

### Pains and Tensions

**T1 (resolved by design): Port contention between multiple Claude windows**
The bridge was the solution. With standalone console as the UI owner, contention is no longer the MCP server's problem. Removing the bridge removes the non-deterministic 150ms startup probe. Resolved.

**T2 (active): `sessionTools` behavioral contract change**
`create_session` returns `dashboardUrl: null` today when HttpServer failed to start (already a known degraded state). PR-B changes it to always return a static URL -- strictly better than null. `open_dashboard` loses auto-browser-open (the `open` npm package call). This is the only real UX regression. Severity: LOW. `open_dashboard` is not called by any bundled workflow (verified: `grep -rn "open_dashboard" workflows/` returns nothing).

**T3 (active): `dashboard-template-workflow.json` hardcodes `http://localhost:3456`**
Already hardcodes the URL in its prompt text. PR-B's static URL behavior matches exactly what this workflow already tells users. No regression here -- this is implicit confirmation that static URL is the right behavior.

**T4 (active): `sessionTools` feature flag description is stale after PR-B**
Currently says "and HTTP dashboard server". After PR-B, `sessionTools` enables only the session store. The flag description must be updated. Low-impact but visible in the MCP tool listing.

**T5 (active): `worktrain-spawn.ts` and `worktrain-await.ts` dual lock-file fallback**
Both files check `daemon-console.lock` first, then `dashboard.lock`. After PR-B, `dashboard.lock` is never written. The second fallback becomes permanently dead code. Not a regression (graceful null return), but a cleanliness debt. Deferred to follow-up chore PR.

### Success Criteria

1. `npm run build` passes with zero errors after both PRs
2. `npx vitest run` passes (pre-existing perf flakiness excluded) after both PRs
3. No import of `bridge-entry`, `primary-tombstone`, or `bridge-events` anywhere in `src/` or `tests/` after PR-A
4. No `ToolContext.httpServer` field after PR-B
5. `sessionTools` flag still enables `workrail_create_session`, `workrail_update_session`, `workrail_read_session`
6. `create_session` returns a non-null `dashboardUrl` (static URL) after PR-B
7. `open_dashboard` returns a URL (not null, not an error) after PR-B
8. MCP-over-HTTP transport tests (`mcp-http-transport.test.ts`, `http-listener.test.ts`) pass after both PRs
9. `triggers.yml` is NOT committed in either PR
10. `workrail cleanup` removal is documented in release notes

### Assumptions being promoted to facts (risks)

**A1 (LOW RISK):** `open_dashboard` is not called by any production workflow. Evidence: `grep -rn "open_dashboard" workflows/` returns no matches. Confirmed.

**A2 (MEDIUM RISK):** No operator has private tooling that calls `/api/v2/sessions` on the MCP server's dashboard port (3456). Evidence: `worktrain-spawn.ts` already prefers `daemon-console.lock`; no bundled workflow calls the endpoint; it's undocumented. This assumption could be wrong for private deployments, but no evidence suggests it is.

**A3 (LOW RISK):** Static `http://localhost:3456` URL in `handleCreateSession` is acceptable for typical use. Evidence: `dashboard-template-workflow.json` already hardcodes this exact URL in prompt text, confirming it's the de-facto standard. Users who run `worktrain console --port 4000` will get a dead link, but the lock-file read in `handleOpenDashboard` mitigates this for `open_dashboard`.

**A4 (LOW RISK):** `daemon-console.lock` format is stable: `{ pid: number, port: number }` JSON. Confirmed in two independent implementations (`daemon-console.ts:13` and `standalone-console.ts:13`). Safe to read in `handleOpenDashboard`.

### Framing risks (what could make this framing wrong)

**FR1:** The scope could be wider than two PRs. If `dashboard-template-workflow.json` is in production use by external operators and those operators depend on the `http://localhost:3456/dashboard.html` URL format, removing HttpServer might break them silently. Counter: the workflow is in `workflows/examples/` (not a core bundled workflow) and already hardcodes port 3456. The PR-B change preserves this exact URL. Not a real risk.

**FR2:** The framing assumes `sessionTools` usage is low-impact after PR-B. If a significant segment of users actively calls `open_dashboard` and relies on auto-browser-launch, this is a non-trivial UX regression. Counter: there is zero evidence of such usage -- no bundled workflow calls it, no documentation describes it as a core feature. Low-impact assumption holds.

**FR3:** The framing could be wrong if there's a third HTTP server that wasn't found. The codebase has two HTTP servers: MCP-over-HTTP (`http-listener.ts`) and dashboard HttpServer (`HttpServer.ts`). If a third exists (e.g., trigger system on port 3200), removing the dashboard HttpServer might cause confusion about which HTTP server serves what. Evidence: `src/trigger/daemon-console.ts` runs on port 3456, separate from both. Not a problem -- the trigger console is already decoupled (it IS the standalone console).

### HMW questions (reframes)

**HMW 1:** "How might we make `handleOpenDashboard` return a guaranteed-live URL rather than a static guess?"
Answer: read `daemon-console.lock` (already planned in PR-B). This transforms the tool from "returns a hint" to "returns the actual running URL when worktrain console is up."

**HMW 2:** "How might we ensure that removing `workrail cleanup` doesn't leave any user with no way to clean up stale processes?"
Answer: the cleanup command killed processes on ports 3456-3499 (all HttpServer ports). After HttpServer removal, no WorkRail-owned processes run on those ports. The cleanup operation is semantically meaningless. Users with stale lock files from older versions: `~/.workrail/daemon-console.lock` has a pid field; `worktrain-spawn.ts` already validates the pid before using the port. Stale locks self-heal.

---

## Selected Direction: Candidate 2 (Two Sequential PRs)

The design candidates doc evaluated three options:

1. **C1 (bridge out, HttpServer simplified):** Removes bridge but leaves HttpServer running. Does not satisfy backlog requirement. Rejected.
2. **C2 (two sequential PRs):** PR-A removes bridge+tombstone; PR-B removes HttpServer entirely. Resolves all four tensions. **Selected.**
3. **C3 (feature flag gated):** Invents removal-gate flag anti-pattern. No repo precedent. Rejected.

---

## PR-A: Bridge and Tombstone Removal

**Branch:** `feat/mcp-simplify-remove-bridge` (already exists; changes already in working tree)
**Commit type:** `chore(mcp)` -- pure deletion, no user-visible behavior change
**Status:** Implementation complete in working tree. Needs final diff review and commit.

### Critical pre-commit checks

```bash
# Check 1: verify http-entry.ts tombstone call site (Contradiction C1)
grep -n "writeTombstone\|clearTombstone\|primary-tombstone\|bridge-events" src/mcp/transports/http-entry.ts
# Expected: zero matches. If any match, remove them before committing.

# Check 2: triggers.yml must NOT be staged (protected file)
# Stage only the PR-A files explicitly -- never git add -A or git add .
```

### Files deleted in working tree

- `src/mcp/transports/bridge-entry.ts` (892 lines)
- `src/mcp/transports/primary-tombstone.ts` (140 lines)
- `src/mcp/transports/bridge-events.ts` (93 lines)
- `tests/unit/mcp/stdin-probe.test.ts`
- `tests/unit/mcp/transports/bridge-entry.test.ts` (638 lines)
- `tests/unit/mcp/transports/primary-tombstone.test.ts` (85 lines)

### Files modified in working tree

- `src/mcp-server.ts` -- simplified to 37 lines
- `src/mcp/transports/stdio-entry.ts` -- tombstone call sites removed
- `src/mcp/transports/http-entry.ts` -- verify tombstone removed (C1)

### Verification for PR-A

```bash
npm run build  # must pass
npx vitest run  # must pass (perf flakiness pre-existing, not caused by these changes)
grep -rn "bridge-entry\|primary-tombstone\|bridge-events\|startBridgeServer\|detectHealthyPrimary\|waitForStdinReadable" src/ tests/
# Expected: zero matches
```

---

## PR-B: HttpServer Removal from MCP Server

**Branch:** `feat/etienneb/stdio-simplification-pr-b` (new from post-PR-A main)
**Commit type:** `feat(mcp)` -- MCP tool contract change
**Expected net change:** ~1200 lines deleted, ~120 lines changed
**Prerequisites:** PR-A merged and CI green

### `daemon-console.lock` format (confirmed)

File: `~/.workrail/daemon-console.lock`
Format: `{ "pid": number, "port": number }` (JSON)
Written by: `src/trigger/daemon-console.ts` and `src/console/standalone-console.ts`
Read by (currently): `worktrain-spawn.ts`, `worktrain-await.ts`
Safe to read in `handleOpenDashboard` with a `try/catch` that falls back to `DEFAULT_CONSOLE_PORT`.

### Files to delete

| File | Size | Why deleted |
|---|---|---|
| `src/infrastructure/session/HttpServer.ts` | ~1211 lines | Dashboard HTTP server removed from MCP |
| `src/infrastructure/session/DashboardHeartbeat.ts` | ~N lines | HttpServer dependency |
| `src/infrastructure/session/DashboardLockRelease.ts` | ~N lines | HttpServer dependency |
| `tests/integration/unified-dashboard.test.ts` | ~206 lines | Tests HttpServer dashboard behavior |
| `tests/unit/http-server-stop-idempotency.test.ts` | ~147 lines | Tests HttpServer lifecycle |
| `tests/integration/process-cleanup.test.ts` | ~N lines | Scan first; delete HttpServer-dependent portions only |

### Files to update

**`src/mcp/types.ts`** (PRIMARY SEAM):
- Remove `readonly httpServer: HttpServer | null` field from `ToolContext`
- Remove `import type { HttpServer }` from the file

**`src/mcp/server.ts`:**
- Remove `httpServer = container.resolve(DI.Infra.HttpServer)` and sessionTools HttpServer gate
- Remove console routes mount block
- Remove `ctx.httpServer?.finalize()`
- Import `DEFAULT_CONSOLE_PORT` from `console-defaults.ts`

**`src/mcp/handlers/session.ts`:**
- Rewrite `requireSessionTools()`: check only `ctx.sessionManager !== null`
- Rewrite `handleCreateSession`: use `http://localhost:${DEFAULT_CONSOLE_PORT}?session=${input.sessionId}`
- Rewrite `handleOpenDashboard`: read `daemon-console.lock` (parse `{ port }`) with fallback to `DEFAULT_CONSOLE_PORT`; return `{ url }` with guidance; no browser auto-open

**`src/di/container.ts`:** remove `HttpServer` import, registration, and `startAsyncServices` block

**`src/di/tokens.ts`:** remove `HttpServer`, `DashboardMode`, `BrowserBehavior` symbols

**`src/config/app-config.ts`:** remove dashboard subtree, type exports, env vars; add startup warning for deprecated vars

**`src/config/feature-flags.ts`:** update `sessionTools` description to remove "HTTP dashboard server"

**`src/cli.ts`:** remove `cleanup` command entirely

**`src/mcp/transports/stdio-entry.ts` and `http-entry.ts`:** remove `ctx.httpServer?.stop()` from shutdown hooks

**`src/runtime/adapters/node-process-signals.ts`:** update comment

**`src/infrastructure/session/index.ts`:** remove HttpServer, DashboardHeartbeat, DashboardLockRelease exports

### New file

**`src/infrastructure/console-defaults.ts`** (~5 lines):
```typescript
/** Default port for the worktrain console UI. */
export const DEFAULT_CONSOLE_PORT = 3456;
```

### Verification for PR-B

```bash
npm run build
npx vitest run
grep -rn "HttpServer\|DashboardHeartbeat\|DashboardLockRelease\|DI\.Infra\.HttpServer" src/ tests/
grep -rn "WORKRAIL_DASHBOARD_PORT\|WORKRAIL_DISABLE_UNIFIED_DASHBOARD" src/
grep -rn "httpServer" src/mcp/types.ts
# All expected: zero matches
```

---

## Scope Not In This Work

| Item | Decision |
|---|---|
| `worktrain-spawn.ts` / `worktrain-await.ts` dead `dashboard.lock` fallback | Separate `chore` PR after PR-B ships |
| MCP-over-HTTP transport (`http-entry.ts`, `http-listener.ts`) | Explicitly out of scope; must not be touched |
| `triggers.yml` modification in working tree | Protected file; must NOT be committed in either PR |
| `dashboard-template-workflow.json` URL update | Not needed; workflow already hardcodes `http://localhost:3456` |

---

## Decisions and Rationale Log

| Decision | Rationale |
|---|---|
| Two PRs | PR-A is independently reviewable, low-risk, high-value. PR-B benefits from PR-A being validated. |
| `ToolContext.httpServer` as primary seam | Compiler-enforced blast radius. |
| Lock-file read in `handleOpenDashboard` | `daemon-console.lock` format confirmed: `{ pid, port }`. Gives live URL when console is running. |
| Static URL in `handleCreateSession` | `dashboard-template-workflow.json` already hardcodes port 3456 in prompt text; static URL matches existing behavior exactly. |
| `workrail cleanup` removed entirely | Semantically wrong after HttpServer removal. Release note sufficient. |
| Deprecated env vars: startup warning | Silently ignoring confuses users. One-line warning. |
| `DEFAULT_CONSOLE_PORT = 3456` | Follows `DEFAULT_MCP_PORT = 3100` pattern. |
| PR-B commit type: `feat(mcp)` | MCP tool contract change. Semantic-release must create release entry. |
| MCP-over-HTTP transport kept | Separate infra for bot services. |
| Delegation not used | Unavailable. Solo work is sufficient for design-only session. |
