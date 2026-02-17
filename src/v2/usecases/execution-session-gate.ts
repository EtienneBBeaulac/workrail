import type { ResultAsync } from 'neverthrow';
import { errAsync, okAsync } from 'neverthrow';
import type { SessionId } from '../durable-core/ids/index.js';
import type { WithHealthySessionLock } from '../durable-core/ids/with-healthy-session-lock.js';
import { SESSION_LOCK_RETRY_AFTER_MS } from '../durable-core/constants.js';
import type { SessionHealthV2 } from '../durable-core/schemas/session/session-health.js';
import type { SessionLockPortV2 } from '../ports/session-lock.port.js';
import type {
  SessionEventLogReadonlyStorePortV2,
  SessionEventLogStoreError,
} from '../ports/session-event-log-store.port.js';
import { projectSessionHealthV2 } from '../projections/session-health.js';

export type ExecutionSessionGateErrorV2 =
  | { readonly code: 'SESSION_LOCKED'; readonly message: string; readonly sessionId: SessionId; readonly retry: { readonly kind: 'retryable_after_ms'; readonly afterMs: number } }
  | { readonly code: 'SESSION_LOCK_REENTRANT'; readonly message: string; readonly sessionId: SessionId }
  | { readonly code: 'LOCK_ACQUIRE_FAILED'; readonly message: string; readonly sessionId: SessionId }
  | { readonly code: 'LOCK_RELEASE_FAILED'; readonly message: string; readonly sessionId: SessionId; readonly retry: { readonly kind: 'retryable_after_ms'; readonly afterMs: number } }
  | { readonly code: 'SESSION_NOT_HEALTHY'; readonly message: string; readonly sessionId: SessionId; readonly health: SessionHealthV2 }
  | { readonly code: 'SESSION_LOAD_FAILED'; readonly message: string; readonly sessionId: SessionId; readonly cause: SessionEventLogStoreError }
  | { readonly code: 'GATE_CALLBACK_FAILED'; readonly message: string; readonly sessionId: SessionId };

/**
 * Central choke point for:
 * - session lock acquisition/release
 * - session health gating
 * - witness minting (`WithHealthySessionLock`)
 *
 * Slice 2.5 (locked): implemented as the single choke point for locking + health gating + witness minting.
 * Refactored to use ResultAsync (errors-as-data) instead of throwing GateFailure exceptions.
 */
export class ExecutionSessionGateV2 {
  private readonly activeSessions = new Set<SessionId>();
  private readonly activeWitnessTokens = new Set<symbol>();

  constructor(
    private readonly lock: SessionLockPortV2,
    private readonly store: SessionEventLogReadonlyStorePortV2
  ) {}

  withHealthySessionLock<T, E>(
    sessionId: SessionId,
    fn: (lock: WithHealthySessionLock) => ResultAsync<T, E>
  ): ResultAsync<T, ExecutionSessionGateErrorV2 | E> {
    if (this.activeSessions.has(sessionId)) {
      return errAsync({ code: 'SESSION_LOCK_REENTRANT', message: `Re-entrant gate call for session: ${sessionId}`, sessionId });
    }

    this.activeSessions.add(sessionId);
    const witnessToken = Symbol(`withHealthySessionLock:${sessionId}`);
    this.activeWitnessTokens.add(witnessToken);

    const doWork = (): ResultAsync<T, ExecutionSessionGateErrorV2 | E> => {
      return this.store
        .loadValidatedPrefix(sessionId)
        // Pre-check is an optimization: we only fail fast here for explicit corruption.
        // Any other failure defers to the lock-held load() path (single source of truth for gating).
        .orElse((e) => {
          if (e.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
            const health: SessionHealthV2 =
              e.location === 'head'
                ? { kind: 'corrupt_head', reason: e.reason }
                : { kind: 'corrupt_tail', reason: e.reason };
            return errAsync({
              code: 'SESSION_NOT_HEALTHY' as const,
              message: 'Session is not healthy',
              sessionId,
              health,
            });
          }

          // Defer to lock-held health gating if validated-prefix is unavailable (I/O, lock busy, etc).
          return okAsync(null);
        })
        .andThen((pre) => {
          if (pre === null) return okAsync(undefined);

          if (pre.kind === 'truncated') {
            return errAsync({
              code: 'SESSION_NOT_HEALTHY' as const,
              message: 'Session is not healthy (validated prefix indicates corrupt tail)',
              sessionId,
              health: {
                kind: 'corrupt_tail' as const,
                reason: pre.tailReason,
              },
            });
          }

          const preHealth = projectSessionHealthV2(pre.truth).match(
            (h) => h,
            () => ({ kind: 'corrupt_tail', reason: { code: 'non_contiguous_indices', message: 'unknown' } } as SessionHealthV2)
          );
          if (preHealth.kind !== 'healthy') {
            return errAsync({
              code: 'SESSION_NOT_HEALTHY' as const,
              message: 'Session is not healthy',
              sessionId,
              health: preHealth,
            });
          }

          return okAsync(undefined);
        })
        .andThen(() =>
          this.lock.acquire(sessionId)
            .mapErr((e) => {
              if (e.code === 'SESSION_LOCK_BUSY') {
                return {
                  code: 'SESSION_LOCKED' as const,
                  message: `Session is locked; retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running for this session.`,
                  sessionId,
                  retry: { kind: 'retryable_after_ms' as const, afterMs: SESSION_LOCK_RETRY_AFTER_MS },
                };
              }
              return { code: 'LOCK_ACQUIRE_FAILED' as const, message: e.message, sessionId };
            })
        )
        .andThen((handle) =>
          this.store.load(sessionId)
            .mapErr((e) => {
              if (e.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
                const health: SessionHealthV2 =
                  e.location === 'head'
                    ? { kind: 'corrupt_head', reason: e.reason }
                    : { kind: 'corrupt_tail', reason: e.reason };
                return {
                  code: 'SESSION_NOT_HEALTHY' as const,
                  message: 'Session is not healthy',
                  sessionId,
                  health,
                };
              }
              return {
                code: 'SESSION_LOAD_FAILED' as const,
                message: `Failed to load session`,
                sessionId,
                cause: e,
              };
            })
            .andThen((truth) => {
              const health = projectSessionHealthV2(truth).match(
                (h) => h,
                () => {
                  return { kind: 'corrupt_tail', reason: { code: 'non_contiguous_indices', message: 'unknown' } } as SessionHealthV2;
                }
              );

              if (health.kind !== 'healthy') {
                return errAsync({
                  code: 'SESSION_NOT_HEALTHY' as const,
                  message: `Session is not healthy`,
                  sessionId,
                  health,
                });
              }

              return okAsync({ handle, truth });
            })
        )
        .andThen(({ handle }) => {
          const witness = {
            ...handle,
            assertHeld: () => this.activeWitnessTokens.has(witnessToken),
          } as unknown as WithHealthySessionLock;

          let callback: ResultAsync<T, E>;
          try {
            callback = fn(witness);
          } catch (e) {
            return errAsync({
              code: 'GATE_CALLBACK_FAILED' as const,
              message: e instanceof Error ? e.message : String(e),
              sessionId,
            });
          }

          return callback
            .andThen((result) =>
              this.lock.release(handle)
                .mapErr(() => ({
                  code: 'LOCK_RELEASE_FAILED' as const,
                  message: 'Failed to release session lock; retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running for this session.',
                  sessionId,
                  retry: { kind: 'retryable_after_ms' as const, afterMs: SESSION_LOCK_RETRY_AFTER_MS },
                }))
                .map(() => result)
            )
            .orElse((callbackErr) =>
              this.lock.release(handle)
                .map(() => callbackErr)
                .mapErr(() => ({
                  code: 'LOCK_RELEASE_FAILED' as const,
                  message: 'Failed to release session lock; retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running for this session.',
                  sessionId,
                  retry: { kind: 'retryable_after_ms' as const, afterMs: SESSION_LOCK_RETRY_AFTER_MS },
                }))
                .andThen((err) => errAsync(err))
            );
        });
    };

    return doWork()
      .map((result) => {
        this.cleanupWitness(sessionId, witnessToken);
        return result;
      })
      .mapErr((e) => {
        this.cleanupWitness(sessionId, witnessToken);
        return e;
      });
  }

  private cleanupWitness(sessionId: SessionId, token: symbol): void {
    this.activeSessions.delete(sessionId);
    this.activeWitnessTokens.delete(token);
  }
}
