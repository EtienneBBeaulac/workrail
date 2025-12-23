import { describe, it, expect } from 'vitest';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { workflowHashForCompiledSnapshot } from '../../../src/v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../../src/v2/durable-core/canonical/json-types.js';

describe('v2 workflowHash (Slice 1 golden)', () => {
  it('computes sha256(JCS(compiledSnapshotV1))', () => {
    const compiled: JsonValue = {
      description: 'Desc',
      name: 'My Workflow',
      preview: { prompt: 'Do thing', stepId: 's1', title: 'Step 1' },
      schemaVersion: 1,
      sourceKind: 'v1_shim',
      version: '1.0.0',
      workflowId: 'my-workflow',
    };

    const crypto = new NodeCryptoV2();
    const res = workflowHashForCompiledSnapshot(compiled, crypto);
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toBe(
      'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11'
    );
  });
});
