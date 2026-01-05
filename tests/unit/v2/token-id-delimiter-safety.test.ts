import { describe, it, expect } from 'vitest';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { packStateTokenPayload } from '../../../src/v2/durable-core/tokens/binary-payload.js';
import { StateTokenPayloadV1Schema } from '../../../src/v2/durable-core/tokens/payloads.js';

describe('v2 token payload delimiter safety', () => {
  it('rejects token payloads with IDs containing ":"', () => {
    // Zod schema validates ID format and rejects delimiter characters
    expect(() => {
      StateTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'state',
        sessionId: 'sess:bad', // Invalid: contains delimiter ":"
        runId: 'run_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        nodeId: 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        workflowHashRef: 'wf_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
    }).toThrow(); // Zod validation error
  });
});
