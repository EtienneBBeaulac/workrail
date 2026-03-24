import { describe, expect, it } from 'vitest';
import { resolveWorkflowReferences, type FileExistsPort } from '../../../src/mcp/handlers/v2-reference-resolver.js';
import type { WorkflowReference } from '../../../src/types/workflow-definition.js';

const normalizePathForAssertion = (value: string): string => value.replaceAll('\\', '/');

const SAMPLE_REF: WorkflowReference = {
  id: 'api-spec',
  title: 'API Specification',
  source: './spec/api.json',
  purpose: 'Authoritative API contract',
  authoritative: true,
};

/** Stub that resolves every path. */
const alwaysExists: FileExistsPort = async () => true;

/** Stub that resolves nothing. */
const neverExists: FileExistsPort = async () => false;

/** Stub that resolves only paths containing a specific substring. */
const existsIf = (substring: string): FileExistsPort =>
  async (p) => p.includes(substring);

describe('resolveWorkflowReferences', () => {
  it('returns empty results for no references', async () => {
    const result = await resolveWorkflowReferences([], '/workspace', alwaysExists);
    expect(result.resolved).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('marks reference as unresolved when path does not exist', async () => {
    const result = await resolveWorkflowReferences([SAMPLE_REF], '/workspace', neverExists);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.status).toBe('unresolved');
    expect('resolvedPath' in result.resolved[0]!).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.referenceId).toBe('api-spec');
  });

  it('marks reference as resolved when path exists', async () => {
    const result = await resolveWorkflowReferences([SAMPLE_REF], '/workspace', alwaysExists);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.status).toBe('resolved');
    if (result.resolved[0]!.status === 'resolved') {
      expect(normalizePathForAssertion(result.resolved[0]!.resolvedPath)).toContain('spec/api.json');
    }
    expect(result.warnings).toHaveLength(0);
  });

  it('handles mixed resolved/unresolved references', async () => {
    const refs: WorkflowReference[] = [
      SAMPLE_REF,
      { id: 'guide', title: 'Guide', source: './docs/guide.md', purpose: 'Guidance', authoritative: false },
    ];
    const result = await resolveWorkflowReferences(refs, '/workspace', existsIf('api.json'));

    expect(result.resolved).toHaveLength(2);
    expect(result.resolved[0]!.status).toBe('resolved');
    expect(result.resolved[1]!.status).toBe('unresolved');
    expect(result.warnings).toHaveLength(1);
  });

  it('blocks workspace escape via ../ traversal', async () => {
    const escapingRef: WorkflowReference = {
      id: 'escape',
      title: 'Escape Attempt',
      source: '../../../etc/passwd',
      purpose: 'Should be blocked',
      authoritative: false,
    };
    // fileExists always returns true — escape should be blocked regardless
    const result = await resolveWorkflowReferences([escapingRef], '/workspace', alwaysExists);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.status).toBe('unresolved');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain('escapes workspace boundary');
  });

  it('allows paths that stay within workspace', async () => {
    const deepRef: WorkflowReference = {
      id: 'deep',
      title: 'Deep Ref',
      source: './deeply/nested/../still-inside.md',
      purpose: 'Normalized path stays inside',
      authoritative: false,
    };
    const result = await resolveWorkflowReferences([deepRef], '/workspace', alwaysExists);

    expect(result.resolved[0]!.status).toBe('resolved');
    expect(result.warnings).toHaveLength(0);
  });

  it('resolves package-relative refs against package root, not workspace', async () => {
    const packageRef: WorkflowReference = {
      id: 'schema',
      title: 'Schema',
      source: './spec/workflow.schema.json',
      purpose: 'Schema reference',
      authoritative: true,
      resolveFrom: 'package',
    };
    // fileExists checks what path is passed — package refs should NOT include /workspace
    const seenPaths: string[] = [];
    const trackingExists: FileExistsPort = async (p) => { seenPaths.push(p); return true; };

    await resolveWorkflowReferences([packageRef], '/workspace', trackingExists);

    // The resolved path should NOT start with /workspace
    expect(seenPaths).toHaveLength(1);
    expect(normalizePathForAssertion(seenPaths[0])).not.toContain('/workspace');
    expect(normalizePathForAssertion(seenPaths[0])).toContain('spec/workflow.schema.json');
  });

  it('blocks package-relative refs that escape package root via ../', async () => {
    const packageRef: WorkflowReference = {
      id: 'external',
      title: 'External',
      source: '../some-sibling-dir/file.md',
      purpose: 'Sibling of package',
      authoritative: false,
      resolveFrom: 'package',
    };
    const result = await resolveWorkflowReferences([packageRef], '/workspace', alwaysExists);

    expect(result.resolved[0]!.status).toBe('unresolved');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain('escapes');
  });

  it('preserves reference metadata in resolved output', async () => {
    const result = await resolveWorkflowReferences([SAMPLE_REF], '/workspace', alwaysExists);

    const ref = result.resolved[0]!;
    expect(ref.id).toBe('api-spec');
    expect(ref.title).toBe('API Specification');
    expect(ref.source).toBe('./spec/api.json');
    expect(ref.purpose).toBe('Authoritative API contract');
    expect(ref.authoritative).toBe(true);
  });

  it('degrades to unresolved warning when fileExists throws', async () => {
    const throwingExists: FileExistsPort = async () => {
      throw new Error('filesystem unavailable');
    };

    const result = await resolveWorkflowReferences([SAMPLE_REF], '/workspace', throwingExists);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.status).toBe('unresolved');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain('could not be checked');
    expect(result.warnings[0]!.message).toContain('filesystem unavailable');
  });
});
