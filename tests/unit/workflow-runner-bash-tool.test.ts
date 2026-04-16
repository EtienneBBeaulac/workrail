/**
 * Unit tests for makeBashTool() in workflow-runner.ts.
 *
 * Strategy: call makeBashTool() directly with a stub schemas argument,
 * then invoke execute() with real shell commands. No mocking -- following
 * the "prefer fakes over mocks" principle from CLAUDE.md.
 *
 * WHY: The execute() function's behavior is fully deterministic given a
 * shell command. Real exec calls are the most reliable way to verify both
 * the success path (return value shape) and the failure path (thrown error
 * message containing stdout and stderr).
 */

import { describe, it, expect } from 'vitest';
import { makeBashTool } from '../../src/daemon/workflow-runner.js';

// Minimal stub for the schemas argument. makeBashTool() uses schemas['BashParams']
// only as the agent parameter schema (for validation by the agent loop), not inside
// execute(). Tests call execute() directly, so a stub is sufficient.
const stubSchemas = { BashParams: {} };

const WORKSPACE = '/tmp';

describe('makeBashTool()', () => {
  describe('success cases (exit 0)', () => {
    it('returns stdout content on successful command', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: 'echo hello',
        cwd: WORKSPACE,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('hello');
    });

    it('returns "(no output)" when command produces no output', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: 'true',
        cwd: WORKSPACE,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe('(no output)');
    });

    it('includes both stdout and stderr in the success output', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: "sh -c 'echo out; echo err >&2'",
        cwd: WORKSPACE,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('out');
      expect(text).toContain('err');
    });

    it('returns details with stdout and stderr properties', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: 'echo hello',
        cwd: WORKSPACE,
      });
      const details = result.details as { stdout: string; stderr: string };
      expect(details).toHaveProperty('stdout');
      expect(details).toHaveProperty('stderr');
    });
  });

  describe('failure cases (non-zero exit)', () => {
    it('throws an error when command exits with non-zero code', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: 'exit 1', cwd: WORKSPACE }),
      ).rejects.toThrow();
    });

    it('includes the failed command in the thrown error message', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const command = "sh -c 'exit 1'";
      await expect(
        tool.execute('test-call-id', { command, cwd: WORKSPACE }),
      ).rejects.toThrow(command);
    });

    it('includes the exit code in the thrown error message', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: "sh -c 'exit 42'", cwd: WORKSPACE }),
      ).rejects.toThrow('exit 42');
    });

    it('includes stdout in the thrown error when command produces output before failing', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', {
          command: "sh -c 'echo stdout-content; exit 1'",
          cwd: WORKSPACE,
        }),
      ).rejects.toThrow('stdout-content');
    });

    it('includes stderr in the thrown error when command writes to stderr before failing', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', {
          command: "sh -c 'echo stderr-content >&2; exit 1'",
          cwd: WORKSPACE,
        }),
      ).rejects.toThrow('stderr-content');
    });

    it('error message contains STDOUT and STDERR section headers', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      let thrownError: Error | undefined;
      try {
        await tool.execute('test-call-id', {
          command: "sh -c 'echo my-out; echo my-err >&2; exit 1'",
          cwd: WORKSPACE,
        });
      } catch (err) {
        thrownError = err as Error;
      }
      expect(thrownError).toBeDefined();
      expect(thrownError?.message).toContain('STDOUT:');
      expect(thrownError?.message).toContain('STDERR:');
      expect(thrownError?.message).toContain('my-out');
      expect(thrownError?.message).toContain('my-err');
    });
  });
});
