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

// ClientUsage is defined in durable-core to avoid a mcp -> v2/projections import cycle.
import type { ClientUsage } from '../../v2/durable-core/schemas/session/usage.js';
export type { ClientUsage };

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
