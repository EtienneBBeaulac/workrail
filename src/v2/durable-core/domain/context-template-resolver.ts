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

// Note: CONTEXT_TOKEN_RE_G (shared global `g`-flagged regex) was removed.
// A shared `g`-flagged regex is a correctness hazard: its `lastIndex` state
// persists across calls. Use a fresh instance inside resolveContextTemplates
// instead (see the comment on CONTEXT_TOKEN_PATTERN above).

// ---------------------------------------------------------------------------
// Dot-path resolution
// ---------------------------------------------------------------------------

/**
 * Result of walking a dot-separated path into a context value.
 *
 * WHY a discriminated union instead of returning undefined: the two failure
 * modes are categorically different and produce different diagnostic messages.
 * - missing_root: the first segment is absent from context entirely
 * - wrong_type: a non-terminal segment exists but is not an object, so the
 *   walk cannot continue (e.g. currentSlice is a string, not an object)
 * - leaf_missing: the walk succeeded through all non-terminal segments but
 *   the final key is absent or null on the parent object
 * - ok: the full path resolved to a defined, non-null value
 */
type DotPathResult =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'missing_root'; readonly rootKey: string }
  | {
      readonly kind: 'wrong_type';
      readonly failedAtKey: string;
      readonly actualType: string;
      readonly preview: string;
    }
  | { readonly kind: 'leaf_missing'; readonly fullPath: string };

/**
 * Walk a dot-separated path into a value, returning a typed result.
 *
 * Pure — no side effects.
 */
function resolveDotPath(base: unknown, path: readonly string[]): DotPathResult {
  if (path.length === 0) return { kind: 'ok', value: base };

  const rootKey = path[0]!;
  if (base === null || typeof base !== 'object') {
    return { kind: 'missing_root', rootKey };
  }

  const rootValue = (base as Record<string, unknown>)[rootKey];
  if (rootValue === undefined || rootValue === null) {
    return { kind: 'missing_root', rootKey };
  }

  let current: unknown = rootValue;
  for (let i = 1; i < path.length; i++) {
    const segment = path[i]!;
    if (current === null || typeof current !== 'object') {
      // Non-terminal segment is not an object -- report the type mismatch.
      const actualType = current === null ? 'null' : typeof current;
      const raw = String(current);
      const preview = raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
      return { kind: 'wrong_type', failedAtKey: path.slice(0, i).join('.'), actualType, preview };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (current === undefined || current === null) {
    return { kind: 'leaf_missing', fullPath: path.join('.') };
  }

  return { kind: 'ok', value: current };
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
 * - Unresolvable tokens become [unset: ...] — visible, non-silent, with a
 *   diagnostic reason so the author can immediately see why resolution failed:
 *   - missing root: [unset: currentSlice.name -- 'currentSlice' not in context]
 *   - wrong type:   [unset: currentSlice.name -- 'currentSlice' is string ("1: Auth..."), not object]
 *   - missing leaf: [unset: slice.title]
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

  // Construct a fresh `g`-flagged regex per call to avoid shared lastIndex state.
  const re = new RegExp(CONTEXT_TOKEN_PATTERN.source, 'g');
  return template.replace(re, (_match, dotPath: string) => {
    const segments = dotPath.split('.');
    const result = resolveDotPath(context, segments);

    switch (result.kind) {
      case 'ok':
        return String(result.value);

      case 'missing_root':
        // Simple case: variable not in context at all. Keep the original
        // [unset: path] format so existing tests and prompt patterns are stable.
        return `[unset: ${dotPath}]`;

      case 'wrong_type':
        // Actionable: tells the author/agent exactly what the value is and why
        // dot-path navigation failed. This is the key diagnostic improvement.
        return `[unset: ${dotPath} -- '${result.failedAtKey}' is ${result.actualType} ("${result.preview}"), not object]`;

      case 'leaf_missing':
        // Parent exists and is an object, but the final key is absent.
        // Same format as missing_root for backwards compat.
        return `[unset: ${dotPath}]`;
    }
  });
}
