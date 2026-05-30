/**
 * ClientUsageReader interface for the usage collection system.
 *
 * WHY modular interface: different MCP clients (Claude Code, Cursor, Antigravity, etc.)
 * store usage data in different formats and locations. A registry of readers allows
 * adding new clients by writing one file and adding one registry entry, with no changes
 * to the collection machinery.
 *
 * WHY separate from the engine: usage collection is best-effort observability.
 * It must never affect session correctness -- it is collected fire-and-forget after
 * run_completed is written.
 *
 * WHY ClientUsage is defined in durable-core: the projections layer must not import
 * from the MCP layer (architecture lock). Defining the shared type in durable-core
 * allows both layers to reference it without cross-boundary imports.
 */

// ClientUsage and TokenSnapshot are defined in durable-core to avoid a
// mcp -> v2/projections import cycle.
import type { ClientUsage, TokenSnapshot } from '../../v2/durable-core/schemas/session/usage.js';
import type { SessionId } from '../../v2/durable-core/ids/index.js';
export type { ClientUsage, TokenSnapshot };

/**
 * Request passed to SnapshotCapable.snapshotConversation.
 *
 * WHY a discriminated union instead of sessionId?: string:
 * - Makes the checkpoint phase explicit at the type level -- a caller cannot
 *   accidentally omit the sessionId at end time or provide one at start time.
 * - Replaces an optional primitive with a domain type. The 'end' variant
 *   carries a SessionId (branded, not a raw string) making misuse a compile
 *   error rather than a silent wrong-ID bug.
 */
export type SnapshotRequest =
  | {
      /** Start of workflow: session has not yet appeared in any tool call.
       *  No session ID verification is possible at this point. */
      readonly kind: 'start';
    }
  | {
      /** End of workflow: session ID is known and used to verify the JSONL
       *  file belongs to this session before accepting its token counts. */
      readonly kind: 'end';
      readonly sessionId: SessionId;
    };

/**
 * Interface for an MCP client that supports conversation-level token snapshots.
 *
 * Separate from ClientUsageReader because not all clients store token data in a
 * greppable local file. Clients implement this only when they can support it --
 * keeping ClientUsageReader's responsibility narrow (session-filtered usage after
 * the fact) vs SnapshotCapable's responsibility (point-in-time conversation total).
 *
 * WHY a separate interface (not an optional method on ClientUsageReader):
 * An optional method allows partial implementations that satisfy the type but
 * silently do nothing. A separate interface forces the caller to explicitly
 * check for the capability via isSnapshotCapable(), making the absence visible.
 */
export interface SnapshotCapable {
  snapshotConversation(workspacePath: string, request: SnapshotRequest): Promise<TokenSnapshot | null>;
}

/**
 * Type guard: true when a reader also implements SnapshotCapable.
 *
 * WHY a guard function (not a cast): callers that don't check get a compile
 * error when they try to call snapshotConversation on a plain ClientUsageReader.
 */
export function isSnapshotCapable(reader: ClientUsageReader): reader is ClientUsageReader & SnapshotCapable {
  return 'snapshotConversation' in reader && typeof (reader as unknown as Record<string, unknown>)['snapshotConversation'] === 'function';
}

/**
 * Interface for an MCP client that writes local usage logs.
 *
 * Responsibility: given a workspace path, return candidate directories to scan;
 * given a candidate file, session ID, and session start time, return summed usage or null.
 *
 * Implementors:
 * - ClaudeCodeUsageReader (src/mcp/client-usage/claude-code.ts)
 * - Future: CursorUsageReader, AntigravityUsageReader, etc.
 */
export interface ClientUsageReader {
  readonly clientName: string;

  /**
   * Return directories to scan for usage log files.
   *
   * WHY takes workspacePath: each client encodes the workspace into the directory path
   * differently. The reader knows how to derive the correct search directory.
   *
   * Returns an empty array if the client's log directory does not exist or is not applicable
   * for the given workspace path. Callers must handle empty arrays gracefully.
   */
  searchDirs(workspacePath: string): string[];

  /**
   * Parse a single log file and return summed usage for the given session, or null if
   * the session is not found in the file.
   *
   * WHY sessionId: the reader must confirm the file belongs to this session (e.g. by
   * grepping for the session ID in tool call payloads) before summing usage.
   *
   * WHY startMs: used to filter files by modification time -- only files modified after
   * session start are candidates. The reader may also use it to filter individual entries.
   *
   * Returns null if:
   * - The session ID is not found in the file
   * - The file cannot be parsed
   * - No assistant entries with usage data are present
   */
  parseUsage(filePath: string, sessionId: string, startMs: number): Promise<ClientUsage | null>;
}
