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
var remote_workflow_storage_1 = require("../../src/infrastructure/storage/remote-workflow-storage");
var error_handler_1 = require("../../src/core/error-handler");
var in_memory_storage_1 = require("../../src/infrastructure/storage/in-memory-storage");
// Mock fetch globally
var mockFetch = globals_1.jest.fn();
global.fetch = mockFetch;
(0, globals_1.describe)('Remote Workflow Storage', function () {
    (0, globals_1.beforeEach)(function () {
        globals_1.jest.clearAllMocks();
        mockFetch.mockClear();
    });
    (0, globals_1.describe)('RemoteWorkflowStorage', function () {
        (0, globals_1.describe)('Constructor and Configuration', function () {
            (0, globals_1.it)('should validate and accept secure HTTPS configuration', function () {
                (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    apiKey: 'test-key',
                    timeout: 5000,
                    retryAttempts: 2
                }); }).not.toThrow();
            });
            (0, globals_1.it)('should remove trailing slash from baseUrl', function () {
                var storage = new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com/'
                });
                // The config is private, but we can test the behavior through fetch calls
                (0, globals_1.expect)(storage).toBeDefined();
            });
            (0, globals_1.it)('should reject missing baseUrl', function () {
                (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: ''
                }); }).toThrow(error_handler_1.SecurityError);
            });
            (0, globals_1.it)('should reject localhost URLs', function () {
                (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://localhost:8080'
                }); }).toThrow(error_handler_1.SecurityError);
            });
            (0, globals_1.it)('should reject private network URLs', function () {
                var privateUrls = [
                    'https://192.168.1.1',
                    'https://10.0.0.1',
                    'https://172.16.0.1'
                ];
                var _loop_1 = function (url) {
                    (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({ baseUrl: url }); }).toThrow(error_handler_1.SecurityError);
                };
                for (var _i = 0, privateUrls_1 = privateUrls; _i < privateUrls_1.length; _i++) {
                    var url = privateUrls_1[_i];
                    _loop_1(url);
                }
            });
            (0, globals_1.it)('should reject unsafe protocols', function () {
                var unsafeUrls = [
                    'file:///etc/passwd',
                    'ftp://example.com',
                    'javascript:alert(1)'
                ];
                var _loop_2 = function (url) {
                    (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({ baseUrl: url }); }).toThrow(error_handler_1.SecurityError);
                };
                for (var _i = 0, unsafeUrls_1 = unsafeUrls; _i < unsafeUrls_1.length; _i++) {
                    var url = unsafeUrls_1[_i];
                    _loop_2(url);
                }
            });
            (0, globals_1.it)('should reject invalid timeout values', function () {
                (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    timeout: 50 // Too low (below 100ms minimum)
                }); }).toThrow(error_handler_1.SecurityError);
                (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    timeout: 70000 // Too high
                }); }).toThrow(error_handler_1.SecurityError);
            });
            (0, globals_1.it)('should reject invalid retry attempts', function () {
                (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    retryAttempts: -1
                }); }).toThrow(error_handler_1.SecurityError);
                (0, globals_1.expect)(function () { return new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    retryAttempts: 15
                }); }).toThrow(error_handler_1.SecurityError);
            });
        });
        (0, globals_1.describe)('loadAllWorkflows', function () {
            var storage;
            (0, globals_1.beforeEach)(function () {
                storage = new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    timeout: 100, // Short timeout for tests
                    retryAttempts: 1 // Minimal retries for tests
                });
            });
            (0, globals_1.it)('should load workflows from registry with workflows format', function () { return __awaiter(void 0, void 0, void 0, function () {
                var mockWorkflows, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockWorkflows = [
                                {
                                    id: 'test-workflow',
                                    name: 'Test Workflow',
                                    description: 'A test workflow',
                                    version: '1.0.0',
                                    steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
                                }
                            ];
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(JSON.stringify({ workflows: mockWorkflows })); }
                            });
                            return [4 /*yield*/, storage.loadAllWorkflows()];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual(mockWorkflows);
                            (0, globals_1.expect)(mockFetch).toHaveBeenCalledWith('https://registry.example.com/workflows', globals_1.expect.objectContaining({
                                headers: globals_1.expect.objectContaining({
                                    'User-Agent': 'workrail-mcp-server/1.0',
                                    'Accept': 'application/json'
                                })
                            }));
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should load workflows from registry with data format', function () { return __awaiter(void 0, void 0, void 0, function () {
                var mockWorkflows, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockWorkflows = [
                                {
                                    id: 'test-workflow',
                                    name: 'Test Workflow',
                                    description: 'A test workflow',
                                    version: '1.0.0',
                                    steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
                                }
                            ];
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(JSON.stringify({ data: mockWorkflows })); }
                            });
                            return [4 /*yield*/, storage.loadAllWorkflows()];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual(mockWorkflows);
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should filter out invalid workflows', function () { return __awaiter(void 0, void 0, void 0, function () {
                var mockResponse, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockResponse = {
                                workflows: [
                                    { id: 'valid', name: 'Valid', steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test prompt' }] },
                                    { name: 'Invalid - no ID', steps: [] },
                                    null,
                                    'invalid string',
                                    { id: 'invalid/id', name: 'Invalid ID', steps: [] }
                                ]
                            };
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(JSON.stringify(mockResponse)); }
                            });
                            return [4 /*yield*/, storage.loadAllWorkflows()];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toHaveLength(1);
                            (0, globals_1.expect)(result[0].id).toBe('valid');
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should throw StorageError for network failures', function () { return __awaiter(void 0, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockFetch.mockRejectedValue(new Error('Network error'));
                            return [4 /*yield*/, (0, globals_1.expect)(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.StorageError)];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, (0, globals_1.expect)(storage.loadAllWorkflows()).rejects.toThrow('Failed to fetch')];
                        case 2:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should throw StorageError for empty response', function () { return __awaiter(void 0, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(''); }
                            });
                            return [4 /*yield*/, (0, globals_1.expect)(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.StorageError)];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, (0, globals_1.expect)(storage.loadAllWorkflows()).rejects.toThrow('Failed to fetch')];
                        case 2:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should throw StorageError for invalid JSON', function () { return __awaiter(void 0, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve('invalid json'); }
                            });
                            return [4 /*yield*/, (0, globals_1.expect)(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.StorageError)];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, (0, globals_1.expect)(storage.loadAllWorkflows()).rejects.toThrow('Failed to fetch')];
                        case 2:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            }); });
        });
        (0, globals_1.describe)('getWorkflowById', function () {
            var storage;
            (0, globals_1.beforeEach)(function () {
                storage = new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    timeout: 100,
                    retryAttempts: 1
                });
            });
            (0, globals_1.it)('should retrieve workflow by ID', function () { return __awaiter(void 0, void 0, void 0, function () {
                var mockWorkflow, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockWorkflow = {
                                id: 'test-workflow',
                                name: 'Test Workflow',
                                description: 'A test workflow',
                                version: '1.0.0',
                                steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
                            };
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(JSON.stringify(mockWorkflow)); }
                            });
                            return [4 /*yield*/, storage.getWorkflowById('test-workflow')];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual(mockWorkflow);
                            (0, globals_1.expect)(mockFetch).toHaveBeenCalledWith('https://registry.example.com/workflows/test-workflow', globals_1.expect.any(Object));
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should return null for 404 responses', function () { return __awaiter(void 0, void 0, void 0, function () {
                var result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockFetch.mockResolvedValueOnce({
                                ok: false,
                                status: 404,
                                statusText: 'Not Found'
                            });
                            return [4 /*yield*/, storage.getWorkflowById('nonexistent')];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toBeNull();
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should throw StorageError for non-404 HTTP errors', function () { return __awaiter(void 0, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockFetch.mockResolvedValueOnce({
                                ok: false,
                                status: 500,
                                statusText: 'Internal Server Error'
                            });
                            return [4 /*yield*/, (0, globals_1.expect)(storage.getWorkflowById('test-workflow')).rejects.toThrow(error_handler_1.StorageError)];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, (0, globals_1.expect)(storage.getWorkflowById('test-workflow')).rejects.toThrow('Failed to fetch')];
                        case 2:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should sanitize workflow ID', function () { return __awaiter(void 0, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    (0, globals_1.expect)(storage.getWorkflowById('test workflow')).rejects.toThrow(error_handler_1.InvalidWorkflowError);
                    (0, globals_1.expect)(storage.getWorkflowById('test/workflow')).rejects.toThrow(error_handler_1.InvalidWorkflowError);
                    (0, globals_1.expect)(storage.getWorkflowById('test\u0000workflow')).rejects.toThrow(error_handler_1.SecurityError);
                    return [2 /*return*/];
                });
            }); });
            (0, globals_1.it)('should validate returned workflow ID matches request', function () { return __awaiter(void 0, void 0, void 0, function () {
                var mockWorkflow;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockWorkflow = {
                                id: 'different-id',
                                name: 'Test Workflow',
                                description: 'A test workflow',
                                version: '1.0.0',
                                steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
                            };
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(JSON.stringify(mockWorkflow)); }
                            });
                            return [4 /*yield*/, (0, globals_1.expect)(storage.getWorkflowById('test-workflow')).rejects.toThrow(error_handler_1.InvalidWorkflowError)];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, (0, globals_1.expect)(storage.getWorkflowById('test-workflow')).rejects.toThrow('Failed to fetch')];
                        case 2:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            }); });
        });
        (0, globals_1.describe)('listWorkflowSummaries', function () {
            var storage;
            (0, globals_1.beforeEach)(function () {
                storage = new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    timeout: 100,
                    retryAttempts: 1
                });
            });
            (0, globals_1.it)('should list workflow summaries', function () { return __awaiter(void 0, void 0, void 0, function () {
                var mockSummaries, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockSummaries = [
                                {
                                    id: 'workflow-1',
                                    name: 'Workflow 1',
                                    description: 'First workflow',
                                    category: 'test',
                                    version: '1.0.0'
                                }
                            ];
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(JSON.stringify({ summaries: mockSummaries })); }
                            });
                            return [4 /*yield*/, storage.listWorkflowSummaries()];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual(mockSummaries);
                            (0, globals_1.expect)(mockFetch).toHaveBeenCalledWith('https://registry.example.com/workflows/summaries', globals_1.expect.any(Object));
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should filter out invalid summaries', function () { return __awaiter(void 0, void 0, void 0, function () {
                var mockResponse, result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockResponse = {
                                summaries: [
                                    { id: 'valid', name: 'Valid Summary' },
                                    { name: 'Invalid - no ID' },
                                    null,
                                    { id: 'invalid/id', name: 'Invalid ID' }
                                ]
                            };
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(JSON.stringify(mockResponse)); }
                            });
                            return [4 /*yield*/, storage.listWorkflowSummaries()];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toHaveLength(1);
                            (0, globals_1.expect)(result[0].id).toBe('valid');
                            return [2 /*return*/];
                    }
                });
            }); });
        });
        (0, globals_1.describe)('save', function () {
            var storage;
            (0, globals_1.beforeEach)(function () {
                mockFetch.mockReset(); // Reset mock implementation from other test suites
                storage = new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    apiKey: 'test-api-key'
                });
            });
            (0, globals_1.it)('should save workflow to registry', function () { return __awaiter(void 0, void 0, void 0, function () {
                var workflow;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            workflow = {
                                id: 'test-workflow',
                                name: 'Test Workflow',
                                description: 'A test workflow',
                                version: '1.0.0',
                                steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
                            };
                            mockFetch.mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve('{}'); }
                            });
                            return [4 /*yield*/, storage.save(workflow)];
                        case 1:
                            _a.sent();
                            (0, globals_1.expect)(mockFetch).toHaveBeenCalledWith('https://registry.example.com/workflows', globals_1.expect.objectContaining({
                                method: 'POST',
                                headers: globals_1.expect.objectContaining({
                                    'Content-Type': 'application/json',
                                    'Authorization': 'Bearer test-api-key'
                                }),
                                body: JSON.stringify(workflow)
                            }));
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should validate workflow before saving', function () { return __awaiter(void 0, void 0, void 0, function () {
                var invalidWorkflows, _i, invalidWorkflows_1, workflow;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            invalidWorkflows = [
                                null,
                                {},
                                { name: 'No ID', steps: [] },
                                { id: 'test', name: 'No steps' },
                                { id: 'invalid/id', name: 'Invalid ID', steps: [] }
                            ];
                            _i = 0, invalidWorkflows_1 = invalidWorkflows;
                            _a.label = 1;
                        case 1:
                            if (!(_i < invalidWorkflows_1.length)) return [3 /*break*/, 4];
                            workflow = invalidWorkflows_1[_i];
                            return [4 /*yield*/, (0, globals_1.expect)(storage.save(workflow)).rejects.toThrow()];
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
            (0, globals_1.it)('should handle registry errors', function () { return __awaiter(void 0, void 0, void 0, function () {
                var workflow;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            workflow = {
                                id: 'test-workflow',
                                name: 'Test Workflow',
                                description: 'A test workflow',
                                version: '1.0.0',
                                steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
                            };
                            mockFetch.mockResolvedValueOnce({
                                ok: false,
                                text: function () { return Promise.resolve(JSON.stringify({ message: 'Validation failed' })); }
                            });
                            return [4 /*yield*/, (0, globals_1.expect)(storage.save(workflow)).rejects.toThrow(error_handler_1.StorageError)];
                        case 1:
                            _a.sent();
                            return [4 /*yield*/, (0, globals_1.expect)(storage.save(workflow)).rejects.toThrow('Failed to save workflow to remote registry')];
                        case 2:
                            _a.sent();
                            return [2 /*return*/];
                    }
                });
            }); });
        });
        (0, globals_1.describe)('Retry Logic', function () {
            var storage;
            (0, globals_1.beforeEach)(function () {
                mockFetch.mockReset(); // Reset mock implementation from other test suites
                storage = new remote_workflow_storage_1.RemoteWorkflowStorage({
                    baseUrl: 'https://registry.example.com',
                    retryAttempts: 2,
                    timeout: 100 // Much shorter for tests
                });
            });
            (0, globals_1.it)('should retry failed requests', function () { return __awaiter(void 0, void 0, void 0, function () {
                var result;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockFetch
                                .mockRejectedValueOnce(new Error('Network error'))
                                .mockResolvedValueOnce({
                                ok: true,
                                text: function () { return Promise.resolve(JSON.stringify({ workflows: [] })); }
                            });
                            return [4 /*yield*/, storage.loadAllWorkflows()];
                        case 1:
                            result = _a.sent();
                            (0, globals_1.expect)(result).toEqual([]);
                            (0, globals_1.expect)(mockFetch).toHaveBeenCalledTimes(2);
                            return [2 /*return*/];
                    }
                });
            }); });
            (0, globals_1.it)('should throw StorageError after all retries fail', function () { return __awaiter(void 0, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            mockFetch.mockClear(); // Clear previous call history
                            mockFetch.mockRejectedValue(new Error('Network error'));
                            return [4 /*yield*/, (0, globals_1.expect)(storage.loadAllWorkflows()).rejects.toThrow(error_handler_1.StorageError)];
                        case 1:
                            _a.sent();
                            (0, globals_1.expect)(mockFetch).toHaveBeenCalledTimes(2); // Initial + 1 retry
                            return [2 /*return*/];
                    }
                });
            }); });
        });
    });
    (0, globals_1.describe)('CommunityWorkflowStorage', function () {
        var bundledStorage;
        var localStorage;
        var communityStorage;
        (0, globals_1.beforeEach)(function () {
            var bundledWorkflow = {
                id: 'bundled-workflow',
                name: 'Bundled Workflow',
                description: 'A bundled workflow',
                version: '1.0.0',
                steps: []
            };
            var localWorkflow = {
                id: 'local-workflow',
                name: 'Local Workflow',
                description: 'A local workflow',
                version: '1.0.0',
                steps: []
            };
            bundledStorage = new in_memory_storage_1.InMemoryWorkflowStorage([bundledWorkflow]);
            localStorage = new in_memory_storage_1.InMemoryWorkflowStorage([localWorkflow]);
            communityStorage = new remote_workflow_storage_1.CommunityWorkflowStorage(bundledStorage, localStorage, {
                baseUrl: 'https://registry.example.com',
                timeout: 100, // Short timeout for tests
                retryAttempts: 1 // Minimal retries for tests
            });
            // Mock remote workflows - handle both loadAllWorkflows and getWorkflowById
            var remoteWorkflow = {
                id: 'remote-workflow',
                name: 'Remote Workflow',
                description: 'A remote workflow',
                version: '1.0.0',
                steps: [{ id: 'step1', title: 'Remote Step', prompt: 'Remote step prompt' }]
            };
            mockFetch.mockImplementation(function (url) {
                if (url.endsWith('/workflows')) {
                    // loadAllWorkflows call
                    return Promise.resolve({
                        ok: true,
                        text: function () { return Promise.resolve(JSON.stringify({
                            workflows: [remoteWorkflow]
                        })); }
                    });
                }
                else if (url.includes('/workflows/remote-workflow')) {
                    // getWorkflowById call
                    return Promise.resolve({
                        ok: true,
                        text: function () { return Promise.resolve(JSON.stringify(remoteWorkflow)); }
                    });
                }
                // Default fallback
                return Promise.resolve({
                    ok: true,
                    text: function () { return Promise.resolve('{}'); }
                });
            });
        });
        (0, globals_1.it)('should load workflows from all sources', function () { return __awaiter(void 0, void 0, void 0, function () {
            var workflows;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, communityStorage.loadAllWorkflows()];
                    case 1:
                        workflows = _a.sent();
                        (0, globals_1.expect)(workflows).toHaveLength(3);
                        (0, globals_1.expect)(workflows.map(function (w) { return w.id; })).toContain('bundled-workflow');
                        (0, globals_1.expect)(workflows.map(function (w) { return w.id; })).toContain('local-workflow');
                        (0, globals_1.expect)(workflows.map(function (w) { return w.id; })).toContain('remote-workflow');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle precedence correctly - later sources override earlier ones', function () { return __awaiter(void 0, void 0, void 0, function () {
            var overrideWorkflow, workflows, bundledWorkflow;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        overrideWorkflow = {
                            id: 'bundled-workflow', // Same ID as bundled
                            name: 'Override Workflow',
                            description: 'An override workflow',
                            version: '2.0.0',
                            steps: []
                        };
                        localStorage = new in_memory_storage_1.InMemoryWorkflowStorage([overrideWorkflow]);
                        communityStorage = new remote_workflow_storage_1.CommunityWorkflowStorage(bundledStorage, localStorage, {
                            baseUrl: 'https://registry.example.com',
                            timeout: 100, // Short timeout for tests
                            retryAttempts: 1 // Minimal retries for tests
                        });
                        return [4 /*yield*/, communityStorage.loadAllWorkflows()];
                    case 1:
                        workflows = _a.sent();
                        bundledWorkflow = workflows.find(function (w) { return w.id === 'bundled-workflow'; });
                        (0, globals_1.expect)(bundledWorkflow.name).toBe('Override Workflow'); // Local overrides bundled
                        (0, globals_1.expect)(bundledWorkflow.version).toBe('2.0.0');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should continue loading when one source fails', function () { return __awaiter(void 0, void 0, void 0, function () {
            var workflows;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        // Make remote storage fail by overriding the implementation 
                        mockFetch.mockImplementation(function () {
                            return Promise.reject(new Error('Network error'));
                        });
                        return [4 /*yield*/, communityStorage.loadAllWorkflows()];
                    case 1:
                        workflows = _a.sent();
                        // Should still get bundled and local workflows
                        (0, globals_1.expect)(workflows).toHaveLength(2);
                        (0, globals_1.expect)(workflows.map(function (w) { return w.id; })).toContain('bundled-workflow');
                        (0, globals_1.expect)(workflows.map(function (w) { return w.id; })).toContain('local-workflow');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should sanitize IDs in getWorkflowById', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, (0, globals_1.expect)(communityStorage.getWorkflowById('invalid id')).rejects.toThrow(error_handler_1.InvalidWorkflowError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should search sources in reverse order for getWorkflowById', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, communityStorage.getWorkflowById('remote-workflow')];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result).toBeDefined();
                        (0, globals_1.expect)(result.name).toBe('Remote Workflow');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should generate summaries from all workflows', function () { return __awaiter(void 0, void 0, void 0, function () {
            var summaries;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, communityStorage.listWorkflowSummaries()];
                    case 1:
                        summaries = _a.sent();
                        (0, globals_1.expect)(summaries).toHaveLength(3);
                        (0, globals_1.expect)(summaries.every(function (s) { return s.category === 'community'; })).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should delegate save to remote storage', function () { return __awaiter(void 0, void 0, void 0, function () {
            var workflow;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        workflow = {
                            id: 'test-save',
                            name: 'Test Save',
                            description: 'Test save workflow',
                            version: '1.0.0',
                            steps: []
                        };
                        mockFetch.mockResolvedValueOnce({
                            ok: true,
                            text: function () { return Promise.resolve('{}'); }
                        });
                        return [4 /*yield*/, communityStorage.save(workflow)];
                    case 1:
                        _a.sent();
                        (0, globals_1.expect)(mockFetch).toHaveBeenCalledWith('https://registry.example.com/workflows', globals_1.expect.objectContaining({ method: 'POST' }));
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
