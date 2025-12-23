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
var get_workflow_1 = require("../../src/application/use-cases/get-workflow");
var error_handler_1 = require("../../src/core/error-handler");
var mockWorkflow = {
    id: 'test-workflow',
    name: 'Test Workflow',
    description: 'A workflow for testing.',
    version: '0.0.1',
    preconditions: ['User has access to system'],
    clarificationPrompts: ['What is your goal?'],
    metaGuidance: ['Follow best practices'],
    steps: [
        { id: 'step1', title: 'Step 1', prompt: 'Prompt for step 1' },
        { id: 'step2', title: 'Step 2', prompt: 'Prompt for step 2' },
        { id: 'step3', title: 'Step 3', prompt: 'Prompt for step 3' },
    ],
};
var mockWorkflowWithConditions = {
    id: 'conditional-workflow',
    name: 'Conditional Workflow',
    description: 'A workflow with conditional steps.',
    version: '0.0.1',
    steps: [
        {
            id: 'step1',
            title: 'Step 1',
            prompt: 'Always executable step',
        },
        {
            id: 'step2',
            title: 'Step 2',
            prompt: 'Only for complex tasks',
            runCondition: { var: 'complexity', equals: 'high' }
        },
        {
            id: 'step3',
            title: 'Step 3',
            prompt: 'Simple task step',
            runCondition: { var: 'complexity', equals: 'low' }
        },
    ],
};
var mockEmptyWorkflow = {
    id: 'empty-workflow',
    name: 'Empty Workflow',
    description: 'A workflow with no steps.',
    version: '0.0.1',
    steps: [],
};
var mockWorkflowWithUndefinedOptionals = {
    id: 'minimal-workflow',
    name: 'Minimal Workflow',
    description: 'A minimal workflow.',
    version: '0.0.1',
    steps: [
        { id: 'step1', title: 'Step 1', prompt: 'Prompt for step 1' },
    ],
};
// Create a mock service that can be controlled by tests
var MockWorkflowService = /** @class */ (function () {
    function MockWorkflowService() {
        this.workflows = new Map();
        this.shouldThrowError = false;
        this.errorToThrow = null;
    }
    MockWorkflowService.prototype.setWorkflow = function (workflow) {
        this.workflows.set(workflow.id, workflow);
    };
    MockWorkflowService.prototype.setError = function (error) {
        this.shouldThrowError = true;
        this.errorToThrow = error;
    };
    MockWorkflowService.prototype.clear = function () {
        this.workflows.clear();
        this.shouldThrowError = false;
        this.errorToThrow = null;
    };
    MockWorkflowService.prototype.getWorkflowById = function (id) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                if (this.shouldThrowError && this.errorToThrow) {
                    throw this.errorToThrow;
                }
                return [2 /*return*/, this.workflows.get(id) || null];
            });
        });
    };
    MockWorkflowService.prototype.listWorkflowSummaries = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, []];
            });
        });
    };
    MockWorkflowService.prototype.getNextStep = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, { step: null, guidance: { prompt: '' }, isComplete: true }];
            });
        });
    };
    MockWorkflowService.prototype.validateStepOutput = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, { valid: true, issues: [], suggestions: [] }];
            });
        });
    };
    return MockWorkflowService;
}());
(0, globals_1.describe)('createGetWorkflow', function () {
    var mockService;
    var getWorkflow;
    (0, globals_1.beforeEach)(function () {
        mockService = new MockWorkflowService();
        mockService.clear();
        getWorkflow = (0, get_workflow_1.createGetWorkflow)(mockService);
    });
    (0, globals_1.describe)('when workflow exists', function () {
        (0, globals_1.beforeEach)(function () {
            mockService.setWorkflow(mockWorkflow);
        });
        (0, globals_1.describe)('preview mode (default)', function () {
            (0, globals_1.it)('should return workflow metadata with first step', function () { return __awaiter(void 0, void 0, void 0, function () {
                var result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, getWorkflow('test-workflow')];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual({
                                id: 'test-workflow',
                                name: 'Test Workflow',
                                description: 'A workflow for testing.',
                                version: '0.0.1',
                                preconditions: ['User has access to system'],
                                clarificationPrompts: ['What is your goal?'],
                                metaGuidance: ['Follow best practices'],
                                totalSteps: 3,
                                firstStep: {
                                    id: 'step1',
                                    title: 'Step 1',
                                    prompt: 'Prompt for step 1'
                                }
                            });
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should return workflow metadata with first step when explicitly set to preview', function () { return __awaiter(void 0, void 0, void 0, function () {
                var result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, getWorkflow('test-workflow', 'preview')];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual({
                                id: 'test-workflow',
                                name: 'Test Workflow',
                                description: 'A workflow for testing.',
                                version: '0.0.1',
                                preconditions: ['User has access to system'],
                                clarificationPrompts: ['What is your goal?'],
                                metaGuidance: ['Follow best practices'],
                                totalSteps: 3,
                                firstStep: {
                                    id: 'step1',
                                    title: 'Step 1',
                                    prompt: 'Prompt for step 1'
                                }
                            });
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should return null firstStep for empty workflow', function () { return __awaiter(void 0, void 0, void 0, function () {
                var result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockService.setWorkflow(mockEmptyWorkflow);
                            return [4 /*yield*/, getWorkflow('empty-workflow', 'preview')];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual({
                                id: 'empty-workflow',
                                name: 'Empty Workflow',
                                description: 'A workflow with no steps.',
                                version: '0.0.1',
                                totalSteps: 0,
                                firstStep: null
                            });
                            return [2 /*return*/];
                    }
                });
            }); });
        });
        (0, globals_1.describe)('metadata mode', function () {
            (0, globals_1.it)('should return workflow metadata without steps', function () { return __awaiter(void 0, void 0, void 0, function () {
                var result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, getWorkflow('test-workflow', 'metadata')];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual({
                                id: 'test-workflow',
                                name: 'Test Workflow',
                                description: 'A workflow for testing.',
                                version: '0.0.1',
                                preconditions: ['User has access to system'],
                                clarificationPrompts: ['What is your goal?'],
                                metaGuidance: ['Follow best practices'],
                                totalSteps: 3
                            });
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should omit optional fields when undefined', function () { return __awaiter(void 0, void 0, void 0, function () {
                var result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockService.setWorkflow(mockWorkflowWithUndefinedOptionals);
                            return [4 /*yield*/, getWorkflow('minimal-workflow', 'metadata')];
                        case 1:
                            result = _a.sent();
                            // Important: MCP output boundary forbids `undefined`, so we must omit absent fields.
                            (0, globals_1.expect)(result).toEqual({
                                id: 'minimal-workflow',
                                name: 'Minimal Workflow',
                                description: 'A minimal workflow.',
                                version: '0.0.1',
                                totalSteps: 1
                            });
                            (0, globals_1.expect)('preconditions' in result).toBe(false);
                            (0, globals_1.expect)('clarificationPrompts' in result).toBe(false);
                            (0, globals_1.expect)('metaGuidance' in result).toBe(false);
                            return [2 /*return*/];
                    }
                });
            }); });
        });
        (0, globals_1.describe)('conditional step handling', function () {
            (0, globals_1.beforeEach)(function () {
                mockService.setWorkflow(mockWorkflowWithConditions);
            });
            (0, globals_1.it)('should return first unconditional step as firstStep', function () { return __awaiter(void 0, void 0, void 0, function () {
                var result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, getWorkflow('conditional-workflow', 'preview')];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual({
                                id: 'conditional-workflow',
                                name: 'Conditional Workflow',
                                description: 'A workflow with conditional steps.',
                                version: '0.0.1',
                                totalSteps: 3,
                                firstStep: {
                                    id: 'step1',
                                    title: 'Step 1',
                                    prompt: 'Always executable step'
                                }
                            });
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should return null firstStep if all steps have unmet conditions', function () { return __awaiter(void 0, void 0, void 0, function () {
                var mockAllConditionalWorkflow, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockAllConditionalWorkflow = {
                                id: 'all-conditional',
                                name: 'All Conditional',
                                description: 'All steps are conditional.',
                                version: '0.0.1',
                                steps: [
                                    {
                                        id: 'step1',
                                        title: 'Step 1',
                                        prompt: 'High complexity step',
                                        runCondition: { var: 'complexity', equals: 'high' }
                                    },
                                    {
                                        id: 'step2',
                                        title: 'Step 2',
                                        prompt: 'Low complexity step',
                                        runCondition: { var: 'complexity', equals: 'low' }
                                    }
                                ]
                            };
                            mockService.setWorkflow(mockAllConditionalWorkflow);
                            return [4 /*yield*/, getWorkflow('all-conditional', 'preview')];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual({
                                id: 'all-conditional',
                                name: 'All Conditional',
                                description: 'All steps are conditional.',
                                version: '0.0.1',
                                totalSteps: 2,
                                firstStep: null
                            });
                            return [2 /*return*/];
                    }
                });
            }); });
        });
    });
    (0, globals_1.describe)('when workflow does not exist', function () {
        (0, globals_1.it)('should throw WorkflowNotFoundError for metadata mode', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, globals_1.expect)(getWorkflow('nonexistent-workflow', 'metadata')).rejects.toThrow(error_handler_1.WorkflowNotFoundError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw WorkflowNotFoundError for preview mode', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, globals_1.expect)(getWorkflow('nonexistent-workflow', 'preview')).rejects.toThrow(error_handler_1.WorkflowNotFoundError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw WorkflowNotFoundError for default mode', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, globals_1.expect)(getWorkflow('nonexistent-workflow')).rejects.toThrow(error_handler_1.WorkflowNotFoundError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('service integration', function () {
        (0, globals_1.it)('should handle service errors gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var serviceError;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        serviceError = new Error('Service error');
                        mockService.setError(serviceError);
                        return [4 /*yield*/, (0, globals_1.expect)(getWorkflow('test-workflow')).rejects.toThrow('Service error')];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('type safety', function () {
        (0, globals_1.it)('should accept valid mode values', function () { return __awaiter(void 0, void 0, void 0, function () {
            var modes, _i, modes_1, mode;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        mockService.setWorkflow(mockWorkflow);
                        modes = ['metadata', 'preview', undefined];
                        _i = 0, modes_1 = modes;
                        _a.label = 1;
                    case 1:
                        if (!(_i < modes_1.length)) return [3 /*break*/, 4];
                        mode = modes_1[_i];
                        return [4 /*yield*/, (0, globals_1.expect)(getWorkflow('test-workflow', mode)).resolves.toBeDefined()];
                    case 2:
                        _a.sent();
                        _a.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4: return [2 /*return*/];
                }
            });
        }); });
    });
});
