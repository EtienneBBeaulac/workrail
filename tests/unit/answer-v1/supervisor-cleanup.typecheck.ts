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

import type { CleanupFence } from '../../../src/answer-v1/cleanup-ownership.js';
import type { OwnerFence } from '../../../src/answer-v1/contracts/invocation-contract.js';
function rejectsCleanupAsExecution(cleanup: CleanupFence) {
  // @ts-expect-error A cleanup fence cannot authorize execution writes.
  const execution: OwnerFence = cleanup;
  return execution;
}
void rejectsCleanupAsExecution;

import type { CleanupTarget } from '../../../src/answer-v1/cleanup-target.js';
declare const target: CleanupTarget;
// @ts-expect-error Cold cleanup inspection cannot grant execution ownership.
const executionFromTarget: import('../../../src/answer-v1/contracts/invocation-contract.js').OwnerFence = target;
void executionFromTarget;
