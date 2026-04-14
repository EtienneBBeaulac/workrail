/**
 * TraceBadge -- shared badge chip used in execution trace views.
 *
 * Used by RunNarrativeView and NodeDetailSection to display
 * trace item kind labels (STEP, CONDITION, LOOP, FORK, etc.).
 *
 * bgColor must be a complete, valid CSS color value. There is no
 * default -- callers must always pass bgColor explicitly to avoid
 * invalid CSS when `color` is a CSS custom property (var(--x)18 is
 * not valid CSS and renders transparent).
 */

interface TraceBadgeProps {
  readonly label: string;
  readonly color: string;
  readonly bgColor: string;
}

export function TraceBadge({ label, color, bgColor }: TraceBadgeProps) {
  return (
    <span
      className="shrink-0 inline-flex items-center px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.20em]"
      style={{ color, backgroundColor: bgColor, border: `1px solid ${color}40` }}
    >
      {label}
    </span>
  );
}
