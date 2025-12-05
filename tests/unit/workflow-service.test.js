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
var workflow_service_1 = require("../../src/application/services/workflow-service");
var mockWorkflow = {
    id: 'test-workflow',
    name: 'Test Workflow',
    description: 'A workflow for testing.',
    version: '0.0.1',
    steps: [
        { id: 'step1', title: 'Step 1', prompt: 'Prompt for step 1' },
        {
            id: 'step2',
            title: 'Step 2',
            prompt: 'Prompt for step 2',
            guidance: ['Guidance 1 for step 2', 'Guidance 2 for step 2'],
        },
        { id: 'step3', title: 'Step 3', prompt: 'Prompt for step 3' },
    ],
};
var mockWorkflowWithAgentRole = {
    id: 'test-workflow-agent-role',
    name: 'Test Workflow with Agent Role',
    description: 'A workflow for testing agentRole functionality.',
    version: '0.0.1',
    steps: [
        {
            id: 'step1',
            title: 'Step 1',
            prompt: 'User-facing prompt for step 1',
            agentRole: 'You are a helpful coding assistant. Focus on best practices.'
        },
        {
            id: 'step2',
            title: 'Step 2',
            prompt: 'User-facing prompt for step 2',
            agentRole: 'Act as a code reviewer. Be thorough and constructive.',
            guidance: ['Check for bugs', 'Verify style guidelines'],
        },
        {
            id: 'step3',
            title: 'Step 3',
            prompt: 'User-facing prompt for step 3'
            // No agentRole - should work normally
        },
        {
            id: 'step4',
            title: 'Step 4',
            prompt: 'User-facing prompt for step 4',
            agentRole: '', // Empty agentRole should be handled gracefully
            guidance: ['Handle empty agentRole']
        },
    ],
};
var mockStorage = {
    getWorkflowById: function (id) { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            if (id === mockWorkflow.id) {
                return [2 /*return*/, Promise.resolve(mockWorkflow)];
            }
            if (id === mockWorkflowWithAgentRole.id) {
                return [2 /*return*/, Promise.resolve(mockWorkflowWithAgentRole)];
            }
            return [2 /*return*/, Promise.resolve(null)];
        });
    }); },
    listWorkflowSummaries: function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, Promise.resolve([])];
        });
    }); },
    loadAllWorkflows: function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, Promise.resolve([mockWorkflow, mockWorkflowWithAgentRole])];
        });
    }); },
};
(0, globals_1.describe)('DefaultWorkflowService', function () {
    var service;
    (0, globals_1.beforeEach)(function () {
        service = new workflow_service_1.DefaultWorkflowService(mockStorage);
        globals_1.jest.clearAllMocks();
    });
    (0, globals_1.describe)('getNextStep', function () {
        (0, globals_1.it)('should return the first step if no steps are completed', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow', [])];
                    case 1:
                        result = _b.sent();
                        (0, globals_1.expect)((_a = result.step) === null || _a === void 0 ? void 0 : _a.id).toBe('step1');
                        (0, globals_1.expect)(result.guidance.prompt).toBe('Prompt for step 1');
                        (0, globals_1.expect)(result.isComplete).toBe(false);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should return the next step based on completed steps', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow', ['step1'])];
                    case 1:
                        result = _b.sent();
                        (0, globals_1.expect)((_a = result.step) === null || _a === void 0 ? void 0 : _a.id).toBe('step2');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should prepend guidance to the prompt if it exists', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, expectedPrompt;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow', ['step1'])];
                    case 1:
                        result = _a.sent();
                        expectedPrompt = '## Step Guidance\n- Guidance 1 for step 2\n- Guidance 2 for step 2\n\nPrompt for step 2';
                        (0, globals_1.expect)(result.guidance.prompt).toBe(expectedPrompt);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should not prepend guidance if it does not exist', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow', ['step1', 'step2'])];
                    case 1:
                        result = _b.sent();
                        (0, globals_1.expect)((_a = result.step) === null || _a === void 0 ? void 0 : _a.id).toBe('step3');
                        (0, globals_1.expect)(result.guidance.prompt).toBe('Prompt for step 3');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should indicate completion when all steps are done', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow', ['step1', 'step2', 'step3'])];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.step).toBeNull();
                        (0, globals_1.expect)(result.isComplete).toBe(true);
                        (0, globals_1.expect)(result.guidance.prompt).toBe('Workflow complete.');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('getNextStep with agentRole', function () {
        (0, globals_1.it)('should include agentRole instructions at the top of guidance prompt', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, expectedPrompt;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow-agent-role', [])];
                    case 1:
                        result = _c.sent();
                        (0, globals_1.expect)((_a = result.step) === null || _a === void 0 ? void 0 : _a.id).toBe('step1');
                        (0, globals_1.expect)((_b = result.step) === null || _b === void 0 ? void 0 : _b.agentRole).toBe('You are a helpful coding assistant. Focus on best practices.');
                        expectedPrompt = '## Agent Role Instructions\n' +
                            'You are a helpful coding assistant. Focus on best practices.\n\n' +
                            'User-facing prompt for step 1';
                        (0, globals_1.expect)(result.guidance.prompt).toBe(expectedPrompt);
                        (0, globals_1.expect)(result.isComplete).toBe(false);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should include agentRole with guidance when both are present', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, expectedPrompt;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow-agent-role', ['step1'])];
                    case 1:
                        result = _c.sent();
                        (0, globals_1.expect)((_a = result.step) === null || _a === void 0 ? void 0 : _a.id).toBe('step2');
                        (0, globals_1.expect)((_b = result.step) === null || _b === void 0 ? void 0 : _b.agentRole).toBe('Act as a code reviewer. Be thorough and constructive.');
                        expectedPrompt = '## Agent Role Instructions\n' +
                            'Act as a code reviewer. Be thorough and constructive.\n\n' +
                            '## Step Guidance\n' +
                            '- Check for bugs\n' +
                            '- Verify style guidelines\n\n' +
                            'User-facing prompt for step 2';
                        (0, globals_1.expect)(result.guidance.prompt).toBe(expectedPrompt);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should work normally for steps without agentRole', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow-agent-role', ['step1', 'step2'])];
                    case 1:
                        result = _c.sent();
                        (0, globals_1.expect)((_a = result.step) === null || _a === void 0 ? void 0 : _a.id).toBe('step3');
                        (0, globals_1.expect)((_b = result.step) === null || _b === void 0 ? void 0 : _b.agentRole).toBeUndefined();
                        (0, globals_1.expect)(result.guidance.prompt).toBe('User-facing prompt for step 3');
                        (0, globals_1.expect)(result.guidance.prompt).not.toContain('Agent Role Instructions');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle empty agentRole gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, expectedPrompt;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow-agent-role', ['step1', 'step2', 'step3'])];
                    case 1:
                        result = _c.sent();
                        (0, globals_1.expect)((_a = result.step) === null || _a === void 0 ? void 0 : _a.id).toBe('step4');
                        (0, globals_1.expect)((_b = result.step) === null || _b === void 0 ? void 0 : _b.agentRole).toBe('');
                        expectedPrompt = '## Step Guidance\n' +
                            '- Handle empty agentRole\n\n' +
                            'User-facing prompt for step 4';
                        (0, globals_1.expect)(result.guidance.prompt).toBe(expectedPrompt);
                        (0, globals_1.expect)(result.guidance.prompt).not.toContain('Agent Role Instructions');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should maintain backward compatibility with existing workflows', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0: return [4 /*yield*/, service.getNextStep('test-workflow', [])];
                    case 1:
                        result = _c.sent();
                        (0, globals_1.expect)((_a = result.step) === null || _a === void 0 ? void 0 : _a.id).toBe('step1');
                        (0, globals_1.expect)((_b = result.step) === null || _b === void 0 ? void 0 : _b.agentRole).toBeUndefined();
                        (0, globals_1.expect)(result.guidance.prompt).toBe('Prompt for step 1');
                        (0, globals_1.expect)(result.guidance.prompt).not.toContain('Agent Role Instructions');
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
