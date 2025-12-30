import { InvalidWorkflowError } from '../core/error-handler';
import type { WorkflowSourceKind } from '../types/workflow-source';

// Lock: pattern per segment is [a-z][a-z0-9_-]* (lowercase only).
// docs/design/v2-core-design-locks.md:1205
const NAMESPACED_SEGMENT_RE = /^[a-z][a-z0-9_-]*$/;
const LEGACY_ID_RE = /^[a-z0-9_-]+$/;

export type WorkflowIdParse =
  | { readonly kind: 'legacy'; readonly raw: string }
  | { readonly kind: 'namespaced'; readonly raw: string; readonly namespace: string; readonly name: string };

export interface WorkflowIdLoadValidation {
  readonly parsed: WorkflowIdParse;
  readonly warnings: readonly string[];
}

export function parseWorkflowId(raw: string): WorkflowIdParse | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  if (!raw.includes('.')) {
    if (!LEGACY_ID_RE.test(raw)) return null;
    return { kind: 'legacy', raw };
  }

  const parts = raw.split('.');
  if (parts.length !== 2) return null;

  const [namespace, name] = parts;
  if (!namespace || !name) return null;
  if (!NAMESPACED_SEGMENT_RE.test(namespace)) return null;
  if (!NAMESPACED_SEGMENT_RE.test(name)) return null;

  return { kind: 'namespaced', raw, namespace, name };
}

export function validateWorkflowIdForLoad(raw: string, sourceKind: WorkflowSourceKind): WorkflowIdLoadValidation {
  const parsed = parseWorkflowId(raw);
  if (!parsed) {
    throw new InvalidWorkflowError(raw || 'unknown', 'Invalid workflow id format');
  }

  // Locked: legacy IDs remain runnable; warn-only.
  if (parsed.kind === 'legacy') {
    return {
      parsed,
      warnings: ['legacy_workflow_id'],
    };
  }

  // Locked: wr.* is reserved for bundled/core.
  if (parsed.namespace === 'wr' && sourceKind !== 'bundled') {
    throw new InvalidWorkflowError(
      parsed.raw,
      `Reserved workflow namespace 'wr.*' is only allowed for bundled workflows (sourceKind=${sourceKind})`
    );
  }

  return { parsed, warnings: [] };
}

export function validateWorkflowIdForSave(raw: string, sourceKind: WorkflowSourceKind): WorkflowIdParse {
  const parsed = parseWorkflowId(raw);
  if (!parsed) {
    throw new InvalidWorkflowError(raw || 'unknown', 'Invalid workflow id format');
  }

  // Locked: creating/saving new workflows with legacy IDs is rejected.
  if (parsed.kind === 'legacy') {
    throw new InvalidWorkflowError(
      parsed.raw,
      "Legacy workflow ids (no dot) are no longer allowed for new workflows; use 'namespace.name'"
    );
  }

  // Locked: wr.* reserved.
  if (parsed.namespace === 'wr' && sourceKind !== 'bundled') {
    throw new InvalidWorkflowError(
      parsed.raw,
      `Reserved workflow namespace 'wr.*' is only allowed for bundled workflows (sourceKind=${sourceKind})`
    );
  }

  return parsed;
}
