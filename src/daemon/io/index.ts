/**
 * Barrel re-export for src/daemon/io/.
 *
 * Import boundary: io/ files may import node: modules (that is their purpose)
 * but must NOT import from @anthropic-ai/sdk, @anthropic-ai/bedrock-sdk,
 * session-scope.ts, or active-sessions.ts. This is enforced by the architecture
 * test in tests/unit/architecture-boundaries.test.ts.
 *
 * Allowed type imports: io/ may import types from agent-loop.ts (e.g.,
 * AgentInternalMessage for appendConversationMessages). These are type-only
 * imports that are erased at compile time and create no runtime coupling
 * to the AgentLoop class or session management infrastructure.
 */

export { loadDaemonSoul, WORKRAIL_DIR, DAEMON_SOUL_DEFAULT, DAEMON_SOUL_TEMPLATE } from './soul-loader.js';
export {
  loadWorkspaceContext,
  stripFrontmatter,
  WORKSPACE_CONTEXT_MAX_BYTES,
  MAX_GLOB_FILES_PER_PATTERN,
  WORKSPACE_CONTEXT_CANDIDATE_PATHS,
} from './workspace-context-loader.js';
export { loadSessionNotes, MAX_SESSION_RECAP_NOTES, MAX_SESSION_NOTE_CHARS } from './session-notes-loader.js';
export { appendConversationMessages } from './conversation-log.js';
export { writeExecutionStats, writeStuckOutboxEntry, DAEMON_STATS_DIR } from './execution-stats.js';
