/**
 * WorkTrain session resume command.
 *
 * Re-fires an orphaned daemon session that crash recovery did not restart.
 *
 * STUB: The daemon HTTP endpoint (POST /api/v2/sessions/:id/resume) does not
 * yet exist. This command returns a clear "not yet implemented" error until
 * the daemon route ships.
 *
 * Design invariants:
 * - Returns CliResult -- never throws, never calls process.exit directly.
 * - Should guard against resuming successfully-completed sessions (daemon route concern).
 */

import type { CliResult } from '../types/cli-result.js';
import { failure } from '../types/cli-result.js';

export interface WorktrainSessionResumeCommandOpts {
  readonly sessionId: string;
}

/**
 * Execute the session resume command.
 *
 * Currently returns a "not yet implemented" failure -- the daemon HTTP route
 * (POST /api/v2/sessions/:id/resume) does not yet exist.
 */
export async function executeWorktrainSessionResumeCommand(
  opts: WorktrainSessionResumeCommandOpts,
): Promise<CliResult> {
  return failure(
    `session resume is not yet implemented -- the daemon resume endpoint is pending.\n` +
    `Session ID: ${opts.sessionId}\n` +
    `Follow-up: POST /api/v2/sessions/:id/resume on the daemon HTTP server.`,
  );
}
