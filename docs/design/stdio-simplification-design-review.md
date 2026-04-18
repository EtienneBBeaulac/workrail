# WorkRail MCP Server Stdio Simplification -- Design Review Findings

**Status:** Review complete. Ready for implementation.
**Date:** 2026-04-17
**Reviewing:** `docs/design/stdio-simplification-design-candidates.md`
**Selected Direction:** Candidate 2 -- two sequential PRs (bridge removal + HttpServer removal)

---

## Tradeoff Review

| Tradeoff | Verdict | Condition for Reversal |
|---|---|---|
| Static `http://localhost:3456` in `open_dashboard` | Acceptable | If significant users run `worktrain console --port N`; mitigate by reading `daemon-console.lock` |
| `workrail cleanup` command removed | Acceptable | Document in release notes; no acceptance criterion requires it |
| `dashboardUrl` is a hint not a guaranteed-live URL | Acceptable | No caller checks URL liveness programmatically |
| `open_dashboard` no longer auto-launches browser | Acceptable | UX tool, not a workflow primitive; no bundled workflow calls it |

All tradeoffs hold under realistic conditions. No tradeoff violates an acceptance criterion.

---

## Failure Mode Review

### FM1: Hardcoded port assumption (YELLOW)
- **Description:** `handleOpenDashboard` returns `http://localhost:3456` -- wrong if user runs `worktrain console --port 4000`
- **Design handling:** Acknowledged in design doc. Mitigation: read `~/.workrail/daemon-console.lock` in handler (~20 lines)
- **Severity:** Yellow -- affects non-default-port users only; degraded behavior is a dead link, not a crash
- **Recommended action:** Include the lock-file read in PR-B (not deferred to follow-up). ~20 lines, well-scoped.

### FM2: Private operator tooling calling /api/v2/sessions on MCP dashboard port (YELLOW)
- **Description:** Removing console route mounting from MCP server breaks undocumented operator tooling
- **Design handling:** Evidence strongly argues against this: `worktrain-spawn.ts` already prefers `daemon-console.lock`; no bundled workflow calls the endpoint; not documented
- **Severity:** Yellow -- very low probability; no evidence exists
- **Recommended action:** No action required. Include a note in PR-B description for awareness.

---

## Runner-Up / Simpler Alternative Review

**C1 (runner-up):** Bridge removal only, HttpServer simplified. Contains no elements worth borrowing into C2 -- C1 is a strict subset of C2's PR-A. C1 fails to satisfy the backlog requirement.

**Simpler C2 variant:** Inject `null` for `httpServer` rather than removing the field from `ToolContext`. Rejected -- violates "Make illegal states unrepresentable." Nullable field for a removed capability perpetuates dead code.

**Hybrid opportunity:** Include `daemon-console.lock` read in PR-B (Open Question 1 from design doc). This resolves FM1 at the point of change rather than deferring. Recommended.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Architectural fixes over patches | Satisfied -- root cause removed |
| Make illegal states unrepresentable | Satisfied -- `ToolContext.httpServer` field deleted |
| YAGNI with discipline | Satisfied -- all dead coordination machinery deleted |
| Determinism over cleverness | Satisfied -- startup has one deterministic path |
| Keep interfaces small and focused | Satisfied -- ToolContext shrinks; `requireSessionTools()` checks one thing |
| Errors are data | Satisfied -- callback-based bridge shutdown gone |
| Dependency injection for boundaries | Minor tension -- hardcoded `DEFAULT_CONSOLE_PORT = 3456` constant. Acceptable; injecting a well-known default adds DI complexity for no behavioral benefit. |

---

## Findings

### RED
None.

### ORANGE
None.

### YELLOW
- **FM1:** `handleOpenDashboard` static port assumption. Resolve by including `daemon-console.lock` read in PR-B.
- **FM2:** Console route removal may break undocumented operator tooling. Low probability. Include in PR-B description.

---

## Recommended Revisions to C2

1. **Include lock-file read in PR-B** (not follow-up): Add `daemon-console.lock` read to `handleOpenDashboard` with fallback to port 3456. ~20 lines. Makes the tool return a live URL rather than a best-effort hint.

2. **Use named constant, not bare literal:** Define `DEFAULT_CONSOLE_PORT = 3456` in a shared location (e.g., `src/infrastructure/console-defaults.ts`). Use it in `handleOpenDashboard`, `handleCreateSession`, and `worktrain-spawn.ts` fallback.

3. **PR-B commit type:** This is a `feat(mcp)` commit (MCP tool contract change: `dashboardUrl` behavior, `open_dashboard` behavior, `workrail cleanup` removal). Not `chore`. Semantic-release must create a release entry.

---

## Residual Concerns

1. **Open Question 2 (cleanup command):** Remove entirely (Option A) or print deprecation notice (Option B). Recommendation: Option A with a clear release note. The command's implementation (lsof/netstat kills on 3456-3499) becomes semantically wrong after HttpServer removal.

2. **Open Question 3 (deprecated env vars):** `WORKRAIL_DASHBOARD_PORT` and `WORKRAIL_DISABLE_UNIFIED_DASHBOARD` will be silently ignored after removal. Recommendation: emit a startup warning when these vars are set but HttpServer is no longer present. One-line check in app startup.

3. **Open Question 4 (http-listener.ts tests):** Review `tests/unit/mcp/http-listener.test.ts` before PR-B to confirm all tests cover MCP-transport lifecycle only, not dashboard election behavior. Low risk but worth a quick scan before deletion decisions.
