/**
 * Unit tests for src/mcp/dev-mode.ts
 *
 * DEV_MODE is a module-level constant evaluated at load time, so we must
 * use vi.resetModules() + dynamic import to test different WORKRAIL_DEV values.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('DEV_MODE', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is true when WORKRAIL_DEV=1', async () => {
    vi.stubEnv('WORKRAIL_DEV', '1');
    const { DEV_MODE } = await import('../../../src/mcp/dev-mode.js');
    expect(DEV_MODE).toBe(true);
    vi.unstubAllEnvs();
  });

  it('is false when WORKRAIL_DEV=0', async () => {
    vi.stubEnv('WORKRAIL_DEV', '0');
    const { DEV_MODE } = await import('../../../src/mcp/dev-mode.js');
    expect(DEV_MODE).toBe(false);
    vi.unstubAllEnvs();
  });

  it('is false when WORKRAIL_DEV is unset', async () => {
    vi.stubEnv('WORKRAIL_DEV', undefined as unknown as string);
    const { DEV_MODE } = await import('../../../src/mcp/dev-mode.js');
    expect(DEV_MODE).toBe(false);
    vi.unstubAllEnvs();
  });

  it('is false when WORKRAIL_DEV=true (non-strict string)', async () => {
    vi.stubEnv('WORKRAIL_DEV', 'true');
    const { DEV_MODE } = await import('../../../src/mcp/dev-mode.js');
    expect(DEV_MODE).toBe(false);
    vi.unstubAllEnvs();
  });
});
