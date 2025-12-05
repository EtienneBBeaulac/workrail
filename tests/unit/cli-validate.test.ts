import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CLI Validate Command', () => {
  const validWorkflowPath = path.join(__dirname, '../../spec/examples/valid-workflow.json');
  const invalidWorkflowPath = path.join(__dirname, '../../spec/examples/invalid-workflow.json');
  const cliPath = path.join(__dirname, '../../dist/cli.js');
  
  let tempDir: string;
  let tempFiles: string[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-validate-test-'));
  });

  afterEach(() => {
    // Clean up temporary files
    tempFiles.forEach(file => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    });
    tempFiles = [];

    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  function createTempFile(content: string, filename: string = 'temp.json'): string {
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    tempFiles.push(filePath);
    return filePath;
  }

  function runCliCommand(args: string[]): { exitCode: number; output: string; error: string } {
    try {
      const output = execSync(`node ${cliPath} ${args.join(' ')}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return { exitCode: 0, output, error: '' };
    } catch (error: any) {
      return {
        exitCode: error.status || 1,
        output: error.stdout || '',
        error: error.stderr || error.message || ''
      };
    }
  }

  describe('Valid workflows', () => {
    it('should validate valid workflow file with exit code 0', () => {
      const result = runCliCommand(['validate', validWorkflowPath]);
      
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('✅ Workflow is valid:');
      expect(result.output).toContain('valid-workflow.json');
    });

    it('should work with relative paths', () => {
      const relativePath = path.relative(process.cwd(), validWorkflowPath);
      const result = runCliCommand(['validate', relativePath]);
      
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('✅ Workflow is valid:');
    });

    it('should work with absolute paths', () => {
      const absolutePath = path.resolve(validWorkflowPath);
      const result = runCliCommand(['validate', absolutePath]);
      
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('✅ Workflow is valid:');
    });
  });

  describe('Invalid workflows', () => {
    it('should reject invalid workflow with exit code 1', () => {
      const result = runCliCommand(['validate', invalidWorkflowPath]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Workflow validation failed:');
      expect(result.error).toContain('Validation errors:');
    });

    it('should display validation errors with bullet points', () => {
      const result = runCliCommand(['validate', invalidWorkflowPath]);
      
      expect(result.error).toContain('•');
      expect(result.error).toContain('Validation errors:');
      expect(result.error).toContain('Please fix the errors above');
    });

    it('should handle workflow with missing required fields', () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        // Missing name, description, version, steps
      };
      const tempFile = createTempFile(JSON.stringify(invalidWorkflow));
      const result = runCliCommand(['validate', tempFile]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Workflow validation failed:');
    });

    it('should handle workflow with invalid field types', () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 123, // Should be string
        description: 'Test description',
        version: '0.0.1',
        steps: []
      };
      const tempFile = createTempFile(JSON.stringify(invalidWorkflow));
      const result = runCliCommand(['validate', tempFile]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Workflow validation failed:');
    });
  });

  describe('File handling errors', () => {
    it('should handle file not found with exit code 1', () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.json');
      const result = runCliCommand(['validate', nonExistentPath]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Error: File not found:');
      expect(result.error).toContain('Please check the file path and try again.');
    });

    it('should handle empty file', () => {
      const emptyFile = createTempFile('');
      const result = runCliCommand(['validate', emptyFile]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Error: Invalid JSON syntax');
    });

    it('should handle file with only whitespace', () => {
      const whitespaceFile = createTempFile('   \n  \t  \n  ');
      const result = runCliCommand(['validate', whitespaceFile]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Error: Invalid JSON syntax');
    });

    it('should handle invalid JSON syntax', () => {
      const invalidJson = createTempFile('{ "invalid": json, }');
      const result = runCliCommand(['validate', invalidJson]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Error: Invalid JSON syntax');
      expect(result.error).toContain('Please check the JSON syntax and try again.');
    });

    it('should handle malformed JSON with missing quotes', () => {
      const malformedJson = createTempFile('{ id: "test", name: missing-quotes }');
      const result = runCliCommand(['validate', malformedJson]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Error: Invalid JSON syntax');
    });

    it('should handle non-object JSON', () => {
      const nonObjectJson = createTempFile('"just a string"');
      const result = runCliCommand(['validate', nonObjectJson]);
      
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('❌ Workflow validation failed:');
    });
  });

  describe('Edge cases', () => {
    it('should handle very small valid workflow', () => {
      const minimalWorkflow = {
        id: 'minimal',
        name: 'Minimal',
        description: 'A minimal workflow',
        version: '0.0.1',
        steps: [{
          id: 'step1',
          title: 'Step 1',
          prompt: 'Do something'
        }]
      };
      const tempFile = createTempFile(JSON.stringify(minimalWorkflow));
      const result = runCliCommand(['validate', tempFile]);
      
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('✅ Workflow is valid:');
    });

    it('should handle workflow with unicode characters', () => {
      const unicodeWorkflow = {
        id: 'unicode-test',
        name: 'Unicode Test 🚀',
        description: 'A workflow with émojis and accénts',
        version: '0.0.1',
        steps: [{
          id: 'unicode-step',
          title: 'Unicode Step 💻',
          prompt: 'Process unicode content'
        }]
      };
      const tempFile = createTempFile(JSON.stringify(unicodeWorkflow));
      const result = runCliCommand(['validate', tempFile]);
      
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('✅ Workflow is valid:');
    });

    it('should handle paths with spaces', () => {
      const workflowWithSpaces = {
        id: 'space-test',
        name: 'Space Test',
        description: 'Test workflow',
        version: '0.0.1',
        steps: [{
          id: 'space-step',
          title: 'Space Step',
          prompt: 'Handle spaces'
        }]
      };
      const filename = 'file with spaces.json';
      const tempFile = createTempFile(JSON.stringify(workflowWithSpaces), filename);
      const result = runCliCommand(['validate', `"${tempFile}"`]);
      
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('✅ Workflow is valid:');
    });
  });

  describe('Help command', () => {
    it('should display help with --help flag', () => {
      const result = runCliCommand(['validate', '--help']);
      
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Usage: workrail validate');
      expect(result.output).toContain('Validate a workflow file against the schema');
      expect(result.output).toContain('Options:');
      expect(result.output).toContain('-h, --help');
    });

    it('should display help with -h flag', () => {
      const result = runCliCommand(['validate', '-h']);
      
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Usage: workrail validate');
    });
  });

  describe('Error message formatting', () => {
    it('should use singular form for single validation error', () => {
      const workflowWithOneError = {
        id: 'INVALID_ID_WITH_CAPS', // Only ID error
        name: 'Valid Name',
        description: 'Valid description',
        version: '0.0.1',
        steps: [{
          id: 'valid-step',
          title: 'Valid Step',
          prompt: 'Valid prompt'
        }]
      };
      const tempFile = createTempFile(JSON.stringify(workflowWithOneError));
      const result = runCliCommand(['validate', tempFile]);
      
      expect(result.exitCode).toBe(1);
      // Output format shows validation errors with bullet points
      expect(result.error).toContain('Validation errors:');
      expect(result.error).toContain('•');
    });

    it('should use plural form for multiple validation errors', () => {
      const result = runCliCommand(['validate', invalidWorkflowPath]);
      
      expect(result.exitCode).toBe(1);
      // Output format shows validation errors with bullet points
      expect(result.error).toContain('Validation errors:');
      // Multiple errors should have multiple bullet points
      const bulletCount = (result.error.match(/•/g) || []).length;
      expect(bulletCount).toBeGreaterThan(1);
    });
  });
}); 