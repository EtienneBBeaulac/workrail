import type { ReactNode } from 'react';

interface Segment {
  label: string;
  onClick?: () => void;
}

interface Props {
  segments: Segment[];
  className?: string;
}

/**
 * Cyberpunk path-style breadcrumb using // separators.
 * Renders as: // SEGMENT // SEGMENT // CURRENT
 *
 * The last segment is the current location (not clickable, full brightness).
 * Earlier segments are dimmed and clickable -- clicking navigates back.
 *
 * Usage:
 *   <PathBreadcrumb segments={[
 *     { label: 'Workflows', onClick: onBack },
 *     { label: 'Coding' },
 *   ]} />
 *   → renders: // WORKFLOWS // CODING
 */
export function PathBreadcrumb({ segments, className = '' }: Props) {
  return (
    <nav aria-label="Breadcrumb" className={`flex items-center gap-0 ${className}`}>
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        const isClickable = !!segment.onClick;

        return (
          <span key={i} className="flex items-center">
            <span className="font-mono text-[10px] tracking-[0.25em] text-[var(--text-muted)] mx-1">
              //
            </span>
            {isClickable ? (
              <button
                type="button"
                onClick={segment.onClick}
                className="font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors cursor-pointer"
              >
                {segment.label.toUpperCase()}
              </button>
            ) : (
              <span
                className={`font-mono text-[10px] uppercase tracking-[0.25em] ${
                  isLast ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'
                }`}
                aria-current={isLast ? 'page' : undefined}
              >
                {segment.label.toUpperCase()}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
