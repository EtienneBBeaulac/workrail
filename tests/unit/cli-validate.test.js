"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var globals_1 = require("@jest/globals");
var child_process_1 = require("child_process");
var fs_1 = require("fs");
var path_1 = require("path");
var os_1 = require("os");
(0, globals_1.describe)('CLI Validate Command', function () {
    var validWorkflowPath = path_1.default.join(__dirname, '../../spec/examples/valid-workflow.json');
    var invalidWorkflowPath = path_1.default.join(__dirname, '../../spec/examples/invalid-workflow.json');
    var cliPath = path_1.default.join(__dirname, '../../dist/cli.js');
    var tempDir;
    var tempFiles = [];
    (0, globals_1.beforeEach)(function () {
        tempDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'cli-validate-test-'));
    });
    (0, globals_1.afterEach)(function () {
        // Clean up temporary files
        tempFiles.forEach(function (file) {
            try {
                if (fs_1.default.existsSync(file)) {
                    fs_1.default.unlinkSync(file);
                }
            }
            catch (error) {
                // Ignore cleanup errors
            }
        });
        tempFiles = [];
        // Clean up temp directory
        try {
            fs_1.default.rmSync(tempDir, { recursive: true, force: true });
        }
        catch (error) {
            // Ignore cleanup errors
        }
    });
    function createTempFile(content, filename) {
        if (filename === void 0) { filename = 'temp.json'; }
        var filePath = path_1.default.join(tempDir, filename);
        fs_1.default.writeFileSync(filePath, content, 'utf-8');
        tempFiles.push(filePath);
        return filePath;
    }
    function runCliCommand(args) {
        try {
            var output = (0, child_process_1.execSync)("node ".concat(cliPath, " ").concat(args.join(' ')), {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return { exitCode: 0, output: output, error: '' };
        }
        catch (error) {
            return {
                exitCode: error.status || 1,
                output: error.stdout || '',
                error: error.stderr || error.message || ''
            };
        }
    }
    (0, globals_1.describe)('Valid workflows', function () {
        (0, globals_1.it)('should validate valid workflow file with exit code 0', function () {
            var result = runCliCommand(['validate', validWorkflowPath]);
            (0, globals_1.expect)(result.exitCode).toBe(0);
            (0, globals_1.expect)(result.output).toContain('✅ Workflow is valid:');
            (0, globals_1.expect)(result.output).toContain('valid-workflow.json');
        });
        (0, globals_1.it)('should work with relative paths', function () {
            var relativePath = path_1.default.relative(process.cwd(), validWorkflowPath);
            var result = runCliCommand(['validate', relativePath]);
            (0, globals_1.expect)(result.exitCode).toBe(0);
            (0, globals_1.expect)(result.output).toContain('✅ Workflow is valid:');
        });
        (0, globals_1.it)('should work with absolute paths', function () {
            var absolutePath = path_1.default.resolve(validWorkflowPath);
            var result = runCliCommand(['validate', absolutePath]);
            (0, globals_1.expect)(result.exitCode).toBe(0);
            (0, globals_1.expect)(result.output).toContain('✅ Workflow is valid:');
        });
    });
    (0, globals_1.describe)('Invalid workflows', function () {
        (0, globals_1.it)('should reject invalid workflow with exit code 1', function () {
            var result = runCliCommand(['validate', invalidWorkflowPath]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Workflow validation failed:');
            (0, globals_1.expect)(result.error).toContain('Validation errors:');
        });
        (0, globals_1.it)('should display validation errors with bullet points', function () {
            var result = runCliCommand(['validate', invalidWorkflowPath]);
            (0, globals_1.expect)(result.error).toContain('•');
            (0, globals_1.expect)(result.error).toContain('Found');
            (0, globals_1.expect)(result.error).toContain('validation error');
        });
        (0, globals_1.it)('should handle workflow with missing required fields', function () {
            var invalidWorkflow = {
                id: 'test-workflow',
                // Missing name, description, version, steps
            };
            var tempFile = createTempFile(JSON.stringify(invalidWorkflow));
            var result = runCliCommand(['validate', tempFile]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Workflow validation failed:');
        });
        (0, globals_1.it)('should handle workflow with invalid field types', function () {
            var invalidWorkflow = {
                id: 'test-workflow',
                name: 123, // Should be string
                description: 'Test description',
                version: '0.0.1',
                steps: []
            };
            var tempFile = createTempFile(JSON.stringify(invalidWorkflow));
            var result = runCliCommand(['validate', tempFile]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Workflow validation failed:');
        });
    });
    (0, globals_1.describe)('File handling errors', function () {
        (0, globals_1.it)('should handle file not found with exit code 1', function () {
            var nonExistentPath = path_1.default.join(tempDir, 'nonexistent.json');
            var result = runCliCommand(['validate', nonExistentPath]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Error: File not found:');
            (0, globals_1.expect)(result.error).toContain('Please check the file path and try again.');
        });
        (0, globals_1.it)('should handle empty file', function () {
            var emptyFile = createTempFile('');
            var result = runCliCommand(['validate', emptyFile]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Error: Invalid JSON syntax');
        });
        (0, globals_1.it)('should handle file with only whitespace', function () {
            var whitespaceFile = createTempFile('   \n  \t  \n  ');
            var result = runCliCommand(['validate', whitespaceFile]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Error: Invalid JSON syntax');
        });
        (0, globals_1.it)('should handle invalid JSON syntax', function () {
            var invalidJson = createTempFile('{ "invalid": json, }');
            var result = runCliCommand(['validate', invalidJson]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Error: Invalid JSON syntax');
            (0, globals_1.expect)(result.error).toContain('Please check the JSON syntax and try again.');
        });
        (0, globals_1.it)('should handle malformed JSON with missing quotes', function () {
            var malformedJson = createTempFile('{ id: "test", name: missing-quotes }');
            var result = runCliCommand(['validate', malformedJson]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Error: Invalid JSON syntax');
        });
        (0, globals_1.it)('should handle non-object JSON', function () {
            var nonObjectJson = createTempFile('"just a string"');
            var result = runCliCommand(['validate', nonObjectJson]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('❌ Workflow validation failed:');
        });
    });
    (0, globals_1.describe)('Edge cases', function () {
        (0, globals_1.it)('should handle very small valid workflow', function () {
            var minimalWorkflow = {
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
            var tempFile = createTempFile(JSON.stringify(minimalWorkflow));
            var result = runCliCommand(['validate', tempFile]);
            (0, globals_1.expect)(result.exitCode).toBe(0);
            (0, globals_1.expect)(result.output).toContain('✅ Workflow is valid:');
        });
        (0, globals_1.it)('should handle workflow with unicode characters', function () {
            var unicodeWorkflow = {
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
            var tempFile = createTempFile(JSON.stringify(unicodeWorkflow));
            var result = runCliCommand(['validate', tempFile]);
            (0, globals_1.expect)(result.exitCode).toBe(0);
            (0, globals_1.expect)(result.output).toContain('✅ Workflow is valid:');
        });
        (0, globals_1.it)('should handle paths with spaces', function () {
            var workflowWithSpaces = {
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
            var filename = 'file with spaces.json';
            var tempFile = createTempFile(JSON.stringify(workflowWithSpaces), filename);
            var result = runCliCommand(['validate', "\"".concat(tempFile, "\"")]);
            (0, globals_1.expect)(result.exitCode).toBe(0);
            (0, globals_1.expect)(result.output).toContain('✅ Workflow is valid:');
        });
    });
    (0, globals_1.describe)('Help command', function () {
        (0, globals_1.it)('should display help with --help flag', function () {
            var result = runCliCommand(['validate', '--help']);
            (0, globals_1.expect)(result.exitCode).toBe(0);
            (0, globals_1.expect)(result.output).toContain('Usage: workrail validate');
            (0, globals_1.expect)(result.output).toContain('Validate a workflow file against the schema');
            (0, globals_1.expect)(result.output).toContain('Options:');
            (0, globals_1.expect)(result.output).toContain('-h, --help');
        });
        (0, globals_1.it)('should display help with -h flag', function () {
            var result = runCliCommand(['validate', '-h']);
            (0, globals_1.expect)(result.exitCode).toBe(0);
            (0, globals_1.expect)(result.output).toContain('Usage: workrail validate');
        });
    });
    (0, globals_1.describe)('Error message formatting', function () {
        (0, globals_1.it)('should use singular form for single validation error', function () {
            var workflowWithOneError = {
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
            var tempFile = createTempFile(JSON.stringify(workflowWithOneError));
            var result = runCliCommand(['validate', tempFile]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toContain('Found 1 validation error.');
        });
        (0, globals_1.it)('should use plural form for multiple validation errors', function () {
            var result = runCliCommand(['validate', invalidWorkflowPath]);
            (0, globals_1.expect)(result.exitCode).toBe(1);
            (0, globals_1.expect)(result.error).toMatch(/Found \d+ validation errors\./);
        });
    });
});
