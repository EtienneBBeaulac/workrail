import type { AgentInternalMessage } from '../agent-loop.js';

/**
 * Delta-append new conversation messages to the JSONL conversation log.
 *
 * Fire-and-forget: schedules the async append and updates `lastFlushedRef.count`
 * synchronously. The caller must not await the result. Any append error is
 * silently swallowed -- conversation history is observability data, not crash
 * recovery state.
 *
 * WHY `appendFn` injectable: allows unit tests to verify the delta slice and
 * call count without touching real filesystem paths.
 *
 * WHY `lastFlushedRef` as an object: allows the counter to be shared by
 * reference across multiple turns without re-creating the closure.
 *
 * @param messages - Full current message array from the agent state.
 * @param lastFlushedRef - Mutable counter tracking how many messages were
 *   already flushed. Updated synchronously before the async append fires.
 * @param conversationPath - Absolute path to the .jsonl conversation log.
 * @param appendFn - Injectable append implementation. Defaults to the
 *   production `appendConversationMessages` from workflow-runner.ts.
 */
export function flushConversation(
  messages: ReadonlyArray<AgentInternalMessage>,
  lastFlushedRef: { count: number },
  conversationPath: string,
  appendFn: (path: string, messages: ReadonlyArray<AgentInternalMessage>) => Promise<void>,
): void {
  const newMessages = messages.slice(lastFlushedRef.count);
  lastFlushedRef.count = messages.length;
  void appendFn(conversationPath, newMessages).catch(() => {});
}
