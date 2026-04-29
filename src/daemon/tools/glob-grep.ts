/**
 * Factories for the Glob and Grep tools used in daemon agent sessions.
 *
 * Extracted from workflow-runner.ts. Zero behavior change.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { glob as tinyGlob } from 'tinyglobby';
import type { AgentTool, AgentToolResult } from '../agent-loop.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import { GLOB_ALWAYS_EXCLUDE, withWorkrailSession } from './_shared.js';

const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeGlobTool(workspacePath: string, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Glob',
    description:
      'Find files matching a glob pattern. Returns newline-separated relative file paths, sorted by modification time descending. ' +
      'node_modules, .git, dist, and build directories are always excluded. ' +
      'Results are capped at 100 files.',
    inputSchema: schemas['GlobParams'],
    label: 'Glob',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.pattern !== 'string' || !params.pattern) throw new Error('Glob: pattern must be a non-empty string');
      const pattern: string = params.pattern;
      const searchRoot: string = params.path ?? workspacePath;
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Glob', summary: pattern.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      const GLOB_LIMIT = 100;

      let paths: string[];
      try {
        paths = await tinyGlob(pattern, {
          cwd: searchRoot,
          ignore: GLOB_ALWAYS_EXCLUDE,
          absolute: false,
        });
      } catch {
        // Non-existent search root or invalid pattern returns empty
        paths = [];
      }

      // Sort by mtime descending (most recently modified first)
      const withMtimes = await Promise.all(
        paths.map(async (p) => {
          try {
            const stat = await fs.stat(path.join(searchRoot, p));
            return { p, mtime: stat.mtimeMs };
          } catch {
            return { p, mtime: 0 };
          }
        }),
      );
      withMtimes.sort((a, b) => b.mtime - a.mtime);

      const sorted = withMtimes.map(x => x.p);
      const truncated = sorted.length > GLOB_LIMIT;
      const result = sorted.slice(0, GLOB_LIMIT);

      let text = result.join('\n');
      if (truncated) {
        text += '\n[Results truncated at 100 files]';
      }

      return {
        content: [{ type: 'text', text: text || '(no matches)' }],
        details: { pattern, searchRoot, matchCount: sorted.length, truncated },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeGrepTool(workspacePath: string, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Grep',
    description:
      'Search file contents using ripgrep (rg). Fast regex search with optional context lines, file-type filtering, and case-insensitive mode. ' +
      'output_mode: "files_with_matches" (default) returns only file paths; "content" returns matching lines; "count" returns match counts per file. ' +
      'node_modules and .git are always excluded.',
    inputSchema: schemas['GrepParams'],
    label: 'Grep',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.pattern !== 'string' || !params.pattern) throw new Error('Grep: pattern must be a non-empty string');
      const pattern: string = params.pattern;
      const searchPath: string = params.path ?? workspacePath;
      const outputMode: string = params.output_mode ?? 'files_with_matches';
      const headLimit: number = params.head_limit ?? 250;
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Grep', summary: pattern.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      const args: string[] = [
        '--hidden',
        '--glob', '!node_modules',
        '--glob', '!.git',
        '--max-columns', '500',
      ];

      if (params['-i']) args.push('-i');
      if (params.glob) { args.push('--glob', params.glob); }
      if (params.type) { args.push('--type', params.type); }

      switch (outputMode) {
        case 'files_with_matches':
          args.push('--files-with-matches');
          break;
        case 'count':
          args.push('--count');
          break;
        case 'content':
          args.push('--vimgrep');
          if (params.context != null) { args.push('-C', String(params.context)); }
          break;
      }

      args.push('--', pattern, searchPath);

      let stdout: string;
      try {
        const result = await execFileAsync('rg', args, { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 });
        stdout = result.stdout;
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
        // ENOENT: rg binary not found
        if (nodeErr.code === 'ENOENT') {
          throw new Error(
            'ripgrep (rg) is not installed. Install it with: brew install ripgrep (macOS) or apt install ripgrep (Ubuntu/Debian).',
          );
        }
        // exit code 1 from rg means "no matches found" -- not an error
        if (typeof nodeErr.code === 'number' && nodeErr.code === 1) {
          return {
            content: [{ type: 'text', text: '(no matches)' }],
            details: { pattern, searchPath, outputMode },
          };
        }
        throw new Error(`rg failed: ${nodeErr.message ?? String(err)}`);
      }

      // Apply head_limit
      const lines = stdout.split('\n').filter(l => l.length > 0);
      const truncated = lines.length > headLimit;
      let result = lines.slice(0, headLimit).join('\n');
      if (truncated) {
        result += `\n[Results truncated at ${headLimit} lines. Use a more specific pattern or increase head_limit.]`;
      }

      return {
        content: [{ type: 'text', text: result || '(no matches)' }],
        details: { pattern, searchPath, outputMode, lineCount: lines.length, truncated },
      };
    },
  };
}
