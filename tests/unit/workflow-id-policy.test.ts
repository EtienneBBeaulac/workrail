import { describe, it, expect } from 'vitest';

import { InvalidWorkflowError } from '../../src/core/error-handler';
import {
  parseWorkflowId,
  validateWorkflowIdForLoad,
  validateWorkflowIdForSave,
} from '../../src/domain/workflow-id-policy';

describe('workflow-id-policy', () => {
  describe('parseWorkflowId', () => {
    it('parses legacy ids (no dot) with safe charset (lowercase only per lock)', () => {
      expect(parseWorkflowId('legacy_id')?.kind).toBe('legacy');
      expect(parseWorkflowId('legacy-id')?.kind).toBe('legacy');
    });

    it('rejects uppercase legacy ids (lock requires lowercase)', () => {
      expect(parseWorkflowId('Legacy_ID')).toBeNull();
      expect(parseWorkflowId('LEGACY')).toBeNull();
    });

    it('parses namespaced ids (namespace.name)', () => {
      expect(parseWorkflowId('team.workflow')).toEqual({
        kind: 'namespaced',
        raw: 'team.workflow',
        namespace: 'team',
        name: 'workflow',
      });

      expect(parseWorkflowId('team.my_workflow')?.kind).toBe('namespaced');
    });

    it('rejects invalid namespaced ids', () => {
      expect(parseWorkflowId('Team.workflow')).toBeNull();
      expect(parseWorkflowId('team.Workflow')).toBeNull();
      expect(parseWorkflowId('team.workflow.extra')).toBeNull();
      expect(parseWorkflowId('team.')).toBeNull();
      expect(parseWorkflowId('.workflow')).toBeNull();
      expect(parseWorkflowId('')).toBeNull();
    });
  });

  describe('validateWorkflowIdForLoad', () => {
    it('allows legacy ids (warn-only)', () => {
      const res = validateWorkflowIdForLoad('legacy_id', 'project');
      expect(res.parsed.kind).toBe('legacy');
      expect(res.warnings).toContain('legacy_workflow_id');
    });

    it('rejects wr.* from non-bundled sources (all sourceKinds)', () => {
      const nonBundledKinds: Array<Exclude<import('../../src/types/workflow-source').WorkflowSourceKind, 'bundled'>> = [
        'user',
        'project',
        'custom',
        'git',
        'remote',
        'plugin',
      ];

      for (const kind of nonBundledKinds) {
        expect(() => validateWorkflowIdForLoad('wr.core', kind)).toThrow(InvalidWorkflowError);
        expect(() => validateWorkflowIdForLoad('wr.something', kind)).toThrow(InvalidWorkflowError);
      }
    });

    it('allows wr.* from bundled sources', () => {
      expect(() => validateWorkflowIdForLoad('wr.core', 'bundled')).not.toThrow();
    });
  });

  describe('validateWorkflowIdForSave', () => {
    it('rejects legacy ids (no dot)', () => {
      expect(() => validateWorkflowIdForSave('legacy_id', 'project')).toThrow(InvalidWorkflowError);
    });

    it('rejects wr.* for non-bundled sources (all sourceKinds)', () => {
      const nonBundledKinds: Array<Exclude<import('../../src/types/workflow-source').WorkflowSourceKind, 'bundled'>> = [
        'user',
        'project',
        'custom',
        'git',
        'remote',
        'plugin',
      ];

      for (const kind of nonBundledKinds) {
        expect(() => validateWorkflowIdForSave('wr.core', kind)).toThrow(InvalidWorkflowError);
      }
    });

    it('accepts valid namespaced ids', () => {
      expect(validateWorkflowIdForSave('team.workflow', 'project')).toEqual({
        kind: 'namespaced',
        raw: 'team.workflow',
        namespace: 'team',
        name: 'workflow',
      });
    });
  });
});
