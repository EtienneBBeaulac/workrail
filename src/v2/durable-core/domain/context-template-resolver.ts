/**
 * Context Template Resolver — render-time {{varName}} substitution.
 *
 * Resolves Mustache-style {{varName}} and {{varName.path.deep}} tokens in
 * step prompt strings against a runtime context object.
 *
 * Why render-time (not compile-time):
 * Context values (rigorMode, slices, currentSlice, etc.) are only known at
 * step execution — they come from agent-submitted context_set events and from
 * loop iteration state. Compile-time resolution would require materializing all
 * possible context combinations, which is not feasible.
 *
 * Token syntax: {{identifier}} or {{identifier.path.deep}}
 * - Intentionally avoids the {{wr.*}} namespace, which is owned by the compiler
 *   pipeline (bindings, refs). The sentinel scan is unaffected.
 * - Tokens that resolve to undefined produce a visible [unset: varName] marker
 *   rather than an empty string — this makes authoring errors immediately
 *   visible in the rendered prompt.
 *
 * Pure function — no I/O, no mutation.
 */

// ---------------------------------------------------------------------------
// Token pattern
// ---------------------------------------------------------------------------

/**
 * Pattern source for context template tokens — valid identifier dot-paths only.
 *
 * Matches {{identifier}} and {{identifier.path.deep}} but NOT expressions like
 * {{x + 1}} or {{fn()}} — those are left as-is so workflow templates that contain
 * non-evaluable expressions are not corrupted.
 *
 * Also excludes the {{wr.*}} namespace (owned by the compiler pipeline).
 * Capture group 1: the dot-path string (e.g. "currentSlice.name").
 *
 * Exported as a source string (not a live regex) so callers construct their own
 * instance with the appropriate flags — avoids the stateful `lastIndex` trap that
 * a shared `g`-flagged regex creates. Mirrors BINDING_TOKEN_RE's convention.
 */
export const CONTEXT_TOKEN_PATTERN = /\{\{(?!wr\.)([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\}\}/;

/** @internal Used only by resolveContextTemplates — owns the `g` flag lifecycle. */
const CONTEXT_TOKEN_RE_G = new RegExp(CONTEXT_TOKEN_PATTERN.source, 'g');

// ---------------------------------------------------------------------------
// Dot-path resolution
// ---------------------------------------------------------------------------

/**
 * Walk a dot-separated path into a value.
 *
 * Returns undefined if any segment is missing or the base value is not an object.
 * Pure — no side effects.
 */
function resolveDotPath(base: unknown, path: readonly string[]): unknown {
  let current: unknown = base;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve all {{varName}} and {{varName.path.deep}} tokens in a template string.
 *
 * Resolution:
 * - Splits token path on '.' and walks into `context` using dot-path resolution
 * - Tokens that resolve to a defined, non-null value are replaced with String(value)
 * - Unresolvable tokens become [unset: varName.path] — visible, non-silent
 *
 * Tokens in the {{wr.*}} namespace are left untouched (owned by the compiler).
 *
 * Pure function — no I/O, no mutation. Safe to call with empty context.
 */
export function resolveContextTemplates(
  template: string,
  context: Record<string, unknown>,
): string {
  // Fast path: no tokens present
  if (!template.includes('{{')) return template;

  return template.replace(CONTEXT_TOKEN_RE_G, (_match, dotPath: string) => {
    const value = resolveDotPath(context, dotPath.split('.'));

    if (value === undefined || value === null) {
      return `[unset: ${dotPath}]`;
    }

    return String(value);
  });
}
