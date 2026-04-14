/**
 * TraceBadge -- shared badge chip used in execution trace views.
 *
 * Used by RunNarrativeView and NodeDetailSection to display
 * trace item kind labels (STEP, CONDITION, LOOP, FORK, etc.).
 *
 * bgColor is optional; when absent it defaults to `${color}18`
 * (18 hex = ~10% opacity), matching the RoutingTraceBadge convention
 * used in NodeDetailSection.
 */

interface TraceBadgeProps {
  readonly label: string;
  readonly color: string;
  readonly bgColor?: string;
}

export function TraceBadge({ label, color, bgColor }: TraceBadgeProps) {
  const bg = bgColor ?? `${color}18`;
  return (
    <span
      className="shrink-0 inline-flex items-center px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.20em]"
      style={{ color, backgroundColor: bg, border: `1px solid ${color}40` }}
    >
      {label}
    </span>
  );
}
