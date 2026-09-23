import { AsyncLocalStorage } from 'node:async_hooks';
import { type Result, ResultAsync, err, errAsync, okAsync } from 'neverthrow';
import type { SessionId } from '../durable-core/ids/index.js';
import type { WithHealthySessionLock } from '../durable-core/ids/with-healthy-session-lock.js';
import { SESSION_LOCK_RETRY_AFTER_MS } from '../durable-core/constants.js';
import type { SessionHealthV2 } from '../durable-core/schemas/session/session-health.js';
import type { SessionLockHandleV2, SessionLockPortV2 } from '../ports/session-lock.port.js';
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
  private readonly pending = new Map<SessionId, Promise<void>>();
  private readonly ancestry = new AsyncLocalStorage<readonly { readonly sessionId: SessionId; readonly token: symbol }[]>();
  private readonly activeWitnessTokens = new Set<symbol>();

  constructor(
    private readonly lock: SessionLockPortV2,
    private readonly store: SessionEventLogReadonlyStorePortV2
  ) {}

  withHealthySessionLock<T, E>(
    sessionId: SessionId,
    fn: (lock: WithHealthySessionLock) => ResultAsync<T, E>
  ): ResultAsync<T, ExecutionSessionGateErrorV2 | E> {
    const ancestors = (this.ancestry.getStore() ?? []).filter(frame => this.activeWitnessTokens.has(frame.token));
    if (ancestors.some(frame => frame.sessionId === sessionId)) {
      return errAsync({ code: 'SESSION_LOCK_REENTRANT', message: `Re-entrant gate call for session: ${sessionId}`, sessionId });
    }
    // A nested caller must not wait while holding another session: opposite lock
    // acquisition orders would deadlock. Independent callers can safely queue.
    if (ancestors.length && this.pending.has(sessionId)) {
      return errAsync({ code: 'SESSION_LOCKED', message: 'Nested session acquisition would wait while holding another session', sessionId,
        retry: { kind: 'retryable_after_ms', afterMs: SESSION_LOCK_RETRY_AFTER_MS } });
    }
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const token = Symbol(`withHealthySessionLock:${sessionId}`);
      this.activeWitnessTokens.add(token);
      return this.ancestry.run([...ancestors, { sessionId, token }], async () => {
        try { return await this.executeLocked(sessionId, fn, token); }
        catch (error) {
          return err<T, ExecutionSessionGateErrorV2>({ code: 'GATE_CALLBACK_FAILED', message: String(error), sessionId });
        } finally { this.activeWitnessTokens.delete(token); }
      });
    });
    const settled = operation.then(() => {}, () => {});
    this.pending.set(sessionId, settled);
    void settled.then(() => { if (this.pending.get(sessionId) === settled) this.pending.delete(sessionId); });
    return new ResultAsync(operation);
  }

  private executeLocked<T, E>(
    sessionId: SessionId,
    fn: (lock: WithHealthySessionLock) => ResultAsync<T, E>,
    witnessToken: symbol,
  ): ResultAsync<T, ExecutionSessionGateErrorV2 | E> {
    let acquiredHandle: SessionLockHandleV2 | undefined;
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
        .map(handle => { acquiredHandle = handle; return handle; })
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

          return callback;
        });
    };

    return new ResultAsync((async () => {
      let outcome: Result<T, ExecutionSessionGateErrorV2 | E>;
      try { outcome = await doWork(); }
      catch (error) { outcome = err({ code: 'GATE_CALLBACK_FAILED', message: String(error), sessionId }); }
      if (acquiredHandle) {
        const releaseFailure = (): Result<T, ExecutionSessionGateErrorV2> => err({
          code: 'LOCK_RELEASE_FAILED', message: 'Failed to release session lock', sessionId,
          retry: { kind: 'retryable_after_ms', afterMs: SESSION_LOCK_RETRY_AFTER_MS },
        });
        try { if ((await this.lock.release(acquiredHandle)).isErr()) return releaseFailure(); }
        catch { return releaseFailure(); }
      }
      return outcome;
    })());
  }
}
