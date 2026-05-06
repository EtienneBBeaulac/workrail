/**
 * Re-exports the pure stuck-detection function and its associated types so
 * that `buildTurnEndSubscriber` can import from this module rather than
 * reaching into the full `workflow-runner.ts`.
 *
 * WHY a thin re-export module: `evaluateStuckSignals` is defined in
 * `src/daemon/state/stuck-detection.ts`. This module gives it a dedicated
 * home in the `turn-end/` collaborator tree. The subscriber calls `detectStuck`
 * via this module; the rest of the codebase imports directly from state/.
 */
export type { StuckSignal, StuckConfig } from '../state/stuck-detection.js';
export { evaluateStuckSignals as detectStuck } from '../state/stuck-detection.js';
