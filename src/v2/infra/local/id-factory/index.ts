import type { RandomEntropyPortV2 } from '../../../ports/random-entropy.port.js';
import type { AttemptId, NodeId, RunId, SessionId } from '../../../durable-core/ids/index.js';
import { asAttemptId, asNodeId, asRunId, asSessionId } from '../../../durable-core/ids/index.js';
import { encodeBase32LowerNoPad } from '../../../durable-core/encoding/base32-lower.js';

const BYTES = 16 as const; // 128-bit

function mint(prefix: string, entropy: RandomEntropyPortV2): string {
  const bytes = entropy.generateBytes(BYTES);
  const suffix = encodeBase32LowerNoPad(bytes);
  return `${prefix}_${suffix}`;
}

/**
 * V2 ID factory.
 *
 * Goals:
 * - Lowercase-only IDs (dedupeKey-safe)
 * - Path-safe IDs (sessionId used in directory layout)
 * - Shorter than UUIDs to reduce token length
 */
export class IdFactoryV2 {
  constructor(private readonly entropy: RandomEntropyPortV2) {}

  mintSessionId(): SessionId {
    return asSessionId(mint('sess', this.entropy));
  }

  mintRunId(): RunId {
    return asRunId(mint('run', this.entropy));
  }

  mintNodeId(): NodeId {
    return asNodeId(mint('node', this.entropy));
  }

  mintAttemptId(): AttemptId {
    return asAttemptId(mint('attempt', this.entropy));
  }

  mintEventId(): string {
    return mint('evt', this.entropy);
  }
}
