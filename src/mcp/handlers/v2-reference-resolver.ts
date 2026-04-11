/**
 * Workflow Reference Resolution
 *
 * Resolves workflow-declared reference paths at start time.
 * This is the I/O boundary for references — the compiler validates structurally
 * (pure), this module validates path existence (I/O).
 *
 * Resolution bases:
 * - `'workspace'` (default): resolved against the user's project root.
 * - `'package'`: resolved against the workrail package root. For files shipped
 *   with the workflow (specs, schemas, bundled guides).
 *
 * Design:
 * - Always succeeds — reference resolution must never block a workflow
 * - Missing paths produce warnings, not errors
 * - Both workspace and package paths are containment-checked (no `../` escape)
 * - Resolution verifies the path is a file, not a directory
 * - Returns ResolvedReference[] for the content envelope
 * - I/O is injectable for testability (defaults to real filesystem)
 *
 * @module mcp/handlers/v2-reference-resolver
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { WorkflowReference, ResolveFrom } from '../../types/workflow-definition.js';
import type { ResolvedReference } from '../step-content-envelope.js';

export interface ReferenceResolutionWarning {
  readonly referenceId: string;
  readonly source: string;
  readonly message: string;
}

export interface ReferenceResolutionResult {
  readonly resolved: readonly ResolvedReference[];
  readonly warnings: readonly ReferenceResolutionWarning[];
}

/** Injectable I/O port for filesystem access checks. */
export type FileExistsPort = (filePath: string) => Promise<boolean>;

/** Default implementation: async fs.stat to verify path is a readable file (not a directory). */
export const defaultFileExists: FileExistsPort = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

/**
 * Derive the workrail package root from this module's location.
 * Package layout: src/mcp/handlers/v2-reference-resolver.ts → package root is 3 levels up.
 */
function getPackageRoot(): string {
  const thisDir = __dirname;
  return path.resolve(thisDir, '..', '..', '..');
}

/**
 * Resolve workflow reference paths against workspace and/or package root.
 *
 * - `resolveFrom: 'workspace'` (default): containment-checked against workspacePath
 * - `resolveFrom: 'package'`: resolved against the workrail package root
 *
 * I/O is async and injectable via fileExists parameter.
 */
export async function resolveWorkflowReferences(
  references: readonly WorkflowReference[],
  workspacePath: string,
  fileExists: FileExistsPort = defaultFileExists,
): Promise<ReferenceResolutionResult> {
  const normalizedWorkspaceBase = path.resolve(workspacePath) + path.sep;
  const packageRoot = getPackageRoot();
  const normalizedPackageBase = path.resolve(packageRoot) + path.sep;

  const entries = await Promise.all(
    references.map(async (ref) => {
      const isPackageRef = ref.resolveFrom === 'package';
      const resolveBase = isPackageRef ? packageRoot : workspacePath;
      const normalizedBase = isPackageRef ? normalizedPackageBase : normalizedWorkspaceBase;
      const resolvedPath = path.resolve(resolveBase, ref.source);

      // Containment check: resolved path must stay within its base (workspace or package root)
      if (!resolvedPath.startsWith(normalizedBase) && resolvedPath !== path.resolve(resolveBase)) {
        return { ref, resolvedPath, exists: false, escaped: true, ioError: null as string | null };
      }

      try {
        const exists = await fileExists(resolvedPath);
        return { ref, resolvedPath, exists, escaped: false, ioError: null as string | null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ref, resolvedPath, exists: false, escaped: false, ioError: message };
      }
    }),
  );

  const resolved: ResolvedReference[] = [];
  const warnings: ReferenceResolutionWarning[] = [];

  for (const { ref, resolvedPath, exists, escaped, ioError } of entries) {
    if (escaped) {
      warnings.push({
        referenceId: ref.id,
        source: ref.source,
        message: `Reference '${ref.id}' source path escapes ${ref.resolveFrom === 'package' ? 'package' : 'workspace'} boundary: ${ref.source}`,
      });
    } else if (ioError != null) {
      warnings.push({
        referenceId: ref.id,
        source: ref.source,
        message: `Reference '${ref.id}' source path could not be checked: ${ioError}`,
      });
    } else if (!exists) {
      warnings.push({
        referenceId: ref.id,
        source: ref.source,
        message: `Reference '${ref.id}' source path does not exist: ${resolvedPath}`,
      });
    }

    const base = {
      id: ref.id,
      title: ref.title,
      source: ref.source,
      purpose: ref.purpose,
      authoritative: ref.authoritative,
      resolveFrom: (ref.resolveFrom ?? 'workspace') as ResolveFrom,
    } as const;

    resolved.push(
      (!escaped && exists)
        ? { ...base, status: 'resolved' as const, resolvedPath }
        : { ...base, status: 'unresolved' as const },
    );
  }

  return { resolved, warnings };
}
