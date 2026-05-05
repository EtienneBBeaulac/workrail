import { describe, it, expect } from 'vitest';
import { buildContextSummary } from '../../../src/coordinators/context-assembly.js';
import type { PhaseHandoffArtifact } from '../../../src/v2/durable-core/schemas/artifacts/index.js';
import type {
  DiscoveryHandoffArtifactV1,
  ShapingHandoffArtifactV1,
  CodingHandoffArtifactV1,
} from '../../../src/v2/durable-core/schemas/artifacts/index.js';

// ─── Test fixtures ───────────────────────────────────────────────────────────

const discovery: DiscoveryHandoffArtifactV1 = {
  kind: 'wr.discovery_handoff',
  version: 1,
  selectedDirection: 'Use a discriminated union for phase results',
  designDocPath: '.workrail/design.md',
  confidenceBand: 'high',
  keyInvariants: ['PhaseResult must be exhaustive', 'No raw casts on deserialization'],
  implementationConstraints: ['Do not modify workflow-runner.ts token protocol', 'All new fields use z.optional()'],
  rejectedDirections: [{ direction: 'Coordinator extracts from notes', reason: 'Brittle and non-deterministic' }],
  keyCodebaseLocations: [{ path: 'src/coordinators/modes/full-pipeline.ts', relevance: 'Main coordinator to update' }],
};

const shaping: ShapingHandoffArtifactV1 = {
  kind: 'wr.shaping_handoff',
  version: 1,
  pitchPath: '.workrail/current-pitch.md',
  selectedShape: 'Typed handoff artifacts + PipelineRunContext file',
  appetite: 'L (1-2 weeks)',
  keyConstraints: ['Engine contracts before workflow changes', 'Single PR required'],
  rabbitHoles: ['Do not redesign buildSystemPrompt()'],
  outOfScope: ['Cross-run context', 'Console visualization'],
  validationChecklist: ['All 4 workflows emit expected artifacts', 'contractRef validation test passes'],
};

const coding: CodingHandoffArtifactV1 = {
  kind: 'wr.coding_handoff',
  version: 1,
  branchName: 'feature/living-work-context',
  keyDecisions: ['Concrete Zod schemas per phase instead of generic', 'buildPhaseResult() is pure function'],
  knownLimitations: ['buildSystemPrompt() redesign deferred'],
  testsAdded: ['tests/unit/coordinators/context-assembly.test.ts'],
  filesChanged: ['src/coordinators/context-assembly.ts', 'src/coordinators/pipeline-run-context.ts'],
};

const all: PhaseHandoffArtifact[] = [discovery, shaping, coding];

// ─── buildContextSummary() ───────────────────────────────────────────────────

describe('buildContextSummary()', () => {
  it('returns empty string for empty artifacts', () => {
    expect(buildContextSummary([], 'coding')).toBe('');
    expect(buildContextSummary([], 'review')).toBe('');
  });

  describe("'shaping' target phase", () => {
    it('includes discovery implementationConstraints and selectedDirection', () => {
      const result = buildContextSummary([discovery], 'shaping');
      expect(result).toContain('Do not modify workflow-runner.ts token protocol');
      expect(result).toContain('Use a discriminated union for phase results');
    });

    it('includes discovery keyInvariants and rejectedDirections', () => {
      const result = buildContextSummary([discovery], 'shaping');
      expect(result).toContain('PhaseResult must be exhaustive');
      expect(result).toContain('Coordinator extracts from notes');
    });

    it('does NOT include shaping or coding fields', () => {
      const result = buildContextSummary(all, 'shaping');
      expect(result).not.toContain('Engine contracts before workflow changes'); // shaping.keyConstraints
      expect(result).not.toContain('Concrete Zod schemas per phase'); // coding.keyDecisions
    });
  });

  describe("'coding' target phase", () => {
    it('includes discovery implementationConstraints', () => {
      const result = buildContextSummary([discovery, shaping], 'coding');
      expect(result).toContain('Do not modify workflow-runner.ts token protocol');
    });

    it('includes shaping keyConstraints, rabbitHoles, outOfScope', () => {
      const result = buildContextSummary([discovery, shaping], 'coding');
      expect(result).toContain('Engine contracts before workflow changes');
      expect(result).toContain('Do not redesign buildSystemPrompt()');
      expect(result).toContain('Cross-run context');
    });

    it('does NOT include discovery selectedDirection (not needed for coding)', () => {
      const result = buildContextSummary([discovery, shaping], 'coding');
      expect(result).not.toContain('Use a discriminated union for phase results');
    });

    it('does NOT include coding fields', () => {
      const result = buildContextSummary(all, 'coding');
      expect(result).not.toContain('Concrete Zod schemas per phase'); // coding.keyDecisions
    });
  });

  describe("'review' target phase", () => {
    it('includes shaping validationChecklist', () => {
      const result = buildContextSummary(all, 'review');
      expect(result).toContain('All 4 workflows emit expected artifacts');
    });

    it('includes coding keyDecisions', () => {
      const result = buildContextSummary(all, 'review');
      expect(result).toContain('Concrete Zod schemas per phase instead of generic');
    });

    it('includes shaping keyConstraints and outOfScope', () => {
      const result = buildContextSummary(all, 'review');
      expect(result).toContain('Engine contracts before workflow changes');
      expect(result).toContain('Cross-run context');
    });

    it('includes discovery implementationConstraints', () => {
      const result = buildContextSummary(all, 'review');
      expect(result).toContain('Do not modify workflow-runner.ts token protocol');
    });

    it('includes coding filesChanged', () => {
      const result = buildContextSummary(all, 'review');
      expect(result).toContain('src/coordinators/context-assembly.ts');
    });

    it('does NOT include discovery selectedDirection (not a review concern)', () => {
      const result = buildContextSummary(all, 'review');
      expect(result).not.toContain('Use a discriminated union for phase results');
    });
  });

  describe("'fix' target phase", () => {
    it('includes shaping validationChecklist', () => {
      const result = buildContextSummary(all, 'fix');
      expect(result).toContain('All 4 workflows emit expected artifacts');
    });

    it('includes coding keyDecisions', () => {
      const result = buildContextSummary(all, 'fix');
      expect(result).toContain('Concrete Zod schemas per phase instead of generic');
    });

    it('includes coding filesChanged (fix agent needs to know WHERE to look)', () => {
      const result = buildContextSummary(all, 'fix');
      expect(result).toContain('src/coordinators/context-assembly.ts');
    });

    it('does NOT include discovery fields', () => {
      const result = buildContextSummary(all, 'fix');
      expect(result).not.toContain('Do not modify workflow-runner.ts token protocol'); // discovery.implementationConstraints
    });
  });

  describe('correctedAssumptions', () => {
    it('includes correctedAssumptions for review when present', () => {
      const codingWithCorrections: CodingHandoffArtifactV1 = {
        ...coding,
        correctedAssumptions: [{ assumed: 'Zod generics would work', actual: 'Needed concrete schemas per phase' }],
      };
      const result = buildContextSummary([shaping, codingWithCorrections], 'review');
      expect(result).toContain('Zod generics would work');
      expect(result).toContain('Needed concrete schemas per phase');
    });

    it('includes correctedAssumptions for fix when present', () => {
      const codingWithCorrections: CodingHandoffArtifactV1 = {
        ...coding,
        correctedAssumptions: [{ assumed: 'Zod generics would work', actual: 'Needed concrete schemas per phase' }],
      };
      const result = buildContextSummary([shaping, codingWithCorrections], 'fix');
      expect(result).toContain('Zod generics would work');
    });
  });

  describe('budget trimming', () => {
    it('returns output within 8KB', () => {
      // Build an artifact with maxed-out fields to trigger trimming
      const bigCoding: CodingHandoffArtifactV1 = {
        ...coding,
        keyDecisions: Array(8).fill('A'.repeat(200)),
        knownLimitations: Array(6).fill('B'.repeat(200)),
        filesChanged: Array(20).fill('C'.repeat(300)),
        testsAdded: Array(10).fill('D'.repeat(200)),
      };
      const result = buildContextSummary([shaping, bigCoding], 'review');
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(8192);
    });

    it('always includes P1 fields (keyConstraints) even when budget is tight', () => {
      const bigCoding: CodingHandoffArtifactV1 = {
        ...coding,
        keyDecisions: Array(8).fill('A'.repeat(200)),
        filesChanged: Array(20).fill('C'.repeat(300)),
        testsAdded: Array(10).fill('D'.repeat(200)),
      };
      const result = buildContextSummary([shaping, bigCoding], 'review');
      // P1 keyConstraints must survive trimming
      expect(result).toContain('Engine contracts before workflow changes');
    });

    it('drops P3 fields (filesChanged/testsAdded) before P1 when budget is tight', () => {
      // Create oversized discovery to eat budget
      const bigDiscovery: DiscoveryHandoffArtifactV1 = {
        ...discovery,
        implementationConstraints: Array(8).fill('A'.repeat(200)),
        keyInvariants: Array(12).fill('B'.repeat(200)),
        keyCodebaseLocations: Array(10).fill({ path: 'C'.repeat(300), relevance: 'D'.repeat(150) }),
      };
      const bigShaping: ShapingHandoffArtifactV1 = {
        ...shaping,
        keyConstraints: Array(8).fill('E'.repeat(200)),
        validationChecklist: Array(10).fill('F'.repeat(200)),
        outOfScope: Array(6).fill('G'.repeat(200)),
        rabbitHoles: Array(6).fill('H'.repeat(200)),
      };
      const bigCoding: CodingHandoffArtifactV1 = {
        ...coding,
        keyDecisions: Array(8).fill('I'.repeat(200)),
        filesChanged: Array(20).fill('J'.repeat(300)),
        testsAdded: Array(10).fill('K'.repeat(200)),
      };
      const result = buildContextSummary([bigDiscovery, bigShaping, bigCoding], 'review');
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(8192);
      // P1 keyConstraints must be present
      expect(result).toContain('EEEEE');
    });

    it('never truncates mid-array (sections are complete or absent)', () => {
      const bigShaping: ShapingHandoffArtifactV1 = {
        ...shaping,
        keyConstraints: Array(8).fill('A'.repeat(200)),
        validationChecklist: Array(10).fill('B'.repeat(200)),
        outOfScope: Array(6).fill('C'.repeat(200)),
        rabbitHoles: Array(6).fill('D'.repeat(200)),
      };
      const result = buildContextSummary([bigShaping], 'coding');
      // If rabbitHoles (P2) is included, ALL items must be present
      if (result.includes('DDDD')) {
        const count = (result.match(/- DDDDD/g) ?? []).length;
        expect(count).toBe(6); // all 6 items or none
      }
    });
  });
});
