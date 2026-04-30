/**
 * Coordinator Session Chaining Types
 *
 * Typed result for child session execution in coordinator pipelines.
 *
 * WHY a separate file (not inline in pr-review.ts):
 * ChildSessionResult is consumed by coordinator logic, coordinator-deps.ts
 * (implementation), and future coordinator scripts. Keeping it in types.ts
 * avoids circular imports between the interface file and implementation.
 *
 * Design invariants:
 * - ChildSessionResult is a discriminated union -- all switch statements must be exhaustive.
 * - delivery_failed maps to kind:'failed', NEVER kind:'success'.
 * - await_degraded is distinct from failed -- it signals infrastructure unavailability,
 *   not a child session failure. Coordinators must handle it separately from failed.
 */

/**
 * Typed result of a child session execution.
 *
 * WHY discriminated union (not boolean flags):
 * A plain { success: boolean; timedOut: boolean } allows illegal states like
 * success:true && timedOut:true. The discriminated union makes these
 * unrepresentable at compile time and forces exhaustive handling at every switch.
 *
 * Variants:
 * - success: child session ran to completion without delivery failure
 * - failed: child session reached a terminal failure state (blocked, stuck, or delivery failed)
 * - timed_out: coordinator gave up waiting; child may still be running
 * - await_degraded: the await infrastructure was unavailable (ConsoleService null);
 *   child session was never polled -- outcome is unknown
 */
export type ChildSessionResult =
  | {
      readonly kind: 'success';
      /** Step notes from the final (tip) node of the child session. Null if unavailable. */
      readonly notes: string | null;
      /** Artifacts emitted across all steps of the child session. */
      readonly artifacts: readonly unknown[];
    }
  | {
      readonly kind: 'failed';
      /**
       * Reason for failure:
       * - error: unexpected error (blocked session, ConsoleService error, etc.)
       * - stuck: session reached a blocked/stuck terminal state
       * - delivery_failed: webhook delivery to the child session failed
       */
      readonly reason: 'error' | 'stuck' | 'delivery_failed';
      readonly message: string;
    }
  | {
      readonly kind: 'timed_out';
      /** Human-readable message explaining the timeout context. */
      readonly message: string;
    }
  | {
      readonly kind: 'await_degraded';
      /** Human-readable message explaining why the await was degraded. */
      readonly message: string;
    };
