import { describe, expect, it } from 'vitest';
import { V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';
import { verifyEAT, signEAT, parseEAT } from '../../src/v2/durable-core/tokens/index.js';
import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';

describe('Security Remediations', () => {

  describe('Context Injection Prevention Zod Schema', () => {
    const validBaseInput = {
      continueToken: 'ct_validtoken12345678901234567890',
      intent: 'rehydrate',
      workspacePath: '/Users/etienneb/git/personal/workrail',
    };

    it('rejects public continue_workflow input if context contains eat_token', () => {
      const input = {
        ...validBaseInput,
        context: {
          eat_token: 'malicious_injected_token',
        },
      };

      const result = V2ContinueWorkflowInput.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0];
        expect(issue?.message).toContain('Reserved system key "eat_token" cannot be set in context.');
      }
    });

    it('rejects public continue_workflow input if contextVariables contains metrics_harness', () => {
      const input = {
        ...validBaseInput,
        contextVariables: {
          metrics_harness: 'cursor',
        },
      };

      const result = V2ContinueWorkflowInput.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0];
        expect(issue?.message).toContain('Reserved system key "metrics_harness" cannot be set in context.');
      }
    });

    it('accepts public continue_workflow input with safe context variables', () => {
      const input = {
        ...validBaseInput,
        context: {
          safeVar: 'safeValue',
        },
      };

      const result = V2ContinueWorkflowInput.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.context).toEqual({ safeVar: 'safeValue' });
      }
    });
  });

  describe('EAT Session-Binding Cryptography', () => {
    // Initialize mock/unsafe ports for EAT signing and verification tests
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();

    // A secure keyring with a current keyBase64Url
    const keyring = {
      current: {
        keyId: 'k1',
        keyBase64Url: 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z6',
      },
    };

    const ports = unsafeTokenCodecPorts({
      keyring,
      hmac,
      base64url,
      base32,
      bech32m,
    });

    const eatPayload = {
      harness: 'claude_code',
      activeModel: 'claude-3-5-sonnet',
      parentSessionId: 'sess_parent123',
      spawnDepth: 1,
      sessionId: 'sess_current456',
    };

    it('signs and verifies a session-bound EAT payload successfully', () => {
      const signResult = signEAT(eatPayload, ports);
      expect(signResult.ok).toBe(true);
      if (!signResult.ok) return;

      // Verification with expected session ID must pass
      const isValid = verifyEAT(eatPayload, signResult.value, ports, 'sess_current456');
      expect(isValid).toBe(true);
    });

    it('rejects EAT verification if expected sessionId does not match', () => {
      const signResult = signEAT(eatPayload, ports);
      expect(signResult.ok).toBe(true);
      if (!signResult.ok) return;

      // Verification with a mismatched expected session ID must fail (mitigating replay)
      const isValid = verifyEAT(eatPayload, signResult.value, ports, 'sess_mismatched789');
      expect(isValid).toBe(false);
    });

    it('retains backward compatibility if no expectedSessionId is passed', () => {
      const signResult = signEAT(eatPayload, ports);
      expect(signResult.ok).toBe(true);
      if (!signResult.ok) return;

      const isValid = verifyEAT(eatPayload, signResult.value, ports);
      expect(isValid).toBe(true);
    });

    // ---- F9: Additional security test cases ----

    it('rejects a parent_eat_token where payload is null (null-payload malformed EAT)', () => {
      // A token that parses as valid JSON but has payload: null
      const malformedToken = JSON.stringify({ payload: null, signature: 'anything' });
      const result = parseEAT(malformedToken, ports);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Must be classified as malformed, not missing or signature_mismatch
      expect(result.error.kind).toBe('malformed');
    });

    it('rejects a parent_eat_token where the payload is missing the spawnDepth field', () => {
      // A token where the payload lacks the required spawnDepth field
      const incompletePayload = {
        harness: 'claude_code',
        activeModel: 'claude-3-5-sonnet',
        sessionId: 'sess_incomplete',
        // spawnDepth intentionally missing
      };
      const malformedToken = JSON.stringify({ payload: incompletePayload, signature: 'anything' });
      const result = parseEAT(malformedToken, ports);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // spawnDepth is not a string field so the type guard catches its absence
      expect(result.error.kind).toBe('malformed');
    });

    it('rejects verification when keyring has rotated away from the signing key (signature_mismatch)', () => {
      // Sign with key N
      const signResult = signEAT(eatPayload, ports);
      expect(signResult.ok).toBe(true);
      if (!signResult.ok) return;

      const signedToken = JSON.stringify({ payload: eatPayload, signature: signResult.value });

      // Verify with a different keyring (key N+1, key N absent) — simulates key rotation
      const rotatedKeyring = {
        current: {
          keyId: 'k2',
          // Completely different key — key N is gone
          keyBase64Url: 'Z9Y8X7W6V5U4T3S2R1Q0P9O8N7M6L5K4J3I2H1G0F9E8D7C6B5A4',
        },
      };
      const rotatedPorts = unsafeTokenCodecPorts({
        keyring: rotatedKeyring,
        hmac,
        base64url,
        base32,
        bech32m,
      });

      const result = parseEAT(signedToken, rotatedPorts);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Token structure is valid, but HMAC fails against the new key
      expect(result.error.kind).toBe('signature_mismatch');
    });
  });
});
