/**
 * Claude Code usage reader.
 *
 * Claude Code writes per-conversation JSONL files to:
 *   ~/.claude/projects/<encoded-workspace-path>/<conversation-uuid>.jsonl
 *
 * Each line is a JSON object. Lines with type='assistant' contain a message.usage
 * object with input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, and a message.model field.
 *
 * Detection strategy: grep each candidate file for the WorkRail session ID.
 * The session ID (sess_...) appears in tool call inputs (e.g. in continueToken
 * parameters passed to mcp__workrail__* tools). Files that contain the session ID
 * are the conversation files for this WorkRail session.
 *
 * WHY grep for session ID (not timestamp-only matching): a JSONL file covers one
 * Claude Code conversation. A single conversation may span multiple WorkRail sessions.
 * Timestamp filtering narrows candidates; session ID grep confirms membership.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientUsage, ClientUsageReader } from './types.js';
import type { TokenSnapshot } from '../../v2/durable-core/schemas/session/usage.js';

/**
 * Shape of an assistant message in Claude Code's JSONL format.
 * Only the fields we care about are declared; unknown fields are ignored (strip mode).
 */
interface ClaudeCodeAssistantEntry {
  readonly type: 'assistant';
  readonly message: {
    readonly model?: string;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_creation_input_tokens?: number;
      readonly cache_read_input_tokens?: number;
    };
  };
}

/**
 * Encode a workspace path to a Claude Code project directory name.
 *
 * Claude Code replaces each path separator with a hyphen.
 * Example: /Users/etienneb/git/personal/workrail
 *       -> -Users-etienneb-git-personal-workrail
 * Example (Windows):   C:\Users\etienneb\git\workrail
 *                   -> C:-Users-etienneb-git-workrail
 *
 * WHY both separators: Claude Code runs on macOS and Windows. On Windows, Node.js
 * path functions return backslash-separated paths. Claude Code uses the same
 * replace-separators-with-hyphens encoding on all platforms.
 */
function encodeWorkspacePath(workspacePath: string): string {
  return workspacePath.replace(/[/\\]/g, '-');
}

/**
 * Check whether a raw JSONL line is an assistant entry.
 * Returns the typed entry or null if it does not match.
 *
 * Pure function: no I/O, validates structure at the boundary.
 */
function parseAssistantEntry(raw: unknown): ClaudeCodeAssistantEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj['type'] !== 'assistant') return null;
  const message = obj['message'];
  if (typeof message !== 'object' || message === null) return null;
  return { type: 'assistant', message: message as ClaudeCodeAssistantEntry['message'] };
}

/**
 * Sum all assistant entry usage fields from a JSONL file.
 * Returns null if no assistant entries with usage data were found.
 *
 * Pure function over the parsed lines: no I/O once the content is provided.
 *
 * WHY deduplication: Claude Code double-writes each turn -- once when the API
 * response arrives and again after tool names are resolved. Both writes have
 * identical usage blocks. Empirically ~35% of entries are duplicates.
 * Deduplication rule: skip entry[i] if entry[i+1] has the same usage block.
 */
function sumUsageFromLines(lines: string[], clientName: string): ClientUsage | null {
  const entries: ClaudeCodeAssistantEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const entry = parseAssistantEntry(parsed);
    if (entry?.message.usage) {
      entries.push(entry);
    }
  }

  if (entries.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let turns = 0;
  let model: string | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const next = entries[i + 1];
    const usage = entry.message.usage!;

    // Skip stale first-write: Claude Code appends the same turn twice when tool
    // names are resolved. Both copies have identical usage blocks; keep the last.
    if (next?.message.usage &&
        next.message.usage.input_tokens === usage.input_tokens &&
        next.message.usage.output_tokens === usage.output_tokens &&
        next.message.usage.cache_read_input_tokens === usage.cache_read_input_tokens &&
        next.message.usage.cache_creation_input_tokens === usage.cache_creation_input_tokens) {
      continue;
    }

    inputTokens += usage.input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
    cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    turns += 1;

    if (entry.message.model) {
      model = entry.message.model;
    }
  }

  if (turns === 0) return null;

  return {
    client: clientName,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    turns,
  };
}

/**
 * Sum token usage from lines without client attribution -- for snapshot use.
 * Applies the same deduplication as sumUsageFromLines.
 * Returns null if no usable entries found.
 */
function sumSnapshotFromLines(lines: string[]): TokenSnapshot | null {
  const result = sumUsageFromLines(lines, '');
  if (!result) return null;
  return {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    turns: result.turns,
  };
}

export class ClaudeCodeUsageReader implements ClientUsageReader {
  readonly clientName = 'claude-code';

  constructor(
    // Allows injecting a custom home directory in tests.
    private readonly homeDir: string = homedir(),
  ) {}

  searchDirs(workspacePath: string): string[] {
    const encoded = encodeWorkspacePath(workspacePath);
    const dir = join(this.homeDir, '.claude', 'projects', encoded);
    return [dir];
  }

  async parseUsage(filePath: string, sessionId: string, startMs: number): Promise<ClientUsage | null> {
    let content: string;
    try {
      // Check modification time: skip files not modified since session start.
      // WHY: narrows candidates cheaply before doing a full file read.
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < startMs) return null;

      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      // File missing or unreadable -- not an error condition (another client may have
      // deleted or rotated the file). Return null to skip.
      return null;
    }

    // Check for session ID presence (fast string search before line parsing).
    // WHY: the session ID appears in tool call inputs in the JSONL content.
    // Files that do not contain the session ID do not belong to this session.
    if (!content.includes(sessionId)) return null;

    const lines = content.split('\n');
    return sumUsageFromLines(lines, this.clientName);
  }

  /**
   * Snapshot the current conversation's cumulative token usage.
   *
   * Finds the most recently modified JSONL in the project directory (the active
   * conversation), reads all assistant entries, applies deduplication, and returns
   * the total. Returns null when the directory does not exist or contains no files.
   *
   * WHY most-recently-modified: the active Claude Code conversation is the file
   * being written to right now. In the overwhelmingly common single-session case,
   * it is the only recently modified file.
   *
   * WHY optional sessionId: at start_workflow time the session hasn't been used in
   * any tool call yet, so no verification is possible. At end time the sessionId is
   * available and used to confirm the file belongs to this session, mitigating the
   * multiple-active-sessions edge case.
   */
  async snapshotCurrentConversation(
    workspacePath: string,
    sessionId?: string,
  ): Promise<TokenSnapshot | null> {
    const dirs = this.searchDirs(workspacePath);
    if (dirs.length === 0) return null;

    const dir = dirs[0];
    let files: import('node:fs').Dirent[];
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    const jsonlFiles = files.filter(f => f.isFile() && f.name.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) return null;

    // Pick the most recently modified JSONL file.
    let latestFile: string | null = null;
    let latestMtime = 0;
    for (const f of jsonlFiles) {
      try {
        const stat = await fs.stat(join(dir, f.name));
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestFile = join(dir, f.name);
        }
      } catch {
        // Skip unreadable files
      }
    }
    if (!latestFile) return null;

    let content: string;
    try {
      content = await fs.readFile(latestFile, 'utf-8');
    } catch {
      return null;
    }

    // When sessionId is provided, verify the file belongs to this session.
    // WHY: guards against picking up a different active conversation in the
    // rare case of multiple active Claude Code sessions for the same workspace.
    if (sessionId && !content.includes(sessionId)) return null;

    return sumSnapshotFromLines(content.split('\n'));
  }
}

/**
 * Default singleton for use in production.
 * Created once at module load time; no mutable state.
 */
export const claudeCodeUsageReader = new ClaudeCodeUsageReader();
