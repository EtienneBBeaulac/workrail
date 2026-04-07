/**
 * Process-wide environment flags
 *
 * Evaluated once at module load. MCP servers are long-lived processes; env
 * vars are set at startup and do not change at runtime. Caching here
 * eliminates per-call process.env lookups on hot paths.
 *
 * Placed at src/ root so both src/mcp/** and src/v2/durable-core/** can
 * import without violating the layering constraint (v2/durable-core must not
 * import from src/mcp/**).
 *
 * Import individual named exports rather than the whole module to keep
 * tree-shaking straightforward.
 *
 * @module env-flags
 */

/**
 * When true, format execution responses as clean natural-language text
 * (the "transparent proxy" mode) rather than structured JSON. Controlled
 * by the WORKRAIL_CLEAN_RESPONSE_FORMAT environment variable.
 */
export const CLEAN_RESPONSE_FORMAT = process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT === 'true';
