import type { ResolveFrom } from '../../types/workflow-definition.js';

/**
 * Shared fields for all resolved reference variants.
 *
 * References are workflow-declared (compile-time) or project-attached (future).
 * Content is never inlined — the agent reads the file itself if needed.
 */
interface ResolvedReferenceBase {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly purpose: string;
  readonly authoritative: boolean;
  /** Resolution context: workspace-relative or package-relative. */
  readonly resolveFrom: ResolveFrom;
}

/**
 * A resolved workflow reference — discriminated union over resolution status.
 *
 * - `resolved`: I/O confirmed the path exists; `resolvedPath` is the absolute path.
 * - `unresolved`: I/O confirmed the path does NOT exist at start time.
 * - `pinned`: replayed from a pinned session — no I/O was performed, only the
 *   declaration is available. Used on rehydrate to avoid lying about resolution state.
 */
export type ResolvedReference =
  | (ResolvedReferenceBase & { readonly status: 'resolved'; readonly resolvedPath: string })
  | (ResolvedReferenceBase & { readonly status: 'unresolved' })
  | (ResolvedReferenceBase & { readonly status: 'pinned' });
