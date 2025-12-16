/**
 * Policy for process lifecycle management (signals, exit handling, etc).
 * Avoid boolean flags by using discriminated unions.
 */
export type ProcessLifecyclePolicy =
  | { kind: 'install_signal_handlers' }
  | { kind: 'no_signal_handlers' };
