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
 *
 * Cross-platform notes:
 * - WORKSPACE uses os.tmpdir() (not hardcoded /tmp)
 * - Commands use node -e instead of sh -c for Windows compatibility
 * - 'true' is replaced with 'node -e ""' (no-op cross-platform)
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { makeBashTool } from '../../src/daemon/workflow-runner.js';

const stubSchemas = { BashParams: {} };
const WORKSPACE = os.tmpdir();

// Cross-platform command helpers
const CMD_ECHO_HELLO = 'node -e "process.stdout.write(\'hello\')"';
const CMD_NOOP = 'node -e ""';
const CMD_STDOUT_AND_STDERR =
  'node -e "process.stdout.write(\'out\'); process.stderr.write(\'err\')"';
const CMD_EXIT_1 = 'node -e "process.exit(1)"';
const CMD_EXIT_42 = 'node -e "process.exit(42)"';
const CMD_STDOUT_THEN_EXIT_1 =
  'node -e "process.stdout.write(\'stdout-content\'); process.exit(1)"';
const CMD_STDERR_THEN_EXIT_1 =
  'node -e "process.stderr.write(\'stderr-content\'); process.exit(1)"';
const CMD_BOTH_THEN_EXIT_1 =
  'node -e "process.stdout.write(\'my-out\'); process.stderr.write(\'my-err\'); process.exit(1)"';

describe('makeBashTool()', () => {
  describe('success cases (exit 0)', () => {
    it('returns stdout content on successful command', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: CMD_ECHO_HELLO,
        cwd: WORKSPACE,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('hello');
    });

    it('returns "(no output)" when command produces no output', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: CMD_NOOP,
        cwd: WORKSPACE,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe('(no output)');
    });

    it('includes both stdout and stderr in the success output', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: CMD_STDOUT_AND_STDERR,
        cwd: WORKSPACE,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('out');
      expect(text).toContain('err');
    });

    it('returns details with stdout and stderr properties', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: CMD_ECHO_HELLO,
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
        tool.execute('test-call-id', { command: CMD_EXIT_1, cwd: WORKSPACE }),
      ).rejects.toThrow();
    });

    it('includes the failed command in the thrown error message', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_EXIT_1, cwd: WORKSPACE }),
      ).rejects.toThrow(CMD_EXIT_1);
    });

    it('includes the exit code in the thrown error message', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_EXIT_42, cwd: WORKSPACE }),
      ).rejects.toThrow('42');
    });

    it('includes stdout in the thrown error when command produces output before failing', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_STDOUT_THEN_EXIT_1, cwd: WORKSPACE }),
      ).rejects.toThrow('stdout-content');
    });

    it('includes stderr in the thrown error when command writes to stderr before failing', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_STDERR_THEN_EXIT_1, cwd: WORKSPACE }),
      ).rejects.toThrow('stderr-content');
    });

    it('error message contains STDOUT and STDERR section headers', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      let thrownError: Error | undefined;
      try {
        await tool.execute('test-call-id', {
          command: CMD_BOTH_THEN_EXIT_1,
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
