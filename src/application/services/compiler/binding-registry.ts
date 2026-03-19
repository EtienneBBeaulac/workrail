/**
 * Binding Registry — Project-Level Binding Overrides
 *
 * Loads per-project binding overrides from .workrail/bindings.json.
 * These overrides take precedence over extensionPoint defaults declared
 * in the workflow JSON.
 *
 * Why startup-time loading: binding values must be frozen into the compiled
 * workflow hash for session reproducibility. Loading once at startup and
 * freezing the result mirrors the template registry pattern.
 *
 * File format (per-workflow overrides keyed by workflow ID):
 * {
 *   "coding-task-workflow-agentic": {
 *     "design_review": "my-team-design-review"
 *   }
 * }
 *
 * A flat format (slotId -> routineId, workflow-agnostic) is also accepted:
 * {
 *   "design_review": "my-team-design-review"
 * }
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolved binding overrides: slotId → routineId.
 * Merged at call site from project overrides + extensionPoint defaults.
 */
export type ProjectBindings = ReadonlyMap<string, string>;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Process-level cache: (workflowId + baseDir) → resolved bindings.
 *
 * Keyed by the composite `workflowId:baseDir` string so that:
 * - Different workflows in the same process each get their own entry.
 * - Tests that inject a different `baseDir` never share results with
 *   production calls that use `process.cwd()`.
 *
 * Populated lazily on the first `getProjectBindings` call for each key.
 * Mirrors the `_templateRegistryCache` pattern in workflow-compiler.ts.
 */
const _projectBindingsCache = new Map<string, ProjectBindings>();

/**
 * Return project-level binding overrides for a workflow, using a
 * process-level cache to avoid repeated filesystem reads.
 *
 * This is the preferred accessor — use `loadProjectBindings` only in tests
 * that need to bypass the cache (e.g. to test loading logic in isolation).
 */
export function getProjectBindings(workflowId: string, baseDir = process.cwd()): ProjectBindings {
  const key = `${workflowId}:${baseDir}`;
  const cached = _projectBindingsCache.get(key);
  if (cached !== undefined) return cached;
  const bindings = loadProjectBindings(workflowId, baseDir);
  _projectBindingsCache.set(key, bindings);
  return bindings;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load project-level binding overrides from .workrail/bindings.json.
 *
 * Returns an empty map if:
 * - The file does not exist (normal baseline — most users won't have this file)
 * - The file is a valid JSON object with no matching entries
 *
 * Warns (but does not fail) if:
 * - The file exists but cannot be parsed as JSON
 * - The file exists but has an unexpected structure
 *
 * The caller provides the workflow ID so that per-workflow sections
 * can be extracted from the file. Flat format (no workflow nesting) is
 * also supported as a fallback for simpler configurations.
 *
 * @param workflowId - ID of the workflow being compiled. Used to find the
 *   per-workflow section `{ "workflowId": { "slotId": "routineId" } }` in the file.
 * @param baseDir - Base directory to resolve `.workrail/bindings.json` from.
 *   Defaults to `process.cwd()`. Injected for testability.
 */
export function loadProjectBindings(workflowId: string, baseDir = process.cwd()): ProjectBindings {
  const filePath = join(baseDir, '.workrail', 'bindings.json');

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e: unknown) {
    // Missing file is the normal baseline — silent
    if (isNodeError(e) && e.code === 'ENOENT') {
      return new Map();
    }
    // Other I/O errors (permissions, etc.) — warn, return empty
    console.warn(`[WorkflowCompiler] Failed to read .workrail/bindings.json: ${String(e)}`);
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[WorkflowCompiler] .workrail/bindings.json is not valid JSON — ignoring`);
    return new Map();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[WorkflowCompiler] .workrail/bindings.json must be a JSON object — ignoring`);
    return new Map();
  }

  const obj = parsed as Record<string, unknown>;

  // Try per-workflow section first: { "workflowId": { "slotId": "routineId" } }
  const perWorkflow = obj[workflowId];
  if (perWorkflow !== undefined) {
    if (typeof perWorkflow === 'object' && !Array.isArray(perWorkflow) && perWorkflow !== null) {
      return extractStringMap(perWorkflow as Record<string, unknown>, `[${workflowId}]`);
    }
    console.warn(`[WorkflowCompiler] .workrail/bindings.json[${workflowId}] is not an object — ignoring`);
    return new Map();
  }

  // Fallback: flat format — every top-level value that is a string is a binding
  // (only if there are no nested objects, i.e. it's truly flat)
  const values = Object.values(obj);
  const allStrings = values.every(v => typeof v === 'string');
  if (allStrings && values.length > 0) {
    return extractStringMap(obj, 'root');
  }

  // No entries for this workflow
  return new Map();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractStringMap(
  obj: Record<string, unknown>,
  context: string,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string') {
      console.warn(
        `[WorkflowCompiler] .workrail/bindings.json ${context}.${key} is not a string — skipping`
      );
      continue;
    }
    result.set(key, value);
  }
  return result;
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}
