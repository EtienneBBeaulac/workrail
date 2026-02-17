import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND, OUTPUT_CHANNEL } from '../durable-core/constants.js';

export type ArtifactProjectionError =
  | { readonly code: 'PROJECTION_INVARIANT_VIOLATION'; readonly message: string };

/**
 * A projected artifact with its event context.
 */
export interface ProjectedArtifactV2 {
  /** The artifact content (parsed from event payload) */
  readonly content: unknown;
  /** The outputId that stored this artifact */
  readonly outputId: string;
  /** SHA-256 hash of the canonicalized artifact */
  readonly sha256: string;
  /** Content type (usually 'application/json') */
  readonly contentType: string;
  /** Size in bytes */
  readonly byteLength: number;
  /** Event index when this artifact was stored */
  readonly createdAtEventIndex: number;
}

/**
 * Per-node artifact view.
 */
export interface NodeArtifactsViewV2 {
  /** All artifacts for this node in event order */
  readonly artifacts: readonly ProjectedArtifactV2[];
}

/**
 * Artifacts projection result.
 */
export interface ArtifactsProjectionV2 {
  /** Artifacts indexed by nodeId */
  readonly byNodeId: Readonly<Record<string, NodeArtifactsViewV2>>;
}

/**
 * Pure projection: derives per-node artifacts from node_output_appended events.
 * 
 * Only processes outputs with:
 * - outputChannel: 'artifact'
 * - payloadKind: 'artifact_ref'
 * - content field present (inlined artifacts)
 * 
 * Lock: Artifacts are stored via Phase 1 wiring in v2-execution.ts
 * Related: §19 Evidence-based validation - projecting typed artifacts
 * 
 * @param events - Sorted domain events
 * @returns Artifacts grouped by nodeId
 */
export function projectArtifactsV2(events: readonly DomainEventV1[]): Result<ArtifactsProjectionV2, ArtifactProjectionError> {
  const byNodeId: Record<string, { artifacts: ProjectedArtifactV2[] }> = {};

  // Verify events are sorted by eventIndex ascending
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({
        code: 'PROJECTION_INVARIANT_VIOLATION',
        message: 'Events must be sorted by eventIndex ascending',
      });
    }
  }

  for (const e of events) {
    // Only process node_output_appended events
    if (e.kind !== EVENT_KIND.NODE_OUTPUT_APPENDED) continue;

    // Only process artifact channel
    if (e.data.outputChannel !== OUTPUT_CHANNEL.ARTIFACT) continue;

    // Only process artifact_ref payloads
    const payload = e.data.payload;
    if (payload.payloadKind !== 'artifact_ref') continue;

    // Only process if content is inlined (small artifacts)
    // Type assertion needed because schema has optional content field
    const contentPayload = payload as typeof payload & { content?: unknown };
    if (contentPayload.content === undefined) continue;

    const nodeId = e.scope?.nodeId;
    if (!nodeId) continue;

    // Ensure node entry exists
    if (!byNodeId[nodeId]) {
      byNodeId[nodeId] = { artifacts: [] };
    }

    // Add artifact to node's collection
    byNodeId[nodeId]!.artifacts.push({
      content: contentPayload.content,
      outputId: e.data.outputId,
      sha256: payload.sha256,
      contentType: payload.contentType,
      byteLength: payload.byteLength,
      createdAtEventIndex: e.eventIndex,
    });
  }

  // Convert to readonly structure
  const result: Record<string, NodeArtifactsViewV2> = {};
  for (const [nodeId, view] of Object.entries(byNodeId)) {
    result[nodeId] = { artifacts: view.artifacts };
  }

  return ok({ byNodeId: result });
}

/**
 * Get all artifact contents for a specific node.
 * 
 * @param projection - The artifacts projection
 * @param nodeId - The node ID to look up
 * @returns Array of artifact contents (empty if none found)
 */
export function getArtifactContentsForNode(
  projection: ArtifactsProjectionV2,
  nodeId: string
): readonly unknown[] {
  const view = projection.byNodeId[nodeId];
  if (!view) return [];
  return view.artifacts.map(a => a.content);
}
