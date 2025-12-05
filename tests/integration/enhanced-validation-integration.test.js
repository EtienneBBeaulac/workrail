"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var globals_1 = require("@jest/globals");
var validation_1 = require("../../src/application/validation");
(0, globals_1.describe)('Enhanced Validation Integration', function () {
    (0, globals_1.describe)('validateWorkflow with Enhanced Error Service', function () {
        (0, globals_1.it)('should provide exact field names for additional properties errors', function () {
            var invalidWorkflow = {
                id: 'test-workflow',
                name: 'Test Workflow',
                description: 'Test description',
                version: '0.0.1',
                steps: [],
                unexpectedField: 'This should not be here' // This is the invalid field
            };
            var result = (0, validation_1.validateWorkflow)(invalidWorkflow);
            (0, globals_1.expect)(result.valid).toBe(false);
            (0, globals_1.expect)(result.errors.length).toBeGreaterThan(0);
            // Find the additional property error
            var additionalPropertyError = result.errors.find(function (error) {
                return error.includes('unexpectedField');
            });
            (0, globals_1.expect)(additionalPropertyError).toBeDefined();
            (0, globals_1.expect)(additionalPropertyError).toContain('unexpectedField');
            (0, globals_1.expect)(additionalPropertyError).toContain('found at root level');
            (0, globals_1.expect)(additionalPropertyError).toContain('This property is not defined in the workflow schema');
        });
        (0, globals_1.it)('should provide exact field names for step-level additional properties', function () {
            var invalidWorkflow = {
                id: 'test-workflow',
                name: 'Test Workflow',
                description: 'Test description',
                version: '0.0.1',
                steps: [
                    {
                        id: 'step-1',
                        title: 'Test Step',
                        prompt: 'Test prompt',
                        agentRole: 'Test role',
                        unexpectedStepField: 'This should not be here' // Invalid field in step
                    }
                ]
            };
            var result = (0, validation_1.validateWorkflow)(invalidWorkflow);
            (0, globals_1.expect)(result.valid).toBe(false);
            (0, globals_1.expect)(result.errors.length).toBeGreaterThan(0);
            // Find the additional property error
            var additionalPropertyError = result.errors.find(function (error) {
                return error.includes('unexpectedStepField');
            });
            (0, globals_1.expect)(additionalPropertyError).toBeDefined();
            (0, globals_1.expect)(additionalPropertyError).toContain('unexpectedStepField');
            (0, globals_1.expect)(additionalPropertyError).toContain('found in step 1');
            (0, globals_1.expect)(additionalPropertyError).toContain('This property is not defined in the workflow schema');
        });
        (0, globals_1.it)('should provide specific missing field names for required property errors', function () {
            var invalidWorkflow = {
                id: 'test-workflow',
                // Missing required fields: name, description, version, steps
            };
            var result = (0, validation_1.validateWorkflow)(invalidWorkflow);
            (0, globals_1.expect)(result.valid).toBe(false);
            (0, globals_1.expect)(result.errors.length).toBeGreaterThan(0);
            // Check that at least one error mentions a specific missing field
            var hasSpecificMissingField = result.errors.some(function (error) {
                return error.includes('Missing required field') &&
                    (error.includes('name') || error.includes('description') || error.includes('version') || error.includes('steps'));
            });
            (0, globals_1.expect)(hasSpecificMissingField).toBe(true);
        });
        (0, globals_1.it)('should prioritize critical errors (additional properties, required fields) first', function () {
            var invalidWorkflow = {
                id: 'test-workflow',
                name: 123, // Type error (should be string)
                version: '0.0.1',
                steps: [],
                unexpectedField: 'additional property error' // Additional property error
                // Missing required field: description
            };
            var result = (0, validation_1.validateWorkflow)(invalidWorkflow);
            (0, globals_1.expect)(result.valid).toBe(false);
            (0, globals_1.expect)(result.errors.length).toBeGreaterThan(0);
            // Critical errors (additional properties, required fields) should come first
            (0, globals_1.expect)(result.errors.length).toBeGreaterThan(0);
            var firstError = result.errors[0];
            (0, globals_1.expect)(firstError).toBeDefined();
            var isCriticalError = firstError.includes('Unexpected property') ||
                firstError.includes('Missing required field');
            (0, globals_1.expect)(isCriticalError).toBe(true);
        });
        (0, globals_1.it)('should handle multiple errors with enhanced messages', function () {
            var invalidWorkflow = {
                id: 'test-workflow',
                name: 'Test Workflow',
                description: 'Test description',
                version: '0.0.1',
                steps: [],
                unexpectedField1: 'first invalid field',
                unexpectedField2: 'second invalid field'
            };
            var result = (0, validation_1.validateWorkflow)(invalidWorkflow);
            (0, globals_1.expect)(result.valid).toBe(false);
            (0, globals_1.expect)(result.errors.length).toBeGreaterThan(1);
            // Each error should be specific
            var hasSpecificError1 = result.errors.some(function (error) {
                return error.includes('unexpectedField1') && error.includes('found at root level');
            });
            var hasSpecificError2 = result.errors.some(function (error) {
                return error.includes('unexpectedField2') && error.includes('found at root level');
            });
            (0, globals_1.expect)(hasSpecificError1).toBe(true);
            (0, globals_1.expect)(hasSpecificError2).toBe(true);
        });
        (0, globals_1.it)('should maintain backward compatibility with valid workflows', function () {
            var validWorkflow = {
                id: 'test-workflow',
                name: 'Test Workflow',
                description: 'Test description',
                version: '0.0.1',
                steps: [
                    {
                        id: 'step-1',
                        title: 'Test Step',
                        prompt: 'Test prompt',
                        agentRole: 'You are a test assistant.',
                        validationCriteria: [
                            {
                                type: 'contains',
                                value: 'test',
                                message: 'Implementation should include test functionality'
                            }
                        ]
                    }
                ]
            };
            var result = (0, validation_1.validateWorkflow)(validWorkflow);
            (0, globals_1.expect)(result.valid).toBe(true);
            (0, globals_1.expect)(result.errors).toHaveLength(0);
        });
    });
});
