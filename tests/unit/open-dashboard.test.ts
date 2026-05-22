import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  autoBootConsoleBackground,
  getCliWorktrainPath,
  handleOpenDashboard,
  handleCreateSession,
} from '../../src/mcp/handlers/session.js';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { request } from 'http';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('http', () => ({
  request: vi.fn(),
}));

describe('autoBootConsoleBackground', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('bypasses spawn completely in Vitest environment by default', async () => {
    await autoBootConsoleBackground();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns the console when lock is missing and forceSpawnInTest is true', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(existsSync).mockReturnValue(true);
    const mockChild = { unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    await autoBootConsoleBackground({ forceSpawnInTest: true });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('cli-worktrain.js'), 'console'],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
    expect(mockChild.unref).toHaveBeenCalled();
  });

  it('skips spawn if lock is active and port ping succeeds', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ pid: 12345, port: 3456 }));
    vi.mocked(existsSync).mockReturnValue(true);
    
    // Mock process.kill to succeed
    const originalKill = process.kill;
    process.kill = vi.fn().mockReturnValue(true) as any;

    // Mock http.request to respond with statusCode 200
    const mockReq = { end: vi.fn(), on: vi.fn() };
    vi.mocked(request).mockImplementation((opts: any, cb: any) => {
      cb({
        resume: () => {},
        statusCode: 200,
      });
      return mockReq as any;
    });

    await autoBootConsoleBackground({ forceSpawnInTest: true });

    expect(spawn).not.toHaveBeenCalled();

    process.kill = originalKill;
  });
});

describe('handleOpenDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns URL directly if lock is active and ping succeeds', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ pid: 12345, port: 3456 }));
    
    const originalKill = process.kill;
    process.kill = vi.fn().mockReturnValue(true) as any;

    // Mock http.request to respond with 200
    const mockReq = { end: vi.fn(), on: vi.fn() };
    vi.mocked(request).mockImplementation((opts: any, cb: any) => {
      cb({
        resume: () => {},
        statusCode: 200,
      });
      return mockReq as any;
    });

    const ctx = { sessionManager: {} } as any;
    const res = await handleOpenDashboard({ sessionId: 'sess-123' }, ctx);

    expect(res.type).toBe('success');
    if (res.type === 'success') {
      expect(res.data.url).toBe('http://localhost:3456?session=sess-123');
      expect(res.data.guidance).toBeDefined();
    }
    expect(spawn).not.toHaveBeenCalled();

    process.kill = originalKill;
  });

  it('spawns and polls successfully if lock is absent or dead', async () => {
    // Stub environment variables using vi.stubEnv
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'development');

    // 1. First lock read returns null (absent)
    // 2. Second lock read returns null (absent) so autoBoot triggers spawn
    // 3. Third lock read (polling) returns our new active process info
    vi.mocked(fs.readFile)
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(JSON.stringify({ pid: 54321, port: 9999 }));

    vi.mocked(existsSync).mockReturnValue(true);

    const originalKill = process.kill;
    process.kill = vi.fn().mockReturnValue(true) as any;

    const mockChild = { unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(mockChild as any);

    // Mock http.request to respond with 200 on second try
    const mockReq = { end: vi.fn(), on: vi.fn() };
    vi.mocked(request).mockImplementation((opts: any, cb: any) => {
      cb({
        resume: () => {},
        statusCode: 200,
      });
      return mockReq as any;
    });

    const ctx = { sessionManager: {} } as any;

    const res = await handleOpenDashboard({ sessionId: 'sess-123' }, ctx);

    expect(res.type).toBe('success');
    if (res.type === 'success') {
      expect(res.data.url).toBe('http://localhost:9999?session=sess-123');
    }
    expect(spawn).toHaveBeenCalled();

    process.kill = originalKill;
  });
});

describe('handleCreateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves dynamic port from lock file when creating session', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ pid: 12345, port: 8888 }));

    const mockSession = {
      id: 'sess-abc',
      workflowId: 'wf-abc',
      createdAt: '2026-05-22',
    };
    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue({
        isErr: () => false,
        value: mockSession,
      }),
      getSessionPath: vi.fn().mockReturnValue('/path/to/session'),
    };
    const ctx = { sessionManager: mockSessionManager } as any;

    const res = await handleCreateSession(
      { workflowId: 'wf-abc', sessionId: 'sess-abc', initialData: {} },
      ctx
    );

    expect(res.type).toBe('success');
    if (res.type === 'success') {
      expect(res.data.dashboardUrl).toBe('http://localhost:8888?session=sess-abc');
    }
  });
});
