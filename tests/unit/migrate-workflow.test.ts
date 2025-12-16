import { describe, vi, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { LoopStep } from '../../src/types/workflow-types';

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    blue: (str: string) => str,
    green: (str: string) => str,
    yellow: (str: string) => str,
    red: (str: string) => str,
    cyan: (str: string) => str,
    gray: (str: string) => str,
  }
}));

import {
  detectWorkflowVersion,
  migrateWorkflow,
  migrateWorkflowFile,
  type MigrateFileDeps,
} from '../../src/cli/commands/migrate';

describe('Workflow Migration', () => {
  describe('detectWorkflowVersion', () => {
    it('should detect explicit version', () => {
      const workflow = { version: '0.1.0', id: 'test', name: 'Test', steps: [] };
      expect(detectWorkflowVersion(workflow)).toBe('0.1.0');
    });

    it('should detect v0.1.0 by loop features', () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test workflow',
        steps: [
          {
            id: 'loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'while', condition: { var: 'test', equals: true } },
            body: 'body'
          } as LoopStep
        ]
      };
      expect(detectWorkflowVersion(workflow)).toBe('0.1.0');
    });

    it('should default to v0.0.1 for basic workflows', () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Do something' }
        ]
      };
      expect(detectWorkflowVersion(workflow)).toBe('0.0.1');
    });
  });

  describe('migrateWorkflow', () => {
    it('should return already_current if at target version', () => {
      const workflow = {
        version: '0.1.0',
        id: 'test',
        name: 'Test',
        steps: []
      };

      const result = migrateWorkflow(workflow);
      expect(result.kind).toBe('already_current');
      if (result.kind === 'already_current') {
        expect(result.version).toBe('0.1.0');
        expect(result.workflow).toEqual(workflow);
      }
    });

    it('should return cannot_downgrade for newer versions', () => {
      const workflow = {
        version: '0.2.0',
        id: 'test',
        name: 'Test',
        steps: []
      };

      const result = migrateWorkflow(workflow);
      expect(result.kind).toBe('cannot_downgrade');
      if (result.kind === 'cannot_downgrade') {
        expect(result.originalVersion).toBe('0.2.0');
        expect(result.targetVersion).toBe('0.1.0');
      }
    });

    it('should add version field during migration', () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test workflow',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Do something' }
        ]
      };

      const result = migrateWorkflow(workflow);
      expect(result.kind).toBe('migrated');
      if (result.kind === 'migrated') {
        expect(result.changes).toContain('Added version field: 0.1.0');
        expect(result.workflow.version).toBe('0.1.0');
      }
    });

    it('should detect loop-like patterns and warn', () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test workflow',
        steps: [
          {
            id: 'step1',
            title: 'Repeat Process',
            prompt: 'Iterate through each item in the list'
          },
          {
            id: 'step2',
            title: 'Process Item',
            prompt: 'Process the item',
            guidance: ['This is step 2 of 5 in the iteration']
          }
        ]
      };

      const result = migrateWorkflow(workflow);
      expect(result.kind).toBe('migrated');
      if (result.kind === 'migrated') {
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.some(w => w.includes('loop-related keywords'))).toBe(true);
        expect(result.warnings.some(w => w.includes('manual iteration'))).toBe(true);
      }
    });

    it('should return invalid_workflow for missing required fields', () => {
      const workflow = {
        // Missing id
        name: 'Test',
        steps: []
      };

      const result = migrateWorkflow(workflow);
      expect(result.kind).toBe('invalid_workflow');
      if (result.kind === 'invalid_workflow') {
        expect(result.errors).toContain('Workflow must have an id');
      }
    });

    it('performs upgrade from older version', () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Old workflow',
        steps: [{ id: 'step1', title: 'Step 1', prompt: 'Do something' }]
      };

      const result = migrateWorkflow(workflow);
      expect(result.kind).toBe('migrated');
      if (result.kind === 'migrated') {
        expect(result.workflow.version).toBe('0.1.0');
      }
    });

    it('is no-op when workflow already at target version', () => {
      const workflow = {
        version: '0.1.0',
        id: 'test',
        name: 'Test',
        steps: []
      };

      const result = migrateWorkflow(workflow);
      expect(result.kind).toBe('already_current');
      if (result.kind === 'already_current') {
        expect(result.workflow).toEqual(workflow);
      }
    });

    it('detects downgrade from newer version', () => {
      const workflow = {
        version: '0.10.0',
        id: 'test',
        name: 'Test',
        steps: []
      };

      const result = migrateWorkflow(workflow);
      expect(result.kind).toBe('cannot_downgrade');
      if (result.kind === 'cannot_downgrade') {
        expect(result.originalVersion).toBe('0.10.0');
        expect(result.targetVersion).toBe('0.1.0');
      }
    });
  });

  describe('migrateWorkflowFile', () => {
    let tempDir: string;
    let testFile: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workrail-test-'));
      testFile = path.join(tempDir, 'test-workflow.json');
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const createDeps = (): MigrateFileDeps => ({
      readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
      writeFile: (p: string, content: string) => fs.promises.writeFile(p, content, 'utf-8'),
      copyFile: (src: string, dest: string) => fs.promises.copyFile(src, dest),
    });

    it('should migrate a file successfully', async () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test workflow',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Do something' }
        ]
      };

      fs.writeFileSync(testFile, JSON.stringify(workflow, null, 2));

      const result = await migrateWorkflowFile(testFile, {}, createDeps());
      expect(result.kind).toBe('file_migrated');
      if (result.kind === 'file_migrated') {
        expect(result.migration.originalVersion).toBe('0.0.1');
        expect(result.migration.targetVersion).toBe('0.1.0');
      }

      // Check file was updated
      const migrated = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
      expect(migrated.version).toBe('0.1.0');
    });

    it('should handle dry-run mode', async () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test workflow',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Do something' }
        ]
      };

      fs.writeFileSync(testFile, JSON.stringify(workflow, null, 2));
      const originalContent = fs.readFileSync(testFile, 'utf-8');

      const result = await migrateWorkflowFile(
        testFile,
        { dryRun: true },
        createDeps()
      );
      expect(result.kind).toBe('dry_run');

      // File should not be modified
      const afterContent = fs.readFileSync(testFile, 'utf-8');
      expect(afterContent).toBe(originalContent);
    });

    it('should create backup when requested', async () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test workflow',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Do something' }
        ]
      };

      fs.writeFileSync(testFile, JSON.stringify(workflow, null, 2));

      const result = await migrateWorkflowFile(
        testFile,
        { backup: true },
        createDeps()
      );
      expect(result.kind).toBe('file_migrated');
      if (result.kind === 'file_migrated') {
        expect(result.backupPath).toBeDefined();
      }

      // Verify backup exists
      const files = fs.readdirSync(tempDir);
      const backupFiles = files.filter(f => f.includes('.backup.'));
      expect(backupFiles.length).toBe(1);
    });

    it('should handle file read errors', async () => {
      const result = await migrateWorkflowFile(
        '/non/existent/file.json',
        {},
        createDeps()
      );
      expect(result.kind).toBe('file_read_error');
      if (result.kind === 'file_read_error') {
        expect(result.message).toBeTruthy();
      }
    });

    it('should handle invalid JSON', async () => {
      fs.writeFileSync(testFile, 'not valid json');

      const result = await migrateWorkflowFile(testFile, {}, createDeps());
      expect(result.kind).toBe('file_parse_error');
      if (result.kind === 'file_parse_error') {
        expect(result.message).toBeTruthy();
      }
    });

    it('should write to different output path', async () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Test workflow',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Do something' }
        ]
      };

      fs.writeFileSync(testFile, JSON.stringify(workflow, null, 2));
      const outputFile = path.join(tempDir, 'migrated-workflow.json');

      const result = await migrateWorkflowFile(
        testFile,
        { outputPath: outputFile },
        createDeps()
      );
      expect(result.kind).toBe('file_migrated');
      if (result.kind === 'file_migrated') {
        expect(result.outputPath).toBe(outputFile);
      }

      // Original should be unchanged
      const original = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
      expect(original.version).toBeUndefined();

      // Output should be migrated
      const migrated = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      expect(migrated.version).toBe('0.1.0');
    });
  });
});
