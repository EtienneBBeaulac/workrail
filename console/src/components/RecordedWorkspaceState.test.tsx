import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordedWorkspaceState } from './RecordedWorkspaceState';
import type { ConsoleSupervisorStatus } from '../api/types';

afterEach(cleanup);
describe('recorded workspace evidence', () => {
  it('leaves legacy runs without workspace evidence unchanged', () => {
    const { container } = render(<RecordedWorkspaceState />);
    expect(container.innerHTML).toBe('');
  });
  it.each([
    [{ kind: 'cleanup_fenced', cleanupPhase: 'removed', resource: { kind: 'recorded', phase: 'create_pending' } }, 'Resource removal recorded; execution settlement unresolved'],
    [{ kind: 'cleanup_fenced', cleanupPhase: 'unbound', resource: { kind: 'recorded', phase: 'running' } }, 'Execution fenced for cleanup; Resource identity unresolved; prior history: Start acknowledged'],
    [{ kind: 'recorded', phase: 'create_pending' }, 'Creation requested'],
    [{ kind: 'recorded', phase: 'created' }, 'Creation acknowledged'],
    [{ kind: 'recorded', phase: 'start_pending' }, 'Start requested'],
    [{ kind: 'recorded', phase: 'running' }, 'Start acknowledged'],
    [{ kind: 'recorded', phase: 'stop_pending' }, 'Stop requested'],
    [{ kind: 'recorded', phase: 'process_stopped' }, 'Process stop acknowledged'],
    [{ kind: 'unconfirmed', operation: 'create', reason: 'ack_unknown' }, 'Creation unconfirmed: acknowledgment unknown'],
    [{ kind: 'unconfirmed', operation: 'stop', reason: 'backend_refused' }, 'Stop unconfirmed: backend refused the request'],
    [{ kind: 'invalid_history' }, 'Conflicting workspace records'],
  ] satisfies ReadonlyArray<readonly [ConsoleSupervisorStatus, string]>)('shows %j as history without live or cleanup authority', (status, label) => {
    render(<RecordedWorkspaceState status={status} />);
    const panel = screen.getByRole('complementary', { name: 'Recorded workspace state' });
    expect(panel.textContent).toContain(label);
    expect(panel.textContent).toContain('Current activity, saved output and cleanup are not verified here.');
    expect(panel.querySelector('button')).toBeNull();
  });
});
