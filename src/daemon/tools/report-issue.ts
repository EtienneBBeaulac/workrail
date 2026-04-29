/**
 * Factory for the report_issue tool used in daemon agent sessions.
 *
 * Extracted from workflow-runner.ts. Zero behavior change.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTool, AgentToolResult } from '../agent-loop.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import { appendIssueAsync, type IssueRecord } from './_shared.js';

/**
 * Build the report_issue tool.
 *
 * Agents call this to record a structured issue for the auto-fix coordinator.
 * The tool does NOT stop the session -- it creates a record and returns a
 * confirmation. For fatal severity, the return value instructs the agent to call
 * continue_workflow with a blocker note, after which the session ends.
 *
 * @param sessionId - The process-local session UUID (keys the issues file).
 * @param emitter - Optional event emitter to fire an issue_reported event.
 * @param workrailSessionId - The WorkRail session ID for event correlation (optional).
 * @param issuesDirOverride - Override the issues directory (for tests).
 * @param onIssueSummary - Optional callback called synchronously with the issue summary
 *   string after each successful report_issue call. Used by runWorkflow() to accumulate
 *   issue summaries for the WORKTRAIN_STUCK marker without async file I/O.
 *   WHY optional callback: avoids circular dependency and keeps execute() synchronous
 *   from the caller's perspective. Fire-and-forget writes happen separately.
 */
export function makeReportIssueTool(
  sessionId: string,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
  issuesDirOverride?: string,
  onIssueSummary?: (summary: string) => void,
): AgentTool {
  const issuesDir = issuesDirOverride ?? path.join(os.homedir(), '.workrail', 'issues');

  return {
    name: 'report_issue',
    description:
      "Record a structured issue, error, or unexpected behavior. Call this AND continue_workflow (unless fatal). " +
      "Does not stop the session -- it creates a record for the auto-fix coordinator.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['tool_failure', 'blocked', 'unexpected_behavior', 'needs_human', 'self_correction'],
          description: 'Category of issue being reported.',
        },
        severity: {
          type: 'string',
          enum: ['info', 'warn', 'error', 'fatal'],
          description: 'Severity level. Fatal means the session cannot continue productively.',
        },
        summary: {
          type: 'string',
          description: 'One-line summary of the issue. Max 200 chars.',
          maxLength: 200,
        },
        context: {
          type: 'string',
          description: 'What you were trying to do when this issue occurred.',
        },
        toolName: {
          type: 'string',
          description: 'Name of the tool that failed or behaved unexpectedly, if applicable.',
        },
        command: {
          type: 'string',
          description: 'The shell command or expression that caused the issue, if applicable.',
        },
        suggestedFix: {
          type: 'string',
          description: 'A suggested fix or recovery action for the auto-fix coordinator.',
        },
        continueToken: {
          type: 'string',
          description: 'The current continueToken, so the coordinator can resume this session.',
        },
      },
      required: ['kind', 'severity', 'summary'],
      additionalProperties: false,
    },
    label: 'report_issue',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_toolCallId: string, params: any): Promise<AgentToolResult<unknown>> => {
      if (typeof params.kind !== 'string' || !params.kind) throw new Error('report_issue: kind must be a non-empty string');
      if (typeof params.severity !== 'string' || !params.severity) throw new Error('report_issue: severity must be a non-empty string');
      if (typeof params.summary !== 'string' || !params.summary) throw new Error('report_issue: summary must be a non-empty string');
      const record: IssueRecord = {
        sessionId,
        kind: params.kind as IssueRecord['kind'],
        severity: params.severity as IssueRecord['severity'],
        summary: String(params.summary ?? '').slice(0, 200),
        ...(params.context !== undefined && { context: String(params.context) }),
        ...(params.toolName !== undefined && { toolName: String(params.toolName) }),
        ...(params.command !== undefined && { command: String(params.command) }),
        ...(params.suggestedFix !== undefined && { suggestedFix: String(params.suggestedFix) }),
        ...(params.continueToken !== undefined && { continueToken: String(params.continueToken) }),
      };

      // Fire-and-forget: write must never block execute() or propagate errors.
      // WHY void + catch: observability must not affect correctness.
      void appendIssueAsync(issuesDir, sessionId, record).catch(() => {
        // Intentionally empty: write failures are silently swallowed.
      });

      // Emit structured event for console/SSE stream visibility.
      emitter?.emit({
        kind: 'issue_reported',
        sessionId,
        issueKind: record.kind,
        severity: record.severity,
        summary: record.summary,
        ...(record.continueToken !== undefined && { continueToken: record.continueToken }),
        ...(workrailSessionId != null ? { workrailSessionId } : {}),
      });

      // Notify the accumulator so runWorkflow() can include issue summaries in
      // the WORKTRAIN_STUCK marker without async file I/O.
      // WHY synchronous callback: execute() already runs synchronously from the
      // agent loop's perspective; the callback push is O(1) and never throws.
      onIssueSummary?.(record.summary);

      const isFatal = record.severity === 'fatal';
      const message = isFatal
        ? `FATAL issue recorded. Call continue_workflow with notes explaining the blocker, then the session will end.`
        : `Issue recorded (severity=${record.severity}). Continue with your work unless this is fatal.`;

      return {
        content: [{ type: 'text', text: message }],
        details: { sessionId, kind: record.kind, severity: record.severity },
      };
    },
  };
}
