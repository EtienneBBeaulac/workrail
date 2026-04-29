/**
 * Re-exports the pure stuck-detection function and its associated types so
 * that `buildTurnEndSubscriber` can import from this module rather than
 * reaching into the full `workflow-runner.ts`.
 *
 * WHY a thin re-export module: `evaluateStuckSignals` is already an extracted
 * pure function defined in `workflow-runner.ts`. This module gives it a
 * dedicated home in the `turn-end/` collaborator tree without moving the
 * definition (which would require updating the tests that import it from
 * `workflow-runner.ts`). The subscriber calls `detectStuck` via this module;
 * the rest of the codebase continues to import `evaluateStuckSignals` directly.
 */
export type { StuckSignal, StuckConfig } from '../workflow-runner.js';
export { evaluateStuckSignals as detectStuck } from '../workflow-runner.js';
