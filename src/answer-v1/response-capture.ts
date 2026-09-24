import { z } from 'zod';

const ToolCall = z.object({
  id: z.string(), name: z.string(), argumentsJson: z.string(),
}).strict().readonly();

/** Preserve raw arguments, including malformed JSON, until answer preparation. */
const ResponsePayload = z.object({
  providerResponseId: z.string().optional(),
  responseText: z.string(),
  calls: z.array(ToolCall).readonly(),
}).strict().readonly().brand<'ResponsePayload'>();

export type ResponsePayload = z.infer<typeof ResponsePayload>;
export const CapturePolicy = z.object({ maxBytes: z.number().int().positive().safe() }).strict().readonly().brand<'CapturePolicy'>();
export type CapturePolicy = z.infer<typeof CapturePolicy>;

export type DecodeResponseResult =
  | { readonly kind: 'decoded'; readonly payload: ResponsePayload }
  | { readonly kind: 'refused'; readonly reason: 'invalid_payload' | 'duplicate_tool_call_ids' | 'payload_too_large' };

/** Called at the provider boundary; Zod copies and freezes every nested mutable value. */
export function decodeResponse(input: unknown, policy: CapturePolicy): DecodeResponseResult {
  const parsed = ResponsePayload.safeParse(input);
  if (!parsed.success) return { kind: 'refused', reason: 'invalid_payload' };
  const payload = parsed.data;
  if (new Set(payload.calls.map(call => call.id)).size !== payload.calls.length) {
    return { kind: 'refused', reason: 'duplicate_tool_call_ids' };
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > policy.maxBytes) {
    return { kind: 'refused', reason: 'payload_too_large' };
  }
  return { kind: 'decoded', payload };
}

export type CaptureSlot =
  | { readonly kind: 'empty' }
  | { readonly kind: 'captured'; readonly payload: ResponsePayload };

export type CaptureDecision =
  | { readonly kind: 'append'; readonly payload: ResponsePayload }
  | { readonly kind: 'replay'; readonly payload: ResponsePayload }
  | { readonly kind: 'refused'; readonly reason: 'conflict' };

/** A store dedupe-key match cannot establish equality of raw model responses.
 * The host must call this against lock-held truth, before choosing append or replay.
 * This pure decision grants no authority and does not perform a durable capture.
 */
export function decideCapture(slot: CaptureSlot, candidate: ResponsePayload): CaptureDecision {
  if (slot.kind === 'empty') return { kind: 'append', payload: candidate };
  const prior = slot.payload;
  const same = prior.providerResponseId === candidate.providerResponseId
    && prior.responseText === candidate.responseText
    && prior.calls.length === candidate.calls.length
    && prior.calls.every((call, index) => {
      const other = candidate.calls[index]!;
      return call.id === other.id && call.name === other.name && call.argumentsJson === other.argumentsJson;
    });
  return same ? { kind: 'replay', payload: prior } : { kind: 'refused', reason: 'conflict' };
}
