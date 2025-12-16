import type { ExitCode, ProcessTerminator } from '../ports/process-terminator.js';
import { assertNever } from '../assert-never.js';

export class NodeProcessTerminator implements ProcessTerminator {
  terminate(code: ExitCode): never {
    switch (code.kind) {
      case 'success':
        process.exit(0);
      case 'failure':
        process.exit(1);
      default:
        return assertNever(code);
    }
  }
}
