/**
 * Barrel re-export for src/daemon/state/.
 *
 * WHY a barrel: allows callers to import from './state/index.js' rather than
 * knowing which sub-module owns each symbol. Import from the specific sub-module
 * when you need to make the dependency explicit; use this barrel for convenience.
 */

export type { SessionState } from './session-state.js';
export {
  createSessionState,
  advanceStep,
  recordCompletion,
  updateToken,
  setSessionId,
  recordToolCall,
} from './session-state.js';

export type { TerminalSignal } from './terminal-signal.js';
export { setTerminalSignal } from './terminal-signal.js';

export type { StuckConfig, StuckSignal } from './stuck-detection.js';
export { evaluateStuckSignals } from './stuck-detection.js';
