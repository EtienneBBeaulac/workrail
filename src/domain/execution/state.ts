import { z } from 'zod';
import type { StepInstanceId } from './ids';

export interface LoopFrame {
  readonly loopId: string;
  readonly iteration: number; // 0-based
  readonly bodyIndex: number; // 0-based index into compiled body step list
}

export type ExecutionState =
  | { readonly kind: 'init' }
  | {
      readonly kind: 'running';
      readonly completed: readonly string[]; // StepInstanceKey[]
      readonly loopStack: readonly LoopFrame[];
      readonly pendingStep?: StepInstanceId; // If present, client must complete this next
    }
  | { readonly kind: 'complete' };

// -----------------------------
// Zod schemas (tool boundary)
// -----------------------------

export const LoopFrameSchema = z.object({
  loopId: z.string().min(1),
  iteration: z.number().int().min(0),
  bodyIndex: z.number().int().min(0),
});

export const StepInstanceIdSchema = z.object({
  stepId: z.string().min(1),
  loopPath: z.array(
    z.object({
      loopId: z.string().min(1),
      iteration: z.number().int().min(0),
    })
  ),
});

export const ExecutionStateSchema: z.ZodType<ExecutionState> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('init') }),
  z.object({
    kind: z.literal('running'),
    completed: z.array(z.string()),
    loopStack: z.array(LoopFrameSchema),
    pendingStep: StepInstanceIdSchema.optional(),
  }),
  z.object({ kind: z.literal('complete') }),
]);

export const initialExecutionState = (): ExecutionState => ({ kind: 'init' });
