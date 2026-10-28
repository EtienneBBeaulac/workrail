import { V2StartWorkflowOutputSchema, V2ContinueWorkflowOutputSchema, type V2ExecutionOutput } from './output-schemas.js';
import type { V2ExecutionRenderEnvelope } from './render-envelope.js';
import { buildResponseSupplements } from './response-supplements.js';
import { ok, err, type Result } from 'neverthrow';

declare const validatedExecutionResponse: unique symbol;
export type ValidatedExecutionResponse = V2ExecutionOutput & {
  readonly [validatedExecutionResponse]: true;
};

/** Only schema-validated execution state can cross the structured publication boundary. */
export function validateExecutionResponse(
  response: V2ExecutionOutput,
): Result<ValidatedExecutionResponse, { readonly code: 'INVALID_EXECUTION_RESPONSE' }> {
  const schema = 'kind' in response ? V2ContinueWorkflowOutputSchema : V2StartWorkflowOutputSchema;
  if (!schema.safeParse(response).success) return err({ code: 'INVALID_EXECUTION_RESPONSE' });
  // Validation must not project away fields from the canonical public response.
  return ok(response as ValidatedExecutionResponse);
}

/** Delivery metadata augments the public state without rebuilding its pending step. */
export function buildExecutionResponse(
  envelope: V2ExecutionRenderEnvelope,
  cleanFormat: boolean,
): V2ExecutionOutput {
  const references = envelope.lifecycle === 'advance' ? undefined : envelope.contentEnvelope?.references;
  const supplements = [
    ...buildResponseSupplements({ lifecycle: envelope.lifecycle, cleanFormat }),
    ...(envelope.contentEnvelope?.supplements ?? []),
  ].sort((left, right) => left.order - right.order);

  return Object.freeze({
    ...envelope.response,
    ...(references != null && references.length > 0 ? { references } : {}),
    ...(supplements.length > 0 ? { supplements: Object.freeze(supplements) } : {}),
  });
}
