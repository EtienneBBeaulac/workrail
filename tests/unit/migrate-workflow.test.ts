import { describe, vi, it, expect, beforeEach, afterEach, jest } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LoopStep } from '../../src/types/workflow-types';

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
  migrateWorkflowFile 
} from '../../src/cli/migrate-workflow';

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
    it('should skip migration if already at target version', () => {
      const workflow = {
        version: '0.1.0',
        id: 'test',
        name: 'Test',
        steps: []
      };
      
      const result = migrateWorkflow(workflow);
      expect(result.success).toBe(true);
      expect(result.warnings).toContain('Workflow is already at version 0.1.0');
      expect(result.migratedWorkflow).toEqual(workflow);
    });

    it('should prevent downgrade', () => {
      const workflow = {
        version: '0.2.0',
        id: 'test',
        name: 'Test',
        steps: []
      };
      
      const result = migrateWorkflow(workflow);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Cannot downgrade from version 0.2.0 to 0.1.0');
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
      expect(result.success).toBe(true);
      expect(result.changes).toContain('Added version field: 0.1.0');
      expect(result.migratedWorkflow?.version).toBe('0.1.0');
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
      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('loop-related keywords'))).toBe(true);
      expect(result.warnings.some(w => w.includes('manual iteration'))).toBe(true);
    });

    it('should validate required fields', () => {
      const workflow = {
        // Missing id
        name: 'Test',
        steps: []
      };

      const result = migrateWorkflow(workflow);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Workflow must have an id');
    });

    it('performs upgrade from older version', () => {
      const workflow = {
        id: 'test',
        name: 'Test',
        description: 'Old workflow',
        steps: [{ id: 'step1', title: 'Step 1', prompt: 'Do something' }]
      };

      const result = migrateWorkflow(workflow);
      expect(result.success).toBe(true);
      expect(result.migratedWorkflow?.version).toBe('0.1.0');
    });

    it('is no-op when workflow already at target version', () => {
      const workflow = {
        version: '0.1.0',
        id: 'test',
        name: 'Test',
        steps: []
      };

      const result = migrateWorkflow(workflow);
      expect(result.success).toBe(true);
      expect(result.migratedWorkflow).toEqual(workflow);
    });

    it('detects downgrade from newer version', () => {
      const workflow = {
        version: '0.10.0',
        id: 'test',
        name: 'Test',
        steps: []
      };

      const result = migrateWorkflow(workflow);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Cannot downgrade from version 0.10.0 to 0.1.0');
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
      // Clean up temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
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
      
      const result = await migrateWorkflowFile(testFile);
      expect(result.success).toBe(true);
      expect(result.originalVersion).toBe('0.0.1');
      expect(result.targetVersion).toBe('0.1.0');
      
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
      
      const result = await migrateWorkflowFile(testFile, undefined, { dryRun: true });
      expect(result.success).toBe(true);
      
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
      
      const result = await migrateWorkflowFile(testFile, undefined, { backup: true });
      expect(result.success).toBe(true);
      
      // Check backup was created
      const backupFile = result.changes.find(c => c.includes('Created backup'));
      expect(backupFile).toBeDefined();
      
      // Verify backup exists
      const files = fs.readdirSync(tempDir);
      const backupFiles = files.filter(f => f.includes('.backup.'));
      expect(backupFiles.length).toBe(1);
    });

    it('should handle file read errors', async () => {
      const result = await migrateWorkflowFile('/non/existent/file.json');
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Failed to read file'))).toBe(true);
    });

    it('should handle invalid JSON', async () => {
      fs.writeFileSync(testFile, 'not valid json');
      
      const result = await migrateWorkflowFile(testFile);
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid JSON'))).toBe(true);
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
      
      const result = await migrateWorkflowFile(testFile, outputFile);
      expect(result.success).toBe(true);
      
      // Original should be unchanged
      const original = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
      expect(original.version).toBeUndefined();
      
      // Output should be migrated
      const migrated = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      expect(migrated.version).toBe('0.1.0');
    });
  });
}); 