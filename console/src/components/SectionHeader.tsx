interface Props {
  label: string;
  count?: number;
  countLabel?: string; // default: 'workflow' (pluralized automatically)
  showRule?: boolean;
  separator?: string;  // default: '//'
}

export function SectionHeader({
  label,
  count,
  countLabel = 'workflow',
  showRule = true,
  separator = '//',
}: Props) {
  const countText = count != null
    ? ` ${separator} ${count} ${countLabel}${count !== 1 ? 's' : ''}`
    : '';

  return (
    <div className="flex items-center gap-3 mb-3 mt-2">
      <span className="font-mono text-[11px] uppercase tracking-[0.30em] text-[var(--text-secondary)] shrink-0">
        {label}{countText}
      </span>
      {showRule && <div className="flex-1 h-px bg-[var(--border)]" />}
    </div>
  );
}
