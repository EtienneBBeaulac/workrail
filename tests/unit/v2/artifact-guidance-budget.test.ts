import { describe, expect, it } from 'vitest';
import { ARTIFACT_CONTRACT_REFS } from '../../../src/v2/durable-core/schemas/artifacts/index.js';
import { getBlockedMessage, ReviewVerdictArtifactV1Schema, ReviewVerdictFindingSchema } from '../../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
import { reasonToBlocker } from '../../../src/v2/durable-core/domain/reason-model.js';
import { MAX_BLOCKER_SUGGESTED_FIX_BYTES } from '../../../src/v2/durable-core/constants.js';

describe('engine-owned artifact correction guidance', () => {
  for (const contractRef of ARTIFACT_CONTRACT_REFS) {
    for (const isAutonomous of [false, true]) {
      for (const kind of ['missing_required_output', 'invalid_required_output'] as const) {
        it(`${contractRef} ${kind} autonomous=${isAutonomous} fits durable budgets`, () => {
          const result = reasonToBlocker({ kind, contractRef }, { isAutonomous });
          expect(result.isOk()).toBe(true);
          if (result.isErr()) return;
          expect(Buffer.byteLength(result.value.suggestedFix!, 'utf8')).toBeLessThanOrEqual(MAX_BLOCKER_SUGGESTED_FIX_BYTES);
          expect(result.value.pointer).toEqual({ kind: 'output_contract', contractRef });
        });
      }
    }
  }

  for (const isAutonomous of [false, true]) {
    it(`review guidance teaches valid finding severities and a valid example, autonomous=${isAutonomous}`, () => {
      const text = getBlockedMessage({ isAutonomous }).join('\n');
      const severityLine = text.split('\n').find(line => line.includes('findings[].severity'));
      expect(severityLine).toBeDefined();
      for (const severity of ReviewVerdictFindingSchema.shape.severity.options) expect(severityLine).toContain(severity);
      expect(severityLine).not.toContain('blocking');
      const example = JSON.parse(text.split('```json\n')[1]!.split('\n```')[0]!);
      const artifact = isAutonomous ? example.artifacts[0] : example.output.artifacts[0];
      expect(ReviewVerdictArtifactV1Schema.safeParse(artifact).success).toBe(true);
      expect(artifact.verdict).toBe('blocking');
      expect(artifact.findings[0].severity).toBe('major');
    });
  }
});
