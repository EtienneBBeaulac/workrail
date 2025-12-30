import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { IFeatureFlagProvider } from '../../src/config/feature-flags';
import { InvalidWorkflowError } from '../../src/core/error-handler';
import { EnhancedMultiSourceWorkflowStorage } from '../../src/infrastructure/storage/enhanced-multi-source-workflow-storage';
import { FileWorkflowStorage } from '../../src/infrastructure/storage/file-workflow-storage';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage';
import { SchemaValidatingWorkflowStorage } from '../../src/infrastructure/storage/schema-validating-workflow-storage';
import type { WorkflowDefinition } from '../../src/types/workflow';
import { createBundledSource, createCustomDirectorySource, createProjectDirectorySource } from '../../src/types/workflow';

const mockFlags: IFeatureFlagProvider = {
  isEnabled: () => true,
  getAll: () => ({} as any),
  getSummary: () => 'mock',
};

function def(id: string, name = id): WorkflowDefinition {
  return {
    id,
    name,
    description: 'desc',
    version: '1.0.0',
    steps: [
      {
        id: 'step-1',
        title: 'Step 1',
        prompt: 'Do the thing',
      },
    ],
  };
}

describe('v2 workflow ID namespace locks (tests-first)', () => {
  describe('bundled wr.* no-shadow (lock)', () => {
    it('prefers bundled wr.* over higher-priority sources for loadAllWorkflows/listWorkflowSummaries/getWorkflowById', async () => {
      const bundled = new InMemoryWorkflowStorage([def('wr.core', 'Bundled Core')], createBundledSource());
      const project = new InMemoryWorkflowStorage([def('wr.core', 'Shadow Attempt')], createProjectDirectorySource('/tmp/workrail-project'));

      const storage = new EnhancedMultiSourceWorkflowStorage({
        includeBundled: false,
        includeUser: false,
        includeProject: false,
      });

      // NOTE: We inject storages directly to test multi-source behavior deterministically.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storage as any).storageInstances = [bundled, project];

      const all = await storage.loadAllWorkflows();
      const picked = all.find((w) => w.definition.id === 'wr.core');
      expect(picked?.source.kind).toBe('bundled');

      const summaries = await storage.listWorkflowSummaries();
      const pickedSummary = summaries.find((s) => s.id === 'wr.core');
      expect(pickedSummary?.source.kind).toBe('bundled');

      const byId = await storage.getWorkflowById('wr.core');
      expect(byId?.source.kind).toBe('bundled');
    });
  });

  describe('schema validating storage: save rejects legacy IDs (no-dot) (lock)', () => {
    it('rejects saving a new legacy ID (no dot) even when schema accepts it', async () => {
      const inner = new InMemoryWorkflowStorage([], createProjectDirectorySource('/tmp/workrail-project'));
      const storage = new SchemaValidatingWorkflowStorage(inner);

      // Uses '-' to satisfy current JSON schema id pattern, but is still legacy (no dot).
      await expect(storage.save(def('legacy-id'))).rejects.toThrow(InvalidWorkflowError);
    });

    it('allows loading legacy IDs (warn-only semantics)', async () => {
      const inner = new InMemoryWorkflowStorage([def('legacy-id')], createProjectDirectorySource('/tmp/workrail-project'));
      const storage = new SchemaValidatingWorkflowStorage(inner);

      const all = await storage.loadAllWorkflows();
      expect(all.map((w) => w.definition.id)).toContain('legacy-id');
    });
  });

  describe('file storage: save rejects new legacy IDs (no-dot) (lock)', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-namespace-locks-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('rejects saving a new legacy ID (no dot)', async () => {
      const storage = new FileWorkflowStorage(tempDir, createCustomDirectorySource(tempDir, 'Test'), mockFlags, {});

      await expect(storage.save(def('legacy_id'))).rejects.toThrow(InvalidWorkflowError);
    });
  });

  describe('file storage: getWorkflowById supports namespaced IDs (dot-safe)', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-namespace-locks-'));

      // NOTE: write the file directly; FileWorkflowStorage indexes by definition.id (not by filename).
      await fs.writeFile(
        path.join(tempDir, 'team.workflow.json'),
        JSON.stringify(def('team.workflow', 'Namespaced Workflow'))
      );
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('can retrieve a workflow by namespaced workflow ID', async () => {
      const storage = new FileWorkflowStorage(tempDir, createCustomDirectorySource(tempDir, 'Test'), mockFlags, {});

      const loaded = await storage.getWorkflowById('team.workflow');
      expect(loaded?.definition.id).toBe('team.workflow');
    });
  });
});
