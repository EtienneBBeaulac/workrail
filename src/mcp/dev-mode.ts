/**
 * Single dev-mode flag for all WorkRail development features.
 *
 * Set WORKRAIL_DEV=1 to enable:
 * - Staleness signal for all workflow categories (including built-in)
 * - Structured tool-call timing emitted to stderr after each MCP call
 * - /api/v2/perf/tool-calls endpoint in the console API
 *
 * Intended for local development and performance investigation.
 * Not documented for production use.
 */
export const DEV_MODE: boolean = process.env['WORKRAIL_DEV'] === '1';
