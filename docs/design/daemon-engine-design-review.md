# Daemon Execution Engine -- Design Review Findings

**Status:** Review complete  
**Date:** 2026-04-14  
**Selected direction:** Candidate 1 -- Daemon as MCP HTTP client  
**Confidence:** HIGH

---

## Tradeoff Review

### T1: HTTP server must be running before daemon

- Does not violate acceptance criteria. Docker Compose `depends_on` / k8s readiness probes handle startup ordering.
- Unacceptable under: requirement for daemon-only operation with no MCP server (not currently specified).
- Hidden assumption: MCP server cold start is under ~5 seconds. True -- current server starts in <500ms.
- **Status: ACCEPTED**

### T2: Tests need running HTTP server or mock

- Conditionally satisfied. MCP SDK provides `InMemoryTransport` in `@modelcontextprotocol/sdk/inMemory.js`. Test setup ~20 lines.
- Unacceptable under: SDK test utilities unavailable or test startup time prohibitive. Neither is currently the case.
- **Status: ACCEPTED**

### T3: ~1-5ms HTTP overhead per step

- No acceptance criterion specifies step latency. Step intervals are seconds to minutes (LLM calls, tool invocations).
- At 1 step/second (pathologically fast): 5ms = 0.5% wall clock. Negligible.
- Unacceptable under: sub-100ms step interval requirement. No such requirement exists.
- **Status: ACCEPTED**

---

## Failure Mode Review

### FM1: MCP session token not propagated (MEDIUM risk)

- **Coverage:** Adequate -- mitigated by using `@modelcontextprotocol/sdk/client` (SDK handles `Mcp-Session-Id` headers automatically).
- **Gap:** Implementation guidance should explicitly name the SDK class: `Client` from `@modelcontextprotocol/sdk/client/index.js` + `StreamableHTTPClientTransport`.
- **Trigger:** Developer uses raw `fetch` instead of SDK client.

### FM2: HTTP server port unavailable (LOW-MEDIUM risk)

- **Coverage:** Partial. `bindWithPortFallback` scans 3100-3199. But if the server binds to a fallback port, the daemon needs to know which port was actually bound.
- **Gap: PORT DISCOVERY NOT SPECIFIED.** The daemon must learn the server's bound port. Options: (a) read `WORKRAIL_HTTP_PORT` env var set by server on startup; (b) use a port discovery file at `~/.workrail/http-port`; (c) always try 3100 first and fall back in the daemon's client too.
- **Trigger:** Port 3100 in use; daemon hardcoded to 3100; server bound to 3147; daemon cannot connect.

### FM3: Daemon crash with ephemeral token state (HIGH risk)

- **Coverage:** Partial. Sessions are append-only event logs; `continueToken` remains valid until advanced. But if the daemon does not persist the token before executing a step, a crash mid-step cannot be recovered automatically.
- **Gap: TOKEN PERSISTENCE NOT SPECIFIED.** The daemon MUST write its active `continueToken` + `checkpointToken` to durable storage before beginning step execution. Without this, crashed sessions require human intervention.
- **Trigger:** Daemon crashes after receiving `continueToken` but before persisting it; next daemon start has no token to resume from.

---

## Runner-Up / Simpler Alternative Review

### Runner-up (Candidate 3) elements worth borrowing

**`DaemonTransport` interface:** A 5-line discriminated union with kind `mcp_http | direct`. Ship with `mcp_http` only. Add `direct` (engine-factory) later if test ergonomics demand it. Zero runtime cost. Preserves optionality.

**Recommendation: BORROW THIS.** Include the interface shape in implementation guidance.

### Simpler alternatives rejected

- **Raw fetch instead of SDK client:** Adds 30+ lines of protocol management (session IDs, protocol version negotiation). More code, more failure modes. Rejected.
- **stdio subprocess transport:** The daemon would get its own session store (different from the MCP server's). Defeats the purpose. Not applicable.

---

## Philosophy Alignment

| Principle | Status | Notes |
|-----------|--------|-------|
| Make illegal states unrepresentable | Satisfied | PID aliasing + DI collision structurally impossible (separate processes) |
| DI for boundaries | Satisfied | Daemon imports SDK client, not WorkRail DI internals |
| Validate at boundaries | Satisfied | MCP server validates at `/mcp`; daemon trusts typed responses |
| Errors are data | Satisfied | MCP error responses are typed JSON; agent loop handles discriminated values |
| Architectural fixes over patches | Satisfied | Root cause is process coupling; fix is process separation |
| YAGNI with discipline | Acceptable tension | `DaemonTransport` interface is 5 lines, zero runtime cost |
| Determinism | Satisfied | No hidden state; only `continueToken` + `checkpointToken` between steps |
| Compose with small pure functions | Satisfied | Step loop is tight, composable, pure data flow |

---

## Findings

### RED (blocking if not addressed before implementation begins)

None.

### ORANGE (should be resolved in implementation design; will cause operational pain if ignored)

**O1: Token persistence not specified**  
The daemon must persist `continueToken` + `checkpointToken` to durable storage before executing each step. Without this, daemon crashes leave sessions in an unrecoverable state. The persistence mechanism (file, SQLite, Redis) is not specified and must be decided before implementation.

**O2: Port discovery mechanism not specified**  
If the MCP server binds to a fallback port (e.g., 3147 instead of 3100), the daemon needs a way to learn the actual port. A port discovery file at `~/.workrail/http-port` or a `WORKRAIL_HTTP_PORT` env var set by the server process would work. This must be specified before implementation.

### YELLOW (worth addressing but won't block a working prototype)

**Y1: SDK client class not named in recommendation**  
Implementation guidance should explicitly call out: `Client` from `@modelcontextprotocol/sdk/client/index.js` + `StreamableHTTPClientTransport`. Otherwise a developer might reach for raw fetch.

**Y2: Test mock server pattern not specified**  
The recommendation that `InMemoryTransport` is available should be validated against the installed SDK version and documented with a code example in implementation guidance.

**Y3: Daemon concurrency model not decided**  
Whether the daemon drives one session at a time or multiple concurrent sessions affects the agent loop design significantly. One-at-a-time is simpler; multiple concurrent requires session fan-out logic. This is an open question that should be answered before implementation.

---

## Recommended Revisions

1. **Add token persistence requirement to design:** The daemon's state management must be specified before building. Recommend: write `continueToken` + `checkpointToken` to `~/.workrail/daemon-state.json` atomically before each step execution begins.

2. **Add port discovery to implementation plan:** Recommend the MCP server write its bound port to `~/.workrail/http-port` on startup. The daemon reads this file. If missing, default to `WORKRAIL_HTTP_PORT` env or 3100.

3. **Add `DaemonTransport` interface to implementation design:** 5-line interface, `mcp_http` implementation only. Keeps the door open for `direct` mode in tests.

4. **Decide daemon concurrency model:** One session at a time (simplest) or multiple concurrent (pi-mono's parallel tool execution pattern). Should be answered in the implementation spec.

---

## Residual Concerns

1. **Key rotation coordination (LOW):** If WorkRail ever implements keyring key rotation, the daemon as a long-running HTTP client will hold tokens signed with the old key. The MCP server will reject them with `token_verify_failed`. The daemon must handle this gracefully (detect `token_invalid` errors and restart the session). This is a future concern, not a current blocker.

2. **MCP protocol version negotiation (LOW):** If the WorkRail MCP server upgrades its protocol version and the daemon's SDK client is pinned to an older version, the `MCP-Protocol-Version` negotiation will fail. Standard dependency management (semver pinning) handles this. Not a design concern.

3. **Open question: should the daemon register as a named MCP client?** The SDK allows client identification via `new Client({ name: 'workrail-daemon', version: '1.0.0' })`. This enables server-side logging and diagnostics. Recommended but not required.
