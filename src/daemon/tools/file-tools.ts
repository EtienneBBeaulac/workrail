/**
 * Factories for the Read, Write, and Edit tools used in daemon agent sessions.
 *
 * These three tools share the `readFileState` Map for read-before-write enforcement.
 * Extracted from workflow-runner.ts. Zero behavior change.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentTool, AgentToolResult } from '../agent-loop.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import type { ReadFileState } from '../workflow-runner.js';
import { READ_SIZE_CAP_BYTES, findActualString, withWorkrailSession } from './_shared.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeReadTool(workspacePath: string, readFileState: Map<string, ReadFileState>, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Read',
    description:
      'Read the contents of a file at the given absolute path. ' +
      'Content is returned in cat -n format: each line is prefixed with its 1-indexed line number and a tab character (e.g. "1\\tline one\\n2\\tline two"). ' +
      'Use offset (0-indexed start line) and limit (max lines) to read a slice of a large file.',
    inputSchema: schemas['ReadParams'],
    label: 'Read',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.filePath !== 'string' || !params.filePath) throw new Error('Read: filePath must be a non-empty string');
      const filePath: string = params.filePath;
      // Enforce workspace boundary: prevent reads outside the workspace
      const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);
      if (!absoluteFilePath.startsWith(workspacePath)) {
        throw new Error(`Read target is outside the workspace: ${filePath}`);
      }
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Read', summary: filePath.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      // Block device paths to prevent reads from infinite streams
      const devPaths = ['/dev/stdin', '/dev/tty', '/dev/zero', '/dev/random', '/dev/full', '/dev/urandom'];
      if (devPaths.some(d => filePath === d)) {
        throw new Error(`Refusing to read device path: ${filePath}`);
      }

      const stat = await fs.stat(filePath);
      const offset: number = params.offset ?? 0;
      const limit: number | undefined = params.limit;
      const isPaginated = params.offset !== undefined || params.limit !== undefined;
      if (!isPaginated && stat.size > READ_SIZE_CAP_BYTES) {
        throw new Error(
          `File is too large to read at once (${stat.size} bytes, cap is ${READ_SIZE_CAP_BYTES} bytes). ` +
          `Use offset and limit parameters to read a specific range of lines.`,
        );
      }

      const rawContent = await fs.readFile(filePath, 'utf8');
      const allLines = rawContent.split('\n');
      const isPartialView = offset !== 0 || limit != null;

      const slicedLines = limit != null ? allLines.slice(offset, offset + limit) : allLines.slice(offset);
      const startLine = offset; // 0-indexed offset -> 1-indexed line numbers start at offset+1
      const formatted = slicedLines.map((l, i) => `${startLine + i + 1}\t${l}`).join('\n');

      // Store in readFileState so Edit and Write can enforce staleness checks
      readFileState.set(filePath, { content: rawContent, timestamp: stat.mtimeMs, isPartialView });

      return {
        content: [{ type: 'text', text: formatted }],
        details: { filePath, totalLines: allLines.length, returnedLines: slicedLines.length, offset, isPartialView },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeWriteTool(workspacePath: string, readFileState: Map<string, ReadFileState>, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Write',
    description:
      'Write content to a file at the given absolute path. Creates parent directories if needed. ' +
      'For existing files: the file must have been read in this session and must not have changed on disk since then. ' +
      'For new files (path does not exist): no prior read is required.',
    inputSchema: schemas['WriteParams'],
    label: 'Write',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.filePath !== 'string' || !params.filePath) throw new Error('Write: filePath must be a non-empty string');
      if (typeof params.content !== 'string') throw new Error('Write: content must be a string');
      const filePath: string = params.filePath;
      // Enforce workspace boundary: prevent writes outside the workspace
      const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);
      if (!absoluteFilePath.startsWith(workspacePath)) {
        throw new Error(`Write target is outside the workspace: ${filePath}`);
      }
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Write', summary: filePath.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      // Staleness guard: only for existing files. New files bypass the check entirely.
      // WHY: a new file has never been read, so there is nothing stale to guard against.
      let existsOnDisk = false;
      try {
        await fs.access(filePath);
        existsOnDisk = true;
      } catch {
        // File does not exist -- new file, no guard needed
      }

      if (existsOnDisk) {
        const state = readFileState.get(filePath);
        if (!state) {
          throw new Error(
            `File has not been read in this session. Call Read first before writing to it: ${filePath}`,
          );
        }
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs !== state.timestamp) {
          throw new Error(
            `File has been modified since it was read. Re-read before writing: ${filePath}`,
          );
        }
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content, 'utf8');

      // Update readFileState so a subsequent Edit/Write sees the new mtime
      const newStat = await fs.stat(filePath);
      readFileState.set(filePath, { content: params.content, timestamp: newStat.mtimeMs, isPartialView: false });

      return {
        content: [{ type: 'text', text: `Written ${params.content.length} bytes to ${filePath}` }],
        details: { filePath, length: params.content.length },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeEditTool(workspacePath: string, readFileState: Map<string, ReadFileState>, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Edit',
    description:
      'Perform an exact string replacement in a file. ' +
      'The file must have been read in this session via the Read tool. ' +
      'By default, old_string must appear exactly once; use replace_all=true to replace all occurrences. ' +
      'Do NOT include line-number prefixes (e.g. "1\\t") from Read output in old_string or new_string.',
    inputSchema: schemas['EditParams'],
    label: 'Edit',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.file_path !== 'string' || !params.file_path) throw new Error('Edit: file_path must be a non-empty string');
      if (typeof params.old_string !== 'string') throw new Error('Edit: old_string must be a string');
      if (typeof params.new_string !== 'string') throw new Error('Edit: new_string must be a string');
      const rawFilePath: string = params.file_path;
      const absoluteFilePath = path.isAbsolute(rawFilePath)
        ? rawFilePath
        : path.join(workspacePath, rawFilePath);
      // Enforce workspace boundary: prevent edits outside the workspace
      if (!absoluteFilePath.startsWith(workspacePath)) {
        throw new Error(`Edit target is outside the workspace: ${rawFilePath}`);
      }
      const filePath: string = absoluteFilePath;
      const oldString: string = params.old_string;
      const newString: string = params.new_string;
      const replaceAll: boolean = params.replace_all ?? false;

      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Edit', summary: filePath.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      // Validate that old_string and new_string differ
      if (oldString === newString) {
        throw new Error('old_string and new_string are identical. No edit needed.');
      }

      // Read-before-write enforcement
      const state = readFileState.get(filePath);
      if (!state) {
        throw new Error(
          `File has not been read in this session. Call Read first before editing: ${filePath}`,
        );
      }

      // Staleness check
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(filePath);
      } catch {
        throw new Error(`File not found: ${filePath}. It may have been deleted after it was read.`);
      }
      if (stat.mtimeMs !== state.timestamp) {
        throw new Error(
          `File has been modified since it was read. Re-read before editing: ${filePath}`,
        );
      }

      const currentContent = await fs.readFile(filePath, 'utf8');

      // Find the actual string to replace (with optional curly-quote normalization)
      const actualString = findActualString(currentContent, oldString);
      if (actualString === null) {
        throw new Error(
          `String to replace not found in file. Make sure old_string exactly matches the file content ` +
          `(do not include line-number prefixes from Read output): ${filePath}`,
        );
      }

      // Count occurrences
      const occurrences = currentContent.split(actualString).length - 1;
      if (!replaceAll && occurrences > 1) {
        throw new Error(
          `old_string appears ${occurrences} times in the file. ` +
          `Provide a more specific string that matches exactly once, or set replace_all=true to replace all occurrences.`,
        );
      }

      // Apply the replacement
      const updatedContent = replaceAll
        ? currentContent.split(actualString).join(newString)
        : currentContent.replace(actualString, newString);

      await fs.writeFile(filePath, updatedContent, 'utf8');

      // Update readFileState with new content and new mtime
      const newStat = await fs.stat(filePath);
      readFileState.set(filePath, { content: updatedContent, timestamp: newStat.mtimeMs, isPartialView: false });

      return {
        content: [{ type: 'text', text: `The file ${filePath} has been updated successfully.` }],
        details: { filePath, occurrencesReplaced: occurrences },
      };
    },
  };
}
