import type { ReactNode, CSSProperties } from 'react';
import { CutCornerBox } from './CutCornerBox';

type Variant = 'grid' | 'list' | 'hero';

interface Props {
  variant?: Variant;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  'aria-label'?: string;
  // hero variant props
  cut?: number;
  borderColor?: string;
}

export function ConsoleCard({
  variant = 'list',
  onClick,
  className = '',
  style,
  children,
  'aria-label': ariaLabel,
  cut = 10,
  borderColor,
}: Props) {
  if (variant === 'hero') {
    return (
      <CutCornerBox cut={cut} borderColor={borderColor} className={`relative ${className}`} style={style}>
        {children}
      </CutCornerBox>
    );
  }

  const baseClasses = 'energy-card group cursor-pointer bg-[var(--bg-card)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:outline-none';

  const variantClasses = {
    grid: 'flex flex-col min-h-[160px]',
    list: 'w-full text-left',
  }[variant];

  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={ariaLabel}
      className={`${baseClasses} ${variantClasses} ${className}`}
      style={style}
    >
      {variant === 'grid' && (
        <div className="h-[3px] w-full bg-[var(--accent)] opacity-60 group-hover:opacity-100 transition-opacity shrink-0" />
      )}
      {children}
    </Tag>
  );
}
