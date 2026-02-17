import type { Brand } from '../../../runtime/brand.js';

/**
 * Branded type: EventId (opaque event identifier).
 *
 * Footgun prevented:
 * - Prevents using random strings as event IDs in the durable log
 * - Makes event references type-safe (vs plain string)
 *
 * How to construct:
 * - Use `asEventId()` after validating format at boundaries
 *
 * Note: EventId is not an idempotency key; use dedupeKey for that.
 *
 * Example:
 * ```typescript
 * const eventId = asEventId('evt_01JH8X2DEF');
 * ```
 */
export type EventId = Brand<string, 'v2.EventId'>;

/**
 * Branded type: EventIndex (0-based event log position).
 *
 * Footgun prevented:
 * - Prevents negative/float indices being used as ordering keys
 * - Distinguishes EventIndex from ManifestIndex at compile time
 *
 * How to construct:
 * - Use `asEventIndex(number)` only for non-negative integers
 *
 * Lock: 0-based, monotonic per session.
 *
 * Example:
 * ```typescript
 * const idx = asEventIndex(0);
 * ```
 */
export type EventIndex = Brand<number, 'v2.EventIndex'>;

/**
 * Branded type: ManifestIndex (0-based manifest stream position).
 *
 * Footgun prevented:
 * - Prevents mixing manifest record indices with event indices
 * - Keeps manifest ordering comparisons type-safe
 *
 * How to construct:
 * - Use `asManifestIndex(number)` only for non-negative integers
 *
 * Lock: 0-based, monotonic per session manifest stream.
 *
 * Example:
 * ```typescript
 * const mIdx = asManifestIndex(0);
 * ```
 */
export type ManifestIndex = Brand<number, 'v2.ManifestIndex'>;

/**
 * Branded type: OutputId (stable output identifier).
 *
 * Footgun prevented:
 * - Prevents passing arbitrary strings as output IDs
 * - Separates output identifiers from event/node/run IDs
 *
 * How to construct:
 * - Use `asOutputId()` after validating format at boundaries
 * - Derive deterministically for idempotent output emission
 *
 * Example:
 * ```typescript
 * const out = asOutputId('out_recap_attempt_01...');
 * ```
 */
export type OutputId = Brand<string, 'v2.OutputId'>;

export function asEventId(value: string): EventId {
  return value as EventId;
}

export function asEventIndex(value: number): EventIndex {
  return value as EventIndex;
}

export function asManifestIndex(value: number): ManifestIndex {
  return value as ManifestIndex;
}

export function asOutputId(value: string): OutputId {
  return value as OutputId;
}
