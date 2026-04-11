import type { ConsoleSessionStatus } from '../api/types';
import { BracketBadge } from './BracketBadge';

// Label text is uppercased; color is derived from status semantics.
const STATUS_CONFIG: Record<ConsoleSessionStatus, { label: string; pulse: boolean; color?: string }> = {
  in_progress:        { label: 'IN PROGRESS', pulse: true },
  dormant:            { label: 'DORMANT',      pulse: false, color: 'var(--text-muted)' },
  complete:           { label: 'COMPLETE',     pulse: false, color: 'var(--success)' },
  complete_with_gaps: { label: 'GAPS',         pulse: false, color: 'var(--warning)' },
  blocked:            { label: 'BLOCKED',      pulse: false, color: 'var(--blocked)' },
};

export function StatusBadge({ status }: { status: ConsoleSessionStatus }) {
  const { label, pulse, color } = STATUS_CONFIG[status];
  return <BracketBadge label={label} pulse={pulse} color={color} />;
}
