/**
 * Git metrics types for engine-side authoritative diff collection.
 *
 * WHY re-export from durable-core: GitEvidence is a shared type used by both
 * the projections layer (session-metrics.ts) and the MCP git-metrics module.
 * The architecture lock forbids projections from importing from MCP, so the
 * canonical definition lives in durable-core (same pattern as ClientUsage/TokenSnapshot).
 *
 * See src/v2/durable-core/schemas/session/git-evidence.ts for the authoritative definition.
 */

export type {
  GitEvidence,
  GitCommittedDiff,
  GitWorkingTreeState,
} from '../../v2/durable-core/schemas/session/git-evidence.js';
