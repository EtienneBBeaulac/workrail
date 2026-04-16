/**
 * WorkTrain Tell Command
 *
 * Appends a user message to ~/.workrail/message-queue.jsonl for async delivery
 * to the WorkTrain daemon. The daemon drains this queue at natural break points
 * between agent completions -- never mid-run.
 *
 * Design invariants:
 * - All I/O is injected via WorktrainTellCommandDeps. Zero direct fs/os imports.
 * - message-queue.jsonl is append-only. This command never reads or rewrites it.
 * - The file and its parent directory are created on first write (create-on-missing).
 * - All failures are returned as CliResult failure variants -- never thrown.
 *
 * Concurrency note: fs.appendFile is used for writes. POSIX guarantees atomicity
 * for writes <= PIPE_BUF (~4096 bytes). Individual message lines are well under this
 * limit in practice. Concurrent `tell` calls from automated tooling with large payloads
 * could interleave -- acceptable for a developer CLI tool.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure, misuse } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Priority level for a queued message.
 * Validated by commander .choices() at the composition root; trusted here.
 */
export type Priority = 'high' | 'normal' | 'low';

/**
 * A single entry in message-queue.jsonl.
 * One JSON object per line (JSONL format).
 */
export interface QueuedMessage {
  /** UUIDv4 generated at enqueue time. */
  readonly id: string;
  /** The message text from the user. */
  readonly message: string;
  /** ISO 8601 timestamp of when the message was queued. */
  readonly timestamp: string;
  /** Optional workspace hint for the daemon to route the message. */
  readonly workspaceHint?: string;
  /** Priority level. Default: 'normal'. */
  readonly priority: Priority;
}

/**
 * All I/O operations required by the tell command.
 * Inject real implementations in the composition root; inject fakes in tests.
 */
export interface WorktrainTellCommandDeps {
  /** Append a line to a file, creating it if it does not exist. */
  readonly appendFile: (path: string, content: string) => Promise<void>;
  /** Create a directory (recursive: true = mkdir -p). */
  readonly mkdir: (path: string, options: { recursive: boolean }) => Promise<string | undefined>;
  /** Return the user's home directory. */
  readonly homedir: () => string;
  /** Join path segments (same semantics as node:path join). */
  readonly joinPath: (...paths: string[]) => string;
  /** Print a line to stdout. */
  readonly print: (line: string) => void;
  /** Return the current timestamp as ISO 8601 string. Injected for determinism in tests. */
  readonly now: () => string;
  /** Generate a UUIDv4. Injected for determinism in tests. */
  readonly generateId: () => string;
}

/**
 * Options for the tell command.
 */
export interface WorktrainTellCommandOpts {
  /** Optional workspace hint to include in the message. */
  readonly workspace?: string;
  /** Priority level. Validated by caller. Defaults to 'normal'. */
  readonly priority?: Priority;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the `worktrain tell <message>` command.
 *
 * Appends a single JSONL line to ~/.workrail/message-queue.jsonl.
 * Creates the file and ~/.workrail/ directory if they do not exist.
 *
 * Returns CliResult success on success, failure on I/O error.
 */
export async function executeWorktrainTellCommand(
  messageText: string,
  deps: WorktrainTellCommandDeps,
  opts: WorktrainTellCommandOpts = {},
): Promise<CliResult> {
  if (!messageText || !messageText.trim()) {
    return misuse('Message text cannot be empty.', [
      'Usage: worktrain tell "<message>"',
    ]);
  }

  const priority: Priority = opts.priority ?? 'normal';
  const queueDir = deps.joinPath(deps.homedir(), '.workrail');
  const queuePath = deps.joinPath(queueDir, 'message-queue.jsonl');

  const entry: QueuedMessage = {
    id: deps.generateId(),
    message: messageText.trim(),
    timestamp: deps.now(),
    ...(opts.workspace ? { workspaceHint: opts.workspace } : {}),
    priority,
  };

  try {
    // Ensure ~/.workrail/ exists before appending
    await deps.mkdir(queueDir, { recursive: true });
    await deps.appendFile(queuePath, JSON.stringify(entry) + '\n');
  } catch (err) {
    return failure(
      `Failed to queue message: ${err instanceof Error ? err.message : String(err)}`,
      { suggestions: [`Check write permissions for ${queuePath}`] },
    );
  }

  deps.print(`Message queued (priority: ${priority}).`);

  return success({
    message: `Message queued (priority: ${priority}).`,
  });
}
