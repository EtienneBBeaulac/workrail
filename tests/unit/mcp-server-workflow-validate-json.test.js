"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var globals_1 = require("@jest/globals");
var validate_workflow_json_1 = require("../../src/application/use-cases/validate-workflow-json");
// Test the workflow validation functionality that powers the MCP tool
(0, globals_1.describe)('MCP Server - workflow_validate_json Integration', function () {
    var validateWorkflowJsonUseCase;
    (0, globals_1.beforeEach)(function () {
        // Test the use case directly since the MCP server class is not exported
        validateWorkflowJsonUseCase = (0, validate_workflow_json_1.createValidateWorkflowJson)();
    });
    (0, globals_1.describe)('workflow validation use case integration', function () {
        (0, globals_1.it)('should validate a valid workflow JSON', function () { return __awaiter(void 0, void 0, void 0, function () {
            var validWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        validWorkflow = JSON.stringify({
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '0.0.1',
                            steps: [{
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Do something'
                                }]
                        });
                        return [4 /*yield*/, validateWorkflowJsonUseCase(validWorkflow)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result).toBeDefined();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        (0, globals_1.expect)(result.suggestions).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should reject invalid workflow JSON', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = JSON.stringify({
                            id: 'test-workflow'
                            // Missing required fields: name, description, version, steps
                        });
                        return [4 /*yield*/, validateWorkflowJsonUseCase(invalidWorkflow)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result).toBeDefined();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues.length).toBeGreaterThan(0);
                        (0, globals_1.expect)(result.suggestions.length).toBeGreaterThan(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle malformed JSON', function () { return __awaiter(void 0, void 0, void 0, function () {
            var malformedJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        malformedJson = '{ invalid json }';
                        return [4 /*yield*/, validateWorkflowJsonUseCase(malformedJson)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result).toBeDefined();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues.some(function (issue) { return issue.includes('Invalid JSON syntax'); })).toBe(true);
                        (0, globals_1.expect)(result.suggestions.some(function (suggestion) {
                            return suggestion.includes('Check for missing quotes, commas, or brackets');
                        })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle empty workflow JSON', function () { return __awaiter(void 0, void 0, void 0, function () {
            var emptyJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        emptyJson = '';
                        return [4 /*yield*/, validateWorkflowJsonUseCase(emptyJson)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result).toBeDefined();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Workflow JSON content is empty.');
                        (0, globals_1.expect)(result.suggestions).toContain('Provide valid JSON content for the workflow.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should provide enhanced error messages for common issues', function () { return __awaiter(void 0, void 0, void 0, function () {
            var workflowWithInvalidId, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        workflowWithInvalidId = JSON.stringify({
                            id: 'Test_Workflow!', // Invalid characters in ID
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '0.0.1',
                            steps: [{
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Do something'
                                }]
                        });
                        return [4 /*yield*/, validateWorkflowJsonUseCase(workflowWithInvalidId)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result).toBeDefined();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.suggestions.some(function (suggestion) {
                            return suggestion.includes('lowercase letters, numbers, and hyphens only');
                        })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
