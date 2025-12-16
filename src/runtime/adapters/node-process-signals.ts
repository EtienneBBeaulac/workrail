import type { ProcessSignal, ProcessSignals } from '../ports/process-signals.js';

/**
 * Node.js adapter for ProcessSignals.
 * Wraps handlers to ignore Node-provided parameters (exit code, signal string, etc).
 */
export class NodeProcessSignals implements ProcessSignals {
  on(signal: ProcessSignal, handler: () => void | Promise<void>): void {
    process.on(signal as any, () => {
      void handler();
    });
  }
}
