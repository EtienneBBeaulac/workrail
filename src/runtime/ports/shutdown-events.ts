import type { ProcessSignal } from './process-signals.js';

export type ShutdownSignal = Exclude<ProcessSignal, 'exit'>;

export type ShutdownEvent =
  | { kind: 'shutdown_requested'; signal: ShutdownSignal };

export type Unsubscribe = () => void;

/**
 * Port for requesting a process shutdown.
 * This makes "we should shut down" explicit and typed, while keeping termination
 * decisions in the composition root (entrypoint), not inside services.
 */
export interface ShutdownEvents {
  onShutdown(listener: (event: ShutdownEvent) => void): Unsubscribe;
  emit(event: ShutdownEvent): void;
}
