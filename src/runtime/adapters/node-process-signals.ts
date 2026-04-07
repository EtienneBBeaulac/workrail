import type { ProcessSignal, ProcessSignals } from '../ports/process-signals.js';

/**
 * Node.js adapter for ProcessSignals.
 * Wraps handlers to ignore Node-provided parameters (exit code, signal string, etc).
 */
export class NodeProcessSignals implements ProcessSignals {
  on(signal: ProcessSignal, handler: () => void | Promise<void>): void {
    // process.on (not process.once) is intentional. NodeProcessSignals is a
    // shared DI singleton -- both HttpServer.setupPrimaryCleanup() and
    // wireShutdownHooks() call on() for SIGINT/SIGTERM/SIGHUP. With process.once,
    // the second caller's registrations would be silently dropped after the first
    // signal fires. Double-invocation is prevented by the shutdownStarted latch
    // in each caller, not by once-semantics at the OS listener level.
    process.on(signal as any, () => {
      void handler();
    });
  }
}
