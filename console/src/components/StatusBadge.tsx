import type { ConsoleSessionStatus } from '../api/types';

// Label text is uppercased; color is derived from status semantics.
const STATUS_CONFIG: Record<ConsoleSessionStatus, { label: string; colorClass: string; colorStyle?: string }> = {
  in_progress: { label: 'IN PROGRESS', colorClass: 'badge-live' },
  dormant:     { label: 'DORMANT',     colorClass: '', colorStyle: 'var(--text-muted)' },
  complete:    { label: 'COMPLETE',    colorClass: '', colorStyle: 'var(--success)' },
  complete_with_gaps: { label: 'GAPS', colorClass: '', colorStyle: 'var(--warning)' },
  blocked:     { label: 'BLOCKED',     colorClass: '', colorStyle: 'var(--blocked)' },
};

export function StatusBadge({ status }: { status: ConsoleSessionStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={`font-mono text-[10px] font-bold uppercase tracking-[0.20em]${config.colorClass ? ` ${config.colorClass}` : ''}`}
      style={config.colorStyle ? { color: config.colorStyle } : undefined}
    >
      [ {config.label} ]
    </span>
  );
}
