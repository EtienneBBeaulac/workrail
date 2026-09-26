import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ReviewVerdictArtifactV1Schema } from '../v2/durable-core/schemas/artifacts/review-verdict.js';

export const NotesAnswerSchema = z.object({ notes: z.string().min(1) }).strict();
export const ReviewFieldsSchema = NotesAnswerSchema.extend(
  ReviewVerdictArtifactV1Schema.omit({ kind: true }).shape,
).strict();
export const ReviewFragmentSchema = ReviewFieldsSchema.partial();
export const reviewFields = ReviewFieldsSchema.keyof().options;
export const minimumReviewFields = 1;

function schema(value: z.ZodTypeAny) {
  return zodToJsonSchema(value, { $refStrategy: 'none' });
}

/** Guidance describes the answer value, never the reply capability or tool envelope.
 * Transport remains permissive so domain rejections can be retained as evidence. */
export function answerFormat(kind: 'notes' | 'review') {
  if (kind === 'notes') return {
    kind: 'notes' as const,
    instructions: 'Set answer to an object with a nonempty notes string. The example illustrates formatting only; replace it with your actual evidence.',
    schema: schema(NotesAnswerSchema),
    example: { notes: 'Describe the work performed and evidence observed here.' } satisfies z.infer<typeof NotesAnswerSchema>,
  } as const;
  return {
    kind: 'review' as const,
    instructions: 'Set answer to an object with one or more review fields. Valid partial answers are retained; all completionFields are needed to finish. To replace a retained value, repeat the proposed replacement on the next reply after the correction question. The example is fictional formatting guidance; supply your actual review, not these conclusions.',
    // JSON Schema cannot represent Zod refinements; share the minimum with the decoder.
    schema: { ...schema(ReviewFragmentSchema), minProperties: minimumReviewFields },
    completionFields: [...reviewFields],
    example: {
      notes: 'Example only: inspected an input validation path.',
      verdict: 'minor', confidence: 'low',
      findings: [{ severity: 'minor', summary: 'Example only: an input error needs a clearer explanation.' }],
      summary: 'Example only: a small improvement was identified.',
    } satisfies z.infer<typeof ReviewFieldsSchema>,
  } as const;
}
export type AnswerFormat = ReturnType<typeof answerFormat>;
