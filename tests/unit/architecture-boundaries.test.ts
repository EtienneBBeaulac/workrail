import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Architecture boundaries', () => {
  it('does not allow DI container usage inside application services', async () => {
    const servicesDir = path.resolve(__dirname, '../../src/application/services');
    const files = await listFilesRecursive(servicesDir);

    const offenders: Array<{ file: string; reason: string }> = [];

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');

      if (/from\s+['"](\.\.\/)+di\/container(\.js)?['"]/.test(content)) {
        offenders.push({ file, reason: 'imports src/di/container' });
      }

      if (/import\s*\{\s*container\s*\}\s*from\s*['"]tsyringe['"]/.test(content)) {
        offenders.push({ file, reason: 'imports tsyringe.container' });
      }

      if (/\bcontainer\.resolve\b|\bcontainer\.register\b|\bcontainer\.createChildContainer\b/.test(content)) {
        offenders.push({ file, reason: 'calls container.*' });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not allow v2 durable-core to import MCP wiring', async () => {
    const v2CoreDir = path.resolve(__dirname, '../../src/v2/durable-core');
    const files = await listFilesRecursive(v2CoreDir);

    const offenders: Array<{ file: string; reason: string }> = [];

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');

      // Any import that reaches into src/mcp is a layering violation.
      if (/\bfrom\s+['"][^'"]*\/mcp\/[^'"]*['"]/.test(content) || /\bfrom\s+['"]\.\.\/\.\.\/mcp\//.test(content)) {
        offenders.push({ file, reason: 'imports from src/mcp/**' });
      }
    }

    expect(offenders).toEqual([]);
  });
});
