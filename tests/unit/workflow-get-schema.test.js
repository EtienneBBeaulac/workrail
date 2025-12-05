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
// Mock the WorkflowOrchestrationServer since we need to access the private class
var TestWorkflowServer = /** @class */ (function () {
    function TestWorkflowServer() {
    }
    TestWorkflowServer.prototype.getWorkflowSchema = function () {
        return __awaiter(this, void 0, void 0, function () {
            var fs, path, schemaPath, schemaContent, schema, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('fs'); })];
                    case 1:
                        fs = _a.sent();
                        return [4 /*yield*/, Promise.resolve().then(function () { return require('path'); })];
                    case 2:
                        path = _a.sent();
                        schemaPath = path.resolve(__dirname, '../../spec/workflow.schema.json');
                        schemaContent = fs.readFileSync(schemaPath, 'utf-8');
                        schema = JSON.parse(schemaContent);
                        result = {
                            schema: schema,
                            metadata: {
                                version: '1.0.0',
                                description: 'Complete JSON schema for workflow files',
                                usage: 'This schema defines the structure, required fields, and validation rules for workflow JSON files',
                                lastUpdated: new Date().toISOString(),
                                schemaPath: 'spec/workflow.schema.json'
                            },
                            commonPatterns: {
                                basicWorkflow: {
                                    id: 'string (required): Unique identifier using lowercase letters, numbers, and hyphens',
                                    name: 'string (required): Human-readable workflow name',
                                    description: 'string (required): Detailed description of the workflow purpose',
                                    version: 'string (required): Semantic version (e.g., "1.0.0")',
                                    steps: 'array (required): List of workflow steps, minimum 1 item'
                                },
                                stepStructure: {
                                    id: 'string (required): Unique step identifier',
                                    title: 'string (required): Human-readable step title',
                                    prompt: 'string (required): Instructions for the step',
                                    agentRole: 'string (required): Role description for the agent',
                                    validationCriteria: 'array (optional): Validation rules for step output'
                                }
                            }
                        };
                        return [2 /*return*/, {
                                content: [{
                                        type: "text",
                                        text: JSON.stringify(result, null, 2)
                                    }]
                            }];
                }
            });
        });
    };
    return TestWorkflowServer;
}());
(0, globals_1.describe)('Workflow Get Schema Tool', function () {
    var server;
    (0, globals_1.beforeEach)(function () {
        server = new TestWorkflowServer();
    });
    (0, globals_1.describe)('getWorkflowSchema', function () {
        (0, globals_1.it)('should return the complete workflow schema', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, responseData;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, server.getWorkflowSchema()];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.content).toHaveLength(1);
                        (0, globals_1.expect)(result.content[0]).toBeDefined();
                        (0, globals_1.expect)(result.content[0].type).toBe('text');
                        responseData = JSON.parse(result.content[0].text);
                        (0, globals_1.expect)(responseData.schema).toBeDefined();
                        (0, globals_1.expect)(responseData.metadata).toBeDefined();
                        (0, globals_1.expect)(responseData.commonPatterns).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should include schema metadata with version and description', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, responseData;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, server.getWorkflowSchema()];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.content[0]).toBeDefined();
                        responseData = JSON.parse(result.content[0].text);
                        (0, globals_1.expect)(responseData.metadata.version).toBe('1.0.0');
                        (0, globals_1.expect)(responseData.metadata.description).toBe('Complete JSON schema for workflow files');
                        (0, globals_1.expect)(responseData.metadata.usage).toContain('structure, required fields, and validation rules');
                        (0, globals_1.expect)(responseData.metadata.schemaPath).toBe('spec/workflow.schema.json');
                        (0, globals_1.expect)(responseData.metadata.lastUpdated).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should include common patterns for basic workflow structure', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, responseData;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, server.getWorkflowSchema()];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.content[0]).toBeDefined();
                        responseData = JSON.parse(result.content[0].text);
                        (0, globals_1.expect)(responseData.commonPatterns.basicWorkflow).toBeDefined();
                        (0, globals_1.expect)(responseData.commonPatterns.basicWorkflow.id).toContain('Unique identifier');
                        (0, globals_1.expect)(responseData.commonPatterns.basicWorkflow.name).toContain('Human-readable workflow name');
                        (0, globals_1.expect)(responseData.commonPatterns.basicWorkflow.description).toContain('Detailed description');
                        (0, globals_1.expect)(responseData.commonPatterns.basicWorkflow.version).toContain('Semantic version');
                        (0, globals_1.expect)(responseData.commonPatterns.basicWorkflow.steps).toContain('minimum 1 item');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should include common patterns for step structure', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, responseData;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, server.getWorkflowSchema()];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.content[0]).toBeDefined();
                        responseData = JSON.parse(result.content[0].text);
                        (0, globals_1.expect)(responseData.commonPatterns.stepStructure).toBeDefined();
                        (0, globals_1.expect)(responseData.commonPatterns.stepStructure.id).toContain('Unique step identifier');
                        (0, globals_1.expect)(responseData.commonPatterns.stepStructure.title).toContain('Human-readable step title');
                        (0, globals_1.expect)(responseData.commonPatterns.stepStructure.prompt).toContain('Instructions for the step');
                        (0, globals_1.expect)(responseData.commonPatterns.stepStructure.agentRole).toContain('Role description');
                        (0, globals_1.expect)(responseData.commonPatterns.stepStructure.validationCriteria).toContain('optional');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should return the actual JSON schema structure', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, responseData;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, server.getWorkflowSchema()];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.content[0]).toBeDefined();
                        responseData = JSON.parse(result.content[0].text);
                        // Verify the schema has the expected structure
                        (0, globals_1.expect)(responseData.schema).toBeDefined();
                        (0, globals_1.expect)(responseData.schema.type).toBe('object');
                        (0, globals_1.expect)(responseData.schema.properties).toBeDefined();
                        (0, globals_1.expect)(responseData.schema.required).toBeDefined();
                        // Check for key workflow properties
                        (0, globals_1.expect)(responseData.schema.properties.id).toBeDefined();
                        (0, globals_1.expect)(responseData.schema.properties.name).toBeDefined();
                        (0, globals_1.expect)(responseData.schema.properties.description).toBeDefined();
                        (0, globals_1.expect)(responseData.schema.properties.version).toBeDefined();
                        (0, globals_1.expect)(responseData.schema.properties.steps).toBeDefined();
                        // Check required fields
                        (0, globals_1.expect)(responseData.schema.required).toContain('id');
                        (0, globals_1.expect)(responseData.schema.required).toContain('name');
                        (0, globals_1.expect)(responseData.schema.required).toContain('description');
                        (0, globals_1.expect)(responseData.schema.required).toContain('version');
                        (0, globals_1.expect)(responseData.schema.required).toContain('steps');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should provide steps array schema definition', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, responseData, stepSchema;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, server.getWorkflowSchema()];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.content[0]).toBeDefined();
                        responseData = JSON.parse(result.content[0].text);
                        (0, globals_1.expect)(responseData.schema.properties.steps).toBeDefined();
                        (0, globals_1.expect)(responseData.schema.properties.steps.type).toBe('array');
                        (0, globals_1.expect)(responseData.schema.properties.steps.minItems).toBe(1);
                        (0, globals_1.expect)(responseData.schema.properties.steps.items).toBeDefined();
                        stepSchema = responseData.schema.properties.steps.items;
                        (0, globals_1.expect)(stepSchema.type).toBe('object');
                        (0, globals_1.expect)(stepSchema.properties).toBeDefined();
                        (0, globals_1.expect)(stepSchema.required).toBeDefined();
                        // Check for required step properties
                        (0, globals_1.expect)(stepSchema.properties.id).toBeDefined();
                        (0, globals_1.expect)(stepSchema.properties.title).toBeDefined();
                        (0, globals_1.expect)(stepSchema.properties.prompt).toBeDefined();
                        (0, globals_1.expect)(stepSchema.properties.agentRole).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should be formatted as valid JSON', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, responseData;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, server.getWorkflowSchema()];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.content[0]).toBeDefined();
                        // This should not throw an error
                        (0, globals_1.expect)(function () { return JSON.parse(result.content[0].text); }).not.toThrow();
                        responseData = JSON.parse(result.content[0].text);
                        (0, globals_1.expect)(typeof responseData).toBe('object');
                        (0, globals_1.expect)(responseData).not.toBeNull();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should return response in MCP tool format', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, server.getWorkflowSchema()];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.content).toBeDefined();
                        (0, globals_1.expect)(Array.isArray(result.content)).toBe(true);
                        (0, globals_1.expect)(result.content).toHaveLength(1);
                        (0, globals_1.expect)(result.content[0]).toBeDefined();
                        (0, globals_1.expect)(result.content[0].type).toBe('text');
                        (0, globals_1.expect)(result.content[0].text).toBeDefined();
                        (0, globals_1.expect)(typeof result.content[0].text).toBe('string');
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
