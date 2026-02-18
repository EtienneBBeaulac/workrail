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
 * @deprecated Use WorkspaceContextResolverPortV2 instead.
 *
 * This port resolves from a fixed CWD baked in at construction time,
 * which is always the server's working directory rather than the client's.
 * It remains for backward compatibility and is delegated to by the new resolver.
 */
export interface WorkspaceAnchorPortV2 {
  resolveAnchors(): ResultAsync<readonly WorkspaceAnchor[], WorkspaceAnchorError>;
}

/**
 * Port for resolving workspace identity anchors per request.
 *
 * Replaces the startup-time singleton (WorkspaceAnchorPortV2) with a pure
 * per-request resolver that accepts an explicit root path, matching the
 * MCP roots protocol where the client reports its workspace URI.
 *
 * Contract:
 * - resolveFromUri: resolves git identity for a client-reported file:// URI
 *   (non-file:// URIs return empty — graceful, not an error)
 * - resolveFromCwd: resolves from process.cwd() as a backward-compat fallback
 *   when the client does not report roots
 * - Both paths degrade gracefully: non-git dirs, missing git, etc. → empty list
 * - Observation emission must never block workflow start
 */
export interface WorkspaceContextResolverPortV2 {
  resolveFromUri(rootUri: string): ResultAsync<readonly WorkspaceAnchor[], WorkspaceAnchorError>;
  resolveFromCwd(): ResultAsync<readonly WorkspaceAnchor[], WorkspaceAnchorError>;
}
