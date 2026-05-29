/**
 * Unit tests for ClaudeCodeUsageReader.
 *
 * Tests the JSONL parsing logic, session ID detection, and token summing.
 * Uses a temporary directory with fixture JSONL files for I/O tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { ClaudeCodeUsageReader } from '../../src/mcp/client-usage/claude-code.js';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeAssistantLine(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  });
}

function makeToolUseLine(sessionId: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-6',
      content: [
        {
          type: 'tool_use',
          name: 'mcp__workrail__continue_workflow',
          input: { continueToken: 'ct_test', sessionId },
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

// ── Test setup ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-client-usage-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── searchDirs ─────────────────────────────────────────────────────────────────

describe('ClaudeCodeUsageReader.searchDirs', () => {
  it('encodes workspace path by replacing slashes with hyphens', () => {
    const reader = new ClaudeCodeUsageReader(path.join('/fake', 'home'));
    const dirs = reader.searchDirs(path.join('/Users', 'etienneb', 'git', 'personal', 'workrail'));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toContain('-Users-etienneb-git-personal-workrail');
    expect(dirs[0]).toContain('.claude');
    expect(dirs[0]).toContain('projects');
  });

  it('uses the injected homeDir', () => {
    const customHome = path.join('/custom', 'home');
    const reader = new ClaudeCodeUsageReader(customHome);
    const dirs = reader.searchDirs(path.join('/my', 'project'));
    // Use path.join segment check so it passes on both Unix (/) and Windows (\)
    expect(dirs[0]).toContain(path.join('custom', 'home'));
  });
});

// ── parseUsage ─────────────────────────────────────────────────────────────────

describe('ClaudeCodeUsageReader.parseUsage', () => {
  it('returns null for a file not modified since startMs', async () => {
    const reader = new ClaudeCodeUsageReader(tmpDir);
    const filePath = path.join(tmpDir, 'old.jsonl');
    await fs.writeFile(filePath, makeAssistantLine('model-1', 100, 50, 200, 300) + '\n');

    // Use a startMs far in the future so the file's mtime is before it
    const futureMs = Date.now() + 1_000_000;
    const result = await reader.parseUsage(filePath, 'sess_test', futureMs);
    expect(result).toBeNull();
  });

  it('returns null when session ID is not found in the file', async () => {
    const reader = new ClaudeCodeUsageReader(tmpDir);
    const filePath = path.join(tmpDir, 'no-session.jsonl');
    await fs.writeFile(
      filePath,
      makeAssistantLine('claude-sonnet-4-6', 100, 50, 200, 300) + '\n' +
      makeToolUseLine('sess_other_session') + '\n',
    );

    const result = await reader.parseUsage(filePath, 'sess_target_session', 0);
    expect(result).toBeNull();
  });

  it('returns null for a non-existent file', async () => {
    const reader = new ClaudeCodeUsageReader(tmpDir);
    const result = await reader.parseUsage(path.join(tmpDir, 'nonexistent.jsonl'), 'sess_test', 0);
    expect(result).toBeNull();
  });

  it('sums usage fields from all assistant entries when session ID found', async () => {
    const reader = new ClaudeCodeUsageReader(tmpDir);
    const filePath = path.join(tmpDir, 'session.jsonl');

    const content = [
      makeToolUseLine('sess_myworkrailsession'),  // contains session ID
      makeAssistantLine('claude-sonnet-4-6', 100, 50, 200, 300),
      makeAssistantLine('claude-sonnet-4-6', 150, 75, 100, 50),
      JSON.stringify({ type: 'user', message: { text: 'hello' } }),  // non-assistant line
    ].join('\n');

    await fs.writeFile(filePath, content);

    const result = await reader.parseUsage(filePath, 'sess_myworkrailsession', 0);

    expect(result).not.toBeNull();
    expect(result!.client).toBe('claude-code');
    // The tool_use line has usage too (input_tokens: 10, output_tokens: 5)
    expect(result!.inputTokens).toBe(100 + 150 + 10);
    expect(result!.outputTokens).toBe(50 + 75 + 5);
    expect(result!.cacheReadTokens).toBe(200 + 100 + 0);
    expect(result!.cacheWriteTokens).toBe(300 + 50 + 0);
    expect(result!.turns).toBe(3); // 3 assistant entries
  });

  it('returns the last non-null model seen', async () => {
    const reader = new ClaudeCodeUsageReader(tmpDir);
    const filePath = path.join(tmpDir, 'models.jsonl');

    const content = [
      'sess_abc' + ' something',  // session ID marker (just string presence)
      makeAssistantLine('claude-sonnet-3-7', 10, 5, 0, 0),
      makeAssistantLine('claude-sonnet-4-6', 20, 10, 0, 0),
    ].join('\n');

    await fs.writeFile(filePath, content);

    const result = await reader.parseUsage(filePath, 'sess_abc', 0);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('claude-sonnet-4-6');
  });

  it('skips malformed JSON lines without throwing', async () => {
    const reader = new ClaudeCodeUsageReader(tmpDir);
    const filePath = path.join(tmpDir, 'malformed.jsonl');

    const content = [
      'sess_xyz is here',
      makeAssistantLine('claude-sonnet-4-6', 100, 50, 0, 0),
      '{ bad json',
      makeAssistantLine('claude-sonnet-4-6', 50, 25, 0, 0),
    ].join('\n');

    await fs.writeFile(filePath, content);

    const result = await reader.parseUsage(filePath, 'sess_xyz', 0);
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(150);
    expect(result!.turns).toBe(2);
  });

  it('returns null when file has session ID but no assistant entries with usage', async () => {
    const reader = new ClaudeCodeUsageReader(tmpDir);
    const filePath = path.join(tmpDir, 'no-usage.jsonl');

    const content = [
      'sess_target is here',
      JSON.stringify({ type: 'user', message: 'hello' }),
      JSON.stringify({ type: 'system', content: 'system prompt' }),
    ].join('\n');

    await fs.writeFile(filePath, content);

    const result = await reader.parseUsage(filePath, 'sess_target', 0);
    expect(result).toBeNull();
  });
});

// ── snapshotCurrentConversation ────────────────────────────────────────────────

describe('ClaudeCodeUsageReader.snapshotCurrentConversation', () => {
  it('returns null when project directory does not exist', async () => {
    const reader = new ClaudeCodeUsageReader(path.join(tmpDir, 'nonexistent'));
    const result = await reader.snapshotCurrentConversation('/some/workspace');
    expect(result).toBeNull();
  });

  it('returns null when project directory is empty', async () => {
    const encoded = '/some/workspace'.replace(/[/\\]/g, '-');
    const projDir = path.join(tmpDir, '.claude', 'projects', encoded);
    await fs.mkdir(projDir, { recursive: true });
    const reader = new ClaudeCodeUsageReader(tmpDir);
    const result = await reader.snapshotCurrentConversation('/some/workspace');
    expect(result).toBeNull();
  });

  it('returns summed tokens from the most recently modified JSONL', async () => {
    const encoded = '/my/project'.replace(/[/\\]/g, '-');
    const projDir = path.join(tmpDir, '.claude', 'projects', encoded);
    await fs.mkdir(projDir, { recursive: true });

    const content = [
      makeAssistantLine('claude-sonnet-4-6', 100, 50, 200, 10),
      makeAssistantLine('claude-sonnet-4-6', 300, 80, 500, 20),
    ].join('\n');
    await fs.writeFile(path.join(projDir, 'session.jsonl'), content);

    const reader = new ClaudeCodeUsageReader(tmpDir);
    const result = await reader.snapshotCurrentConversation('/my/project');
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(400);
    expect(result!.outputTokens).toBe(130);
    expect(result!.cacheReadTokens).toBe(700);
    expect(result!.cacheWriteTokens).toBe(30);
    expect(result!.turns).toBe(2);
  });

  it('deduplicates consecutive entries with identical usage blocks', async () => {
    const encoded = '/dedup/project'.replace(/[/\\]/g, '-');
    const projDir = path.join(tmpDir, '.claude', 'projects', encoded);
    await fs.mkdir(projDir, { recursive: true });

    // Two identical consecutive entries -- should count as one turn
    const line = makeAssistantLine('model', 100, 50, 0, 0);
    await fs.writeFile(path.join(projDir, 'session.jsonl'), [line, line].join('\n'));

    const reader = new ClaudeCodeUsageReader(tmpDir);
    const result = await reader.snapshotCurrentConversation('/dedup/project');
    expect(result).not.toBeNull();
    expect(result!.turns).toBe(1);
    expect(result!.inputTokens).toBe(100);
  });

  it('returns null when sessionId is provided but file does not contain it', async () => {
    const encoded = '/verify/project'.replace(/[/\\]/g, '-');
    const projDir = path.join(tmpDir, '.claude', 'projects', encoded);
    await fs.mkdir(projDir, { recursive: true });

    const content = makeAssistantLine('model', 100, 50, 0, 0);
    await fs.writeFile(path.join(projDir, 'session.jsonl'), content);

    const reader = new ClaudeCodeUsageReader(tmpDir);
    const result = await reader.snapshotCurrentConversation('/verify/project', 'sess_notpresent');
    expect(result).toBeNull();
  });

  it('returns result when sessionId is present in the file', async () => {
    const encoded = '/verify2/project'.replace(/[/\\]/g, '-');
    const projDir = path.join(tmpDir, '.claude', 'projects', encoded);
    await fs.mkdir(projDir, { recursive: true });

    const toolLine = makeToolUseLine('sess_mymatchingsession');
    const usageLine = makeAssistantLine('model', 100, 50, 0, 0);
    await fs.writeFile(path.join(projDir, 'session.jsonl'), [usageLine, toolLine].join('\n'));

    const reader = new ClaudeCodeUsageReader(tmpDir);
    const result = await reader.snapshotCurrentConversation('/verify2/project', 'sess_mymatchingsession');
    // Verification passed -- result is non-null because the session ID is present
    expect(result).not.toBeNull();
  });
});
