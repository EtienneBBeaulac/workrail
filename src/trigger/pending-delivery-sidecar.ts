/**
 * Generalized pending-delivery sidecar: typed per-adapter state for async delivery pollers.
 *
 * WHY a separate file (not in pending-draft-review-poller.ts): the sidecar format is delivery
 * infrastructure shared by all async adapters. pending-draft-review-poller.ts is about the
 * polling lifecycle for one specific adapter; it should not own cross-adapter types.
 *
 * WHY discriminated union (not Record<string,unknown>): each adapter's poll state has a known
 * shape at compile time. A discriminated union makes illegal states unrepresentable and
 * eliminates unsafe casts in startup recovery.
 *
 * Invariant: writePendingDeliverySidecar() MUST be called BEFORE the poller starts.
 * Crash recovery reads this file to restart the poller after daemon restart.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DAEMON_SESSIONS_DIR } from '../daemon/tools/_shared.js';

// ---------------------------------------------------------------------------
// Per-adapter poll state types
// ---------------------------------------------------------------------------

export interface GitHubDraftReviewPollState {
  readonly reviewId: number;
  readonly prNumber: number;
  readonly prRepo: string;
  readonly token: string;
  readonly login: string;
  readonly workrailSessionId: string;
}

// ---------------------------------------------------------------------------
// PendingDeliverySidecar: discriminated union per adapterId
// ---------------------------------------------------------------------------

export type PendingDeliverySidecar =
  | {
      readonly adapterId: 'github_draft_review';
      readonly daemonSessionId: string;
      readonly createdAt: string;
      readonly state: GitHubDraftReviewPollState;
    };
// Future adapter kinds extend this union:
// | { readonly adapterId: 'gitlab_mr_note'; readonly daemonSessionId: string; readonly createdAt: string; readonly state: GitLabMrNotePollState }

// ---------------------------------------------------------------------------
// PollHandle: discriminated union (replaces Record<string,unknown>)
// ---------------------------------------------------------------------------

export type PollHandle =
  | {
      readonly adapterId: 'github_draft_review';
      readonly state: GitHubDraftReviewPollState;
    };

// ---------------------------------------------------------------------------
// Sidecar I/O helpers
// ---------------------------------------------------------------------------

/**
 * Write a pending-delivery sidecar BEFORE starting the poller.
 * Uses atomic tmp-then-rename to prevent partial writes.
 */
export async function writePendingDeliverySidecar(
  sidecar: PendingDeliverySidecar,
  sessionsDir: string = DAEMON_SESSIONS_DIR,
): Promise<void> {
  const sidecarPath = path.join(sessionsDir, `pending-delivery-${sidecar.daemonSessionId}.json`);
  const tmpPath = `${sidecarPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(sidecar, null, 2), 'utf8');
  await fs.rename(tmpPath, sidecarPath);
}

/**
 * Read all pending-delivery sidecars from the sessions directory.
 * Skips malformed or unknown adapterId entries silently -- each entry is validated
 * against the discriminated union shape before being returned.
 */
export async function readAllPendingDeliverySidecars(
  sessionsDir: string = DAEMON_SESSIONS_DIR,
): Promise<PendingDeliverySidecar[]> {
  const sidecars: PendingDeliverySidecar[] = [];
  let entries: string[];
  try { entries = await fs.readdir(sessionsDir); } catch { return sidecars; }
  for (const entry of entries) {
    if (!entry.startsWith('pending-delivery-') || !entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(sessionsDir, entry), 'utf8');
      const parsed = JSON.parse(raw) as Partial<PendingDeliverySidecar>;
      if (parsed.adapterId === 'github_draft_review') {
        const s = parsed.state as Partial<GitHubDraftReviewPollState> | undefined;
        if (
          typeof parsed.daemonSessionId === 'string' &&
          typeof parsed.createdAt === 'string' &&
          s !== undefined &&
          typeof s.reviewId === 'number' &&
          typeof s.prNumber === 'number' &&
          typeof s.prRepo === 'string' &&
          typeof s.token === 'string' &&
          typeof s.login === 'string' &&
          typeof s.workrailSessionId === 'string'
        ) {
          sidecars.push(parsed as PendingDeliverySidecar);
        } else {
          console.warn(`[PendingDeliverySidecar] Skipping malformed github_draft_review sidecar: ${entry}`);
        }
      } else if (parsed.adapterId !== undefined) {
        console.warn(`[PendingDeliverySidecar] Unknown adapterId '${String(parsed.adapterId)}' -- skipping: ${entry}`);
      }
    } catch { /* skip corrupt sidecars */ }
  }
  return sidecars;
}
