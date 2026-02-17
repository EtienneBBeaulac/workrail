/**
 * Golden token fixtures: regression tests for binary token encoding.
 *
 * Purpose:
 * - Verify token encoding remains stable across code changes
 * - Detect unintended changes to binary format
 * - Ensure cross-platform compatibility
 *
 * Note: Golden tokens are generated once and committed. If format changes,
 * regenerate fixtures via `npm run generate-golden-tokens`.
 *
 * @enforces binary-payload-deterministic
 * @enforces token-binary-wire-format
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { Bech32mAdapterV2 } from '../../../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../../../src/v2/infra/local/base32/index.js';
import { parseTokenV1Binary } from '../../../../src/v2/durable-core/tokens/token-codec.js';
import {
  packStateTokenPayload,
  packAckTokenPayload,
} from '../../../../src/v2/durable-core/tokens/binary-payload.js';
import type { StateTokenPayloadV1, AckTokenPayloadV1 } from '../../../../src/v2/durable-core/tokens/payloads.js';
import { asSessionId, asRunId, asNodeId, asAttemptId, asWorkflowHashRef } from '../../../../src/v2/durable-core/ids/index.js';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface GoldenTokenFixture {
  description: string;
  payload: StateTokenPayloadV1 | AckTokenPayloadV1;
  expectedPackedHex: string;
  expectedTokenPrefix: string;
}

function loadFixture(filename: string): GoldenTokenFixture {
  const content = fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
  return JSON.parse(content) as GoldenTokenFixture;
}

describe('Golden token fixtures (regression protection)', () => {
  describe('State tokens', () => {
    it('state-token-minimal: packing produces expected bytes', () => {
      const fixture = loadFixture('state-token-minimal.json');
      const base32 = new Base32AdapterV2();

      const packed = packStateTokenPayload(fixture.payload as StateTokenPayloadV1, base32);
      expect(packed.isOk()).toBe(true);
      if (packed.isErr()) return;

      const actualHex = Array.from(packed.value).map(b => b.toString(16).padStart(2, '0')).join('');
      expect(actualHex).toBe(fixture.expectedPackedHex);
    });

    it('state-token-varied-ids: different IDs produce different bytes', () => {
      const fixture = loadFixture('state-token-varied-ids.json');
      const base32 = new Base32AdapterV2();

      const packed = packStateTokenPayload(fixture.payload as StateTokenPayloadV1, base32);
      expect(packed.isOk()).toBe(true);
      if (packed.isErr()) return;

      const actualHex = Array.from(packed.value).map(b => b.toString(16).padStart(2, '0')).join('');
      expect(actualHex).toBe(fixture.expectedPackedHex);
    });
  });

  describe('Ack tokens', () => {
    it('ack-token-minimal: packing produces expected bytes', () => {
      const fixture = loadFixture('ack-token-minimal.json');
      const base32 = new Base32AdapterV2();

      const packed = packAckTokenPayload(fixture.payload as AckTokenPayloadV1, base32);
      expect(packed.isOk()).toBe(true);
      if (packed.isErr()) return;

      const actualHex = Array.from(packed.value).map(b => b.toString(16).padStart(2, '0')).join('');
      expect(actualHex).toBe(fixture.expectedPackedHex);
    });
  });

  describe('Token string stability', () => {
    it('detects changes to bech32m encoding', () => {
      // Golden token string (generated once, committed as baseline)
      const goldenToken = 'st1qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrvu4pvve7uwv22j23skxtzv3h45xv5wxwuaawl2n39dup0gup04qkhavgd';

      const base32 = new Base32AdapterV2();
      const bech32m = new Bech32mAdapterV2();
      // parseTokenV1Binary only needs bech32m and base32
      const parsed = parseTokenV1Binary(goldenToken, { bech32m, base32 });

      expect(parsed.isOk()).toBe(true);
      if (parsed.isErr()) {
        console.error('Golden token parse failed!');
        console.error(`Code: ${parsed.error.code}`);
        console.error(`Message: ${parsed.error.message}`);
        console.error('');
        console.error('This indicates the token encoding format has changed.');
        console.error('If this is intentional, regenerate golden fixtures:');
        console.error('  npm run generate-golden-tokens');
      }
    });
  });
});
