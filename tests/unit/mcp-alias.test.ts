import { describe, it, expect } from 'vitest';
import { V2ContinueWorkflowInputShape, V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';

describe('MCP continue_workflow schema compatibility aliases', () => {
  describe('Static disjointness verification', () => {
    it('asserts flat alias keys do not exist in the canonical input shape', () => {
      const canonicalKeys = Object.keys(V2ContinueWorkflowInputShape.shape);
      
      // The canonical shape should not contain our flat compatibility aliases directly.
      // This guarantees they are boundary-only additions and don't silently shadow future fields.
      expect(canonicalKeys).not.toContain('notes');
      expect(canonicalKeys).not.toContain('artifacts');
    });
  });

  describe('Transform and normalisation', () => {
    const continueToken = 'ct_mockToken12345';
    const workspacePath = '/Users/mock/git/project';

    it('successfully parses and normalizes pure flat aliased payloads', () => {
      const payload = {
        continueToken,
        workspacePath,
        notes: 'Substantive step notes with more than 50 characters required for step completions.',
        artifacts: [{ kind: 'wr.mock_artifact', data: 42 }],
      };

      const result = V2ContinueWorkflowInput.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output).toBeDefined();
        expect(result.data.output?.notesMarkdown).toBe(payload.notes);
        expect(result.data.output?.artifacts).toEqual(payload.artifacts);
        expect(result.data.intent).toBe('advance');
      }
    });

    it('successfully parses pure canonical nested output payloads', () => {
      const payload = {
        continueToken,
        workspacePath,
        output: {
          notesMarkdown: 'Substantive step notes with more than 50 characters required for step completions.',
          artifacts: [{ kind: 'wr.mock_artifact', data: 42 }],
        },
      };

      const result = V2ContinueWorkflowInput.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output).toBeDefined();
        expect(result.data.output?.notesMarkdown).toBe(payload.output.notesMarkdown);
        expect(result.data.output?.artifacts).toEqual(payload.output.artifacts);
        expect(result.data.intent).toBe('advance');
      }
    });

    it('successfully normalizes hybrid payloads (e.g. flat notes, nested artifacts)', () => {
      const payload = {
        continueToken,
        workspacePath,
        notes: 'Substantive step notes with more than 50 characters required for step completions.',
        output: {
          artifacts: [{ kind: 'wr.mock_artifact', data: 42 }],
        },
      };

      const result = V2ContinueWorkflowInput.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output).toBeDefined();
        expect(result.data.output?.notesMarkdown).toBe(payload.notes);
        expect(result.data.output?.artifacts).toEqual(payload.output.artifacts);
        expect(result.data.intent).toBe('advance');
      }
    });

    it('infers intent as rehydrate when no output or aliases are present', () => {
      const payload = {
        continueToken,
        workspacePath,
      };

      const result = V2ContinueWorkflowInput.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.output).toBeUndefined();
        expect(result.data.intent).toBe('rehydrate');
      }
    });
  });

  describe('Validation conflict guards', () => {
    const continueToken = 'ct_mockToken12345';
    const workspacePath = '/Users/mock/git/project';

    it('rejects payload containing both flat notes and nested notesMarkdown', () => {
      const payload = {
        continueToken,
        workspacePath,
        notes: 'Flat notes',
        output: {
          notesMarkdown: 'Nested notes',
        },
      };

      const result = V2ContinueWorkflowInput.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some(i => i.path.includes('notes') && i.message.includes('Provide either "notes" or "output.notesMarkdown"'))).toBe(true);
      }
    });

    it('rejects payload containing both flat artifacts and nested artifacts', () => {
      const payload = {
        continueToken,
        workspacePath,
        artifacts: [{ kind: 'flat' }],
        output: {
          artifacts: [{ kind: 'nested' }],
        },
      };

      const result = V2ContinueWorkflowInput.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some(i => i.path.includes('artifacts') && i.message.includes('Provide either "artifacts" or "output.artifacts"'))).toBe(true);
      }
    });

    it('rejects rehydrate intent when flat notes are supplied', () => {
      const payload = {
        continueToken,
        workspacePath,
        intent: 'rehydrate',
        notes: 'Some notes',
      };

      const result = V2ContinueWorkflowInput.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some(i => i.path.includes('output') && i.message.includes('intent is "rehydrate" but output was provided'))).toBe(true);
      }
    });
  });
});
