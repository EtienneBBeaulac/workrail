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
 * Where to derive the workspace directory for git identity resolution.
 *
 * A closed discriminated union — exhaustive handling is enforced by TypeScript.
 * The priority order (explicit_path > mcp_root_uri > server_cwd) is encoded
 * in selectWorkspaceSource() in the handler layer, not here.
 *
 * Why an ADT instead of method overloads:
 * - Reduces interface surface from 3 methods to 1
 * - Makes the source selection point a pure, separately testable function
 * - Adding a new source variant requires updating the adapter's exhaustive switch
 *   (compile error) rather than silently adding a new code path
 */
export type WorkspaceSource =
  | { readonly kind: 'explicit_path'; readonly path: string }   // passed by caller via tool input
  | { readonly kind: 'mcp_root_uri'; readonly uri: string }     // MCP roots protocol
  | { readonly kind: 'server_cwd' };                             // last-resort fallback

/**
 * Port for resolving workspace identity anchors per request.
 *
 * Single-method interface: all workspace sources funnel through resolve(source).
 * The caller selects the appropriate WorkspaceSource variant; the adapter
 * resolves it to git anchors.
 *
 * Contract:
 * - explicit_path: resolves from the given absolute filesystem path
 * - mcp_root_uri: resolves from a client-reported file:// URI
 *   (non-file:// URIs return empty — graceful, not an error)
 * - server_cwd: resolves from process.cwd() (server startup directory)
 * - All variants degrade gracefully: non-git dirs, missing git → empty list
 * - Observation emission must never block workflow start
 */
export interface WorkspaceContextResolverPortV2 {
  resolve(source: WorkspaceSource): ResultAsync<readonly WorkspaceAnchor[], WorkspaceAnchorError>;
}
