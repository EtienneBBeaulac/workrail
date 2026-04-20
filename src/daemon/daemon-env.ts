/**
 * loadDaemonEnv -- load ~/.workrail/.env into process.env at daemon startup.
 *
 * WHY: secrets like WORKTRAIN_BOT_TOKEN live in .env so users don't have to
 * re-export them on every shell session or remember to pass them to --install.
 * Shell env always wins (we only set if not already set).
 *
 * WHY separate module: loadDaemonEnv is called from src/cli-worktrain.ts (the
 * composition root), but cli-worktrain.ts calls program.parse() at module level,
 * making it untestable via import. Extracting here lets tests import and exercise
 * the function directly without side effects.
 *
 * WHY optional deps: injectable I/O allows tests to control readFile and homedir
 * without ESM module mocking (vi.spyOn cannot redefine ESM namespace exports).
 * The composition root calls with no arguments (real defaults).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface LoadDaemonEnvDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly homedir: () => string;
}

const defaultDeps: LoadDaemonEnvDeps = {
  readFile: (p) => fs.promises.readFile(p, 'utf-8'),
  homedir: os.homedir,
};

export async function loadDaemonEnv(deps: LoadDaemonEnvDeps = defaultDeps): Promise<void> {
  const envPath = path.join(deps.homedir(), '.workrail', '.env');
  let content: string;
  try {
    content = await deps.readFile(envPath);
  } catch {
    return; // .env is optional -- missing is not an error
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
