/**
 * Factory for the Bash tool used in daemon agent sessions.
 *
 * Extracted from workflow-runner.ts. Zero behavior change.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentTool, AgentToolResult } from '../agent-loop.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import { BASH_TIMEOUT_MS, withWorkrailSession } from './_shared.js';

const execAsync = promisify(exec);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeBashTool(workspacePath: string, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Bash',
    description:
      'Execute a shell command. Throws on failure (non-zero exit with stderr, or exit code 2+). ' +
      'Exit code 1 with empty stderr is treated as "no match found" (standard grep semantics) and ' +
      'returns empty output without throwing. ' +
      `Maximum execution time: ${BASH_TIMEOUT_MS / 1000}s.`,
    inputSchema: schemas['BashParams'],
    label: 'Bash',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.command !== 'string' || !params.command) throw new Error('Bash: command must be a non-empty string');
      console.log(`[WorkflowRunner] Tool: bash "${String(params.command).slice(0, 80)}"`);
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Bash', summary: String(params.command).slice(0, 80), ...withWorkrailSession(workrailSessionId) });
      const cwd = params.cwd ?? workspacePath;
      try {
        const { stdout, stderr } = await execAsync(params.command, {
          cwd,
          timeout: BASH_TIMEOUT_MS,
          shell: '/bin/bash',
        });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { stdout, stderr },
        };
      } catch (err: unknown) {
        // Node's child_process.exec errors (ExecException) attach stdout, stderr,
        // code, and signal as own properties. Extract them so the agent can reason
        // about what went wrong and retry intelligently.
        // WHY rawCode: `code` is null (not a number) when the process was killed by
        // a signal (e.g. SIGTERM on exec timeout). Check rawCode before coalescing
        // so the signal branch is reachable -- `rawCode ?? 'unknown'` would collapse
        // null to 'unknown' and make signal unreachable.
        const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown };
        const stdout = String(e.stdout ?? '');
        const stderr = String(e.stderr ?? '');
        const rawCode = e.code;
        const signal = e.signal;

        // Exit code 1 with empty stderr is "no match found" -- not a real error.
        // This is standard POSIX semantics for grep (exit 1 = no lines matched,
        // exit 2 = genuine error). Applying the same rule to any command that exits
        // 1 with no error output is safe: a command that fails silently is almost
        // always reporting "nothing found", not a broken execution.
        // WHY `rawCode === 1 && !stderr.trim()`: rawCode is a number when set by
        // normal process exit; the trim() guard ignores purely-whitespace stderr.
        // This branch is NOT entered for exit 2+ (always an error) or when stderr
        // is non-empty (the process wrote a diagnostic message, so it is a real error).
        if (rawCode === 1 && !stderr.trim()) {
          return {
            content: [{ type: 'text', text: stdout || '(no output)' }],
            details: { stdout, stderr },
          };
        }

        const exitInfo = rawCode != null
          ? `exit ${String(rawCode)}`
          : signal
            ? `signal ${String(signal)}`
            : 'exit unknown';
        throw new Error(
          `Command failed: ${params.command} (${exitInfo})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        );
      }
    },
  };
}
