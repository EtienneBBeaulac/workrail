import type { CSSProperties } from 'react';

interface Props {
  label: string;
  color?: string;       // CSS color value, default: var(--text-secondary)
  pulse?: boolean;      // applies badge-live animation class
  className?: string;
  style?: CSSProperties;
  role?: string;
  'aria-label'?: string;
}

export function BracketBadge({ label, color, pulse = false, className = '', style, role, 'aria-label': ariaLabel }: Props) {
  return (
    <span
      className={`font-mono text-[10px] font-bold uppercase tracking-[0.20em]${pulse ? ' badge-live' : ''}${className ? ` ${className}` : ''}`}
      style={color ? { color, ...style } : style}
      role={role}
      aria-label={ariaLabel}
    >
      [ {label} ]
    </span>
  );
}
