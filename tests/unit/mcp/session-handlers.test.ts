/**
 * Unit tests for session tool handlers.
 *
 * Tests focus on handleOpenDashboard's daemon-console.lock read behavior
 * and the requireSessionTools guard after HttpServer removal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../src/mcp/types.js';
import { handleOpenDashboard } from '../../../src/mcp/handlers/session.js';
import { DEFAULT_CONSOLE_PORT } from '../../../src/infrastructure/console-defaults.js';

// Mock fs/promises so tests don't touch the real filesystem.
// handleOpenDashboard reads ~/.workrail/daemon-console.lock via fs.readFile.
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

// Import the mocked readFile after vi.mock hoisting.
import { readFile } from 'fs/promises';
const mockReadFile = vi.mocked(readFile);

// Minimal ToolContext with sessionManager enabled (non-null).
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workflowService: {} as ToolContext['workflowService'],
    featureFlags: {
      isEnabled: () => true,
    } as unknown as ToolContext['featureFlags'],
    sessionManager: {} as ToolContext['sessionManager'],
    v2: null,
    ...overrides,
  };
}

describe('handleOpenDashboard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns live URL from daemon-console.lock when running on a custom port', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ pid: 1234, port: 4000 }));

    const result = await handleOpenDashboard({ sessionId: 'sess-1' }, makeCtx());

    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.data.url).toBe('http://localhost:4000?session=sess-1');
      expect(result.data.guidance).toBeDefined();
    }
  });

  it('falls back to DEFAULT_CONSOLE_PORT when lock file does not exist (ENOENT)', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValueOnce(enoent);

    const result = await handleOpenDashboard({ sessionId: 'sess-2' }, makeCtx());

    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.data.url).toBe(`http://localhost:${DEFAULT_CONSOLE_PORT}?session=sess-2`);
    }
  });

  it('falls back to DEFAULT_CONSOLE_PORT when lock file contains malformed JSON', async () => {
    mockReadFile.mockResolvedValueOnce('not valid json {{');

    const result = await handleOpenDashboard({ sessionId: undefined }, makeCtx());

    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.data.url).toBe(`http://localhost:${DEFAULT_CONSOLE_PORT}`);
    }
  });

  it('returns guidance string in every successful response', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ pid: 42, port: 3456 }));

    const result = await handleOpenDashboard({}, makeCtx());

    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(typeof result.data.guidance).toBe('string');
      expect(result.data.guidance!.length).toBeGreaterThan(0);
    }
  });

  it('returns PRECONDITION_FAILED when sessionManager is null', async () => {
    const result = await handleOpenDashboard({}, makeCtx({ sessionManager: null }));

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('PRECONDITION_FAILED');
    }
  });
});

describe('requireSessionTools guard (via handleOpenDashboard)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: 1, port: 3456 }));
  });

  it('allows access when sessionManager is present', async () => {
    const result = await handleOpenDashboard({}, makeCtx());
    expect(result.type).toBe('success');
  });

  it('blocks access when sessionManager is null', async () => {
    const result = await handleOpenDashboard({}, makeCtx({ sessionManager: null }));
    expect(result.type).toBe('error');
  });
});
