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
// @ts-nocheck
var path_1 = require("path");
var rpc_client_1 = require("../helpers/rpc-client");
jest.setTimeout(30000);
describe('Comprehensive API Endpoint Tests', function () {
    var SERVER_PATH = path_1.default.resolve(__dirname, '../../src/index.ts');
    var client;
    beforeAll(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            client = new rpc_client_1.RpcClient(SERVER_PATH);
            return [2 /*return*/];
        });
    }); }, 30000);
    afterAll(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!client) return [3 /*break*/, 2];
                    return [4 /*yield*/, client.close()];
                case 1:
                    _a.sent();
                    _a.label = 2;
                case 2: return [2 /*return*/];
            }
        });
    }); }, 10000);
    describe('workflow_list endpoint', function () {
        it('should return available workflows', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_list')];
                    case 1:
                        res = _a.sent();
                        expect(res.result).toBeDefined();
                        expect(res.result.workflows).toBeDefined();
                        expect(Array.isArray(res.result.workflows)).toBe(true);
                        expect(res.result.workflows.length).toBeGreaterThan(0);
                        // Verify workflow structure
                        res.result.workflows.forEach(function (workflow) {
                            expect(workflow).toHaveProperty('id');
                            expect(workflow).toHaveProperty('name');
                            expect(workflow).toHaveProperty('description');
                            expect(workflow).toHaveProperty('version');
                            expect(typeof workflow.id).toBe('string');
                            expect(typeof workflow.name).toBe('string');
                            expect(typeof workflow.description).toBe('string');
                            expect(typeof workflow.version).toBe('string');
                        });
                        return [2 /*return*/];
                }
            });
        }); });
        it('should include known workflows', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res, workflowIds;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_list')];
                    case 1:
                        res = _a.sent();
                        workflowIds = res.result.workflows.map(function (w) { return w.id; });
                        expect(workflowIds).toContain('coding-task-workflow');
                        expect(workflowIds).toContain('adaptive-ticket-creation');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('workflow_get endpoint', function () {
        describe('metadata mode', function () {
            it('should return workflow metadata without steps', function () { return __awaiter(void 0, void 0, void 0, function () {
                var res;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, client.send('workflow_get', {
                                id: 'coding-task-workflow',
                                mode: 'metadata'
                            })];
                        case 1:
                            res = _a.sent();
                            expect(res.result).toBeDefined();
                            expect(res.result.id).toBe('coding-task-workflow');
                            expect(res.result).toHaveProperty('name');
                            expect(res.result).toHaveProperty('description');
                            expect(res.result).toHaveProperty('version');
                            expect(res.result).toHaveProperty('totalSteps');
                            expect(res.result).toHaveProperty('preconditions');
                            expect(res.result).toHaveProperty('metaGuidance');
                            expect(res.result).not.toHaveProperty('steps');
                            expect(res.result).not.toHaveProperty('firstStep');
                            expect(typeof res.result.totalSteps).toBe('number');
                            expect(res.result.totalSteps).toBeGreaterThan(0);
                            return [2 /*return*/];
                    }
                });
            }); });
        });
        describe('preview mode (default)', function () {
            it('should return workflow preview with first step', function () { return __awaiter(void 0, void 0, void 0, function () {
                var res;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, client.send('workflow_get', {
                                id: 'coding-task-workflow',
                                mode: 'preview'
                            })];
                        case 1:
                            res = _a.sent();
                            expect(res.result).toBeDefined();
                            expect(res.result.id).toBe('coding-task-workflow');
                            expect(res.result).toHaveProperty('name');
                            expect(res.result).toHaveProperty('description');
                            expect(res.result).toHaveProperty('version');
                            expect(res.result).toHaveProperty('totalSteps');
                            expect(res.result).toHaveProperty('firstStep');
                            expect(res.result).toHaveProperty('preconditions');
                            expect(res.result).toHaveProperty('metaGuidance');
                            expect(res.result).not.toHaveProperty('steps');
                            // Verify first step structure
                            expect(res.result.firstStep).toHaveProperty('id');
                            expect(res.result.firstStep).toHaveProperty('title');
                            expect(res.result.firstStep).toHaveProperty('prompt');
                            expect(res.result.firstStep).toHaveProperty('agentRole');
                            return [2 /*return*/];
                    }
                });
            }); });
            it('should return preview by default when no mode specified', function () { return __awaiter(void 0, void 0, void 0, function () {
                var res;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, client.send('workflow_get', {
                                id: 'coding-task-workflow'
                                // No mode parameter - should default to preview
                            })];
                        case 1:
                            res = _a.sent();
                            expect(res.result).toBeDefined();
                            expect(res.result.id).toBe('coding-task-workflow');
                            expect(res.result).toHaveProperty('name');
                            expect(res.result).toHaveProperty('description');
                            expect(res.result).toHaveProperty('version');
                            expect(res.result).toHaveProperty('totalSteps');
                            expect(res.result).toHaveProperty('firstStep');
                            expect(res.result).toHaveProperty('preconditions');
                            expect(res.result).toHaveProperty('metaGuidance');
                            expect(res.result).not.toHaveProperty('steps');
                            return [2 /*return*/];
                    }
                });
            }); });
        });
        it('should handle non-existent workflow', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_get', {
                            id: 'non-existent-workflow',
                            mode: 'metadata'
                        })];
                    case 1:
                        res = _a.sent();
                        // Should return error response, not throw
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle invalid mode parameter', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_get', {
                            id: 'coding-task-workflow',
                            mode: 'invalid-mode'
                        })];
                    case 1:
                        res = _a.sent();
                        // Should return error response, not throw
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBe(-32602); // Invalid params
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('workflow_next endpoint', function () {
        it('should return first step when no completed steps', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_next', {
                            workflowId: 'coding-task-workflow',
                            completedSteps: []
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.result).toBeDefined();
                        expect(res.result).toHaveProperty('step');
                        expect(res.result).toHaveProperty('guidance');
                        expect(res.result).toHaveProperty('isComplete', false);
                        // Verify step structure
                        expect(res.result.step).toHaveProperty('id');
                        expect(res.result.step).toHaveProperty('title');
                        expect(res.result.step).toHaveProperty('prompt');
                        expect(res.result.step).toHaveProperty('agentRole');
                        return [2 /*return*/];
                }
            });
        }); });
        it('should progress through workflow steps', function () { return __awaiter(void 0, void 0, void 0, function () {
            var firstRes, secondRes;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_next', {
                            workflowId: 'coding-task-workflow',
                            completedSteps: []
                        })];
                    case 1:
                        firstRes = _a.sent();
                        expect(firstRes.result.step.id).toBe('phase-0-intelligent-triage');
                        return [4 /*yield*/, client.send('workflow_next', {
                                workflowId: 'coding-task-workflow',
                                completedSteps: ['phase-0-intelligent-triage']
                            })];
                    case 2:
                        secondRes = _a.sent();
                        expect(secondRes.result.step.id).not.toBe('phase-0-intelligent-triage');
                        expect(secondRes.result.isComplete).toBe(false);
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle conditional steps with context', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_next', {
                            workflowId: 'coding-task-workflow',
                            completedSteps: ['phase-0-intelligent-triage'],
                            context: {
                                taskComplexity: 'Large'
                            }
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.result).toBeDefined();
                        expect(res.result.step).toBeDefined();
                        expect(res.result.isComplete).toBe(false);
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle non-existent workflow', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_next', {
                            workflowId: 'non-existent-workflow',
                            completedSteps: []
                        })];
                    case 1:
                        res = _a.sent();
                        // Should return error response, not throw
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle invalid completed steps', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_next', {
                            workflowId: 'coding-task-workflow',
                            completedSteps: ['invalid-step-id']
                        })];
                    case 1:
                        res = _a.sent();
                        // This should still work as the workflow engine can handle unknown completed steps
                        expect(res.result || res.error).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('workflow_validate endpoint', function () {
        it('should validate step output successfully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: 'coding-task-workflow',
                            stepId: 'phase-0-intelligent-triage',
                            output: 'Task has been analyzed as Medium complexity with clear scope and boundaries.'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.result).toBeDefined();
                        expect(res.result).toHaveProperty('valid', true);
                        expect(res.result).toHaveProperty('issues');
                        expect(res.result).toHaveProperty('suggestions');
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle invalid step output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: 'coding-task-workflow',
                            stepId: 'phase-0-intelligent-triage',
                            output: 'Invalid or incomplete output'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.result).toBeDefined();
                        expect(res.result).toHaveProperty('valid');
                        expect(res.result).toHaveProperty('issues');
                        expect(res.result).toHaveProperty('suggestions');
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle non-existent workflow', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: 'non-existent-workflow',
                            stepId: 'some-step',
                            output: 'Some output'
                        })];
                    case 1:
                        res = _a.sent();
                        // Should return error response, not throw
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle non-existent step', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: 'coding-task-workflow',
                            stepId: 'non-existent-step',
                            output: 'Some output'
                        })];
                    case 1:
                        res = _a.sent();
                        // Should return error response, not throw
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle empty output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: 'coding-task-workflow',
                            stepId: 'phase-0-intelligent-triage',
                            output: ''
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.result).toBeDefined();
                        expect(res.result).toHaveProperty('valid');
                        expect(res.result).toHaveProperty('issues');
                        expect(res.result).toHaveProperty('suggestions');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('Cross-endpoint Integration Tests', function () {
        it('should have consistent workflow data across endpoints', function () { return __awaiter(void 0, void 0, void 0, function () {
            var listRes, workflowFromList, metadataRes;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_list')];
                    case 1:
                        listRes = _a.sent();
                        workflowFromList = listRes.result.workflows.find(function (w) { return w.id === 'coding-task-workflow'; });
                        return [4 /*yield*/, client.send('workflow_get', {
                                id: 'coding-task-workflow',
                                mode: 'metadata'
                            })];
                    case 2:
                        metadataRes = _a.sent();
                        // Verify consistency
                        expect(workflowFromList.id).toBe(metadataRes.result.id);
                        expect(workflowFromList.name).toBe(metadataRes.result.name);
                        expect(workflowFromList.description).toBe(metadataRes.result.description);
                        expect(workflowFromList.version).toBe(metadataRes.result.version);
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle workflow execution flow', function () { return __awaiter(void 0, void 0, void 0, function () {
            var nextRes, validateRes;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_next', {
                            workflowId: 'coding-task-workflow',
                            completedSteps: []
                        })];
                    case 1:
                        nextRes = _a.sent();
                        return [4 /*yield*/, client.send('workflow_validate', {
                                workflowId: 'coding-task-workflow',
                                stepId: nextRes.result.step.id,
                                output: 'Task analyzed as Medium complexity'
                            })];
                    case 2:
                        validateRes = _a.sent();
                        expect(validateRes.result).toBeDefined();
                        expect(validateRes.result).toHaveProperty('valid');
                        expect(validateRes.result).toHaveProperty('issues');
                        expect(validateRes.result).toHaveProperty('suggestions');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('Error Handling and Edge Cases', function () {
        it('should handle missing required parameters', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_get', {})];
                    case 1:
                        res = _a.sent();
                        // Should return error response, not throw
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBe(-32602); // Invalid params
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle large output validation', function () { return __awaiter(void 0, void 0, void 0, function () {
            var largeOutput, res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        largeOutput = 'x'.repeat(10000);
                        return [4 /*yield*/, client.send('workflow_validate', {
                                workflowId: 'coding-task-workflow',
                                stepId: 'phase-0-intelligent-triage',
                                output: largeOutput
                            })];
                    case 1:
                        res = _a.sent();
                        expect(res.result).toBeDefined();
                        expect(res.result).toHaveProperty('valid');
                        expect(res.result).toHaveProperty('issues');
                        expect(res.result).toHaveProperty('suggestions');
                        return [2 /*return*/];
                }
            });
        }); });
        it('should handle special characters in parameters', function () { return __awaiter(void 0, void 0, void 0, function () {
            var specialOutput, res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        specialOutput = 'Output with special chars: \\n\\t\\r"\'<>&';
                        return [4 /*yield*/, client.send('workflow_validate', {
                                workflowId: 'coding-task-workflow',
                                stepId: 'phase-0-intelligent-triage',
                                output: specialOutput
                            })];
                    case 1:
                        res = _a.sent();
                        expect(res.result).toBeDefined();
                        expect(res.result).toHaveProperty('valid');
                        expect(res.result).toHaveProperty('issues');
                        expect(res.result).toHaveProperty('suggestions');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    describe('Performance and Load Testing', function () {
        it('should handle multiple concurrent requests', function () { return __awaiter(void 0, void 0, void 0, function () {
            var promises, results;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        promises = Array(5).fill(null).map(function () {
                            return client.send('workflow_list');
                        });
                        return [4 /*yield*/, Promise.all(promises)];
                    case 1:
                        results = _a.sent();
                        results.forEach(function (result) {
                            expect(result.result).toBeDefined();
                            expect(result.result.workflows).toBeDefined();
                            expect(Array.isArray(result.result.workflows)).toBe(true);
                        });
                        return [2 /*return*/];
                }
            });
        }); });
        it('should complete requests within reasonable time', function () { return __awaiter(void 0, void 0, void 0, function () {
            var startTime, endTime;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        startTime = Date.now();
                        return [4 /*yield*/, client.send('workflow_get', {
                                id: 'coding-task-workflow',
                                mode: 'metadata'
                            })];
                    case 1:
                        _a.sent();
                        endTime = Date.now();
                        expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
