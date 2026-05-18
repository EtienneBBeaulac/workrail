/**
 * WorkTrain session kill command.
 *
 * Aborts a running daemon session.
 *
 * STUB: The daemon HTTP endpoint (POST /api/v2/sessions/:id/abort) does not
 * yet exist. This command returns a clear "not yet implemented" error until
 * the daemon route ships. The CLI surface is registered now so operators can
 * discover it and scripts can be written against it.
 *
 * Design invariants:
 * - Returns CliResult -- never throws, never calls process.exit directly.
 * - Requires --force or a y/N confirmation for the destructive action.
 */

import type { CliResult } from '../types/cli-result.js';
import { failure } from '../types/cli-result.js';

export interface WorktrainSessionKillCommandOpts {
  readonly sessionId: string;
  readonly force?: boolean;
}

/**
 * Execute the session kill command.
 *
 * Currently returns a "not yet implemented" failure -- the daemon HTTP route
 * (POST /api/v2/sessions/:id/abort) does not yet exist. The CLI surface is
 * registered now; the implementation ships when the daemon route does.
 */
export async function executeWorktrainSessionKillCommand(
  opts: WorktrainSessionKillCommandOpts,
): Promise<CliResult> {
  return failure(
    `session kill is not yet implemented -- the daemon abort endpoint is pending.\n` +
    `Session ID: ${opts.sessionId}\n` +
    `Follow-up: POST /api/v2/sessions/:id/abort on the daemon HTTP server.`,
  );
}
