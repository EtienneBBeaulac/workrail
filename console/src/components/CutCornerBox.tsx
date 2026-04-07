import type { CSSProperties, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// CutCornerBox
//
// A box with a diagonal cut on the top-left corner and a thin border that
// follows the cut edge.
//
// Geometry:
//   Two absolutely positioned layers fill the outer wrapper:
//     1. Border layer  (inset: 0)   -- clip-path at `cut`px, background = borderColor
//     2. Content layer (inset: 1px) -- clip-path at `cut`px (SAME value)
//
//   Both clip-paths use the same cut value. The 1px inset shifts the content
//   layer's polygon so its diagonal sits at x+y = cut+2 in outer coordinates,
//   while the border layer diagonal is at x+y = cut. The strip between them
//   (width = 2/√2 ≈ 1.4px) shows the border color -- matching the visual
//   weight of the 1px straight-edge borders on all other sides.
//
//   Using different cut values (outer > inner) is a common mistake that causes
//   the two diagonals to coincide (zero border) or cross (negative border).
//   The 1px inset alone is sufficient -- no cut-size difference needed.
//
// Drop shadow:
//   box-shadow is clipped by clip-path. Use `shadow` prop to apply
//   filter:drop-shadow() instead, which renders after compositing.
//
// Height:
//   Both content layers use position:absolute, so the outer wrapper needs
//   explicit height (via className or style). For viewport-filling panels,
//   use position:fixed/absolute constraints. For fixed-height cards, set
//   style={{ height: 'Npx' }}.
//
// Usage:
//   // Floating panel (viewport-filling):
//   <CutCornerBox cut={18} borderColor="rgba(0,240,255,0.28)" background="..." shadow
//     className="fixed top-3 right-3 bottom-3 w-[560px]" style={{ zIndex: 40 }}>
//     ...
//   </CutCornerBox>
//
//   // Card (explicit height):
//   <CutCornerBox cut={10} className="relative h-[506px]">
//     ...
//   </CutCornerBox>
//
//   // Simple clip only (no border tracking, any height):
//   <div style={{ clipPath: cutCornerPath(10) }}>...</div>
// ---------------------------------------------------------------------------

const INSET_PX = 1;

/** Returns a CSS clip-path polygon string for a top-left cut corner. */
export function cutCornerPath(cut: number): string {
  return `polygon(${cut}px 0, 100% 0, 100% 100%, 0 100%, 0 ${cut}px)`;
}

interface Props {
  /** Cut size in pixels. Controls the visible corner angle. Default: 12. */
  cut?: number;
  /** Border color, including along the diagonal. Default: var(--border). */
  borderColor?: string;
  /** Panel background color. Default: var(--bg-card). */
  background?: string;
  /**
   * Adds a filter:drop-shadow() to the outer wrapper.
   * Accepts a CSS drop-shadow string, e.g.
   * "drop-shadow(0 16px 48px rgba(0,0,0,0.8)) drop-shadow(0 2px 8px rgba(0,0,0,0.5))"
   */
  dropShadow?: string;
  /**
   * Adds backdrop-filter to the inner content layer (the frosted glass effect).
   * The ambient background bleeds through the semi-transparent panel background.
   */
  backdropFilter?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function CutCornerBox({
  cut = 12,
  borderColor = 'var(--border)',
  background = 'var(--bg-card)',
  dropShadow,
  backdropFilter,
  className,
  style,
  children,
}: Props) {
  const path = cutCornerPath(cut);

  return (
    <div
      className={className}
      style={{
        filter: dropShadow ? `${dropShadow}` : undefined,
        ...style,
      }}
    >
      {/* Border layer: fills the outer wrapper, clipped to the cut shape. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: borderColor,
          clipPath: path,
          pointerEvents: 'none',
        }}
      />
      {/* Content layer: inset 1px, same clip-path.
          The 1px inset shifts the diagonal to x+y = cut+2 in outer coords,
          creating a ~1.4px diagonal border strip (matches 1px straight borders). */}
      <div
        style={{
          position: 'absolute',
          inset: INSET_PX,
          background,
          backdropFilter: backdropFilter ?? undefined,
          WebkitBackdropFilter: backdropFilter ?? undefined,
          clipPath: path,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}
