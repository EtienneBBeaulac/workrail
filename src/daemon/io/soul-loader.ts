/**
 * Daemon soul file loader.
 *
 * WHY this module: loadDaemonSoul() is a file I/O operation with no session
 * or agent dependencies. It belongs in the io/ layer, not in the orchestration
 * file (workflow-runner.ts). Extracting it makes the I/O boundary explicit.
 *
 * WHY WORKRAIL_DIR lives here: it is used only by loadDaemonSoul().
 * Path constants that exist only to support a single I/O function belong
 * with that function, not in a shared constants file.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DAEMON_SOUL_DEFAULT, DAEMON_SOUL_TEMPLATE } from '../soul-template.js';

export { DAEMON_SOUL_DEFAULT, DAEMON_SOUL_TEMPLATE } from '../soul-template.js';

/**
 * Root directory for WorkRail user data (crash recovery, soul file, etc.).
 * WHY: daemon-soul.md lives alongside daemon-sessions/ in ~/.workrail/, not in
 * the data/ subdirectory controlled by WORKRAIL_DATA_DIR.
 */
export const WORKRAIL_DIR = path.join(os.homedir(), '.workrail');

/**
 * Load the operator-customizable agent rules from a soul file.
 *
 * @param resolvedPath - Optional resolved path from the cascade in trigger-store.ts:
 *   TriggerDefinition.soulFile (trigger override) -> WorkspaceConfig.soulFile (workspace default).
 *   When absent, falls back to ~/.workrail/daemon-soul.md (global default).
 *
 * On first run (file absent), writes a template to disk so the operator can discover
 * and customize it. The write is best-effort: if it fails, the warning is logged and
 * DAEMON_SOUL_DEFAULT is returned anyway.
 *
 * WHY path.dirname(soulPath) for mkdir: for workspace-scoped paths like
 * ~/.workrail/workspaces/my-project/daemon-soul.md, the parent dir must be created --
 * not WORKRAIL_DIR (~/.workrail) which is already present.
 */
export async function loadDaemonSoul(resolvedPath?: string): Promise<string> {
  const soulPath = resolvedPath ?? path.join(WORKRAIL_DIR, 'daemon-soul.md');
  try {
    return await fs.readFile(soulPath, 'utf8');
  } catch (err: unknown) {
    // ENOENT = first run. Write the template, then return the default content.
    // Any other error (permissions, etc.) is treated the same way.
    const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isEnoent) {
      // Best-effort template creation -- failure is logged but never fatal.
      try {
        await fs.mkdir(path.dirname(soulPath), { recursive: true });
        await fs.writeFile(soulPath, DAEMON_SOUL_TEMPLATE, 'utf8');
        console.log(`[WorkflowRunner] Created daemon-soul.md template at ${soulPath}`);
      } catch (writeErr: unknown) {
        console.warn(
          `[WorkflowRunner] Warning: could not write daemon-soul.md template: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        );
      }
    } else {
      console.warn(
        `[WorkflowRunner] Warning: could not read daemon-soul.md: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return DAEMON_SOUL_DEFAULT;
  }
}
