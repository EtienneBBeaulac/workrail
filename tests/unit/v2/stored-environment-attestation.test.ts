import { describe, it, expect } from 'vitest';
import { parseStoredEnvironmentAttestation } from '../../../src/mcp/handlers/v2-execution/stored-environment-attestation.js';
import { parseEAT, signEAT, unsafeTokenCodecPorts } from '../../../src/v2/durable-core/tokens/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
const ports = unsafeTokenCodecPorts({ keyring: { current: { keyId: 'k1',
  keyBase64Url: 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z6' } },
  hmac: new NodeHmacSha256V2(), base64url: new NodeBase64UrlV2(),
  base32: new Base32AdapterV2(), bech32m: new Bech32mAdapterV2() });
const payload = { harness: 'mcp', activeModel: 'historical-report', spawnDepth: 2,
  sessionId: 'sess_fixture', parentSessionId: 'sess_parent' };
const signed = signEAT(payload, ports);
if (!signed.ok) throw new Error('Signing fixture failed');
const signature = signed.value;
describe('stored environment attestation compatibility', () => {
  it('verifies both canonical and historical forms without broadening the public parser', () => {
    const canonical = JSON.stringify({ payload, signature });
    const historical = JSON.stringify({ payload, signature: { ok: true, value: signature } });
    expect(parseStoredEnvironmentAttestation(canonical, ports, 'sess_fixture')).toEqual({ ok: true,
      value: { payload, signature, historicalWrapper: false, verificationKey: 'current' } });
    expect(parseStoredEnvironmentAttestation(historical, ports, 'sess_fixture')).toEqual({ ok: true,
      value: { payload, signature, historicalWrapper: true, verificationKey: 'current' } });
    expect(parseEAT(historical, ports, 'sess_fixture').ok).toBe(false);
    expect(parseStoredEnvironmentAttestation(historical, ports, 'sess_other')).toEqual({ ok: false,
      error: { kind: 'signature_mismatch' } });
  });
  it.each([
    { ok: false, value: signature }, { ok: true, value: 42 },
    { ok: true, value: signature, extra: 'ambiguous' }, { ok: true },
  ])('rejects malformed signing-result wrappers: %j', wrapper => {
    expect(parseStoredEnvironmentAttestation(JSON.stringify({ payload, signature: wrapper }), ports, 'sess_fixture')).toMatchObject({ ok: false, error: { kind: 'malformed' } });
  });
  it('identifies the previous key without granting authority to a retired key', () => {
    const next = { ...ports.keyring.current, keyBase64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    const rotated = unsafeTokenCodecPorts({ ...ports, keyring: { v: 1, current: next, previous: ports.keyring.current } });
    const raw = JSON.stringify({ payload, signature });
    expect(parseStoredEnvironmentAttestation(raw, rotated, 'sess_fixture')).toMatchObject({ ok: true,
      value: { payload, verificationKey: 'previous' } });
    const retired = unsafeTokenCodecPorts({ ...ports, keyring: { v: 1, current: next, previous: null } });
    expect(parseStoredEnvironmentAttestation(raw, retired, 'sess_fixture')).toEqual({ ok: false,
      error: { kind: 'signature_mismatch' } });
  });
  it('rejects an invalid inner signature and preserves missing versus malformed', () => {
    expect(parseStoredEnvironmentAttestation(JSON.stringify({ payload, signature: { ok: true, value: 'invalid' } }), ports, 'sess_fixture')).toEqual({ ok: false, error: { kind: 'signature_mismatch' } });
    expect(parseStoredEnvironmentAttestation(undefined, ports, 'sess_fixture')).toEqual({ ok: false, error: { kind: 'missing' } });
    expect(parseStoredEnvironmentAttestation('{broken', ports, 'sess_fixture')).toMatchObject({ ok: false, error: { kind: 'malformed' } });
  });
});
