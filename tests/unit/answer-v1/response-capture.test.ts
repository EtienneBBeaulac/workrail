import { describe, expect, it } from 'vitest';
import { CapturePolicy, decideCapture, decodeResponse, type ResponsePayload } from '../../../src/answer-v1/response-capture.js';

const policy = CapturePolicy.parse({ maxBytes: 4096 });
const raw = () => ({ providerResponseId: 'r1', responseText: 'observed', calls: [
  { id: 'c1', name: 'answer', argumentsJson: '{invalid json retained' },
  { id: 'c2', name: 'inspect', argumentsJson: '{"path":"a"}' },
] });
function decode(value: unknown): ResponsePayload {
  const result = decodeResponse(value, policy);
  if (result.kind !== 'decoded') throw new Error(result.reason);
  return result.payload;
}

describe('immutable raw response capture decisions', () => {
  it('retains the entire original response before selecting any tool call', () => {
    const input = raw();
    const captured = decode(input);
    expect(captured).toEqual(input);
    input.calls[0]!.argumentsJson = 'changed';
    input.calls.push({ id: 'c3', name: 'answer', argumentsJson: '{}' });
    expect(captured.calls).toHaveLength(2);
    expect(captured.calls[0]!.argumentsJson).toBe('{invalid json retained');
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.calls)).toBe(true);
    expect(Object.isFrozen(captured.calls[0])).toBe(true);
    expect(decideCapture({ kind: 'empty' }, captured)).toEqual({ kind: 'append', payload: captured });
  });
  it('replays the original payload after object reconstruction', () => {
    const original = decode(raw());
    const reconstructed = decode(JSON.parse(JSON.stringify(raw())));
    const decision = decideCapture({ kind: 'captured', payload: original }, reconstructed);
    expect(decision.kind).toBe('replay');
    if (decision.kind === 'replay') expect(decision.payload).toBe(original);
  });
  it.each(['provider', 'text', 'id', 'name', 'arguments', 'order', 'count'] as const)(
    'refuses changed %s while retaining the original and allowing exact replay', field => {
      const original = decode(raw());
      const changed = raw();
      switch (field) {
        case 'provider': changed.providerResponseId = 'r2'; break;
        case 'text': changed.responseText = 'changed'; break;
        case 'id': changed.calls[0]!.id = 'other'; break;
        case 'name': changed.calls[0]!.name = 'other'; break;
        case 'arguments': changed.calls[0]!.argumentsJson = '{}'; break;
        case 'order': changed.calls.reverse(); break;
        case 'count': changed.calls.pop(); break;
      }
      const slot = { kind: 'captured' as const, payload: original };
      expect(decideCapture(slot, decode(changed))).toEqual({ kind: 'refused', reason: 'conflict' });
      expect(slot.payload).toEqual(raw());
      expect(decideCapture(slot, decode(raw())).kind).toBe('replay');
    },
  );
  it('preserves omitted provider identity and refuses identity changes', () => {
    const missing = decode({ responseText: 'observed', calls: [] });
    const slot = { kind: 'captured' as const, payload: missing };
    expect(decideCapture(slot, decode({ calls: [], responseText: 'observed' })).kind).toBe('replay');
    const identified = decode({ providerResponseId: '', responseText: 'observed', calls: [] });
    expect(decideCapture(slot, identified)).toEqual({ kind: 'refused', reason: 'conflict' });
    expect(decideCapture({ kind: 'captured', payload: identified }, missing)).toEqual({ kind: 'refused', reason: 'conflict' });
  });
  it('prevents runtime mutation of captured nested values', () => {
    const captured = decode(raw());
    expect(Reflect.set(captured, 'responseText', 'changed')).toBe(false);
    expect(Reflect.set(captured.calls[0]!, 'argumentsJson', 'changed')).toBe(false);
    expect(Reflect.set(captured.calls, '2', captured.calls[0])).toBe(false);
    expect(captured).toEqual(raw());
  });
  it('counts UTF-8 and JSON escaping throughout tool calls', () => {
    const input = { responseText: '', calls: [{ id: 'é', name: '答', argumentsJson: '{"value":"😀"}' }] };
    const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
    expect(decodeResponse(input, CapturePolicy.parse({ maxBytes: bytes })).kind).toBe('decoded');
    expect(decodeResponse(input, CapturePolicy.parse({ maxBytes: bytes - 1 }))).toEqual({ kind: 'refused', reason: 'payload_too_large' });
  });
  it('refuses duplicate ids even when the calls are otherwise identical', () => {
    const input = raw(); input.calls[1] = { ...input.calls[0]! };
    expect(decodeResponse(input, policy)).toEqual({ kind: 'refused', reason: 'duplicate_tool_call_ids' });
  });
  it.each([null, {}, { ...raw(), extra: true }, { ...raw(), calls: [{ id: 2 }] }])(
    'refuses malformed or unrecognized payloads without dropping data', input => {
      expect(decodeResponse(input, policy)).toEqual({ kind: 'refused', reason: 'invalid_payload' });
    },
  );
  it('measures serialized UTF-8 bytes and admits the exact boundary', () => {
    const input = { responseText: 'é', calls: [] };
    const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
    expect(decodeResponse(input, CapturePolicy.parse({ maxBytes: bytes })).kind).toBe('decoded');
    expect(decodeResponse(input, CapturePolicy.parse({ maxBytes: bytes - 1 }))).toEqual({ kind: 'refused', reason: 'payload_too_large' });
  });
});
