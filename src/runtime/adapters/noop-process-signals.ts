import type { ProcessSignal, ProcessSignals } from '../ports/process-signals.js';

/**
 * No-op ProcessSignals implementation for test mode.
 */
export class NoopProcessSignals implements ProcessSignals {
  on(_signal: ProcessSignal, _handler: () => void | Promise<void>): void {
    // no-op
  }
}
