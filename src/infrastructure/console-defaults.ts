/**
 * Default port for the worktrain console UI.
 *
 * This constant is the de-facto standard port for `worktrain console`.
 * It is used as a fallback when the daemon-console.lock file is absent
 * or cannot be parsed.
 *
 * Follows the DEFAULT_MCP_PORT pattern established in mcp-server.ts.
 */
export const DEFAULT_CONSOLE_PORT = 3456;
