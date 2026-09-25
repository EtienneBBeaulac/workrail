/** Compiler constraints; not authorization, migration or runtime proof. */
import { inspectLegacyRollback } from './legacy-rollback-contract.js';
import type { LegacyRollbackInspectConfig, RollbackInspectionResult, IncompatibleAnswerSession } from './legacy-rollback-contract.js';
import type { SharedAuthorityConfig } from './host-composition.js';
import type { SessionId } from '../../src/v2/durable-core/ids/index.js';
declare const authority: SharedAuthorityConfig;
declare const signal: AbortSignal;
declare const id: SessionId;
const config: LegacyRollbackInspectConfig = { targetBaseline: '396cdfa4e665afa993b50fcf0ec59ca53a2167db', discovery: authority };
void inspectLegacyRollback(config, signal);
declare const report: Extract<RollbackInspectionResult, { kind: 'no_answer_sessions_observed' }>;
const withLaunch = { ...report, launchAuthority: 'launch' };
// @ts-expect-error An observation must not carry launch authority.
const invalidReport: RollbackInspectionResult = withLaunch;
const withPointer = { kind: 'host' as const, sessionId: id, pointer: { recoveryLocator: 'hidden' } };
// @ts-expect-error Operator diagnostics must not expose host recovery pointers.
const invalidEntry: IncompatibleAnswerSession = withPointer;
// @ts-expect-error A refusal requires at least one observed incompatible session.
const emptyRefusal: RollbackInspectionResult = { kind: 'refused', baseline: config.targetBaseline, notice: 'observation_only_not_downgrade_authorization', reason: 'incompatible_answer_sessions_present', affectedSessions: [], remediation: 'use_supporting_version_or_separate_verified_backup' };
// @ts-expect-error The inspector has no launch effect capability.
const launchConfig: LegacyRollbackInspectConfig = { ...config, launch: () => undefined };
// @ts-expect-error Unsupported arbitrary baselines are not accepted by this typed boundary.
const arbitraryTarget: LegacyRollbackInspectConfig = { ...config, targetBaseline: 'HEAD' };
// @ts-expect-error Inconclusive must explain an actual issue, not an empty list.
const noIssue: RollbackInspectionResult = { kind: 'inconclusive', baseline: config.targetBaseline, notice: 'observation_only_not_downgrade_authorization', issues: [], observedIncompatibleSessions: [] };
