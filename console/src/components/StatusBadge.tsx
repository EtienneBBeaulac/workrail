import type { ConsoleRunStatus } from '../api/types';

const STATUS_CONFIG: Record<ConsoleRunStatus, { label: string; color: string }> = {
  in_progress: { label: 'In Progress', color: 'var(--accent)' },
  complete: { label: 'Complete', color: 'var(--success)' },
  complete_with_gaps: { label: 'Gaps', color: 'var(--warning)' },
  blocked: { label: 'Blocked', color: 'var(--blocked)' },
};

export function StatusBadge({ status }: { status: ConsoleRunStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
      style={{ backgroundColor: `${config.color}20`, color: config.color }}
    >
      {config.label}
    </span>
  );
}
