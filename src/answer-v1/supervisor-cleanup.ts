import { SessionJournal } from './journal.js';
import { retainSupervisorTransition, type RetainSupervisorResult } from './supervisor-journal.js';
import { startExecutionDeadline, createSystemDeadlineClock, type DeadlineClock } from './execution-deadline.js';
import type { OwnerFence } from './contracts/invocation-contract.js';
import type { SupervisorBinding } from '../v2/durable-core/schemas/session/supervisor.js';

export interface SupervisorCleanup {
  readonly signal: AbortSignal;
  retainStopIntent(): Promise<RetainSupervisorResult>;
  retainProcessStopped(): Promise<RetainSupervisorResult>;
  close(): void;
}

/** Trusted host boundary. Expired inference cannot authorize further work, but must not
 * prevent recording bounded teardown. Only these two exact-owner transitions escape;
 * no caller receives the independent journal or authority to start/create another process. */
export function beginSupervisorCleanup(
  source: SessionJournal, owner: OwnerFence, supervisor: string,
  binding: SupervisorBinding, parent: AbortSignal, clock: DeadlineClock = createSystemDeadlineClock(),
): SupervisorCleanup | undefined {
  const now = clock.read();
  if (now.kind !== 'reading') return undefined;
  const started = startExecutionDeadline({ kind: 'new_execution', expiresAtMs: now.wallMs + 30_000 },
    clock, parent);
  if (started.kind !== 'started') return undefined;
  const deadline = started.deadline;
  const journal = new SessionJournal(source.engine, source.enrollment, source.config,
    signal => !signal.aborted && deadline.check().kind === 'active');
  const scope = Object.freeze({ supervisor, binding: Object.freeze({ ...binding }) });
  const fence = Object.freeze({ ...owner });
  const retain = (kind: 'supervisor_stop_intended' | 'supervisor_process_stopped') =>
    retainSupervisorTransition(journal, fence, { kind, ...scope }, deadline.signal);
  return Object.freeze({
    signal: deadline.signal,
    retainStopIntent: () => retain('supervisor_stop_intended'),
    retainProcessStopped: () => retain('supervisor_process_stopped'),
    close: () => deadline.close(),
  });
}
