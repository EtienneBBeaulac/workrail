/**
 * WorkTrain session retry command.
 *
 * Re-fires a session from scratch with the same goal and context.
 *
 * STUB: The daemon HTTP endpoint (POST /api/v2/sessions/:id/retry) does not
 * yet exist. This command returns a clear "not yet implemented" error until
 * the daemon route ships.
 *
 * Design invariants:
 * - Returns CliResult -- never throws, never calls process.exit directly.
 * - Requires --force or a y/N confirmation (destructive -- starts a new session).
 * - Should guard against retrying already-running sessions (daemon route concern).
 */

import type { CliResult } from '../types/cli-result.js';
import { failure } from '../types/cli-result.js';

export interface WorktrainSessionRetryCommandOpts {
  readonly sessionId: string;
  readonly force?: boolean;
}

/**
 * Execute the session retry command.
 *
 * Currently returns a "not yet implemented" failure -- the daemon HTTP route
 * (POST /api/v2/sessions/:id/retry) does not yet exist.
 */
export async function executeWorktrainSessionRetryCommand(
  opts: WorktrainSessionRetryCommandOpts,
): Promise<CliResult> {
  return failure(
    `session retry is not yet implemented -- the daemon retry endpoint is pending.\n` +
    `Session ID: ${opts.sessionId}\n` +
    `Follow-up: POST /api/v2/sessions/:id/retry on the daemon HTTP server.`,
  );
}
