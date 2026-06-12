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
 */

import { okAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import type { WorkspaceAnchor, WorkspaceSource, WorkspaceContextResolverPortV2 } from '../ports/workspace-anchor.port.js';

/**
 * Resolve the directory to use when loading `.workrail/bindings.json` for
 * binding drift detection at resume time.
 *
 * Mirrors the priority ladder of selectWorkspaceSource but returns a concrete
 * absolute path synchronously — no async, no git resolution, no anchors.
 * Used only by loadProjectBindings, which appends `.workrail/bindings.json`.
 *
 * Priority:
 *  1. explicit workspacePath from the tool input (highest confidence)
 *  2. primary MCP root URI converted to path (strips file:// prefix)
 *  3. server process.cwd() (always available, may be wrong for remote clients)
 */
export function resolveBindingBaseDir(
  workspacePath: string | undefined,
  resolvedRootUris: readonly string[],
): string {
  if (workspacePath !== undefined) return workspacePath;

  const primaryUri = resolvedRootUris[0];
  if (primaryUri !== undefined) {
    // Convert file:///absolute/path → /absolute/path.
    // Non-file URIs (e.g. ssh://) fall through to server_cwd.
    if (primaryUri.startsWith('file://')) {
      return decodeURIComponent(primaryUri.replace(/^file:\/\//, ''));
    }
  }

  return process.cwd();
}

/**
 * Select the appropriate WorkspaceSource based on available inputs.
 *
 * Priority (first match wins — absence-based, not failure-based):
 * 1. explicit_path  — workspacePath provided by the tool caller
 * 2. mcp_root_uri   — primary root from the MCP roots protocol
 * 3. server_cwd     — process.cwd() of the MCP server process (always available)
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

/**
 * Resolve workspace git identity anchors for a tool call.
 *
 * Selects the workspace source via selectWorkspaceSource(), then delegates
 * to the resolver adapter. All failures are absorbed to an empty anchor list —
 * workspace resolution must never block workflow start or session resume.
 */
export function resolveWorkspaceAnchors(
  v2: {
    readonly workspaceResolver?: WorkspaceContextResolverPortV2;
    readonly resolvedRootUris?: readonly string[];
  },
  workspacePath: string | undefined,
): ResultAsync<readonly WorkspaceAnchor[], never> {
  if (!v2.workspaceResolver) return okAsync([]);

  const source = selectWorkspaceSource(workspacePath, v2.resolvedRootUris ?? []);

  return v2.workspaceResolver.resolve(source)
    .orElse(() => okAsync([])); // absorb ANCHOR_RESOLVE_FAILED → graceful degradation
}
