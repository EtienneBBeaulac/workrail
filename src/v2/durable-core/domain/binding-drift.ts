/**
 * Binding Drift Detection
 *
 * Compares the binding manifest frozen into a pinned snapshot at session-start
 * time against the current project bindings from .workrail/bindings.json.
 *
 * Drift = any slot whose resolved value differs between the two snapshots.
 *
 * Why this exists: bindings are resolved at compile time and frozen into the
 * workflow hash. If the user changes .workrail/bindings.json mid-session, the
 * active session is still using the original compiled values. This function
 * surfaces that discrepancy as informational warnings rather than failing hard.
 *
 * Pure function — no I/O, no mutation, no side effects.
 */

/**
 * A single binding drift warning.
 * Defined here (domain layer) and re-exported from the MCP output-schemas
 * to avoid a layering violation (durable-core must not import from mcp/).
 *
 * `message` is intentionally absent — it is presentation data derivable from
 * the other fields. Callers that need a human-readable string should use
 * `formatDriftWarning(w)` rather than embedding the message in the value.
 * This keeps the domain type free of display coupling.
 */
export interface BindingDriftWarning {
  readonly code: 'BINDING_DRIFT';
  readonly slotId: string;
  readonly pinnedValue: string;
  readonly currentValue: string;
}

/**
 * Format a BindingDriftWarning as a human-readable string.
 *
 * Separated from the type so the domain layer stays display-agnostic.
 * Use this at the serialization/presentation boundary (response formatter,
 * structured logs) rather than at detection time.
 */
export function formatDriftWarning(w: BindingDriftWarning): string {
  if (w.currentValue === 'default') {
    // Override was removed — slot now falls back to the extensionPoint default
    return (
      `Binding '${w.slotId}' was removed from .workrail/bindings.json since this session started. ` +
      `Session uses '${w.pinnedValue}' (project override at start); ` +
      `it now falls back to the workflow default. ` +
      `Start a new session to pick up the change.`
    );
  }
  return (
    `Binding '${w.slotId}' changed since this session started. ` +
    `Session uses '${w.pinnedValue}' (compiled at start); ` +
    `current .workrail/bindings.json specifies '${w.currentValue}'. ` +
    `Start a new session to pick up the updated binding.`
  );
}

/**
 * Detect binding drift between what was frozen at session start and what is
 * currently active in the project.
 *
 * `pinnedOverrides` contains ONLY slots that were sourced from project overrides
 * at compile time (not extensionPoint defaults). This is the right comparison set
 * because:
 * - Changed override (currentValue !== pinnedValue) → drift
 * - Removed override (currentValue === undefined) → drift; the slot now resolves
 *   to its extensionPoint default, which may differ from the compiled value
 *
 * Slots absent from `pinnedOverrides` were compiled from their workflow default —
 * if they have no current project override, that is not drift (same source, same value).
 *
 * @param pinnedOverrides - project-override slots only from the compiled snapshot
 * @param currentBindings - current project overrides from .workrail/bindings.json
 * @returns Array of drift warnings (empty = no drift)
 */
export function detectBindingDrift(
  pinnedOverrides: Readonly<Record<string, string>>,
  currentBindings: ReadonlyMap<string, string>,
): readonly BindingDriftWarning[] {
  const warnings: BindingDriftWarning[] = [];

  for (const [slotId, pinnedValue] of Object.entries(pinnedOverrides)) {
    const currentValue = currentBindings.get(slotId);
    if (currentValue === undefined) {
      // Override was removed — slot now falls back to extensionPoint default.
      // This is real drift: the compiled session used a project override, but
      // the current project does not have one. Use 'default' as the sentinel
      // current value so callers can render an informative message.
      warnings.push({ code: 'BINDING_DRIFT', slotId, pinnedValue, currentValue: 'default' });
    } else if (currentValue !== pinnedValue) {
      // Override changed to a different value.
      warnings.push({ code: 'BINDING_DRIFT', slotId, pinnedValue, currentValue });
    }
  }

  return warnings;
}
