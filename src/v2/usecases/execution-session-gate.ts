import type { ResultAsync } from 'neverthrow';
import { ResultAsync as RA, errAsync } from 'neverthrow';
import type { SessionId } from '../durable-core/ids/index.js';
import type { WithHealthySessionLock } from '../durable-core/ids/with-healthy-session-lock.js';
import type { SessionHealthV2 } from '../durable-core/schemas/session/session-health.js';
import type { SessionLockPortV2 } from '../ports/session-lock.port.js';
import type {
  SessionEventLogReadonlyStorePortV2,
  SessionEventLogStoreError,
} from '../ports/session-event-log-store.port.js';
import { projectSessionHealthV2 } from '../projections/session-health.js';

export type ExecutionSessionGateErrorV2 =
  | { readonly code: 'SESSION_LOCKED'; readonly message: string; readonly sessionId: SessionId; readonly retry: { readonly kind: 'retryable'; readonly afterMs: number } }
  | { readonly code: 'SESSION_LOCK_REENTRANT'; readonly message: string; readonly sessionId: SessionId }
  | { readonly code: 'LOCK_ACQUIRE_FAILED'; readonly message: string; readonly sessionId: SessionId }
  | { readonly code: 'LOCK_RELEASE_FAILED'; readonly message: string; readonly sessionId: SessionId; readonly retry: { readonly kind: 'retryable'; readonly afterMs: number } }
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

    const doWork = async (): Promise<T> => {
      // Lock-free health check (early hint):
      // - allowed to fail closed on manifest-attested corruption (fast return)
      // - IO errors are explicitly modeled as "precheck unavailable" (not empty truth)
      // Locked invariant: re-check under lock before minting witness / allowing append (TOCTOU guard).
      const precheckResult = await this.store.loadValidatedPrefix(sessionId).match(
        (v) => ({ kind: 'available' as const, prefix: v }),
        (e) => {
          if (e.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
            const health: SessionHealthV2 =
              e.location === 'head'
                ? { kind: 'corrupt_head', reason: e.reason }
                : { kind: 'corrupt_tail', reason: e.reason };
            throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
              code: 'SESSION_NOT_HEALTHY',
              message: 'Session is not healthy',
              sessionId,
              health,
            });
          }
          // IO errors: precheck unavailable; defer health decision to locked path.
          return { kind: 'unavailable' as const };
        }
      );

      const pre = precheckResult.kind === 'available' ? precheckResult.prefix : null;

      if (pre !== null) {
        if (!pre.isComplete) {
          throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
            code: 'SESSION_NOT_HEALTHY',
            message: 'Session is not healthy (validated prefix indicates corrupt tail)',
            sessionId,
            health: {
              kind: 'corrupt_tail',
              reason: pre.tailReason ?? { code: 'non_contiguous_indices', message: 'Validated prefix stopped early (corrupt tail)' },
            },
          });
        }

        const preHealth = projectSessionHealthV2(pre.truth).match(
          (h) => h,
          () => ({ kind: 'corrupt_tail', reason: { code: 'non_contiguous_indices', message: 'unknown' } } as SessionHealthV2)
        );
        if (preHealth.kind !== 'healthy') {
          throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
            code: 'SESSION_NOT_HEALTHY',
            message: 'Session is not healthy',
            sessionId,
            health: preHealth,
          });
        }
      }
      // If precheck was unavailable (IO error), defer health decision to strict load under lock.

      const handle = await this.lock.acquire(sessionId).match(
        (h) => h,
        (e) => {
          if (e.code === 'SESSION_LOCK_BUSY') {
            throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
              code: 'SESSION_LOCKED',
              message: `Session is locked; retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running for this session.`,
              sessionId,
              retry: { kind: 'retryable', afterMs: 1000 },
            });
          }
          throw new GateFailure<ExecutionSessionGateErrorV2 | E>({ code: 'LOCK_ACQUIRE_FAILED', message: e.message, sessionId });
        }
      );

      try {
        const truth = await this.store.load(sessionId).match(
          (v) => v,
          (e) => {
            if (e.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
              const health: SessionHealthV2 =
                e.location === 'head'
                  ? { kind: 'corrupt_head', reason: e.reason }
                  : { kind: 'corrupt_tail', reason: e.reason };
              throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
                code: 'SESSION_NOT_HEALTHY',
                message: 'Session is not healthy',
                sessionId,
                health,
              });
            }
            throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
              code: 'SESSION_LOAD_FAILED',
              message: `Failed to load session`,
              sessionId,
              cause: e,
            });
          }
        );

        const health = projectSessionHealthV2(truth).match(
          (h) => h,
          () => {
            // projectSessionHealthV2 is currently infallible
            return { kind: 'corrupt_tail', reason: { code: 'non_contiguous_indices', message: 'unknown' } } as SessionHealthV2;
          }
        );

        if (health.kind !== 'healthy') {
          throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
            code: 'SESSION_NOT_HEALTHY',
            message: `Session is not healthy`,
            sessionId,
            health,
          });
        }

        const witness = {
          ...handle,
          assertHeld: () => this.activeWitnessTokens.has(witnessToken),
        } as unknown as WithHealthySessionLock;
        let callback: ResultAsync<T, E>;
        try {
          callback = fn(witness);
        } catch (e) {
          throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
            code: 'GATE_CALLBACK_FAILED',
            message: e instanceof Error ? e.message : String(e),
            sessionId,
          });
        }

        const res = await callback.match(
          (v) => ({ ok: true as const, value: v }),
          (e) => ({ ok: false as const, error: e })
        );

        if (!res.ok) {
          // Callback errors propagate as-is (E) to keep the gate generic.
          throw new GateFailure<ExecutionSessionGateErrorV2 | E>(res.error);
        }

        return res.value;
      } catch (e) {
        if (e instanceof GateFailure) throw e;
        throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
          code: 'GATE_CALLBACK_FAILED',
          message: e instanceof Error ? e.message : String(e),
          sessionId,
        });
      } finally {
        await this.lock.release(handle).match(
          () => undefined,
          () => {
            throw new GateFailure<ExecutionSessionGateErrorV2 | E>({
              code: 'LOCK_RELEASE_FAILED',
              message: 'Failed to release session lock; retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running for this session.',
              sessionId,
              retry: { kind: 'retryable', afterMs: 1000 },
            });
          }
        );
      }
    };

    return RA.fromPromise(
      (async () => {
        try {
          return await doWork();
        } finally {
          // Locked: lexical lifetime + no leaks. Cleanup must happen exactly once.
          this.activeSessions.delete(sessionId);
          this.activeWitnessTokens.delete(witnessToken);
        }
      })(),
      (e) => {
        if (e instanceof GateFailure) return e.error as ExecutionSessionGateErrorV2 | E;
        return {
          code: 'GATE_CALLBACK_FAILED',
          message: e instanceof Error ? e.message : String(e),
          sessionId,
        } as ExecutionSessionGateErrorV2;
      }
    );
  }
}

class GateFailure<E> extends Error {
  constructor(readonly error: E) {
    const msg = (error as { readonly message?: unknown } | null | undefined)?.message;
    super(typeof msg === 'string' ? msg : 'GateFailure');
  }
}
