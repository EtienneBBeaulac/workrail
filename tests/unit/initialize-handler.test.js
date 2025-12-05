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
var mcp_initialize_1 = require("../../src/tools/mcp_initialize");
var mcp_types_1 = require("../../src/types/mcp-types");
var error_handler_1 = require("../../src/core/error-handler");
var globals_1 = require("@jest/globals");
(0, globals_1.describe)('initializeHandler', function () {
    (0, globals_1.describe)('successful initialization', function () {
        (0, globals_1.it)('should return successful response with correct protocol version', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request, response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: '2024-11-05',
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, mcp_initialize_1.initializeHandler)(request)];
                    case 1:
                        response = _a.sent();
                        (0, globals_1.expect)(response.jsonrpc).toBe('2.0');
                        (0, globals_1.expect)(response.id).toBe(1);
                        (0, globals_1.expect)(response.result.protocolVersion).toBe('2024-11-05');
                        (0, globals_1.expect)(response.result.capabilities.tools.listChanged).toBe(false);
                        (0, globals_1.expect)(response.result.capabilities.tools.notifyProgress).toBe(false);
                        (0, globals_1.expect)(response.result.capabilities.resources.listChanged).toBe(false);
                        (0, globals_1.expect)(response.result.serverInfo.name).toBe('workflow-lookup');
                        (0, globals_1.expect)(response.result.serverInfo.version).toBe('1.0.0');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should accept clientInfo when provided', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request, response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 2,
                            method: 'initialize',
                            params: {
                                protocolVersion: '2024-11-05',
                                capabilities: { tools: {} },
                                clientInfo: { name: 'test-client', version: '1.0.0' }
                            }
                        };
                        return [4 /*yield*/, (0, mcp_initialize_1.initializeHandler)(request)];
                    case 1:
                        response = _a.sent();
                        (0, globals_1.expect)(response.result.protocolVersion).toBe('2024-11-05');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('parameter validation', function () {
        (0, globals_1.it)('should throw INVALID_PARAMS when params is missing', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize'
                        };
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toThrow(error_handler_1.MCPError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toMatchObject({
                                code: mcp_types_1.MCPErrorCodes.INVALID_PARAMS,
                                message: 'Invalid params: params object is required'
                            })];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw INVALID_PARAMS when protocolVersion is missing', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toThrow(error_handler_1.MCPError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toMatchObject({
                                code: mcp_types_1.MCPErrorCodes.INVALID_PARAMS,
                                message: 'Invalid params: protocolVersion is required'
                            })];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw INVALID_PARAMS when capabilities is missing', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: '2024-11-05'
                            }
                        };
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toThrow(error_handler_1.MCPError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toMatchObject({
                                code: mcp_types_1.MCPErrorCodes.INVALID_PARAMS,
                                message: 'Invalid params: capabilities is required'
                            })];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw INVALID_PARAMS when protocolVersion is empty string', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: '',
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toThrow(error_handler_1.MCPError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toMatchObject({
                                code: mcp_types_1.MCPErrorCodes.INVALID_PARAMS,
                                message: 'Invalid params: protocolVersion is required'
                            })];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('protocol version validation', function () {
        (0, globals_1.it)('should throw SERVER_ERROR for unsupported protocol version', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: '1.0',
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toThrow(error_handler_1.MCPError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toMatchObject({
                                code: mcp_types_1.MCPErrorCodes.SERVER_ERROR,
                                message: 'Unsupported protocol version',
                                data: {
                                    supportedVersions: ['2024-11-05'],
                                    requestedVersion: '1.0'
                                }
                            })];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw SERVER_ERROR for future protocol version', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: '2025-01-01',
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toThrow(error_handler_1.MCPError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toMatchObject({
                                code: mcp_types_1.MCPErrorCodes.SERVER_ERROR,
                                message: 'Unsupported protocol version',
                                data: {
                                    supportedVersions: ['2024-11-05'],
                                    requestedVersion: '2025-01-01'
                                }
                            })];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw SERVER_ERROR for malformed protocol version', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: 'invalid-version',
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toThrow(error_handler_1.MCPError)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, (0, globals_1.expect)((0, mcp_initialize_1.initializeHandler)(request)).rejects.toMatchObject({
                                code: mcp_types_1.MCPErrorCodes.SERVER_ERROR,
                                message: 'Unsupported protocol version',
                                data: {
                                    supportedVersions: ['2024-11-05'],
                                    requestedVersion: 'invalid-version'
                                }
                            })];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('capabilities declaration', function () {
        (0, globals_1.it)('should declare listChanged as false for tools', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request, response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: '2024-11-05',
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, mcp_initialize_1.initializeHandler)(request)];
                    case 1:
                        response = _a.sent();
                        (0, globals_1.expect)(response.result.capabilities.tools.listChanged).toBe(false);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should declare listChanged as false for resources', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request, response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: '2024-11-05',
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, mcp_initialize_1.initializeHandler)(request)];
                    case 1:
                        response = _a.sent();
                        (0, globals_1.expect)(response.result.capabilities.resources.listChanged).toBe(false);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should declare notifyProgress as false', function () { return __awaiter(void 0, void 0, void 0, function () {
            var request, response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        request = {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'initialize',
                            params: {
                                protocolVersion: '2024-11-05',
                                capabilities: { tools: {} }
                            }
                        };
                        return [4 /*yield*/, (0, mcp_initialize_1.initializeHandler)(request)];
                    case 1:
                        response = _a.sent();
                        (0, globals_1.expect)(response.result.capabilities.tools.notifyProgress).toBe(false);
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
