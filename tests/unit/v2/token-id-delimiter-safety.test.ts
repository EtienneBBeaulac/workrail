import { describe, it, expect } from 'vitest';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { parseTokenV1 } from '../../../src/v2/durable-core/tokens/index.js';

describe('v2 token payload delimiter safety', () => {
  it('rejects token payloads with ids containing ":"', () => {
    const base64url = new NodeBase64UrlV2();

    const payload = {
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: 'sess:bad',
      runId: 'run_1',
      nodeId: 'node_1',
      workflowHash: 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2',
    };

    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const payloadB64 = base64url.encodeBase64Url(bytes);

    const token = `st1invalid${payloadB64}aa`;

    const parsed = parseTokenV1(token, base64url);
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error.code).toBe('TOKEN_INVALID_FORMAT');
    }
  });
});
