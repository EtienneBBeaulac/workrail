// Mirror of console-types.ts from the backend (Console DTOs)

export type ConsoleRunStatus = 'in_progress' | 'complete' | 'complete_with_gaps' | 'blocked';
export type ConsoleSessionHealth = 'healthy' | 'corrupt';

export interface ConsoleSessionSummary {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly workflowId: string | null;
  readonly workflowName: string | null;
  readonly workflowHash: string | null;
  readonly runId: string | null;
  readonly status: ConsoleRunStatus;
  readonly health: ConsoleSessionHealth;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly tipCount: number;
  readonly hasUnresolvedGaps: boolean;
  readonly recapSnippet: string | null;
  readonly gitBranch: string | null;
  readonly lastModifiedMs: number;
}

export interface ConsoleSessionListResponse {
  readonly sessions: readonly ConsoleSessionSummary[];
  readonly totalCount: number;
}

export interface ConsoleDagNode {
  readonly nodeId: string;
  readonly nodeKind: 'step' | 'checkpoint' | 'blocked_attempt';
  readonly parentNodeId: string | null;
  readonly createdAtEventIndex: number;
  readonly isPreferredTip: boolean;
  readonly isTip: boolean;
  readonly stepLabel: string | null;
}

export interface ConsoleDagEdge {
  readonly edgeKind: 'acked_step' | 'checkpoint';
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly createdAtEventIndex: number;
}

export interface ConsoleDagRun {
  readonly runId: string;
  readonly workflowId: string | null;
  readonly workflowName: string | null;
  readonly workflowHash: string | null;
  readonly preferredTipNodeId: string | null;
  readonly nodes: readonly ConsoleDagNode[];
  readonly edges: readonly ConsoleDagEdge[];
  readonly tipNodeIds: readonly string[];
  readonly status: ConsoleRunStatus;
  readonly hasUnresolvedCriticalGaps: boolean;
}

export interface ConsoleSessionDetail {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly health: ConsoleSessionHealth;
  readonly runs: readonly ConsoleDagRun[];
}

// ---------------------------------------------------------------------------
// Node Detail
// ---------------------------------------------------------------------------

export type ConsoleValidationOutcome = 'pass' | 'fail';

export interface ConsoleValidationResult {
  readonly validationId: string;
  readonly attemptId: string;
  readonly contractRef: string;
  readonly outcome: ConsoleValidationOutcome;
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
}

export type ConsoleAdvanceOutcomeKind = 'advanced' | 'blocked';

export interface ConsoleAdvanceOutcome {
  readonly attemptId: string;
  readonly kind: ConsoleAdvanceOutcomeKind;
  readonly recordedAtEventIndex: number;
}

export interface ConsoleNodeGap {
  readonly gapId: string;
  readonly severity: 'critical' | 'non_critical';
  readonly summary: string;
  readonly isResolved: boolean;
}

export interface ConsoleArtifact {
  readonly sha256: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly content: unknown;
}

export interface ConsoleNodeDetail {
  readonly nodeId: string;
  readonly nodeKind: 'step' | 'checkpoint' | 'blocked_attempt';
  readonly parentNodeId: string | null;
  readonly createdAtEventIndex: number;
  readonly isPreferredTip: boolean;
  readonly isTip: boolean;
  readonly stepLabel: string | null;
  readonly recapMarkdown: string | null;
  readonly artifacts: readonly ConsoleArtifact[];
  readonly advanceOutcome: ConsoleAdvanceOutcome | null;
  readonly validations: readonly ConsoleValidationResult[];
  readonly gaps: readonly ConsoleNodeGap[];
}

// ---------------------------------------------------------------------------
// API Envelope
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}
