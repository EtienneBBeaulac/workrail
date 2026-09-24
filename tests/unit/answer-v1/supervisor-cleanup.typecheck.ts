import type { SupervisorCleanup } from '../../../src/answer-v1/supervisor-cleanup.js';

function rejectsExecutionAuthority(cleanup: SupervisorCleanup) {
  // @ts-expect-error Cleanup cannot create/start a supervisor.
  cleanup.retainStartIntent();
  // @ts-expect-error Cleanup cannot append arbitrary canonical events.
  cleanup.append({ kind: 'model_call_reserved' });
  // @ts-expect-error Cleanup cannot invoke workspace effects.
  cleanup.execute('Bash', { command: 'true' });
}
void rejectsExecutionAuthority;
