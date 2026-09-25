import type { DomainEventV1 } from '../schemas/session/index.js';

/** Canonical run state shared by every execution entrypoint. */
export function projectRunLifecycle(events: readonly DomainEventV1[], runId: string) {
  const stopped = events.find((event): event is Extract<DomainEventV1, { kind: 'run_stopped' }> =>
    event.kind === 'run_stopped' && event.scope.runId === runId);
  if (stopped) return { kind: 'stopped' as const, event: stopped };
  if (events.some(event => event.kind === 'run_completed' && event.scope.runId === runId)) {
    return { kind: 'completed' as const };
  }
  return { kind: 'active' as const };
}
