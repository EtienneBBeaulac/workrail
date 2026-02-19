import type { ConsoleSessionHealth } from '../api/types';

export function HealthBadge({ health }: { health: ConsoleSessionHealth }) {
  if (health === 'healthy') return null;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
      style={{ backgroundColor: 'var(--error)20', color: 'var(--error)' }}
    >
      Corrupt
    </span>
  );
}
