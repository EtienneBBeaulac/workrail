import type { SupervisorCleanup } from '../../../src/answer-v1/supervisor-cleanup.js';

function rejectsExecutionAuthority(cleanup: SupervisorCleanup) {
  // @ts-expect-error Cleanup cannot create/start a supervisor.
  void cleanup.retainStartIntent;
  // @ts-expect-error Cleanup cannot append arbitrary canonical events.
  void cleanup.append;
  // @ts-expect-error Cleanup cannot invoke workspace effects.
  void cleanup.execute;
}
void rejectsExecutionAuthority;
