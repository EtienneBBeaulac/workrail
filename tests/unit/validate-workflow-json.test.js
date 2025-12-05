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
(0, globals_1.describe)('Validate Workflow JSON Use Case', function () {
    var validateWorkflowJsonUseCase;
    (0, globals_1.beforeEach)(function () {
        validateWorkflowJsonUseCase = (0, validate_workflow_json_1.createValidateWorkflowJson)();
    });
    (0, globals_1.describe)('createValidateWorkflowJson factory', function () {
        (0, globals_1.it)('should create a use case function', function () {
            var useCase = (0, validate_workflow_json_1.createValidateWorkflowJson)();
            (0, globals_1.expect)(typeof useCase).toBe('function');
        });
        (0, globals_1.it)('should return async function', function () {
            var useCase = (0, validate_workflow_json_1.createValidateWorkflowJson)();
            var result = useCase('{}');
            (0, globals_1.expect)(result).toBeInstanceOf(Promise);
        });
    });
    (0, globals_1.describe)('input validation', function () {
        (0, globals_1.it)('should reject null input', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase(null)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Workflow JSON content is required and must be a string.');
                        (0, globals_1.expect)(result.suggestions).toContain('Provide valid JSON content for the workflow.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should reject undefined input', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase(undefined)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Workflow JSON content is required and must be a string.');
                        (0, globals_1.expect)(result.suggestions).toContain('Provide valid JSON content for the workflow.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should reject non-string input', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase(123)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Workflow JSON content is required and must be a string.');
                        (0, globals_1.expect)(result.suggestions).toContain('Provide valid JSON content for the workflow.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should reject empty string', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase('')];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Workflow JSON content is empty.');
                        (0, globals_1.expect)(result.suggestions).toContain('Provide valid JSON content for the workflow.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should reject whitespace-only string', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase('   \n  \t  ')];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Workflow JSON content is empty.');
                        (0, globals_1.expect)(result.suggestions).toContain('Provide valid JSON content for the workflow.');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('JSON parsing errors', function () {
        (0, globals_1.it)('should handle invalid JSON syntax', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase('{ invalid json }')];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues[0]).toContain('Invalid JSON syntax:');
                        (0, globals_1.expect)(result.suggestions).toContain('Check for missing quotes, commas, or brackets in the JSON.');
                        (0, globals_1.expect)(result.suggestions).toContain('Ensure all strings are properly quoted.');
                        (0, globals_1.expect)(result.suggestions).toContain('Verify that brackets and braces are properly matched.');
                        (0, globals_1.expect)(result.suggestions).toContain('Use a JSON formatter or validator to identify syntax errors.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle missing quotes', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase('{ id: test }')];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues[0]).toContain('Invalid JSON syntax:');
                        (0, globals_1.expect)(result.suggestions).toContain('Ensure all strings are properly quoted.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle trailing commas', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase('{ "id": "test", }')];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues[0]).toContain('Invalid JSON syntax:');
                        (0, globals_1.expect)(result.suggestions).toContain('Check for missing quotes, commas, or brackets in the JSON.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle unmatched brackets', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, validateWorkflowJsonUseCase('{ "id": "test"')];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues[0]).toContain('Invalid JSON syntax:');
                        (0, globals_1.expect)(result.suggestions).toContain('Verify that brackets and braces are properly matched.');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('valid workflow validation', function () {
        (0, globals_1.it)('should validate minimal valid workflow', function () { return __awaiter(void 0, void 0, void 0, function () {
            var validWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        validWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '0.0.1',
                            steps: [{
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Do something'
                                }]
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(validWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        (0, globals_1.expect)(result.suggestions).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should validate complex valid workflow', function () { return __awaiter(void 0, void 0, void 0, function () {
            var validWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        validWorkflow = {
                            id: 'complex-workflow',
                            name: 'Complex Test Workflow',
                            description: 'A complex test workflow with multiple features',
                            version: '1.0.0',
                            preconditions: ['User has access to system'],
                            metaGuidance: ['Follow best practices'],
                            steps: [{
                                    id: 'step-1',
                                    title: 'First Step',
                                    prompt: 'Do the first task',
                                    guidance: ['Be careful', 'Double check'],
                                    askForFiles: true,
                                    requireConfirmation: false,
                                    runCondition: {
                                        var: 'complexity',
                                        equals: 'high'
                                    }
                                }, {
                                    id: 'step-2',
                                    title: 'Second Step',
                                    prompt: 'Do the second task'
                                }]
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(validWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        (0, globals_1.expect)(result.suggestions).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('invalid workflow validation', function () {
        (0, globals_1.it)('should detect missing required fields', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = {
                            id: 'test-workflow'
                            // Missing name, description, version, steps
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues.length).toBeGreaterThan(0);
                        (0, globals_1.expect)(result.suggestions.length).toBeGreaterThan(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should detect invalid field types', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = {
                            id: 'test-workflow',
                            name: 123, // Should be string
                            description: 'Test description',
                            version: '0.0.1',
                            steps: []
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues.some(function (issue) { return issue.includes('Expected \'string\' but received a different type'); })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should detect invalid ID pattern', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = {
                            id: 'Test_Workflow!', // Invalid characters
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '0.0.1',
                            steps: [{
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Do something'
                                }]
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues.some(function (issue) { return issue.includes('pattern'); })).toBe(true);
                        (0, globals_1.expect)(result.suggestions.some(function (suggestion) {
                            return suggestion.includes('lowercase letters, numbers, and hyphens only');
                        })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should detect empty steps array', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '0.0.1',
                            steps: [] // Empty steps array
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.suggestions.some(function (suggestion) {
                            return suggestion.includes('at least one step');
                        })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should detect invalid version format', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: 'invalid-version',
                            steps: [{
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Do something'
                                }]
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.suggestions.some(function (suggestion) {
                            return suggestion.includes('semantic versioning');
                        })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('error message enhancement', function () {
        (0, globals_1.it)('should enhance missing required property errors', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = {
                            id: 'test-workflow'
                            // Missing required fields
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues.some(function (issue) {
                            return issue.includes('Missing required field') && issue.includes('This field is mandatory and must be provided');
                        })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should enhance additional properties errors', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '0.0.1',
                            steps: [{
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Do something'
                                }],
                            invalidProperty: 'should not be here'
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues.some(function (issue) {
                            return issue.includes('Unexpected property') && issue.includes('This property is not defined in the workflow schema');
                        })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('suggestions generation', function () {
        (0, globals_1.it)('should provide specific suggestions for common errors', function () { return __awaiter(void 0, void 0, void 0, function () {
            var invalidWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        invalidWorkflow = {
                            id: 'Test_Workflow!', // Invalid ID
                            name: 123, // Invalid name type
                            description: '', // Empty description
                            version: 'bad-version', // Invalid version
                            steps: [] // Empty steps
                        };
                        return [4 /*yield*/, validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.suggestions).toContain('Ensure the workflow ID follows the pattern: lowercase letters, numbers, and hyphens only.');
                        (0, globals_1.expect)(result.suggestions).toContain('Provide a clear, descriptive name for the workflow.');
                        (0, globals_1.expect)(result.suggestions).toContain('Add a meaningful description explaining what the workflow accomplishes.');
                        (0, globals_1.expect)(result.suggestions).toContain('Use semantic versioning format (e.g., "0.0.1", "1.0.0").');
                        (0, globals_1.expect)(result.suggestions).toContain('Ensure the workflow has at least one step with id, title, and prompt fields.');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('legacy function export', function () {
        (0, globals_1.it)('should work with legacy validateWorkflowJson function', function () { return __awaiter(void 0, void 0, void 0, function () {
            var validWorkflow, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        validWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'A test workflow',
                            version: '0.0.1',
                            steps: [{
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Do something'
                                }]
                        };
                        return [4 /*yield*/, (0, validate_workflow_json_1.validateWorkflowJson)(JSON.stringify(validWorkflow))];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        (0, globals_1.expect)(result.suggestions).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
