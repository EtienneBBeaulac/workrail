import { assertNever } from '../runtime/assert-never.js';
import { createHostDiscovery } from './discovery.js';
import type { HostDiscoveryCursor, HostSessionScanner } from './contracts/host-discovery-contract.js';
import type { IncompatibleAnswerSession, LegacyRollbackInspectConfig, RollbackInspectionResult, RollbackReadIssue } from './contracts/legacy-rollback-contract.js';

/** Observation only: no result authorizes launching an older reader. */
export async function inspectLegacyRollback(
  config: LegacyRollbackInspectConfig, signal: AbortSignal,
  discover: typeof createHostDiscovery = createHostDiscovery,
): Promise<RollbackInspectionResult> {
  const context = { baseline: config.targetBaseline, notice: 'observation_only_not_downgrade_authorization' as const };
  if (signal.aborted) return { ...context, kind: 'cancelled' };
  const observed: IncompatibleAnswerSession[] = [];
  const issues: RollbackReadIssue[] = [];
  let count = 0;
  let scanner: HostSessionScanner | undefined;
  try {
    const created = await discover(config.discovery, signal);
    switch (created.kind) {
      case 'cancelled': issues.push({ kind: 'root', reason: 'scan_cancelled', detail: 'Inspection cancelled before enumeration completed' }); break;
      case 'refused': issues.push({ kind: 'root', reason: created.reason, detail: created.detail }); break;
      case 'created': {
        scanner = created.scanner;
        let cursor: HostDiscoveryCursor | undefined;
        let finished = false;
        while (!finished) {
          const result = await scanner.scan(cursor, signal);
          switch (result.kind) {
            case 'cancelled': issues.push({ kind: 'root', reason: 'scan_cancelled', detail: 'Inspection cancelled before enumeration completed' }); finished = true; break;
            case 'refused': issues.push({ kind: 'root', reason: 'scan_refused', detail: result.detail }); finished = true; break;
            case 'unavailable': issues.push({ kind: 'root', reason: result.reason, detail: result.detail }); finished = true; break;
            case 'page':
              for (const entry of result.page.entries) {
                count++;
                switch (entry.kind) {
                  case 'legacy': break;
                  case 'host': case 'unbound': observed.push({ kind: entry.kind, sessionId: entry.sessionId }); break;
                  case 'unavailable': issues.push({ kind: 'session', sessionId: entry.sessionId, reason: entry.reason, detail: entry.detail }); break;
                  default: assertNever(entry);
                }
              }
              if (result.page.kind === 'end') finished = true;
              else cursor = result.page.nextCursor;
              break;
            default: assertNever(result);
          }
        }
        break;
      }
      default: assertNever(created);
    }
  } catch {
    issues.push({ kind: 'root', reason: 'storage_unavailable', detail: 'Inspection could not finish reading canonical storage' });
  } finally {
    if (scanner) {
      // Caller cancellation must not prevent releasing the read-only scanner.
      try {
        const closed = await scanner.close(AbortSignal.timeout(1000));
        if (closed.kind !== 'closed') issues.push({ kind: 'root', reason: 'cleanup_incomplete', detail: closed.detail });
      } catch {
        issues.push({ kind: 'root', reason: 'cleanup_incomplete', detail: 'Scanner cleanup failed' });
      }
    }
  }
  const [issue, ...otherIssues] = issues;
  if (issue) return { ...context, kind: 'inconclusive', issues: [issue, ...otherIssues], observedIncompatibleSessions: observed };
  const [first, ...rest] = observed;
  if (first) return { ...context, kind: 'refused', reason: 'incompatible_answer_sessions_present', affectedSessions: [first, ...rest], remediation: 'use_supporting_version_or_separate_verified_backup' };
  return { ...context, kind: 'no_answer_sessions_observed', scannedSessionCount: count };
}
