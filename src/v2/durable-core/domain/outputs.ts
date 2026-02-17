/**
 * Output ordering normalizer.
 *
 * Lock: output ordering is deterministic (single emission path)
 * Design: v2-core-design-locks.md §1 (output determinism)
 *
 * Rule:
 * - At most one recap first
 * - Then artifacts sorted by (sha256, contentType) ascending
 */

import { OUTPUT_CHANNEL, type OutputChannelV1 } from '../constants.js';

export type OutputPayload = {
  readonly sha256?: string;
  readonly contentType?: string;
  readonly [key: string]: unknown;
};

export type OutputToAppend = {
  readonly outputId: string;
  readonly outputChannel: OutputChannelV1;
  readonly payload: OutputPayload;
  readonly supersedesOutputId?: string;
};

/**
 * Normalize outputs for deterministic append.
 *
 * Enforces the locked output ordering:
 * 1. At most one recap output first (if present)
 * 2. Then artifact outputs sorted by (sha256, contentType) ascending
 *
 * This ensures that replay produces identical event order.
 *
 * @param outputs - Array of outputs to normalize (order is ignored)
 * @returns Normalized array with deterministic ordering
 */
export function normalizeOutputsForAppend(outputs: readonly OutputToAppend[]): OutputToAppend[] {
  const recap = outputs.filter((o) => o.outputChannel === OUTPUT_CHANNEL.RECAP);
  const artifacts = outputs.filter((o) => o.outputChannel === OUTPUT_CHANNEL.ARTIFACT);

  // At most one recap (take first if multiple exist, but this shouldn't happen in normal operation)
  const recapFirst = recap.length > 0 ? [recap[0]!] : [];

  // Artifacts sorted by (sha256, contentType) ascending (deterministic with en-US locale)
  const sortedArtifacts = [...artifacts].sort((a, b) => {
    const aSha = a.payload.sha256 ?? '';
    const bSha = b.payload.sha256 ?? '';
    if (aSha !== bSha) return aSha.localeCompare(bSha, 'en-US');

    const aType = a.payload.contentType ?? '';
    const bType = b.payload.contentType ?? '';
    return aType.localeCompare(bType, 'en-US');
  });

  return [...recapFirst, ...sortedArtifacts];
}
