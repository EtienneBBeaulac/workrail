import type { ExitCode, ProcessTerminator } from '../ports/process-terminator.js';

/**
 * Test adapter: never exits the process.
 * Useful to catch accidental termination during tests.
 */
export class ThrowingProcessTerminator implements ProcessTerminator {
  terminate(code: ExitCode): never {
    throw new Error(`[ProcessTerminator] terminate(${code.kind})`);
  }
}
