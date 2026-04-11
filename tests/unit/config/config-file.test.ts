/**
 * Unit tests for loadWorkrailConfigFile.
 *
 * Uses a temporary HOME directory override via WORKRAIL_DATA_DIR-style patching.
 * Since the function hardcodes os.homedir(), we override os.homedir via vi.mock
 * and write real temp files so tests are isolated from the developer's real config.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Mocking approach ─────────────────────────────────────────────────────────
// We mock the `os` module so that `os.homedir()` returns a temp directory,
// isolating tests from the developer's real ~/.workrail/config.json.
// ─────────────────────────────────────────────────────────────────────────────

let tmpHome: string;

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  return {
    ...original,
    homedir: () => tmpHome ?? original.homedir(),
  };
});

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workrail-cfg-test-'));
  warnSpy.mockClear();
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function load() {
  const { loadWorkrailConfigFile } = await import('../../../src/config/config-file.js');
  return loadWorkrailConfigFile;
}

function writeConfig(content: string): void {
  const dir = path.join(tmpHome, '.workrail');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), content, 'utf-8');
}

describe('loadWorkrailConfigFile', () => {
  it('returns ok({}) when config file is absent', async () => {
    const loadWorkrailConfigFile = await load();
    // tmpHome has no .workrail/config.json

    const result = loadWorkrailConfigFile();

    expect(result.kind).toBe('ok');
    expect((result as Extract<typeof result, { kind: 'ok' }>).value).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns ok(parsed) for a valid config file', async () => {
    writeConfig(JSON.stringify({
      CACHE_TTL: '600000',
      WORKRAIL_LOG_LEVEL: 'INFO',
    }));
    const loadWorkrailConfigFile = await load();

    const result = loadWorkrailConfigFile();

    expect(result.kind).toBe('ok');
    const value = (result as Extract<typeof result, { kind: 'ok' }>).value;
    expect(value).toEqual({ CACHE_TTL: '600000', WORKRAIL_LOG_LEVEL: 'INFO' });
  });

  it('logs a warning and returns ok({}) for malformed JSON', async () => {
    writeConfig('{ invalid json }');
    const loadWorkrailConfigFile = await load();

    const result = loadWorkrailConfigFile();

    expect(result.kind).toBe('ok');
    expect((result as Extract<typeof result, { kind: 'ok' }>).value).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
  });

  it('logs a warning per unknown key and ignores it', async () => {
    writeConfig(JSON.stringify({
      CACHE_TTL: '300000',
      UNKNOWN_FLAG_XYZ: 'foo',
    }));
    const loadWorkrailConfigFile = await load();

    const result = loadWorkrailConfigFile();

    expect(result.kind).toBe('ok');
    const value = (result as Extract<typeof result, { kind: 'ok' }>).value;
    expect(value).toEqual({ CACHE_TTL: '300000' });
    expect(value).not.toHaveProperty('UNKNOWN_FLAG_XYZ');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('UNKNOWN_FLAG_XYZ'));
  });

  it('ignores GITHUB_TOKEN (treated as unknown key) and logs a warning', async () => {
    writeConfig(JSON.stringify({
      CACHE_TTL: '300000',
      GITHUB_TOKEN: 'ghp_secret',
    }));
    const loadWorkrailConfigFile = await load();

    const result = loadWorkrailConfigFile();

    expect(result.kind).toBe('ok');
    const value = (result as Extract<typeof result, { kind: 'ok' }>).value;
    expect(value).not.toHaveProperty('GITHUB_TOKEN');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GITHUB_TOKEN'));
  });

  it('ignores files where values are not all strings (unexpected shape)', async () => {
    writeConfig(JSON.stringify({ CACHE_TTL: 300000 })); // number, not string
    const loadWorkrailConfigFile = await load();

    const result = loadWorkrailConfigFile();

    expect(result.kind).toBe('ok');
    expect((result as Extract<typeof result, { kind: 'ok' }>).value).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'));
  });

  it('env override: config file values can be overridden by process.env (merge contract)', async () => {
    writeConfig(JSON.stringify({
      CACHE_TTL: '300000',
      WORKRAIL_LOG_LEVEL: 'DEBUG',
    }));
    const loadWorkrailConfigFile = await load();

    const result = loadWorkrailConfigFile();
    expect(result.kind).toBe('ok');
    const fileValues = (result as Extract<typeof result, { kind: 'ok' }>).value;

    // Caller is responsible for the merge (happens in container.ts)
    const processEnvOverride: Record<string, string> = { CACHE_TTL: '999999' };
    const merged = { ...fileValues, ...processEnvOverride };

    expect(merged['CACHE_TTL']).toBe('999999');        // process.env wins
    expect(merged['WORKRAIL_LOG_LEVEL']).toBe('DEBUG'); // config file survives
  });
});
