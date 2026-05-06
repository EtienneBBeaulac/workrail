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

// ---------------------------------------------------------------------------
// Daemon functional core boundary enforcement
// ---------------------------------------------------------------------------
//
// src/daemon/core/ (excluding agent-client.ts) and src/daemon/state/ must have
// no node: or @anthropic-ai/* imports. These modules are the functional core --
// they must be importable in any test context without I/O stubs.
//
// agent-client.ts is excluded because it constructs SDK client objects
// (its entire purpose is to import and wrap the SDK clients).

describe('Daemon functional core boundary enforcement', () => {
  const DAEMON_CORE_DIR = path.resolve(__dirname, '../../src/daemon/core');
  const DAEMON_STATE_DIR = path.resolve(__dirname, '../../src/daemon/state');

  // Extended to cover all Node.js built-ins that would violate the no-I/O invariant.
  // Covers: node: prefix, and bare module names for common built-ins without the prefix.
  const NODE_IMPORT_PATTERN = /\bfrom\s+['"](?:node:|fs['"\/]|path['"]|os['"]|child_process['"]|crypto['"]|util['"]|events['"]|stream['"]|buffer['"]|url['"]|assert['"]|timers['"])/;
  const SDK_IMPORT_PATTERN = /\bfrom\s+['"]@anthropic-ai\//;

  async function checkDirectory(dir: string, excludeFile?: string): Promise<Array<{ file: string; violation: string }>> {
    const violations: Array<{ file: string; violation: string }> = [];
    let files: string[];
    try {
      files = await listFilesRecursive(dir);
    } catch {
      return []; // directory does not exist yet
    }

    for (const file of files) {
      const relativePath = path.relative(dir, file);
      if (excludeFile && relativePath === excludeFile) continue;

      const content = await fs.readFile(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (NODE_IMPORT_PATTERN.test(line)) {
          violations.push({ file: path.relative(path.resolve(__dirname, '../..'), file), violation: `line ${i + 1}: node: import -- ${line.trim()}` });
        }
        if (SDK_IMPORT_PATTERN.test(line)) {
          violations.push({ file: path.relative(path.resolve(__dirname, '../..'), file), violation: `line ${i + 1}: @anthropic-ai/* import -- ${line.trim()}` });
        }
      }
    }
    return violations;
  }

  it('src/daemon/core/ (excluding agent-client.ts) has no node: or @anthropic-ai/* imports', async () => {
    const violations = await checkDirectory(DAEMON_CORE_DIR, 'agent-client.ts');
    if (violations.length > 0) {
      expect.fail(
        `Forbidden imports in daemon functional core:\n` +
        violations.map((v) => `  ${v.file}: ${v.violation}`).join('\n') +
        `\n\nDaemon core/ (except agent-client.ts) must have no node: or SDK imports.` +
        `\nMove I/O functions to src/daemon/io/ or src/daemon/runner/ instead.`,
      );
    }
  });

  it('src/daemon/state/ has no node: or @anthropic-ai/* imports', async () => {
    const violations = await checkDirectory(DAEMON_STATE_DIR);
    if (violations.length > 0) {
      expect.fail(
        `Forbidden imports in daemon state layer:\n` +
        violations.map((v) => `  ${v.file}: ${v.violation}`).join('\n') +
        `\n\nDaemon state/ must have no node: or SDK imports.` +
        `\nState types and transitions are pure; keep them free of I/O.`,
      );
    }
  });

  it('src/daemon/state/ does not import from src/daemon/core/', async () => {
    // WHY: core/ may depend on state/ (e.g. buildSessionResult reads SessionState).
    // The reverse direction (state/ importing from core/) would create a cycle.
    let files: string[];
    try {
      files = await listFilesRecursive(DAEMON_STATE_DIR);
    } catch {
      return;
    }
    const violations: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/\bfrom\s+['"].*\/core\//.test(lines[i]!)) {
          violations.push({ file: path.relative(path.resolve(__dirname, '../..'), file), line: i + 1, text: lines[i]!.trim() });
        }
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `state/ imports from core/ (forbidden direction):\n` +
        violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n'),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Daemon io/ boundary enforcement
// ---------------------------------------------------------------------------
//
// src/daemon/io/ is the I/O layer. It may import node: modules and types from
// agent-loop.ts (e.g., AgentInternalMessage for appendConversationMessages).
// It must NOT import SDK client construction packages or session-management
// modules (session-scope.ts, active-sessions.ts).

describe('Daemon io/ boundary enforcement', () => {
  const DAEMON_IO_DIR = path.resolve(__dirname, '../../src/daemon/io');

  async function checkIoDirectory(): Promise<Array<{ file: string; violation: string }>> {
    const violations: Array<{ file: string; violation: string }> = [];
    let files: string[];
    try {
      files = await listFilesRecursive(DAEMON_IO_DIR);
    } catch {
      return [];
    }
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const rel = path.relative(path.resolve(__dirname, '../..'), file);
        if (/\bfrom\s+['"]@anthropic-ai\/sdk['"]/.test(line)) {
          violations.push({ file: rel, violation: `line ${i + 1}: @anthropic-ai/sdk import -- ${line.trim()}` });
        }
        if (/\bfrom\s+['"]@anthropic-ai\/bedrock-sdk['"]/.test(line)) {
          violations.push({ file: rel, violation: `line ${i + 1}: @anthropic-ai/bedrock-sdk import -- ${line.trim()}` });
        }
        if (/\bfrom\s+['"].*\/session-scope(\.js)?['"]/.test(line)) {
          violations.push({ file: rel, violation: `line ${i + 1}: session-scope import -- ${line.trim()}` });
        }
        if (/\bfrom\s+['"].*\/active-sessions(\.js)?['"]/.test(line)) {
          violations.push({ file: rel, violation: `line ${i + 1}: active-sessions import -- ${line.trim()}` });
        }
      }
    }
    return violations;
  }

  it('src/daemon/io/ does not import SDK clients or session-management modules', async () => {
    const violations = await checkIoDirectory();
    if (violations.length > 0) {
      expect.fail(
        `Forbidden imports in daemon io/ layer:\n` +
        violations.map((v) => `  ${v.file}: ${v.violation}`).join('\n') +
        `\n\nio/ is the I/O boundary layer. It may not construct SDK clients or` +
        `\nmanage session state. Move session-dependent code to src/daemon/runner/ instead.`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Daemon runner/ boundary enforcement
// ---------------------------------------------------------------------------
//
// src/daemon/runner/ is the orchestration layer. It may import from io/, state/,
// core/, tools/, and agent-loop.ts. It must NOT import runWorkflow from
// workflow-runner.ts at runtime (that would create a circular dependency since
// workflow-runner.ts calls runner/ functions and defines runWorkflow).

describe('Daemon runner/ boundary enforcement', () => {
  const DAEMON_RUNNER_DIR = path.resolve(__dirname, '../../src/daemon/runner');

  it('src/daemon/runner/ does not import runWorkflow from workflow-runner.ts', async () => {
    let files: string[];
    try {
      files = await listFilesRecursive(DAEMON_RUNNER_DIR);
    } catch {
      return; // directory does not exist yet
    }
    const violations: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Match runtime import of runWorkflow from workflow-runner (not type-only)
        if (/\bimport\s*\{[^}]*\brunWorkflow\b/.test(line) && /workflow-runner/.test(line) && !/\bimport\s+type\b/.test(line)) {
          violations.push({
            file: path.relative(path.resolve(__dirname, '../..'), file),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }
    if (violations.length > 0) {
      expect.fail(
        `runner/ imports runWorkflow from workflow-runner.ts at runtime:\n` +
        violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n') +
        `\n\nThis creates a circular dependency. Inject runWorkflow as a parameter instead.`,
      );
    }
  });
});
