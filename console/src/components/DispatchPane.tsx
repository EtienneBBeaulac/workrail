/**
 * DispatchPane
 *
 * Left column of the AUTO tab. Provides:
 * - Workflow selector (dropdown of available workflows, MRU default via localStorage)
 * - Goal textarea (monospace, placeholder: // describe the task...)
 * - [ RUN ] button that calls POST /api/v2/auto/dispatch
 * - Inline error display below button on failure
 * - Collapsible [ TRIGGERS ] section showing configured triggers
 *
 * Pure presenter: all data fetching is done via hooks defined in api/hooks.ts.
 * No ViewModel layer for MVP -- the pane owns its fetch hooks directly.
 */

import { useState, useEffect, useRef } from 'react';
import { BracketBadge } from './BracketBadge';
import { MonoLabel } from './MonoLabel';
import { useWorkflowList, useTriggerList, dispatchWorkflow } from '../api/hooks';
import { formatRelativeTime } from '../utils/time';

// ---------------------------------------------------------------------------
// MRU: most-recently-used workflow (persisted across sessions)
// ---------------------------------------------------------------------------

const MRU_KEY = 'workrail:auto:mru-workflow';

function readMruWorkflowId(): string | null {
  try { return localStorage.getItem(MRU_KEY); } catch { return null; }
}

function writeMruWorkflowId(id: string): void {
  try { localStorage.setItem(MRU_KEY, id); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// DispatchPane
// ---------------------------------------------------------------------------

export function DispatchPane() {
  const workflowsQuery = useWorkflowList();
  const triggersQuery = useTriggerList();

  const workflows = workflowsQuery.data?.workflows ?? [];
  const triggers = triggersQuery.data?.triggers ?? [];

  // Derive initial workflow selection: MRU > first available
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(() => {
    return readMruWorkflowId() ?? '';
  });
  const [workspacePath, setWorkspacePath] = useState('');
  const [goal, setGoal] = useState('');
  const [isDispatching, setIsDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchSuccess, setDispatchSuccess] = useState(false);
  const [triggersCollapsed, setTriggersCollapsed] = useState(true);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  // Auto-select first workflow if nothing is selected yet and workflows load
  useEffect(() => {
    if (!selectedWorkflowId && workflows.length > 0) {
      setSelectedWorkflowId(workflows[0]?.id ?? '');
    }
  }, [selectedWorkflowId, workflows]);

  const handleWorkflowChange = (id: string) => {
    setSelectedWorkflowId(id);
    writeMruWorkflowId(id);
  };

  const handleRun = async () => {
    if (!selectedWorkflowId || !goal.trim() || !workspacePath.trim()) return;
    setIsDispatching(true);
    setDispatchError(null);
    setDispatchSuccess(false);
    try {
      await dispatchWorkflow({
        workflowId: selectedWorkflowId,
        goal: goal.trim(),
        workspacePath: workspacePath.trim(),
      });
      setDispatchSuccess(true);
      setGoal('');
      // Refocus goal textarea for the next dispatch
      setTimeout(() => goalRef.current?.focus(), 100);
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Dispatch failed');
    } finally {
      setIsDispatching(false);
    }
  };

  const canRun = !!selectedWorkflowId && !!goal.trim() && !!workspacePath.trim() && !isDispatching;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <MonoLabel color="var(--accent)">Dispatch</MonoLabel>
      </div>

      {/* Workflow selector */}
      <div className="flex flex-col gap-1.5">
        <MonoLabel>Workflow</MonoLabel>
        {workflowsQuery.isLoading ? (
          <div className="text-[var(--text-muted)] text-xs">Loading workflows...</div>
        ) : workflows.length === 0 ? (
          <div className="text-[var(--text-muted)] text-xs">No workflows available</div>
        ) : (
          <select
            value={selectedWorkflowId}
            onChange={(e) => handleWorkflowChange(e.target.value)}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name ?? w.id}</option>
            ))}
          </select>
        )}
      </div>

      {/* Workspace path */}
      <div className="flex flex-col gap-1.5">
        <MonoLabel>Workspace path</MonoLabel>
        <input
          type="text"
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          placeholder="/path/to/repo"
          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
        />
      </div>

      {/* Goal textarea */}
      <div className="flex flex-col gap-1.5">
        <MonoLabel>Goal</MonoLabel>
        <textarea
          ref={goalRef}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="// describe the task..."
          rows={4}
          className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-y"
          onKeyDown={(e) => {
            // Ctrl+Enter or Cmd+Enter to submit
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canRun) {
              e.preventDefault();
              void handleRun();
            }
          }}
        />
      </div>

      {/* Run button */}
      <div className="flex flex-col gap-2">
        <button
          onClick={() => void handleRun()}
          disabled={!canRun}
          className="self-start disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <BracketBadge
            label={isDispatching ? 'RUNNING...' : 'RUN'}
            color={canRun ? 'var(--accent)' : undefined}
            pulse={isDispatching}
          />
        </button>

        {/* Success message */}
        {dispatchSuccess && (
          <div className="text-[var(--success)] font-mono text-[10px] uppercase tracking-[0.20em]">
            Dispatched -- check Queue pane
          </div>
        )}

        {/* Error message */}
        {dispatchError && (
          <div className="text-[var(--error)] text-xs font-mono">
            {dispatchError}
          </div>
        )}
      </div>

      {/* Triggers section */}
      <div className="border-t border-[var(--border)] pt-4">
        <button
          onClick={() => setTriggersCollapsed(!triggersCollapsed)}
          className="flex items-center gap-2 mb-2 cursor-pointer group"
        >
          <span
            className="text-[var(--text-muted)] text-xs transition-transform duration-150"
            style={{ transform: triggersCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          >
            ▼
          </span>
          <BracketBadge label="TRIGGERS" color="var(--text-secondary)" />
          {triggers.length > 0 && (
            <span className="text-xs text-[var(--text-muted)]">({triggers.length})</span>
          )}
        </button>

        {!triggersCollapsed && (
          <div className="space-y-2">
            {triggersQuery.isLoading ? (
              <div className="text-[var(--text-muted)] text-xs pl-4">Loading triggers...</div>
            ) : triggers.length === 0 ? (
              <div className="text-[var(--text-muted)] text-xs pl-4">
                No triggers configured. Set WORKRAIL_TRIGGERS_ENABLED=true and create triggers.yml.
              </div>
            ) : (
              triggers.map((t) => (
                <div
                  key={t.id}
                  className="pl-4 border-l-2 border-[var(--border)] text-xs space-y-0.5"
                >
                  <div className="font-mono text-[var(--text-primary)] text-[11px]">{t.id}</div>
                  <div className="text-[var(--text-muted)]">{t.workflowId}</div>
                  <div className="text-[var(--text-muted)] truncate">{t.goal}</div>
                  {/* lastFiredAt: not yet tracked server-side */}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
