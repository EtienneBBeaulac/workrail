# PR-A Bridge Removal -- Implementation Plan

**Date:** 2026-04-17
**Branch:** `feat/mcp-simplify-remove-bridge`
**Confidence:** High

---

## Problem Statement

The WorkRail MCP server contains a bridge mechanism (bridge-entry.ts, primary-tombstone.ts, bridge-events.ts) that was built to solve port contention between multiple Claude Code windows. PR #512 (merged) introduced `worktrain console` as a standalone process that owns the dashboard UI independently of the MCP server. The bridge mechanism's reason for existence is gone. It adds ~1127 lines of reconnect state machine, spawn coordination, and tombstone logic that make startup non-deterministic (150ms probe delay) and increase operational complexity.

---

## Acceptance Criteria

1. `src/mcp/transports/bridge-entry.ts` does not exist
2. `src/mcp/transports/primary-tombstone.ts` does not exist
3. `src/mcp/transports/bridge-events.ts` does not exist
4. `src/mcp-server.ts` no longer imports or re-exports `startBridgeServer`, `detectHealthyPrimary`, or `waitForStdinReadable`
5. `src/mcp-server.ts` no longer contains the auto-bridge detection block (lines 89-118 in current file)
6. `src/mcp/transports/stdio-entry.ts` no longer imports from `primary-tombstone.ts` or `bridge-events.ts`
7. `src/mcp/transports/http-entry.ts` no longer imports from `primary-tombstone.ts` or `bridge-events.ts`
8. `npm run build` exits 0 with 0 TypeScript errors
9. `npm test` exits 0

---

## Non-Goals

- HttpServer removal (PR-B)
- ToolContext changes
- DI token cleanup
- Any change to http-entry.ts transport logic (MCP-over-HTTP for bot services)
- Modifying http-listener.ts or http-listener.test.ts
- Removing `ctx.httpServer?.stop()` from shutdown hooks (HttpServer still starts in PR-A state)
- Cleaning up `worktrain-spawn.ts` / `worktrain-await.ts` dashboard.lock fallback (chore PR later)

---

## Philosophy-Driven Constraints

- **Architectural fixes over patches:** Delete root cause, not add flags
- **YAGNI:** Delete all three modules with no callers
- **Determinism:** Startup path must be a single unconditional call to `startStdioServer()` for stdio mode
- **Commit type:** `chore(mcp)` -- internal cleanup, no user-visible behavior change, no tool contract change

---

## Invariants

1. `WORKRAIL_TRANSPORT=http` path must still work -- `startHttpServer()` is called unconditionally for http mode
2. `WORKRAIL_TRANSPORT=stdio` must call `startStdioServer()` directly after removal -- no probe, no bridge detection
3. `mcp/index.ts` exports must be unchanged (confirmed: no bridge symbols were re-exported)
4. `tests/integration/mcp-http-transport.test.ts` must pass -- MCP-over-HTTP transport is untouched

---

## Selected Approach

**Direct deletion with targeted import removal.** Delete 3 source files and 3 test files. Remove their imports and call sites from 3 modified source files. TypeScript compiler verifies completeness at the import boundary.

**Runner-up:** None. All alternatives were anti-patterns.

---

## Vertical Slices

### Slice 1: Create branch and verify baseline

- Create git branch `feat/mcp-simplify-remove-bridge` from current HEAD
- Run `npm run build` to confirm baseline is green
- Run `npm test` to confirm baseline test suite is green
- **Done when:** Both commands exit 0

### Slice 2: Delete source files

- Delete `src/mcp/transports/bridge-entry.ts`
- Delete `src/mcp/transports/primary-tombstone.ts`
- Delete `src/mcp/transports/bridge-events.ts`
- **Done when:** Files do not exist on disk

### Slice 3: Delete test files

- Delete `tests/unit/mcp/transports/bridge-entry.test.ts`
- Delete `tests/unit/mcp/transports/primary-tombstone.test.ts`
- Delete `tests/unit/mcp/stdin-probe.test.ts`
- **Done when:** Files do not exist on disk

### Slice 4: Modify mcp-server.ts

Remove the following from `src/mcp-server.ts`:
- Import of `startBridgeServer`, `detectHealthyPrimary` from `./mcp/transports/bridge-entry.js`
- Re-export of `startBridgeServer`, `detectHealthyPrimary` from `./mcp/transports/bridge-entry.js`
- `STDIO_CLIENT_PROBE_MS` constant (line 49)
- `waitForStdinReadable` function (lines 62-82)
- Auto-bridge detection block inside `main()` (lines 88-118)
- Top JSDoc comment block (lines 11-24) describing auto-bridge -- replace with simplified description
- **Done when:** File compiles with no errors referencing bridge-entry; `main()` calls `startStdioServer()` unconditionally for stdio mode

### Slice 5: Modify stdio-entry.ts

Remove from `src/mcp/transports/stdio-entry.ts`:
- Import: `import { writeTombstone, clearTombstone } from './primary-tombstone.js'`
- Import: `import { logBridgeEvent } from './bridge-events.js'`
- Call: `logBridgeEvent({ kind: 'primary_started', transport: 'stdio' })` (line 39)
- Call: `clearTombstone()` (line 44)
- In `onBeforeTerminate`: remove the tombstone write block (lines 124-127: `const port = ctx.httpServer?.getPort(); if (port != null) { writeTombstone(port, process.pid); }`)
- **Done when:** File compiles with no imports or references to deleted modules; `onBeforeTerminate` only calls `await ctx.httpServer?.stop()`

### Slice 6: Modify http-entry.ts

Remove from `src/mcp/transports/http-entry.ts` (tombstone/bridge-events call sites ONLY):
- Import: `import { clearTombstone, writeTombstone } from './primary-tombstone.js'`
- Import: `import { logBridgeEvent } from './bridge-events.js'`
- Call: `logBridgeEvent({ kind: 'primary_started', transport: 'http', port })` (line 32)
- Call: `clearTombstone()` (line 35)
- In `onBeforeTerminate`: remove `if (boundPort != null) { writeTombstone(boundPort, process.pid); }` (lines 111-113)
- **Done when:** File compiles with no imports or references to deleted modules; ALL transport logic (bindWithPortFallback, MCP endpoint registration, health endpoint) is unchanged

### Slice 7: Build and test verification

- Run `npm run build` -- must exit 0 with 0 errors
- Run `npm test` -- must exit 0
- **Done when:** Both commands succeed

### Slice 8: Commit and push PR

- `git add` the 6 deleted files and 3 modified source files
- Commit with message: `chore(mcp): remove bridge, tombstone, and bridge-events from MCP server`
- Push branch and create PR against main
- **Done when:** PR is open

---

## Test Design

**Tests to delete:**
- `tests/unit/mcp/transports/bridge-entry.test.ts` -- imports deleted module
- `tests/unit/mcp/transports/primary-tombstone.test.ts` -- imports deleted module
- `tests/unit/mcp/stdin-probe.test.ts` -- imports `waitForStdinReadable` from mcp-server.ts (also deleted)

**Tests that must stay green:**
- `tests/unit/mcp-server.test.ts` -- reads mcp-server.ts as string; no assertion for bridge exports
- `tests/unit/mcp/http-listener.test.ts` -- tests createHttpListener lifecycle; no bridge dependency
- `tests/integration/mcp-http-transport.test.ts` -- tests MCP-over-HTTP; no bridge dependency
- All other tests (no bridge imports in non-deleted test files)

**No new tests required.** The change is a deletion; the verification is `npm run build` (0 errors) + `npm test`.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Missed import in unexpected file | Low | Build failure | Grep sweep confirmed before implementation: only 7 files (5 src, 2 tests) import from deleted modules |
| http-entry.ts transport logic broken | Low | Runtime failure | Tombstone call sites are isolated lines; transport logic verified as non-overlapping |
| mcp-server.test.ts string assertions fail | Low | Test failure | Test file read in full; no assertion for bridge exports |

---

## PR Packaging Strategy

Single PR. Branch: `feat/mcp-simplify-remove-bridge`. All 8 slices in one commit.

Commit message: `chore(mcp): remove bridge, tombstone, and bridge-events from MCP server`

PR description must include:
- What was deleted and why (bridge mechanism superseded by standalone worktrain console)
- What was NOT changed (http-entry.ts transport logic, http-listener.ts, ToolContext)
- Link to design doc: `docs/design/stdio-simplification-design-candidates.md` PR-A section

---

## Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| All slices | Architectural fixes over patches | Satisfied -- root cause deleted, no shim |
| Slice 2-3 | YAGNI with discipline | Satisfied -- all 3 modules have zero callers post-removal |
| Slice 4 | Determinism over cleverness | Satisfied -- startup becomes single unconditional call |
| Slice 4 | Make illegal states unrepresentable | Satisfied -- waitForStdinReadable deleted |
| Slice 4 | Document why, not what | Satisfied -- JSDoc updated to reflect simplified behavior |
| Slice 5-6 | Type safety as first line | Satisfied -- compiler verifies no remaining references |
| Slice 6 | Keep interfaces small | Satisfied -- http-entry.ts shrinks, transport logic unchanged |

---

## Follow-Up Tickets

- `worktrain-spawn.ts` and `worktrain-await.ts` `dashboard.lock` fallback is now permanently dead code. Remove in a separate chore PR.
- PR-B: Remove HttpServer from MCP server startup entirely.

---

## Unresolved Unknown Count

**0.** All import surfaces verified, failure modes addressed, acceptance criteria measurable.

## Plan Confidence Band

**High.**
