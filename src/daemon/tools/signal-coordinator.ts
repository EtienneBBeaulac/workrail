/**
 * Factory for the signal_coordinator tool used in daemon agent sessions.
 *
 * Extracted from workflow-runner.ts. Zero behavior change.
 *
 * WHY DAEMON_SIGNALS_DIR is defined here: the constant belongs to the
 * signal_coordinator tool's domain. It is re-exported from workflow-runner.ts
 * for backward compatibility with tests that import it from there.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentTool, AgentToolResult } from '../agent-loop.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import { appendSignalAsync, type SignalRecord, withWorkrailSession } from './_shared.js';

/**
 * Directory that holds per-session signal JSONL files.
 *
 * Each concurrent runWorkflow() call appends its signals to
 * ~/.workrail/signals/<sessionId>.jsonl. Coordinators can tail this file
 * or read it at session boundaries without touching the durable session store.
 *
 * WHY a sidecar file instead of the v2 session store:
 * The session store uses a re-entrancy guard (ExecutionSessionGate.activeSessions).
 * At the point signal_coordinator executes, the gate is already held by the
 * ongoing continue_workflow / complete_step machinery. Attempting a second
 * session lock would return SESSION_LOCK_REENTRANT. The sidecar file avoids
 * this entirely: it is a separate, lock-free append channel that the coordinator
 * can read independently. The DaemonEventEmitter simultaneously broadcasts the
 * signal to the daemon JSONL event stream for live console visibility.
 */
export const DAEMON_SIGNALS_DIR = path.join(os.homedir(), '.workrail', 'signals');

/**
 * Build the signal_coordinator tool for daemon sessions.
 *
 * The agent calls this to emit a structured coordinator signal without
 * advancing the workflow step. The signal is written to:
 * 1. ~/.workrail/signals/<sessionId>.jsonl -- sidecar JSONL for coordinator polling
 * 2. The daemon event log (via DaemonEventEmitter) -- for live console visibility
 *
 * WHY NOT writing to the v2 session store directly:
 * The session store uses a re-entrancy guard (ExecutionSessionGate). When
 * signal_coordinator executes, the gate is already held by the in-flight
 * continue_workflow / complete_step tool. Attempting withHealthySessionLock()
 * would return SESSION_LOCK_REENTRANT and abort the signal write. The sidecar
 * file is the correct channel for mid-step, non-advancing signal emission.
 *
 * WHY fire-and-observe (always returns immediately):
 * The tool must not block the agent. Signals are best-effort observability
 * artifacts -- a coordinator that reads them asynchronously is the intended
 * consumer. The agent proceeds to its next tool call regardless.
 *
 * @param sessionId - Process-local UUID (keys the sidecar JSONL file).
 * @param emitter - Optional event emitter for daemon JSONL visibility.
 * @param workrailSessionId - WorkRail session ID for event correlation.
 * @param signalsDirOverride - Override the signals directory (for tests).
 */
export function makeSignalCoordinatorTool(
  sessionId: string,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
  signalsDirOverride?: string,
): AgentTool {
  const signalsDir = signalsDirOverride ?? DAEMON_SIGNALS_DIR;

  return {
    name: 'signal_coordinator',
    description:
      'Emit a structured mid-session signal to the coordinator WITHOUT advancing the workflow step. ' +
      'Use this to surface progress updates, intermediate findings, data requests, ' +
      'approval requests, or blocking conditions while the session continues. ' +
      'Always returns immediately -- fire-and-observe, never blocks. ' +
      'Signal kinds: "progress" (heartbeat, no data needed), "finding" (intermediate result), ' +
      '"data_needed" (request external data), "approval_needed" (request coordinator approval), ' +
      '"blocked" (cannot continue without coordinator intervention).',
    inputSchema: {
      type: 'object',
      properties: {
        signalKind: {
          type: 'string',
          enum: ['progress', 'finding', 'data_needed', 'approval_needed', 'blocked'],
          description: 'The kind of signal to emit.',
        },
        payload: {
          type: 'object',
          additionalProperties: true,
          description: 'Structured data accompanying the signal. Pass {} for progress signals.',
        },
      },
      required: ['signalKind', 'payload'],
      additionalProperties: false,
    },
    label: 'signal_coordinator',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_toolCallId: string, params: any): Promise<AgentToolResult<unknown>> => {
      if (typeof params.signalKind !== 'string' || !params.signalKind) throw new Error('signal_coordinator: signalKind must be a non-empty string');
      const signalId = 'sig_' + randomUUID().replace(/-/g, '').slice(0, 8);
      const signalKind = String(params.signalKind ?? 'progress');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = (typeof params.payload === 'object' && params.payload !== null && !Array.isArray(params.payload))
        ? (params.payload as Record<string, unknown>)
        : {};

      console.log(`[WorkflowRunner] Tool: signal_coordinator sessionId=${sessionId} signalKind=${signalKind} signalId=${signalId}`);

      const record: SignalRecord = {
        signalId,
        sessionId,
        ...(workrailSessionId != null ? { workrailSessionId } : {}),
        signalKind,
        payload,
      };

      // Fire-and-forget sidecar write. A failed write never blocks or throws.
      void appendSignalAsync(signalsDir, sessionId, record).catch(() => {
        // Intentionally empty: write failures are silently swallowed.
      });

      // Emit to the daemon event log for live console visibility.
      emitter?.emit({
        kind: 'signal_emitted',
        sessionId,
        signalKind,
        signalId,
        payload,
        ...(workrailSessionId != null ? { workrailSessionId } : {}),
      });

      const result = { status: 'recorded' as const, signalId };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
