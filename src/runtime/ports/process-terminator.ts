/**
 * Port for terminating the current process.
 * This should only be used by composition roots / entrypoints.
 */
export type ExitCode =
  | { kind: 'success' }
  | { kind: 'failure' };

export interface ProcessTerminator {
  terminate(code: ExitCode): never;
}
