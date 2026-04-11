import type { CSSProperties, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  color?: string; // CSS color value or variable, default: var(--text-muted)
  className?: string;
  style?: CSSProperties;
}

export function MonoLabel({ children, color, className = '', style }: Props) {
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-[0.30em] ${className}`}
      style={{ color: color ?? 'var(--text-muted)', ...style }}
    >
      {children}
    </span>
  );
}
