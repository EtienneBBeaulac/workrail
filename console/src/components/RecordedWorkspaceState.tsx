import type { ConsoleSupervisorStatus } from '../api/types';

const PHASE_LABELS = {
  create_pending: 'Creation requested',
  created: 'Creation acknowledged',
  start_pending: 'Start requested',
  running: 'Start acknowledged',
  stop_pending: 'Stop requested',
  process_stopped: 'Process stop acknowledged',
} as const satisfies Record<Extract<ConsoleSupervisorStatus, { kind: 'recorded' }>['phase'], string>;

const CLEANUP_LABELS = {
  unbound: 'Resource identity unresolved', bound: 'Resource identity retained',
  stop_pending: 'Cleanup stop requested', stopped: 'Stopped resource observed',
  remove_pending: 'Removal requested', removed: 'Resource removal recorded; execution settlement unresolved',
} as const satisfies Record<Extract<ConsoleSupervisorStatus, { kind: 'cleanup_fenced' }>['cleanupPhase'], string>;

function describe(status: ConsoleSupervisorStatus): string {
  switch (status.kind) {
    case 'recorded': return PHASE_LABELS[status.phase];
    case 'unconfirmed': {
      const action = { create: 'Creation', start: 'Start', stop: 'Stop' } as const;
      return `${action[status.operation]} unconfirmed: ${status.reason === 'ack_unknown' ? 'acknowledgment unknown' : 'backend refused the request'}`;
    }
    case 'cleanup_fenced': return `Execution fenced for cleanup; ${CLEANUP_LABELS[status.cleanupPhase]}; prior history: ${describe(status.resource)}`;
    case 'invalid_history': return 'Conflicting workspace records';
    default: { const unreachable: never = status; return unreachable; }
  }
}

/** Journal evidence is diagnostic, never a live health or cleanup receipt. */
export function RecordedWorkspaceState({ status }: { readonly status?: ConsoleSupervisorStatus }) {
  if (!status) return null;
  return (
    <aside aria-label="Recorded workspace state" className="border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
      <p className="text-xs font-medium text-[var(--text-primary)]">Recorded workspace state: {describe(status)}</p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">Journal history only. Current activity, saved output and cleanup are not verified here.</p>
    </aside>
  );
}
