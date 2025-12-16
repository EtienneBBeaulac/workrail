/**
 * Runtime mode of the current process.
 * This is a first-class domain concept and should be injected (DI), not inferred ad-hoc via env vars.
 */
export type RuntimeMode =
  | { kind: 'production' }
  | { kind: 'test' }
  | { kind: 'cli' }
  | { kind: 'rpc' };
