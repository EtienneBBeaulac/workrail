/**
 * Conversation log writer for daemon agent sessions.
 *
 * WHY this module: appendConversationMessages() is an I/O function that writes
 * the agent's conversation history to a per-session JSONL file. It has no session
 * state or agent loop dependencies beyond the message type from agent-loop.ts.
 * It belongs in the io/ layer.
 *
 * WHY this module imports AgentInternalMessage from agent-loop.ts: the function
 * signature requires the message type for type safety. This is a type-only
 * dependency -- no AgentLoop CLASS is constructed here.
 *
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentInternalMessage } from '../agent-loop.js';

/**
 * Append a batch of AgentInternalMessage values to a per-session conversation JSONL file.
 *
 * WHY fire-and-forget: conversation history is observability/crash-recovery data. A write
 * failure must never affect the agent loop. Callers invoke this as void + .catch(() => {}).
 *
 * WHY JSONL (one JSON object per line): enables incremental delta appends, crash-tolerant
 * reads (discard the last line if it is not valid JSON), and direct jq inspection.
 *
 * WHY append-only: preserves the valid prefix even if the daemon crashes mid-write.
 *
 * @param filePath - Absolute path to the .jsonl file (created on first call if absent).
 * @param messages - New messages since the last flush (the delta for this turn).
 */
export async function appendConversationMessages(
  filePath: string,
  messages: ReadonlyArray<AgentInternalMessage>,
): Promise<void> {
  if (messages.length === 0) return;
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, lines, 'utf8');
}
