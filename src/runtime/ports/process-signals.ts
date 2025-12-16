/**
 * Port for registering process signal handlers.
 * This abstracts Node's `process.on` to keep infrastructure concerns out of domain services.
 */
export type ProcessSignal = NodeJS.Signals | 'exit';

export interface ProcessSignals {
  on(signal: ProcessSignal, handler: () => void | Promise<void>): void;
}
