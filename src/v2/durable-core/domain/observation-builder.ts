import type { WorkspaceAnchor } from '../../ports/workspace-anchor.port.js';
import { MAX_OBSERVATION_SHORT_STRING_LENGTH } from '../constants.js';

/**
 * Observation event data shape (matches DomainEventV1 observation_recorded payload).
 *
 * Lock: §1 observation_recorded — closed-set keys + tagged scalar values.
 */
export interface ObservationEventData {
  readonly key: 'git_branch' | 'git_head_sha' | 'repo_root_hash';
  readonly value:
    | { readonly type: 'short_string'; readonly value: string }
    | { readonly type: 'git_sha1'; readonly value: string }
    | { readonly type: 'sha256'; readonly value: string };
  readonly confidence: 'low' | 'med' | 'high';
}

/**
 * Convert workspace anchors to observation event data.
 *
 * Pure function. Maps each anchor to the correct tagged value type
 * per the locked observation_recorded schema.
 *
 * Lock: §1 observation_recorded
 * - git_branch → short_string (bounded to 80 chars)
 * - git_head_sha → git_sha1 (40 hex chars)
 * - repo_root_hash → sha256 (sha256:<64 hex chars>)
 *
 * Returns empty array for empty input (graceful: no observations is valid).
 */
export function anchorsToObservations(anchors: readonly WorkspaceAnchor[]): readonly ObservationEventData[] {
  const observations: ObservationEventData[] = [];

  for (const anchor of anchors) {
    switch (anchor.key) {
      case 'git_branch':
        // Lock: short_string max 80 chars
        if (anchor.value.length > MAX_OBSERVATION_SHORT_STRING_LENGTH) break;
        observations.push({
          key: 'git_branch',
          value: { type: 'short_string', value: anchor.value },
          confidence: 'high',
        });
        break;

      case 'git_head_sha':
        // Lock: git_sha1 = 40 lowercase hex chars
        if (!/^[0-9a-f]{40}$/.test(anchor.value)) break;
        observations.push({
          key: 'git_head_sha',
          value: { type: 'git_sha1', value: anchor.value },
          confidence: 'high',
        });
        break;

      case 'repo_root_hash':
        // Lock: sha256 = sha256:<64 lowercase hex chars>
        if (!/^sha256:[0-9a-f]{64}$/.test(anchor.value)) break;
        observations.push({
          key: 'repo_root_hash',
          value: { type: 'sha256', value: anchor.value },
          confidence: 'high',
        });
        break;

      default: {
        const _exhaustive: never = anchor;
        return _exhaustive;
      }
    }
  }

  return observations;
}
