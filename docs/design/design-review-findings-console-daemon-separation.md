# Design Review Findings: Console-Daemon Separation

**Selected Design:** Candidate A -- Delete daemon-console.ts  
**Reviewed:** 2026-04-21  
**Status:** Raw review material for main agent synthesis

---

## Tradeoff Review

### Tradeoff 1: CLI commands may fail if daemon runs without console
- `worktrain spawn`, `worktrain await`, `worktrain-trigger-poll` discover the console port via `daemon-console.lock`. If the daemon no longer auto-starts the console, these commands will get ECONNREFUSED when the user has not run `worktrain console` separately.
- **Verdict:** Acceptable. Failure mode is explicit (ECONNREFUSED), not silent. The lock-file discovery still works -- it just requires the user to start the console. Not a violation of acceptance criteria.
- **Condition under which it fails:** An automated pipeline that expects the daemon to auto-start the console. Would need pipeline update.

### Tradeoff 2: Browser dispatch returns 503 with a confusing message
- Current message: "Autonomous dispatch requires v2 tools enabled." This is wrong for standalone console context -- the daemon IS enabled, but standalone console has no live v2 context.
- **Verdict:** MUST FIX as part of implementation. Not optional. The message should clearly direct users to run `worktrain console` alongside the daemon or use the CLI.
- **Condition under which it fails:** If left with the current message, users will be confused when they click the dispatch button with the standalone console running.

---

## Failure Mode Review

| Failure Mode | Handled? | Mitigation |
|---|---|---|
| Browser dispatch 503 confusing message | REQUIRES FIX | Change message in console-routes.ts POST /api/v2/auto/dispatch |
| CLI spawn/await/poll ECONNREFUSED | ACCEPTABLE | Clear error, users know to start console |
| Lock file race (old daemon-console.ts and standalone conflict) | NOT APPLICABLE | daemon-console.ts is deleted |
| Daemon tests referencing startDaemonConsole | CLEANUP NEEDED | Delete tests/unit/daemon-console.test.ts |

**Most dangerous failure mode:** The 503 message confusion. All others are low risk.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate C -- proxy):** One element worth borrowing: making the 503 response more actionable. Instead of a generic message, distinguish between "standalone console (daemon not available)" and "daemon console with working dispatch". The improvement is 2 lines in console-routes.ts. Proxy routes from Candidate C are not needed.

**Simpler variant of Candidate A:** Candidate A without the 503 message fix. Satisfies structural acceptance criteria but leaves confusing UX. Not recommended -- the message fix is too small to omit.

**Hybrid:** Candidate A + improved 503 message = the correct implementation. This is what is recommended.

---

## Philosophy Alignment

| Principle | Status | Notes |
|---|---|---|
| Architectural fixes over patches | SATISFIED | Deleting root cause, not patching |
| YAGNI with discipline | SATISFIED | Net -220 lines |
| Make illegal states unrepresentable | SATISFIED | Dual-console ambiguity eliminated |
| Dependency injection for boundaries | SATISFIED | standalone-console.ts already uses DI correctly |
| Errors are data | ACCEPTABLE TENSION | 503 HTTP response is correct at HTTP boundary |

No risky philosophy tensions.

---

## Findings

### RED (Blocking)
None.

### ORANGE (Must Address Before Implementation)

**O1: 503 error message is wrong for standalone console context**
- Location: `src/v2/usecases/console-routes.ts`, POST /api/v2/auto/dispatch handler, line ~758
- Current: "Autonomous dispatch requires v2 tools enabled."
- Required: "Autonomous dispatch requires the WorkTrain daemon. Run `worktrain console` alongside `worktrain daemon`, or use the `worktrain dispatch` CLI command."
- Why orange: UX-blocking confusion for the primary user. Small fix but must be done.

### YELLOW (Should Address, Not Blocking)

**Y1: trigger-listener.ts comment still mentions startDaemonConsole**
- Location: `src/trigger/trigger-listener.ts`, TriggerListenerHandle interface JSDoc (lines 81-88)
- The JSDoc says "Pass to startDaemonConsole() so POST /sessions/:id/steer can dispatch steers..."
- After Candidate A, this guidance is stale. Remove the `steerRegistry` JSDoc reference to `startDaemonConsole`.

**Y2: cli-worktrain.ts daemon startup may have a console handle cleanup path**
- Location: `src/cli-worktrain.ts`, around line 439 -- `consoleHandle` variable used in signal handlers
- After removing `startDaemonConsole()` call, verify the SIGINT/SIGTERM handler correctly cleans up without attempting `consoleHandle.stop()`.

**Y3: launchd service definition may need updating**
- If the owner runs `worktrain daemon` via launchd, a second launchd plist (or a wrapper script) is needed to also start `worktrain console`. This is documentation/deployment work, not code.

---

## Recommended Revisions

1. **Delete `src/trigger/daemon-console.ts`** (220 lines)
2. **Delete `tests/unit/daemon-console.test.ts`** (tests for deleted file)
3. **In `src/cli-worktrain.ts`**: Remove lines 370, 431-449 (startDaemonConsole import and call); update signal handler to not reference `consoleHandle`
4. **In `src/v2/usecases/console-routes.ts`**: Update POST /api/v2/auto/dispatch 503 message (O1)
5. **In `src/trigger/trigger-listener.ts`**: Remove stale JSDoc reference to `startDaemonConsole` (Y1)
6. **(Optional)** Document launchd startup change in `docs/configuration.md`

---

## Residual Concerns

**RC1: The `worktrain dispatch` CLI command must exist or be easy to use**
The improved 503 message references `worktrain dispatch`. If this command does not exist, the message is misleading. Verify that a dispatch CLI command exists (`worktrain-trigger-poll.ts` does force-poll, but does a dispatch-by-workflow-id CLI exist?). If not, the 503 message should be adjusted to remove the CLI reference.

**RC2: Owner may not know to run both `worktrain daemon` and `worktrain console` separately**
This is a documentation and UX concern, not a code concern. The daemon startup log should include a line like "[DaemonConsole] Start the WorkRail console with: worktrain console" when the console is not detected. This would be a small addition to cli-worktrain.ts after the trigger listener starts.
