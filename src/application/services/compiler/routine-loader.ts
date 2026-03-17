/**
 * Routine Loader — Reads routine JSON definitions from disk.
 *
 * Sync I/O, intended for startup-only use.
 * Returns raw WorkflowDefinition objects — the caller (workflow-compiler)
 * converts them to template expanders.
 *
 * Separated from template-registry.ts to keep the registry pure (no I/O).
 *
 * Boundary validation: this is the system edge where raw JSON enters
 * the typed domain. Every parsed file is structurally validated before
 * being accepted — no `as` casts without guards.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { WorkflowDefinition } from '../../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../../types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Error types — errors are data, not swallowed warnings
// ---------------------------------------------------------------------------

export interface RoutineLoadWarning {
  readonly file: string;
  readonly reason: string;
}

export interface RoutineLoadResult {
  readonly routines: ReadonlyMap<string, WorkflowDefinition>;
  /** Files that were skipped with reasons — surfaced for observability */
  readonly warnings: readonly RoutineLoadWarning[];
}

// ---------------------------------------------------------------------------
// Routine directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the routines directory path.
 * Walks up from this file to find the project root's workflows/routines/ directory.
 */
function resolveRoutinesDir(): string {
  // From src/application/services/compiler/ -> project root
  const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(projectRoot, 'workflows', 'routines');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all routine definitions from the workflows/routines/ directory.
 *
 * Returns routines that passed boundary validation plus structured
 * warnings for any files that were skipped. Callers decide how to
 * handle warnings (log, surface to user, ignore) — this function
 * doesn't swallow errors silently.
 *
 * Sync I/O — call once at startup, not in hot paths.
 */
export function loadRoutineDefinitions(
  routinesDir?: string,
): Result<RoutineLoadResult, string> {
  const dir = routinesDir ?? resolveRoutinesDir();

  if (!existsSync(dir)) {
    // No routines directory is not an error — just means no routines to inject
    return ok({ routines: new Map(), warnings: [] });
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (e) {
    return err(`Failed to read routines directory '${dir}': ${e}`);
  }

  const routines = new Map<string, WorkflowDefinition>();
  const warnings: RoutineLoadWarning[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      // Boundary validation: structurally verify before entering typed domain
      if (!hasWorkflowDefinitionShape(parsed)) {
        warnings.push({ file, reason: 'does not match WorkflowDefinition shape (missing id, name, description, version, or steps)' });
        continue;
      }

      routines.set(parsed.id, parsed);
    } catch (e) {
      warnings.push({ file, reason: String(e) });
    }
  }

  return ok({ routines, warnings });
}
