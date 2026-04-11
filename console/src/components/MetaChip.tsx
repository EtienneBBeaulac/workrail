import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  variant?: 'default' | 'outlined'; // default: plain bg, outlined: border
  className?: string;
}

export function MetaChip({ children, variant = 'default', className = '' }: Props) {
  const base = 'font-mono text-[10px] px-1.5 py-0.5 text-[var(--text-secondary)] inline-flex items-center';
  const variantClass = variant === 'outlined'
    ? 'border border-[var(--border)]'
    : 'bg-[var(--bg-secondary)]';

  return (
    <span className={`${base} ${variantClass} ${className}`}>
      {children}
    </span>
  );
}
