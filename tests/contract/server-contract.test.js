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
var response_validator_1 = require("../../src/validation/response-validator");
jest.setTimeout(10000);
describe('MCP Server JSON-RPC contract', function () {
    var SERVER_PATH = path_1.default.resolve(__dirname, '../../src/index.ts');
    var SAMPLE_ID = 'coding-task-workflow';
    var client;
    beforeAll(function () {
        client = new rpc_client_1.RpcClient(SERVER_PATH);
    });
    afterAll(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.close()];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    it('responds to workflow_list', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('workflow_list')];
                case 1:
                    res = _a.sent();
                    expect(res.jsonrpc).toBe('2.0');
                    expect(res.result).toBeDefined();
                    response_validator_1.responseValidator.validate('workflow_list', res.result);
                    expect(Array.isArray(res.result.workflows)).toBe(true);
                    return [2 /*return*/];
            }
        });
    }); });
    it('returns a workflow with workflow_get', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('workflow_get', { id: SAMPLE_ID })];
                case 1:
                    res = _a.sent();
                    expect(res.result).toBeDefined();
                    expect(res.result.id).toBe(SAMPLE_ID);
                    response_validator_1.responseValidator.validate('workflow_get', res.result);
                    return [2 /*return*/];
            }
        });
    }); });
    it('gives next step via workflow_next', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('workflow_next', { workflowId: SAMPLE_ID, completedSteps: [] })];
                case 1:
                    res = _a.sent();
                    response_validator_1.responseValidator.validate('workflow_next', res.result);
                    expect(res.result.step).not.toBeNull();
                    expect(res.result.isComplete).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
    it('returns METHOD_NOT_FOUND error for unknown method', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('unknown_method')];
                case 1:
                    res = _a.sent();
                    expect(res.error).toBeDefined();
                    expect(res.error.code).toBe(-32601);
                    return [2 /*return*/];
            }
        });
    }); });
    it('returns INVALID_PARAMS for bad params', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('workflow_get', {})];
                case 1:
                    res = _a.sent();
                    expect(res.error).toBeDefined();
                    expect(res.error.code).toBe(-32602);
                    return [2 /*return*/];
            }
        });
    }); });
    it('handles initialize handshake', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} })];
                case 1:
                    res = _a.sent();
                    expect(res.result.serverInfo).toBeDefined();
                    expect(res.result.serverInfo.name).toBeDefined();
                    expect(res.result.protocolVersion).toBe('2024-11-05');
                    expect(res.result.capabilities.tools.listChanged).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
    it('rejects unsupported protocol version', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('initialize', { protocolVersion: '1.0', capabilities: {} })];
                case 1:
                    res = _a.sent();
                    expect(res.error).toBeDefined();
                    expect(res.error.code).toBe(-32000);
                    expect(res.error.message).toBe('Unsupported protocol version');
                    expect(res.error.data.supportedVersions).toEqual(['2024-11-05']);
                    return [2 /*return*/];
            }
        });
    }); });
    it('rejects initialize with missing protocolVersion', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('initialize', { capabilities: {} })];
                case 1:
                    res = _a.sent();
                    expect(res.error).toBeDefined();
                    expect(res.error.code).toBe(-32602);
                    expect(res.error.message).toBe('Invalid params: protocolVersion is required');
                    return [2 /*return*/];
            }
        });
    }); });
    it('shutdown returns null', function () { return __awaiter(void 0, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client.send('shutdown', {})];
                case 1:
                    res = _a.sent();
                    expect(res.result).toBeNull();
                    return [2 /*return*/];
            }
        });
    }); });
    describe('workflow_validate endpoint', function () {
        it('validates valid step output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            stepId: 'phase-0-intelligent-triage',
                            output: 'I have analyzed the current authentication setup and found no existing authentication implementation.'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.jsonrpc).toBe('2.0');
                        expect(res.result).toBeDefined();
                        response_validator_1.responseValidator.validate('workflow_validate', res.result);
                        expect(typeof res.result.valid).toBe('boolean');
                        // Issues and suggestions can be undefined or empty arrays
                        if (res.result.issues !== undefined) {
                            expect(Array.isArray(res.result.issues)).toBe(true);
                        }
                        if (res.result.suggestions !== undefined) {
                            expect(Array.isArray(res.result.suggestions)).toBe(true);
                        }
                        return [2 /*return*/];
                }
            });
        }); });
        it('validates step output with issues', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            stepId: 'phase-0-intelligent-triage',
                            output: 'I created a simple function'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.jsonrpc).toBe('2.0');
                        expect(res.result).toBeDefined();
                        response_validator_1.responseValidator.validate('workflow_validate', res.result);
                        expect(typeof res.result.valid).toBe('boolean');
                        if (res.result.issues) {
                            expect(Array.isArray(res.result.issues)).toBe(true);
                        }
                        if (res.result.suggestions) {
                            expect(Array.isArray(res.result.suggestions)).toBe(true);
                        }
                        return [2 /*return*/];
                }
            });
        }); });
        it('validates comprehensive step output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            stepId: 'phase-0-intelligent-triage',
                            output: 'I implemented a POST /auth/login endpoint that accepts email and password, validates credentials using bcrypt, queries the user from the database, and returns a JWT token signed with the secret from environment variables.'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.jsonrpc).toBe('2.0');
                        expect(res.result).toBeDefined();
                        response_validator_1.responseValidator.validate('workflow_validate', res.result);
                        expect(typeof res.result.valid).toBe('boolean');
                        return [2 /*return*/];
                }
            });
        }); });
        it('returns INVALID_PARAMS for missing workflowId', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            stepId: 'phase-0-intelligent-triage',
                            output: 'Some output'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBe(-32602);
                        expect(res.error.message).toBe('Invalid params');
                        return [2 /*return*/];
                }
            });
        }); });
        it('returns INVALID_PARAMS for missing stepId', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            output: 'Some output'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBe(-32602);
                        expect(res.error.message).toBe('Invalid params');
                        return [2 /*return*/];
                }
            });
        }); });
        it('returns INVALID_PARAMS for missing output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            stepId: 'phase-0-intelligent-triage'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBe(-32602);
                        expect(res.error.message).toBe('Invalid params');
                        return [2 /*return*/];
                }
            });
        }); });
        it('returns INVALID_PARAMS for invalid workflowId format', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: 'invalid@workflow!id',
                            stepId: 'phase-0-intelligent-triage',
                            output: 'Some output'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBe(-32602);
                        expect(res.error.message).toBe('Invalid params');
                        return [2 /*return*/];
                }
            });
        }); });
        it('returns INVALID_PARAMS for invalid stepId format', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            stepId: 'invalid@step!id',
                            output: 'Some output'
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBe(-32602);
                        expect(res.error.message).toBe('Invalid params');
                        return [2 /*return*/];
                }
            });
        }); });
        it('returns INVALID_PARAMS for output exceeding maxLength', function () { return __awaiter(void 0, void 0, void 0, function () {
            var longOutput, res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        longOutput = 'a'.repeat(10001);
                        return [4 /*yield*/, client.send('workflow_validate', {
                                workflowId: SAMPLE_ID,
                                stepId: 'phase-0-intelligent-triage',
                                output: longOutput
                            })];
                    case 1:
                        res = _a.sent();
                        expect(res.error).toBeDefined();
                        expect(res.error.code).toBe(-32602);
                        expect(res.error.message).toBe('Invalid params');
                        return [2 /*return*/];
                }
            });
        }); });
        it('handles non-existent workflow gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
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
                        // Should return a proper response, not an error
                        expect(res.jsonrpc).toBe('2.0');
                        if (res.result) {
                            response_validator_1.responseValidator.validate('workflow_validate', res.result);
                        }
                        return [2 /*return*/];
                }
            });
        }); });
        it('handles non-existent step gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            stepId: 'non-existent-step',
                            output: 'Some output'
                        })];
                    case 1:
                        res = _a.sent();
                        // Should return a proper response, not an error
                        expect(res.jsonrpc).toBe('2.0');
                        if (res.result) {
                            response_validator_1.responseValidator.validate('workflow_validate', res.result);
                        }
                        return [2 /*return*/];
                }
            });
        }); });
        it('handles empty output string', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            stepId: 'phase-0-intelligent-triage',
                            output: ''
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.jsonrpc).toBe('2.0');
                        expect(res.result).toBeDefined();
                        response_validator_1.responseValidator.validate('workflow_validate', res.result);
                        expect(typeof res.result.valid).toBe('boolean');
                        return [2 /*return*/];
                }
            });
        }); });
        it('handles whitespace-only output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var res;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, client.send('workflow_validate', {
                            workflowId: SAMPLE_ID,
                            stepId: 'phase-0-intelligent-triage',
                            output: '   \n\t  '
                        })];
                    case 1:
                        res = _a.sent();
                        expect(res.jsonrpc).toBe('2.0');
                        expect(res.result).toBeDefined();
                        response_validator_1.responseValidator.validate('workflow_validate', res.result);
                        expect(typeof res.result.valid).toBe('boolean');
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
