import type { ReactNode, CSSProperties } from 'react';

interface Props {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * Wraps children with a stylized dual amber vertical connector line that ends
 * on a diagonal at the bottom. Used to visually group nested items (e.g.
 * sessions under a branch, branches under a repo) in a schematic/circuit style.
 *
 * The line is defined in index.css (.branch-tree-line) as a ::before pseudo-element
 * with two parallel lines (1px outer, 3px inner) clipped by a diagonal polygon.
 */
export function TreeLine({ children, className = '', style }: Props) {
  return (
    <div className={`branch-tree-line ${className}`} style={style}>
      {children}
    </div>
  );
}
