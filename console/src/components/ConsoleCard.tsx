import { forwardRef } from 'react';
import type { ReactNode, CSSProperties, MouseEvent, KeyboardEvent } from 'react';
import { CutCornerBox } from './CutCornerBox';

type Variant = 'grid' | 'list' | 'hero';

interface Props {
  variant?: Variant;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus?: () => void;
  /** Controls tab order. Used by useGridKeyNav for roving tabindex behaviour. */
  tabIndex?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  'aria-label'?: string;
  // hero variant props
  cut?: number;
  borderColor?: string;
}

export const ConsoleCard = forwardRef<HTMLButtonElement, Props>(function ConsoleCard(
  {
    variant = 'list',
    onClick,
    onKeyDown,
    onFocus,
    tabIndex,
    className = '',
    style,
    children,
    'aria-label': ariaLabel,
    cut = 10,
    borderColor,
  },
  ref,
) {
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

  const sharedClasses = `${baseClasses} ${variantClasses} ${className}`;
  const accentBar = variant === 'grid' && (
    <div className="h-[3px] w-full bg-[var(--accent)] opacity-60 group-hover:opacity-100 transition-opacity shrink-0" />
  );

  if (onClick) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        tabIndex={tabIndex}
        aria-label={ariaLabel}
        className={sharedClasses}
        style={style}
      >
        {accentBar}
        {children}
      </button>
    );
  }

  return (
    <div
      aria-label={ariaLabel}
      className={sharedClasses}
      style={style}
    >
      {accentBar}
      {children}
    </div>
  );
});
