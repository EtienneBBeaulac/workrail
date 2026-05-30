/**
 * Engine-side git metrics collection module.
 *
 * Provides fire-and-forget functions for capturing authoritative git diff stats
 * at session start and completion. Follows the established pattern of
 * collectAndRecordUsage and recordTokenCheckpoint.
 *
 * Usage:
 * - Call recordGitStart() in handleV2StartWorkflow (after session created)
 * - Call recordGitMetrics() in the completion async IIFE (after recordTokenCheckpoint)
 */

export { recordGitStart, recordGitMetrics } from './record.js';
export type { GitEvidence, GitCommittedDiff, GitWorkingTreeState } from './types.js';
