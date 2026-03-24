import { z } from 'zod';
import { JsonValueSchema } from '../../canonical/json-zod.js';

/**
 * Compiled workflow snapshot (schemaVersion 1).
 *
 * Lock: schemaVersion 1 is the canonical v2 pinned snapshot schema.
 * We use `sourceKind` to discriminate between:
 * - 'v1_preview': Slice 1 read-only preview (id/name/description/preview only; cannot be used for execution)
 * - 'v1_pinned': Slice 3+ full pinned v1 definition (executable; determinism anchor for v1-backed v2 execution)
 */
const CompiledWorkflowSnapshotV1PreviewSchema = z.object({
  schemaVersion: z.literal(1),
  sourceKind: z.literal('v1_preview'),
  workflowId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  // Minimal preview to support inspect_workflow without implementing execution.
  preview: z.object({
    stepId: z.string().min(1),
    title: z.string().min(1),
    prompt: z.string().min(1),
  }),
});

const CompiledWorkflowSnapshotV1PinnedSchema = z.object({
  schemaVersion: z.literal(1),
  sourceKind: z.literal('v1_pinned'),
  workflowId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  // The full v1 workflow definition as JSON-safe data.
  // This is the determinism anchor for v1-backed v2 execution.
  definition: JsonValueSchema,
  /**
   * Binding manifest frozen at start time: slotId → resolvedRoutineId.
   *
   * Captured during v1 compilation and stored alongside the definition so
   * that resume-time drift detection can compare what was active at session
   * start against what .workrail/bindings.json currently declares.
   *
   * Absent for workflows without extensionPoints (empty map = no bindings).
   * Optional for backward compatibility with snapshots produced before this field existed.
   *
   * Note on hashing: this field is included in the workflow hash (via
   * workflowHashForCompiledSnapshot). Two runs of the same workflow JSON
   * with different .workrail/bindings.json overrides will produce different
   * hashes and different pinned snapshots. This is intentional — different
   * bindings produce different compiled output and must be treated as distinct
   * determinism anchors.
   */
  resolvedBindings: z.record(z.string()).optional(),
  /**
   * Project-override subset of resolvedBindings: only slots sourced from
   * .workrail/bindings.json (not extensionPoint defaults).
   *
   * Used by drift detection at resume time so that override-removal is
   * correctly identified as drift. If a slot is absent here, it was compiled
   * from its extensionPoint default — `undefined` current override is not drift.
   *
   * Optional for backward compatibility with older snapshots.
   */
  pinnedOverrides: z.record(z.string()).optional(),
  /**
   * Reference resolution state frozen at start time.
   *
   * This preserves the exact reference status the session started with
   * (`resolved` vs `unresolved`, plus any absolute resolved path) so
   * rehydrate can replay the same truth without re-checking the filesystem.
   *
   * Included in the workflow hash intentionally: different reference
   * resolution outcomes produce different agent-visible context.
   *
   * Optional for backward compatibility with snapshots produced before
   * reference state was pinned.
   */
  resolvedReferences: z.array(z.discriminatedUnion('status', [
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      source: z.string().min(1),
      purpose: z.string().min(1),
      authoritative: z.boolean(),
      resolveFrom: z.enum(['workspace', 'package']),
      status: z.literal('resolved'),
      resolvedPath: z.string().min(1),
    }),
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      source: z.string().min(1),
      purpose: z.string().min(1),
      authoritative: z.boolean(),
      resolveFrom: z.enum(['workspace', 'package']),
      status: z.literal('unresolved'),
    }),
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      source: z.string().min(1),
      purpose: z.string().min(1),
      authoritative: z.boolean(),
      resolveFrom: z.enum(['workspace', 'package']),
      status: z.literal('pinned'),
    }),
  ])).optional(),
});

export const CompiledWorkflowSnapshotV1Schema = z.discriminatedUnion('sourceKind', [
  CompiledWorkflowSnapshotV1PreviewSchema,
  CompiledWorkflowSnapshotV1PinnedSchema,
]);

export type CompiledWorkflowSnapshotV1 = z.infer<typeof CompiledWorkflowSnapshotV1Schema>;

export const CompiledWorkflowSnapshotSchema = CompiledWorkflowSnapshotV1Schema;
export type CompiledWorkflowSnapshot = CompiledWorkflowSnapshotV1;
