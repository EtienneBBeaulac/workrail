import { describe, expect, it } from 'vitest';
import { V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';
import { verifyEAT, signEAT } from '../../src/v2/durable-core/tokens/index.js';
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
      const signature = signEAT(eatPayload, ports);
      expect(signature).not.toBeNull();
      if (!signature) return;

      // Verification with expected session ID must pass
      const isValid = verifyEAT(eatPayload, signature, ports, 'sess_current456');
      expect(isValid).toBe(true);
    });

    it('rejects EAT verification if expected sessionId does not match', () => {
      const signature = signEAT(eatPayload, ports);
      expect(signature).not.toBeNull();
      if (!signature) return;

      // Verification with a mismatched expected session ID must fail (mitigating replay)
      const isValid = verifyEAT(eatPayload, signature, ports, 'sess_mismatched789');
      expect(isValid).toBe(false);
    });

    it('retains backward compatibility if no expectedSessionId is passed', () => {
      const signature = signEAT(eatPayload, ports);
      expect(signature).not.toBeNull();
      if (!signature) return;

      const isValid = verifyEAT(eatPayload, signature, ports);
      expect(isValid).toBe(true);
    });
  });
});
