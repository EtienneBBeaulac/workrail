import type { ResultAsync } from 'neverthrow';

/**
 * Workspace anchor: a typed observation about the current workspace identity.
 *
 * Lock: §1 observation_recorded — closed-set keys + tagged scalar values.
 * These are the workspace identity signals used by resume_session ranking.
 *
 * Why a discriminated union (not Record<string, string>):
 * - Closed set prevents ad-hoc keys from leaking into durable truth
 * - Tagged values enforce format constraints per key (SHA-1 vs short_string)
 * - Exhaustive handling in the observation builder
 */
export type WorkspaceAnchor =
  | { readonly key: 'git_branch'; readonly value: string }
  | { readonly key: 'git_head_sha'; readonly value: string }
  | { readonly key: 'repo_root_hash'; readonly value: string };

export type WorkspaceAnchorError =
  | { readonly code: 'ANCHOR_RESOLVE_FAILED'; readonly message: string };

/**
 * Port for resolving workspace identity anchors.
 *
 * Lock: §DI — inject external effects at boundaries.
 *
 * Contract:
 * - Returns anchors for the current workspace (may be empty if not a git repo)
 * - Graceful degradation: resolve failures return empty list, not errors
 *   (observation emission should never block workflow start)
 * - Pure consumers call this once at start_workflow time
 */
export interface WorkspaceAnchorPortV2 {
  resolveAnchors(): ResultAsync<readonly WorkspaceAnchor[], WorkspaceAnchorError>;
}
