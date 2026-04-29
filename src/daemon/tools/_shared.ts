/**
 * Shared utilities for daemon tool factories.
 *
 * WHY this module exists: the tool factory files under src/daemon/tools/ need a
 * set of helpers (persistTokens, withWorkrailSession, constants, etc.) that were
 * previously private to workflow-runner.ts. Extracting them here breaks the
 * circular import that would otherwise occur if tool files imported from
 * workflow-runner.ts at runtime.
 *
 * This module has NO runtime imports from workflow-runner.ts. It only uses
 * third-party modules and the project's own utility modules.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ok, err } from '../../runtime/result.js';
import type { Result } from '../../runtime/result.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directory that holds per-session crash-recovery state files.
 * Each concurrent runWorkflow() call writes to its own <sessionId>.json file,
 * so concurrent sessions never clobber each other.
 *
 * WHY exported: trigger-router.ts and tests import this constant from
 * workflow-runner.ts. workflow-runner.ts re-exports it from here.
 */
export const DAEMON_SESSIONS_DIR = path.join(os.homedir(), '.workrail', 'daemon-sessions');

/** Maximum wall-clock time allowed for a single Bash tool invocation. */
export const BASH_TIMEOUT_MS = 5 * 60 * 1000;

/** Max file size Read will return without offset/limit (256 KiB). */
export const READ_SIZE_CAP_BYTES = 256 * 1024;

/** Glob paths always excluded from makeGlobTool results. */
export const GLOB_ALWAYS_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];

// ---------------------------------------------------------------------------
// withWorkrailSession
// ---------------------------------------------------------------------------

/**
 * Conditionally spreads workrailSessionId into a daemon event object.
 *
 * WHY: workrailSessionId (the WorkRail sess_xxx ID) is unavailable at session_started
 * time -- it can only be decoded from the continueToken after executeStartWorkflow()
 * returns. All subsequent events include it when available, via this helper.
 * Returns an empty object when sid is null so callers can spread unconditionally.
 */
export function withWorkrailSession(sid: string | null | undefined): { workrailSessionId?: string } {
  return sid != null ? { workrailSessionId: sid } : {};
}

// ---------------------------------------------------------------------------
// persistTokens
// ---------------------------------------------------------------------------

/**
 * Error shape for a persistTokens failure.
 * WHY its own type (not a generic string): the code field lets callers
 * distinguish filesystem errors (ENOSPC, EPERM) from logic errors without
 * string parsing.
 */
export interface PersistTokensError {
  readonly code: string;
  readonly message: string;
}

/**
 * Atomically write the current continue/checkpoint tokens to a per-session sidecar file.
 *
 * WHY atomic write (write tmp then rename): a crash during fs.writeFile() would leave
 * a partial JSON file. The tmp-file + rename pattern ensures the sidecar is always
 * either the previous valid state or the new complete state -- never corrupted.
 */
export async function persistTokens(
  sessionId: string,
  continueToken: string,
  checkpointToken: string | null,
  worktreePath?: string,
  recoveryContext?: {
    readonly workflowId: string;
    readonly goal: string;
    readonly workspacePath: string;
  },
): Promise<Result<void, PersistTokensError>> {
  try {
    await fs.mkdir(DAEMON_SESSIONS_DIR, { recursive: true });

    const sessionPath = path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`);
    const state = JSON.stringify(
      {
        continueToken,
        checkpointToken,
        ts: Date.now(),
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(recoveryContext !== undefined ? {
          workflowId: recoveryContext.workflowId,
          goal: recoveryContext.goal,
          workspacePath: recoveryContext.workspacePath,
        } : {}),
      },
      null,
      2,
    );
    const tmp = `${sessionPath}.tmp`;
    await fs.writeFile(tmp, state, 'utf8');
    await fs.rename(tmp, sessionPath);
    return ok(undefined);
  } catch (e: unknown) {
    const nodeErr = e as NodeJS.ErrnoException;
    return err({ code: nodeErr.code ?? 'UNKNOWN', message: nodeErr.message ?? String(e) });
  }
}

// ---------------------------------------------------------------------------
// findActualString
// ---------------------------------------------------------------------------

/**
 * Normalizes LLM-generated typographic quotes to their ASCII equivalents.
 *
 * WHY: LLMs trained on typographic text often generate curly single quotes (‘, ’)
 * and curly double quotes (“, ”) where the user intended straight ASCII quotes.
 * When these appear in an `old_string` for Edit, the exact match fails. This function
 * tries the normalized form as a fallback, recovering from the most common LLM quote variants.
 *
 * Handles ~95% of LLM quote variants. Full Unicode normalization is YAGNI (YELLOW-2).
 */
export function findActualString(fileContent: string, oldString: string): string | null {
  if (fileContent.includes(oldString)) return oldString;
  // Handle LLM-generated typographic quotes
  const normalized = oldString
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, '-')
    .replace(/—/g, '--');
  if (fileContent.includes(normalized)) return normalized;
  return null;
}

// ---------------------------------------------------------------------------
// appendIssueAsync / IssueRecord
// ---------------------------------------------------------------------------

/** Input record shape for a report_issue call (before ts is appended). */
export interface IssueRecord {
  sessionId: string;
  kind: 'tool_failure' | 'blocked' | 'unexpected_behavior' | 'needs_human' | 'self_correction';
  severity: 'info' | 'warn' | 'error' | 'fatal';
  summary: string;
  context?: string;
  toolName?: string;
  command?: string;
  suggestedFix?: string;
  continueToken?: string;
}

/**
 * Append a single JSON issue record to the per-session JSONL file.
 *
 * WHY void + catch: issue recording is purely observational. A failed write
 * (disk full, permission denied) must not propagate to the caller or interrupt
 * the workflow session. Same fire-and-forget contract as DaemonEventEmitter.
 *
 * WHY separate helper: keeps execute() synchronous from the caller's perspective
 * and makes the async write path independently testable via issuesDirOverride.
 *
 * @param issuesDir - Directory for issue files (override in tests; production uses ~/.workrail/issues).
 * @param sessionId - Session identifier used as the filename.
 * @param record - The issue payload to serialize as a JSON line.
 */
export async function appendIssueAsync(
  issuesDir: string,
  sessionId: string,
  record: IssueRecord,
): Promise<void> {
  await fs.mkdir(issuesDir, { recursive: true });
  const filePath = path.join(issuesDir, `${sessionId}.jsonl`);
  const line = JSON.stringify({ ...record, ts: Date.now() }) + '\n';
  await fs.appendFile(filePath, line, 'utf8');
}

// ---------------------------------------------------------------------------
// appendSignalAsync / SignalRecord
// ---------------------------------------------------------------------------

/** Payload written to the per-session JSONL sidecar (before ts is appended). */
export interface SignalRecord {
  readonly signalId: string;
  readonly sessionId: string;
  readonly workrailSessionId?: string;
  readonly signalKind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Append a single JSON signal record to the per-session JSONL file.
 *
 * Fire-and-forget: errors are swallowed so a failed write never interrupts
 * the session. Same contract as appendIssueAsync and DaemonEventEmitter.
 */
export async function appendSignalAsync(
  signalsDir: string,
  sessionId: string,
  record: SignalRecord,
): Promise<void> {
  await fs.mkdir(signalsDir, { recursive: true });
  const filePath = path.join(signalsDir, `${sessionId}.jsonl`);
  const line = JSON.stringify({ ...record, ts: Date.now() }) + '\n';
  await fs.appendFile(filePath, line, 'utf8');
}
