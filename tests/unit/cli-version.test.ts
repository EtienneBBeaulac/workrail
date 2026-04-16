import { describe, it, expect, vi } from 'vitest';
import { executeVersionCommand } from '../../src/cli/commands/version.js';

describe('executeVersionCommand', () => {
  it('prints WorkRail v<version> and returns success', () => {
    const printed: string[] = [];
    const result = executeVersionCommand({
      getVersion: () => '3.16.0',
      print: (msg) => printed.push(msg),
    });

    expect(result.kind).toBe('success');
    expect(printed).toEqual(['WorkRail v3.16.0']);
  });

  it('returns failure when getVersion throws', () => {
    const result = executeVersionCommand({
      getVersion: () => { throw new Error('file not found'); },
      print: vi.fn(),
    });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('file not found');
    }
  });

  it('does not call print on failure', () => {
    const print = vi.fn();
    executeVersionCommand({
      getVersion: () => { throw new Error('boom'); },
      print,
    });

    expect(print).not.toHaveBeenCalled();
  });
});

describe('workrail version CLI integration', () => {
  it('outputs WorkRail v<version> to stdout with exit code 0', () => {
    const { execSync } = require('child_process');
    const path = require('path');
    const cliPath = path.join(__dirname, '../../dist/cli.js');

    let output: string;
    try {
      output = execSync(`node ${cliPath} version`, { encoding: 'utf-8' });
    } catch (err: any) {
      throw new Error(`CLI exited with non-zero code: ${err.message}`);
    }

    expect(output.trim()).toMatch(/^WorkRail v\d+\.\d+\.\d+/);
  });
});
