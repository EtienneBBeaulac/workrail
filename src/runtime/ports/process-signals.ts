/**
 * Port for registering process signal handlers.
 * This abstracts Node's `process.on` / `process.once` to keep infrastructure
 * concerns out of domain services.
 *
 * `on`   -- permanent handler, fires on every occurrence of the signal.
 * `once` -- one-shot handler, fires at most once then removes itself.
 *           Use this when the handler must not accumulate across repeated signals
 *           (e.g. a shutdown latch that should only trigger one teardown).
 */
export type ProcessSignal = NodeJS.Signals | 'exit';

export interface ProcessSignals {
  on(signal: ProcessSignal, handler: () => void | Promise<void>): void;
  once(signal: ProcessSignal, handler: () => void | Promise<void>): void;
}
