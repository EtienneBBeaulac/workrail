import type { ArtifactContractRef } from './index.js';
import { getBlockedMessage as getAssessmentBlockedMessage } from './assessment.js';
import { getBlockedMessage as getLoopControlBlockedMessage } from './loop-control.js';
import { getBlockedMessage as getCoordinatorSignalBlockedMessage } from './coordinator-signal.js';
import { getBlockedMessage as getReviewVerdictBlockedMessage } from './review-verdict.js';
import { getBlockedMessage as getDiscoveryHandoffBlockedMessage } from './discovery-handoff.js';
import { getBlockedMessage as getGateVerdictBlockedMessage } from './gate-verdict.js';
import { getShapingHandoffBlockedMessage, getCodingHandoffBlockedMessage } from './phase-handoff.js';

/**
 * Registry mapping each artifact contract reference to its actionable blocked message.
 *
 * Used by reasonToBlocker() to produce contract-specific suggestedFix content,
 * and by the circuit-breaker in advance.ts to name the actual required artifact type.
 *
 * WHY here (not in reason-model.ts): reason-model.ts is in the domain layer and must
 * not import from infra. This registry lives in the artifact schema layer which has no
 * circular dependency risk. The architecture test enforces durable-core purity.
 */
export const ARTIFACT_BLOCKED_MESSAGES: Readonly<Record<ArtifactContractRef, () => readonly string[]>> = {
  'wr.contracts.assessment': getAssessmentBlockedMessage,
  'wr.contracts.loop_control': getLoopControlBlockedMessage,
  'wr.contracts.coordinator_signal': getCoordinatorSignalBlockedMessage,
  'wr.contracts.review_verdict': getReviewVerdictBlockedMessage,
  'wr.contracts.discovery_handoff': getDiscoveryHandoffBlockedMessage,
  'wr.contracts.shaping_handoff': getShapingHandoffBlockedMessage,
  'wr.contracts.coding_handoff': getCodingHandoffBlockedMessage,
  'wr.contracts.gate_verdict': getGateVerdictBlockedMessage,
};

/**
 * Get the actionable blocked message for a given contract reference.
 * Returns null when the contractRef is not in the registry (unknown contract).
 */
export function getArtifactBlockedMessage(contractRef: string): readonly string[] | null {
  const fn = (ARTIFACT_BLOCKED_MESSAGES as Record<string, (() => readonly string[]) | undefined>)[contractRef];
  return fn ? fn() : null;
}
