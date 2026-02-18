/**
 * Workspace Resolution
 *
 * Pure functions for selecting and resolving workspace context.
 *
 * Design: two-step pipeline separated by concern:
 *
 * 1. selectWorkspaceSource — pure, I/O-free; selects WHICH source to use based
 *    on available inputs and the priority ladder. Testable without any mocks.
 *
 * 2. resolveWorkspaceAnchors — thin I/O wrapper; calls the resolver with the
 *    selected source. Returns ResultAsync<anchors, never> (always succeeds;
 *    failures absorbed to empty — workspace resolution must never block a workflow).
 *
 * Priority ladder (explicit > MCP roots > server CWD):
 * - explicit_path: caller passed workspacePath directly — highest confidence
 * - mcp_root_uri: MCP roots protocol reported by client — reliable when supported
 * - server_cwd: last resort; always available but may be wrong (server != client CWD)
 *
 * Why the fallback ladder uses ABSENCE, not FAILURE to decide:
 * If the caller passes an explicit workspacePath that happens to not be a git repo,
 * they get empty anchors — not a silent fallthrough to another source.
 * The caller made an explicit choice; respect it.
 */

import { okAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import type { WorkspaceAnchor, WorkspaceSource } from '../../v2/ports/workspace-anchor.port.js';
import type { V2Dependencies } from '../types.js';

// ---------------------------------------------------------------------------
// Source selection — pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Select the appropriate WorkspaceSource based on available inputs.
 *
 * Priority (first match wins — absence-based, not failure-based):
 * 1. explicit_path  — workspacePath provided by the tool caller
 * 2. mcp_root_uri   — primary root from the MCP roots protocol
 * 3. server_cwd     — process.cwd() of the MCP server process (always available)
 *
 * Pure function: same inputs always produce the same output.
 * No I/O, no side effects — testable without any mocks or fakes.
 */
export function selectWorkspaceSource(
  workspacePath: string | undefined,
  resolvedRootUris: readonly string[],
): WorkspaceSource {
  // Priority 1: explicit path from tool input (highest confidence)
  if (workspacePath !== undefined) {
    return { kind: 'explicit_path', path: workspacePath };
  }

  // Priority 2: MCP roots protocol URI (client-reported workspace)
  const primaryUri = resolvedRootUris[0];
  if (primaryUri !== undefined) {
    return { kind: 'mcp_root_uri', uri: primaryUri };
  }

  // Priority 3: server process CWD (always present, may not match client workspace)
  return { kind: 'server_cwd' };
}

// ---------------------------------------------------------------------------
// Resolution — thin I/O wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve workspace git identity anchors for a tool call.
 *
 * Selects the workspace source via selectWorkspaceSource(), then delegates
 * to the resolver adapter. All failures are absorbed to an empty anchor list —
 * workspace resolution must never block workflow start or session resume.
 *
 * Returns ResultAsync<anchors, never>: typed as "always succeeds" since the
 * graceful-degradation contract means empty-on-failure is the correct outcome,
 * not a propagated error.
 */
export function resolveWorkspaceAnchors(
  v2: V2Dependencies,
  workspacePath: string | undefined,
): ResultAsync<readonly WorkspaceAnchor[], never> {
  if (!v2.workspaceResolver) return okAsync([]);

  const source = selectWorkspaceSource(workspacePath, v2.resolvedRootUris ?? []);

  return v2.workspaceResolver.resolve(source)
    .orElse(() => okAsync([])); // absorb ANCHOR_RESOLVE_FAILED → graceful degradation
}
