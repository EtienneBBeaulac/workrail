import { z } from 'zod';
import { StepInstanceIdSchema } from './state';
import type { StepInstanceId } from './ids';

export type WorkflowEvent =
  | { readonly kind: 'step_completed'; readonly stepInstanceId: StepInstanceId };

export const WorkflowEventSchema: z.ZodType<WorkflowEvent> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('step_completed'),
    stepInstanceId: StepInstanceIdSchema,
  }),
]);
