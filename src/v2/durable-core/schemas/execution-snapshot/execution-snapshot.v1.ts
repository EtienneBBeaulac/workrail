import { z } from 'zod';
import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { Brand } from '../../../../runtime/brand.js';
import {
  DelimiterSafeIdV1Schema,
  StepInstanceKeyV1Schema,
  stepInstanceKeyFromParts,
  type DelimiterSafeIdV1,
  type LoopPathFrameV1,
  type StepInstanceKeyV1,
} from './step-instance-key.js';

export type ExecutionSnapshotFileV1 = z.infer<typeof ExecutionSnapshotFileV1Schema>;

/**
 * Set wrapper for completed step instances (locked):
 * - explicit wrapper (not raw array)
 * - lexicographically sorted
 * - unique
 */
const CompletedStepInstancesV1Schema = z
  .object({
    kind: z.literal('set'),
    values: z.array(StepInstanceKeyV1Schema),
  })
  .strict()
  .superRefine((v, ctx) => {
    // enforce sorted + unique
    for (let i = 1; i < v.values.length; i++) {
      if (String(v.values[i]!).localeCompare(String(v.values[i - 1]!)) < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Completed step instances must be sorted lexicographically by key',
          path: ['values'],
        });
        break;
      }
    }
    const set = new Set(v.values.map(String));
    if (set.size !== v.values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed step instances must be unique', path: ['values'] });
    }
  });

export type CompletedStepInstancesV1 = z.infer<typeof CompletedStepInstancesV1Schema>;

export interface LoopFrameV1 {
  readonly loopId: DelimiterSafeIdV1;
  readonly iteration: number;
  readonly bodyIndex: number;
}

export const LoopFrameV1Schema = z.object({
  loopId: DelimiterSafeIdV1Schema,
  iteration: z.number().int().nonnegative(),
  bodyIndex: z.number().int().nonnegative(),
}).strict();

export const LoopPathFrameV1Schema = z.object({
  loopId: DelimiterSafeIdV1Schema,
  iteration: z.number().int().nonnegative(),
}).strict();

export type PendingStepV1 = z.infer<typeof PendingStepV1Schema>;

export const PendingStepV1Schema = z.object({
  stepId: DelimiterSafeIdV1Schema,
  loopPath: z.array(LoopPathFrameV1Schema),
}).strict();

export const PendingV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('some'), step: PendingStepV1Schema }).strict(),
]);

export type PendingV1 = z.infer<typeof PendingV1Schema>;

export type EngineStateV1 = z.infer<typeof EngineStateV1Schema>;

const EngineStateInitV1Schema = z.object({ kind: z.literal('init') }).strict();

const EngineStateRunningV1Schema = z.object({
  kind: z.literal('running'),
  completed: CompletedStepInstancesV1Schema,
  loopStack: z.array(LoopFrameV1Schema),
  pending: PendingV1Schema,
}).strict();

const EngineStateCompleteV1Schema = z.object({ kind: z.literal('complete') }).strict();

export const EngineStateV1Schema = z
  .discriminatedUnion('kind', [EngineStateInitV1Schema, EngineStateRunningV1Schema, EngineStateCompleteV1Schema])
  .superRefine((s, ctx) => {
    if (s.kind !== 'running') return;

    // Lock: loop IDs unique within loopStack.
    const seen = new Set<string>();
    for (const f of s.loopStack) {
      const id = String(f.loopId);
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `loopStack must not contain the same loopId twice: ${id}`,
          path: ['loopStack'],
        });
        break;
      }
      seen.add(id);
    }

    if (s.pending.kind !== 'some') return;

    // Lock: pending.loopPath must match loopStack.map(loopId, iteration).
    const expected = s.loopStack.map((f) => ({ loopId: f.loopId, iteration: f.iteration }));
    const actual = s.pending.step.loopPath;
    const sameLength = expected.length === actual.length;
    const sameEntries =
      sameLength &&
      expected.every((e, i) => String(e.loopId) === String(actual[i]!.loopId) && e.iteration === actual[i]!.iteration);

    if (!sameEntries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pending.step.loopPath must exactly match loopStack (loopId + iteration)',
        path: ['pending', 'step', 'loopPath'],
      });
      return;
    }

    // Lock: when pending.kind=some, the pending StepInstanceKey must NOT be present in completed.
    const pendingKey = stepInstanceKeyFromParts(s.pending.step.stepId, s.pending.step.loopPath as readonly LoopPathFrameV1[]);
    const completed = new Set(s.completed.values.map(String));
    if (completed.has(String(pendingKey))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Impossible state: pending step instance is already in completed set',
        path: ['pending'],
      });
    }
  });

export type EnginePayloadV1 = z.infer<typeof EnginePayloadV1Schema>;

export const EnginePayloadV1Schema = z.object({
  v: z.literal(1),
  engineState: EngineStateV1Schema,
}).strict();

/**
 * Execution snapshot file stored in CAS and referenced by `node_created.data.snapshotRef`.
 *
 * Locked intent:
 * - versioned outer envelope
 * - JSON-only (JCS canonicalizable)
 * - contains enough engine payload to rehydrate deterministically
 */
export const ExecutionSnapshotFileV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('execution_snapshot'),
  enginePayload: EnginePayloadV1Schema,
}).strict();

/**
 * A minimal branded type for an execution snapshot ref (sha256:*), used by CAS and events.
 * This is intentionally separate from Session snapshot pins (which also use SnapshotRef).
 */
export type SnapshotRefV1 = Brand<string, 'v2.SnapshotRefV1'>;

export type SnapshotHashErrorV1 =
  | { readonly code: 'SNAPSHOT_HASH_CANONICALIZE_FAILED'; readonly message: string }
  | { readonly code: 'SNAPSHOT_HASH_UNSUPPORTED'; readonly message: string };

/**
 * Deterministic ordering check helper for completed sets.
 * (Pure; useful for tests and future reducers.)
 */
export function isSortedLex(values: readonly StepInstanceKeyV1[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (String(values[i]!).localeCompare(String(values[i - 1]!)) < 0) return false;
  }
  return true;
}

export type CompletedSetBuildErrorV1 = { readonly code: 'COMPLETED_SET_UNSORTED'; readonly message: string };

export function completedSetFromSorted(values: readonly StepInstanceKeyV1[]): Result<CompletedStepInstancesV1, CompletedSetBuildErrorV1> {
  if (!isSortedLex(values)) {
    return err({ code: 'COMPLETED_SET_UNSORTED', message: 'values must already be sorted lexicographically' });
  }
  return ok({ kind: 'set', values: [...values] });
}
