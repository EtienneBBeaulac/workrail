import type { ConsoleSessionStatus } from '../api/types';

const STATUS_CONFIG: Record<ConsoleSessionStatus, { label: string; color: string }> = {
  in_progress: { label: 'In Progress', color: 'var(--accent)' },
  dormant: { label: 'Dormant', color: 'var(--text-secondary)' },
  complete: { label: 'Complete', color: 'var(--success)' },
  complete_with_gaps: { label: 'Gaps', color: 'var(--warning)' },
  blocked: { label: 'Blocked', color: 'var(--blocked)' },
};

export function StatusBadge({ status }: { status: ConsoleSessionStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
      style={{ backgroundColor: `color-mix(in srgb, ${config.color} 12%, transparent)`, color: config.color }}
    >
      {config.label}
    </span>
  );
}
