# Implementation Plan: POST /api/v2/sessions/:sessionId/steer

See WORKRAIL session notes for full design rationale.

## Summary

HTTP endpoint allowing coordinator scripts to inject text into running daemon sessions.
Uses existing steer() mechanism in AgentLoop via a new SteerRegistry type.

## Files Changed

- src/daemon/workflow-runner.ts -- SteerRegistry type export, steerRegistry param, register/deregister
- src/trigger/trigger-router.ts -- RunWorkflowFn extension, TriggerRouter wiring
- src/v2/usecases/console-routes.ts -- steerRegistry param, POST endpoint
- src/trigger/daemon-console.ts -- steerRegistry in StartDaemonConsoleOptions
- src/trigger/trigger-listener.ts -- creates steerRegistry, exposes in TriggerListenerHandle
- src/cli-worktrain.ts -- passes handle.steerRegistry to startDaemonConsole

## Design

SteerRegistry = Map<string, (text: string) => void>
- runWorkflow() registers callback after workrailSessionId is decoded
- runWorkflow() deregisters in finally block (prevents stale entries)
- HTTP endpoint: 503 (no registry), 400 (invalid text), 404 (not found), 200 (ok)
- Daemon-only; MCP-mode sessions return 404
- localhost-only auth (127.0.0.1 binding in daemon-console.ts)

## Non-Goals

- Auth token (v1 local-only)
- waitForCoordinator blocking gate (Phase 2B)
- wr.coordinator_signal artifact schema (Phase A)
- MCP-mode injection (v2)
- Crash recovery for in-flight steers (v1 known limitation)
