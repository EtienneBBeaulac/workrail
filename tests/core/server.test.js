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
/**
 * @jest-environment node
 */
var server_1 = require("../../src/infrastructure/rpc/server");
var globals_1 = require("@jest/globals");
(0, globals_1.describe)('WorkflowLookupServer', function () {
    (0, globals_1.it)('should create a server instance', function () {
        var mockService = {
            listWorkflowSummaries: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/, []];
            }); }); },
            getWorkflowById: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/, null];
            }); }); },
            getNextStep: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/, ({ step: null, guidance: { prompt: '' }, isComplete: true })];
            }); }); },
            validateStepOutput: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/, ({ valid: true, issues: [], suggestions: [] })];
            }); }); }
        };
        var server = (0, server_1.createWorkflowLookupServer)(mockService);
        (0, globals_1.expect)(server).toBeDefined();
        (0, globals_1.expect)(typeof server.start).toBe('function');
        (0, globals_1.expect)(typeof server.stop).toBe('function');
    });
    (0, globals_1.it)('should start and stop without errors', function () { return __awaiter(void 0, void 0, void 0, function () {
        var mockService, server, originalLog;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    mockService = {
                        listWorkflowSummaries: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                            return [2 /*return*/, []];
                        }); }); },
                        getWorkflowById: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                            return [2 /*return*/, null];
                        }); }); },
                        getNextStep: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                            return [2 /*return*/, ({ step: null, guidance: { prompt: '' }, isComplete: true })];
                        }); }); },
                        validateStepOutput: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                            return [2 /*return*/, ({ valid: true, issues: [], suggestions: [] })];
                        }); }); }
                    };
                    server = (0, server_1.createWorkflowLookupServer)(mockService);
                    originalLog = console.log;
                    console.log = globals_1.jest.fn();
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 4, 5]);
                    return [4 /*yield*/, server.start()];
                case 2:
                    _a.sent();
                    return [4 /*yield*/, server.stop()];
                case 3:
                    _a.sent();
                    (0, globals_1.expect)(console.log).toHaveBeenCalledWith('Initializing Workflow Lookup MCP Server...');
                    (0, globals_1.expect)(console.log).toHaveBeenCalledWith('Server ready to accept JSON-RPC requests');
                    (0, globals_1.expect)(console.log).toHaveBeenCalledWith('Shutting down Workflow Lookup MCP Server...');
                    (0, globals_1.expect)(console.log).toHaveBeenCalledWith('Server stopped');
                    return [3 /*break*/, 5];
                case 4:
                    console.log = originalLog;
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); });
});
