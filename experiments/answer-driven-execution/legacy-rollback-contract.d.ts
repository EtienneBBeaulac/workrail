/** Design-only operator inspection; proposed production entrypoint is absent. */
import type { SessionId } from '../../src/v2/durable-core/ids/index.js';
import type { DiscoveryUnavailableReason, HostDiscoveryConfig } from './host-discovery-contract.js';
export type KnownLegacyBaseline = '396cdfa4e665afa993b50fcf0ec59ca53a2167db';
type NoAuthority = Readonly<{
  launchAuthority?: never; readyToDowngrade?: never; compatible?: never;
  owner?: never; runner?: never; reply?: never; pointer?: never; recoveryLocator?: never;
}>;
export type IncompatibleAnswerSession = NoAuthority & Readonly<{
  kind: 'host' | 'unbound'; sessionId: SessionId;
}>;
export type RollbackReadIssue = NoAuthority & (
  | Readonly<{ kind: 'session'; sessionId: SessionId; reason: DiscoveryUnavailableReason; detail: string }>
  | Readonly<{ kind: 'root'; reason: DiscoveryUnavailableReason | 'missing_authority' | 'scan_refused' | 'cleanup_incomplete' | 'scan_cancelled'; detail: string }>
);
type InspectionContext = NoAuthority & Readonly<{
  baseline: KnownLegacyBaseline;
  notice: 'observation_only_not_downgrade_authorization';
}>;
export type RollbackInspectionResult = InspectionContext & (
  | Readonly<{
      kind: 'refused'; reason: 'incompatible_answer_sessions_present';
      affectedSessions: readonly [IncompatibleAnswerSession, ...IncompatibleAnswerSession[]];
      remediation: 'use_supporting_version_or_separate_verified_backup';
    }>
  | Readonly<{
      kind: 'inconclusive';
      issues: readonly [RollbackReadIssue, ...RollbackReadIssue[]];
      observedIncompatibleSessions: readonly IncompatibleAnswerSession[];
    }>
  | Readonly<{ kind: 'no_answer_sessions_observed'; scannedSessionCount: number }>
  | Readonly<{ kind: 'cancelled' }>
);
export type LegacyRollbackInspectConfig = Readonly<{
  targetBaseline: KnownLegacyBaseline;
  discovery: HostDiscoveryConfig;
  launch?: never; migrate?: never; modify?: never;
}>;
/** Each invocation creates fresh canonical discovery, enumerates all its pages,
 * and closes its reader before returning. Host AND unbound answer sessions refuse,
 * including completed/stopped ones. Canonical data, not the optional index, decides.
 * Any unreadable entry, root error, incomplete scan or failed cleanup is inconclusive,
 * never an empty result; retain known blockers alongside nonempty issues. Entries
 * are unique and ordered by sessionId using UTF-16 code units. A pre-aborted call
 * returns cancelled without opening a reader. No writes, inference, owner changes,
 * downgrade launch or token issuance. Unknown target values refuse at the external
 * parser before this typed boundary; this known target does not imply runtime loading.
 * Results observe one enumerated population, not an atomic or future snapshot; even
 * no_answer_sessions_observed neither certifies compatibility nor authorizes launch.
 * All legacy/operator actions remain separate from this non-authoritative report.
 */
export declare function inspectLegacyRollback(
  config: LegacyRollbackInspectConfig, signal: AbortSignal
): Promise<RollbackInspectionResult>;
