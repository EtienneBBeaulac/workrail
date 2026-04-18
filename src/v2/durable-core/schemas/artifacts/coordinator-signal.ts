import { z } from 'zod';

/**
 * Coordinator Signal Artifact Schema (v1)
 *
 * Typed artifact for mid-session signaling from an agent to its coordinator.
 * Agents emit this artifact to surface progress updates, intermediate findings,
 * data requests, approval requests, or blocking conditions without stopping
 * the session.
 *
 * NOTE on naming:
 *   - `kind: 'wr.coordinator_signal'` is the discriminator field in the artifact object.
 *   - `COORDINATOR_SIGNAL_CONTRACT_REF = 'wr.contracts.coordinator_signal'` is the
 *     contract reference used in workflow YAML (`output.contractRef`) and in
 *     `ARTIFACT_CONTRACT_REFS`. These are distinct identifiers that serve different roles.
 *
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 * Related: docs/ideas/design-mid-session-signaling.md (Selected Direction: D + A)
 *
 * Example usage in workflow:
 * ```json
 * {
 *   "id": "signal-step",
 *   "prompt": "Signal your coordinator with findings.",
 *   "output": {
 *     "contractRef": "wr.contracts.coordinator_signal"
 *   }
 * }
 * ```
 *
 * Agent provides:
 * ```json
 * {
 *   "artifacts": [{
 *     "kind": "wr.coordinator_signal",
 *     "signalKind": "finding",
 *     "payload": { "summary": "Found 3 critical issues in module A" }
 *   }]
 * }
 * ```
 */

/**
 * Contract reference for coordinator signal artifacts.
 * Used in workflow step definitions to declare the required output contract.
 */
export const COORDINATOR_SIGNAL_CONTRACT_REF = 'wr.contracts.coordinator_signal' as const;

/**
 * Valid signal kinds for coordinator signal artifacts.
 *
 * - 'progress': Fire-and-observe heartbeat; no data required. Pass `payload: {}`.
 * - 'finding': Intermediate result or discovery worth surfacing now.
 * - 'data_needed': Agent requests external data from coordinator before continuing.
 * - 'approval_needed': Agent requests coordinator approval before proceeding.
 * - 'blocked': Agent has hit a blocking condition and cannot continue without intervention.
 */
export const CoordinatorSignalKindSchema = z.enum([
  'progress',
  'finding',
  'data_needed',
  'approval_needed',
  'blocked',
]);

export type CoordinatorSignalKind = z.infer<typeof CoordinatorSignalKindSchema>;

/**
 * Coordinator Signal Artifact V1 Schema
 *
 * Machine-checkable artifact for mid-session agent-to-coordinator communication.
 * Validated against this schema when a step declares
 * `output.contractRef: 'wr.contracts.coordinator_signal'`.
 *
 * The `signal_coordinator` tool (future work) emits artifacts of this shape.
 */
export const CoordinatorSignalArtifactV1Schema = z
  .object({
    /** Artifact kind discriminator (must be 'wr.coordinator_signal') */
    kind: z.literal('wr.coordinator_signal'),

    /**
     * The signal kind.
     * Closed enum -- only the five defined kinds are valid.
     */
    signalKind: CoordinatorSignalKindSchema,

    /**
     * Structured payload accompanying the signal.
     *
     * For signals with no data to attach (e.g. progress updates), pass `{}`.
     * For findings, include structured data the coordinator needs to act on.
     *
     * NOTE: The `signal_coordinator` tool (future work) will default this to `{}`
     * when the agent omits it, so agents using the tool do not need to pass `{}` manually.
     */
    payload: z.record(z.unknown()),

    /**
     * Optional session identifier.
     * The engine already knows the session; include this for coordinator log correlation
     * when the artifact is read out-of-band via the node detail API.
     */
    sessionId: z.string().optional(),
  })
  .strict();

export type CoordinatorSignalArtifactV1 = z.infer<typeof CoordinatorSignalArtifactV1Schema>;

/**
 * Type guard to check if an unknown artifact is a coordinator signal artifact.
 *
 * Checks the kind discriminant only -- does not validate the full schema.
 * Use `parseCoordinatorSignalArtifact()` for full validation.
 *
 * @param artifact - Unknown artifact to check
 * @returns True if artifact has the coordinator signal kind
 */
export function isCoordinatorSignalArtifact(
  artifact: unknown,
): artifact is { readonly kind: 'wr.coordinator_signal' } {
  return (
    typeof artifact === 'object' &&
    artifact !== null &&
    (artifact as Record<string, unknown>).kind === 'wr.coordinator_signal'
  );
}

/**
 * Parse and validate an unknown artifact as a coordinator signal artifact.
 *
 * Returns the parsed artifact on success, null on validation failure.
 * Use `isCoordinatorSignalArtifact()` to check kind before calling this
 * if you want to distinguish "wrong kind" from "wrong schema".
 *
 * @param artifact - Unknown artifact to validate
 * @returns Parsed artifact or null if validation fails
 */
export function parseCoordinatorSignalArtifact(
  artifact: unknown,
): CoordinatorSignalArtifactV1 | null {
  const result = CoordinatorSignalArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}
