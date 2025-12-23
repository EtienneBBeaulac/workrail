import { z } from 'zod';
import type { Brand } from '../../../../runtime/brand.js';
import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';

/**
 * Delimiter-safe identifiers (locked for execution state).
 *
 * Lock: `[a-z0-9_-]+` and explicitly disallow `@`, `/`, `:`.
 */
export type DelimiterSafeIdV1 = Brand<string, 'v2.DelimiterSafeIdV1'>;

export function asDelimiterSafeIdV1(value: string): DelimiterSafeIdV1 {
  return value as DelimiterSafeIdV1;
}

export const DelimiterSafeIdV1Schema = z
  .string()
  .regex(/^[a-z0-9_-]+$/, 'Expected delimiter-safe id: [a-z0-9_-]+')
  .transform(asDelimiterSafeIdV1);

/**
 * StepInstanceKey canonical format (locked).
 *
 * - If `loopPath` is empty: `stepId`
 * - Else: `(loopId@iteration joined by "/") + "::" + stepId`
 *
 * Example: `outer@0/inner@2::triage`
 */
export type StepInstanceKeyV1 = Brand<string, 'v2.StepInstanceKeyV1'>;

export interface LoopPathFrameV1 {
  readonly loopId: DelimiterSafeIdV1;
  readonly iteration: number;
}

export type StepInstanceKeyParseErrorV1 =
  | { readonly code: 'STEP_INSTANCE_KEY_EMPTY'; readonly message: string }
  | { readonly code: 'STEP_INSTANCE_KEY_BAD_FORMAT'; readonly message: string };

function asStepInstanceKeyV1(value: string): StepInstanceKeyV1 {
  return value as StepInstanceKeyV1;
}

export function stepInstanceKeyFromParts(stepId: DelimiterSafeIdV1, loopPath: readonly LoopPathFrameV1[]): StepInstanceKeyV1 {
  if (loopPath.length === 0) return asStepInstanceKeyV1(stepId);
  const prefix = loopPath.map((f) => `${f.loopId}@${f.iteration}`).join('/');
  return asStepInstanceKeyV1(`${prefix}::${stepId}`);
}

export function parseStepInstanceKeyV1(raw: string): Result<StepInstanceKeyV1, StepInstanceKeyParseErrorV1> {
  if (raw.trim() === '') return err({ code: 'STEP_INSTANCE_KEY_EMPTY', message: 'StepInstanceKey must be non-empty' });

  // Either: stepId, or: <loopPath>::<stepId>
  const parts = raw.split('::');
  if (parts.length === 1) {
    const stepId = parts[0]!;
    if (!/^[a-z0-9_-]+$/.test(stepId)) {
      return err({ code: 'STEP_INSTANCE_KEY_BAD_FORMAT', message: 'Invalid stepId segment' });
    }
    return ok(asStepInstanceKeyV1(stepId));
  }
  if (parts.length !== 2) {
    return err({ code: 'STEP_INSTANCE_KEY_BAD_FORMAT', message: 'Expected at most one "::" separator' });
  }

  const [loopPathRaw, stepId] = parts as [string, string];
  if (!/^[a-z0-9_-]+$/.test(stepId)) {
    return err({ code: 'STEP_INSTANCE_KEY_BAD_FORMAT', message: 'Invalid stepId segment' });
  }

  const frames = loopPathRaw.split('/');
  if (frames.length === 0) return err({ code: 'STEP_INSTANCE_KEY_BAD_FORMAT', message: 'Empty loopPath segment' });

  for (const f of frames) {
    const seg = f.split('@');
    if (seg.length !== 2) return err({ code: 'STEP_INSTANCE_KEY_BAD_FORMAT', message: 'loopPath frame must be loopId@iteration' });
    const [loopId, it] = seg as [string, string];
    if (!/^[a-z0-9_-]+$/.test(loopId)) return err({ code: 'STEP_INSTANCE_KEY_BAD_FORMAT', message: 'Invalid loopId segment' });
    if (!/^\d+$/.test(it)) return err({ code: 'STEP_INSTANCE_KEY_BAD_FORMAT', message: 'Invalid iteration segment' });
  }

  return ok(asStepInstanceKeyV1(raw));
}

export const StepInstanceKeyV1Schema = z
  .string()
  .min(1)
  .superRefine((v, ctx) => {
    const parsed = parseStepInstanceKeyV1(v);
    if (parsed.isErr()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error.message });
    }
  })
  .transform(asStepInstanceKeyV1);
