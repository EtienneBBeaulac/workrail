"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var globals_1 = require("@jest/globals");
var fs_1 = require("fs");
var path_1 = require("path");
var validation_1 = require("../../src/application/validation");
var validPath = path_1.default.resolve(__dirname, '../../spec/examples/valid-workflow.json');
var invalidPath = path_1.default.resolve(__dirname, '../../spec/examples/invalid-workflow.json');
(0, globals_1.describe)('Workflow Validation', function () {
    (0, globals_1.it)('should validate a valid workflow as valid', function () {
        var data = JSON.parse(fs_1.default.readFileSync(validPath, 'utf-8'));
        var result = (0, validation_1.validateWorkflow)(data);
        (0, globals_1.expect)(result.valid).toBe(true);
        (0, globals_1.expect)(result.errors.length).toBe(0);
    });
    (0, globals_1.it)('should validate an invalid workflow as invalid', function () {
        var data = JSON.parse(fs_1.default.readFileSync(invalidPath, 'utf-8'));
        var result = (0, validation_1.validateWorkflow)(data);
        (0, globals_1.expect)(result.valid).toBe(false);
        (0, globals_1.expect)(result.errors.length).toBeGreaterThan(0);
    });
    (0, globals_1.it)('should handle non-object input as invalid', function () {
        var result = (0, validation_1.validateWorkflow)(null);
        (0, globals_1.expect)(result.valid).toBe(false);
        (0, globals_1.expect)(result.errors.length).toBeGreaterThan(0);
    });
});
