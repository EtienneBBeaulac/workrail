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
 * Platform notes:
 * - WORKSPACE uses os.tmpdir() (not hardcoded /tmp)
 * - These tests are skipped on Windows: makeBashTool() uses shell: '/bin/bash'
 *   which is POSIX-only. Windows support for the bash tool is a separate task.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { makeBashTool } from '../../src/daemon/workflow-runner.js';

// WHY: makeBashTool() uses shell: '/bin/bash' which does not exist on Windows.
// Skipping rather than failing keeps the CI matrix green while being honest
// that this feature is POSIX-only. See workflow-runner.ts for the shell option.
const SKIP_ON_WINDOWS = process.platform === 'win32';

const stubSchemas = { BashParams: {} };
const WORKSPACE = os.tmpdir();

// Cross-platform command helpers
const CMD_ECHO_HELLO = 'node -e "process.stdout.write(\'hello\')"';
const CMD_NOOP = 'node -e ""';
const CMD_STDOUT_AND_STDERR =
  'node -e "process.stdout.write(\'out\'); process.stderr.write(\'err\')"';
const CMD_EXIT_1 = 'node -e "process.exit(1)"';
const CMD_EXIT_2 = 'node -e "process.exit(2)"';
const CMD_EXIT_42 = 'node -e "process.exit(42)"';
const CMD_STDOUT_THEN_EXIT_1 =
  'node -e "process.stdout.write(\'stdout-content\'); process.exit(1)"';
const CMD_STDERR_THEN_EXIT_1 =
  'node -e "process.stderr.write(\'stderr-content\'); process.exit(1)"';
const CMD_BOTH_THEN_EXIT_1 =
  'node -e "process.stdout.write(\'my-out\'); process.stderr.write(\'my-err\'); process.exit(1)"';
// Exit 2 with stderr -- simulates grep "Usage error" or real grep error
const CMD_STDERR_THEN_EXIT_2 =
  'node -e "process.stderr.write(\'grep: invalid option\'); process.exit(2)"';

describe('makeBashTool()', () => {
  describe.skipIf(SKIP_ON_WINDOWS)('success cases (exit 0)', () => {
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

  describe.skipIf(SKIP_ON_WINDOWS)('exit-1 with empty stderr (grep "no match" semantics)', () => {
    it('returns empty stdout when exit 1 and no stderr (grep finds nothing)', async () => {
      // Simulates: ls docs/plans/ | grep -i trigger  -- grep finds no lines, exits 1
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: CMD_EXIT_1,
        cwd: WORKSPACE,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      // Should NOT throw; should return "(no output)" since stdout is also empty
      expect(text).toBe('(no output)');
    });

    it('returns stdout content when exit 1 and no stderr', async () => {
      // Edge case: command exits 1 but wrote something to stdout before exiting
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: CMD_STDOUT_THEN_EXIT_1,
        cwd: WORKSPACE,
      });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain('stdout-content');
    });

    it('returns details with stdout and stderr when exit 1 and no stderr', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      const result = await tool.execute('test-call-id', {
        command: CMD_EXIT_1,
        cwd: WORKSPACE,
      });
      const details = result.details as { stdout: string; stderr: string };
      expect(details).toHaveProperty('stdout');
      expect(details).toHaveProperty('stderr');
    });

    it('still throws when exit 1 with non-empty stderr (real grep error)', async () => {
      // Simulates: grep writes a diagnostic to stderr before exiting 1
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_STDERR_THEN_EXIT_1, cwd: WORKSPACE }),
      ).rejects.toThrow('stderr-content');
    });

    it('throws when exit 2 regardless of stderr (grep usage/IO error)', async () => {
      // Exit code 2 from grep always means a real error, never "no match"
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_EXIT_2, cwd: WORKSPACE }),
      ).rejects.toThrow('exit 2');
    });

    it('throws when exit 2 even with non-empty stderr (grep IO/usage error)', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_STDERR_THEN_EXIT_2, cwd: WORKSPACE }),
      ).rejects.toThrow();
    });
  });

  describe.skipIf(SKIP_ON_WINDOWS)('failure cases (non-zero exit)', () => {
    it('throws an error when command exits with non-zero code and has stderr', async () => {
      // CMD_EXIT_1 alone no longer throws (exit 1, empty stderr = "no match" semantics).
      // Use a command that writes to stderr so the throw path is exercised.
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_STDERR_THEN_EXIT_1, cwd: WORKSPACE }),
      ).rejects.toThrow();
    });

    it('includes the failed command in the thrown error message', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_STDERR_THEN_EXIT_1, cwd: WORKSPACE }),
      ).rejects.toThrow(CMD_STDERR_THEN_EXIT_1);
    });

    it('includes the exit code in the thrown error message', async () => {
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_EXIT_42, cwd: WORKSPACE }),
      ).rejects.toThrow('42');
    });

    it('includes stdout in the thrown error when command writes to stdout and stderr before failing', async () => {
      // CMD_STDOUT_THEN_EXIT_1 exits 1 with empty stderr, which is now a "no match" success.
      // Use CMD_BOTH_THEN_EXIT_1 (stdout + stderr + exit 1) to verify the stdout-in-error path.
      const tool = makeBashTool(WORKSPACE, stubSchemas);
      await expect(
        tool.execute('test-call-id', { command: CMD_BOTH_THEN_EXIT_1, cwd: WORKSPACE }),
      ).rejects.toThrow('my-out');
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
