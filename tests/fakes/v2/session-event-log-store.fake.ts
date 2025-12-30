/**
 * In-memory fake for session event log store (both readonly and append ports).
 *
 * Implements all append invariants:
 * - Events are ordered by eventIndex (0-based, monotonic, contiguous within session)
 * - Append is atomic (all-or-none)
 * - Idempotency via dedupeKey: replaying same dedupeKey is all-or-nothing
 * - Partial idempotency detection: if ANY event exists but NOT all, fails fast
 *
 * @enforces event-index-zero-based
 * @enforces event-index-monotonic-contiguous
 * @enforces dedupe-key-idempotent
 * @enforces append-plan-atomic
 */

import { okAsync, errAsync, type ResultAsync } from 'neverthrow';
import type {
  SessionEventLogReadonlyStorePortV2,
  SessionEventLogAppendStorePortV2,
  LoadedSessionTruthV2,
  LoadedValidatedPrefixV2,
  SessionEventLogStoreError,
  AppendPlanV2,
} from '../../../src/v2/ports/session-event-log-store.port.js';
import type { SessionId } from '../../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1, ManifestRecordV1 } from '../../../src/v2/durable-core/schemas/session/index.js';
import type { WithHealthySessionLock } from '../../../src/v2/durable-core/ids/with-healthy-session-lock.js';

interface SessionData {
  events: DomainEventV1[];
  manifest: ManifestRecordV1[];
  dedupeKeysSeen: Set<string>;
}

/**
 * In-memory fake for session event log store.
 * 
 * Behavior:
 * - Events are stored in a per-session collection
 * - Append enforces all-or-nothing semantics and idempotency
 * - Idempotency checks: if ANY dedupeKey exists but NOT all in plan, fails with INVARIANT_VIOLATION
 * - EventIndex must be contiguous and 0-based per session
 */
export class InMemorySessionEventLogStore
  implements SessionEventLogReadonlyStorePortV2, SessionEventLogAppendStorePortV2
{
  private sessions = new Map<string, SessionData>();

  load(sessionId: SessionId): ResultAsync<LoadedSessionTruthV2, SessionEventLogStoreError> {
    const key = String(sessionId);
    const session = this.sessions.get(key);

    if (!session) {
      return okAsync({ events: [], manifest: [] });
    }

    return okAsync({
      events: [...session.events],
      manifest: [...session.manifest],
    });
  }

  loadValidatedPrefix(sessionId: SessionId): ResultAsync<LoadedValidatedPrefixV2, SessionEventLogStoreError> {
    // For fakes: always return full truth as complete validated prefix
    return this.load(sessionId).map((truth) => ({
      truth,
      isComplete: true,
      tailReason: null,
    }));
  }

  append(lock: WithHealthySessionLock, plan: AppendPlanV2): ResultAsync<void, SessionEventLogStoreError> {
    // Validate witness is still held
    if (!lock.assertHeld()) {
      return errAsync({
        code: 'SESSION_STORE_INVARIANT_VIOLATION' as const,
        message: 'Lock witness was released before append completed',
      });
    }

    const key = String(lock.sessionId);
    const session = this.sessions.get(key) ?? { events: [], manifest: [], dedupeKeysSeen: new Set() };

    const newEvents = plan.events ?? [];
    if (newEvents.length === 0) {
      // No-op append is ok
      return okAsync(void 0);
    }

    // Check idempotency: either ALL dedupeKeys exist or NONE
    const dedupeKeysInPlan = new Set(newEvents.map((e) => e.dedupeKey));
    const existingDedupeKeys = new Set<string>();
    const missingDedupeKeys = new Set<string>();

    for (const dedupeKey of dedupeKeysInPlan) {
      if (session.dedupeKeysSeen.has(dedupeKey)) {
        existingDedupeKeys.add(dedupeKey);
      } else {
        missingDedupeKeys.add(dedupeKey);
      }
    }

    // Partial idempotency is an invariant violation
    if (existingDedupeKeys.size > 0 && missingDedupeKeys.size > 0) {
      return errAsync({
        code: 'SESSION_STORE_INVARIANT_VIOLATION' as const,
        message: `Partial dedupeKey idempotency detected: ${existingDedupeKeys.size} exist, ${missingDedupeKeys.size} missing`,
      });
    }

    // If all exist, it's a no-op
    if (existingDedupeKeys.size === dedupeKeysInPlan.size) {
      return okAsync(void 0);
    }

    // Validate ordering: eventIndex must be contiguous and in ascending order
    const lastEventIndex = session.events.length > 0 ? session.events[session.events.length - 1].eventIndex : -1;

    for (let i = 0; i < newEvents.length; i++) {
      const event = newEvents[i];
      const expectedIndex = lastEventIndex + i + 1;

      if (event.eventIndex !== expectedIndex) {
        return errAsync({
          code: 'SESSION_STORE_INVARIANT_VIOLATION' as const,
          message: `Event ordering violation: expected eventIndex ${expectedIndex}, got ${event.eventIndex}`,
        });
      }
    }

    // All checks passed: atomically add all events and record dedupeKeys
    session.events.push(...newEvents);
    for (const dedupeKey of dedupeKeysInPlan) {
      session.dedupeKeysSeen.add(dedupeKey);
    }

    this.sessions.set(key, session);

    return okAsync(void 0);
  }
}
