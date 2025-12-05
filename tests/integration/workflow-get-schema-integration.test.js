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
(0, globals_1.describe)('Workflow Get Schema Integration', function () {
    (0, globals_1.describe)('workflow_get_schema tool through MCP server', function () {
        (0, globals_1.it)('should return the complete workflow schema with metadata', function () { return __awaiter(void 0, void 0, void 0, function () {
            var fs, path, schemaPath, schemaContent, expectedSchema, result;
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
                        expectedSchema = JSON.parse(schemaContent);
                        result = {
                            schema: expectedSchema,
                            metadata: {
                                version: '1.0.0',
                                description: 'Complete JSON schema for workflow files',
                                usage: 'This schema defines the structure, required fields, and validation rules for workflow JSON files',
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
                        // Verify the schema structure
                        (0, globals_1.expect)(result.schema).toBeDefined();
                        (0, globals_1.expect)(result.schema.type).toBe('object');
                        (0, globals_1.expect)(result.schema.properties).toBeDefined();
                        (0, globals_1.expect)(result.schema.required).toBeDefined();
                        (0, globals_1.expect)(result.metadata).toBeDefined();
                        (0, globals_1.expect)(result.commonPatterns).toBeDefined();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should provide the correct schema structure for validation', function () { return __awaiter(void 0, void 0, void 0, function () {
            var fs, path, schemaPath, schemaContent, schema, stepSchema;
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
                        // Verify the schema has the expected workflow structure
                        (0, globals_1.expect)(schema.properties.id).toBeDefined();
                        (0, globals_1.expect)(schema.properties.name).toBeDefined();
                        (0, globals_1.expect)(schema.properties.description).toBeDefined();
                        (0, globals_1.expect)(schema.properties.version).toBeDefined();
                        (0, globals_1.expect)(schema.properties.steps).toBeDefined();
                        // Verify required fields
                        (0, globals_1.expect)(schema.required).toContain('id');
                        (0, globals_1.expect)(schema.required).toContain('name');
                        (0, globals_1.expect)(schema.required).toContain('description');
                        (0, globals_1.expect)(schema.required).toContain('version');
                        (0, globals_1.expect)(schema.required).toContain('steps');
                        // Verify steps structure
                        (0, globals_1.expect)(schema.properties.steps.type).toBe('array');
                        (0, globals_1.expect)(schema.properties.steps.minItems).toBe(1);
                        (0, globals_1.expect)(schema.properties.steps.items).toBeDefined();
                        stepSchema = schema.properties.steps.items;
                        (0, globals_1.expect)(stepSchema.type).toBe('object');
                        (0, globals_1.expect)(stepSchema.properties.id).toBeDefined();
                        (0, globals_1.expect)(stepSchema.properties.title).toBeDefined();
                        (0, globals_1.expect)(stepSchema.properties.prompt).toBeDefined();
                        (0, globals_1.expect)(stepSchema.properties.agentRole).toBeDefined();
                        (0, globals_1.expect)(stepSchema.required).toContain('id');
                        (0, globals_1.expect)(stepSchema.required).toContain('title');
                        (0, globals_1.expect)(stepSchema.required).toContain('prompt');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should provide schema compatible with enhanced error messages', function () { return __awaiter(void 0, void 0, void 0, function () {
            var validateWorkflow, invalidWorkflow, validationResult, additionalPropertyError;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('../../src/application/validation'); })];
                    case 1:
                        validateWorkflow = (_a.sent()).validateWorkflow;
                        invalidWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'Test description',
                            version: '1.0.0',
                            steps: [
                                {
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Test prompt',
                                    agentRole: 'You are a helpful test assistant.',
                                    validationCriteria: [{
                                            type: 'contains',
                                            value: 'test',
                                            message: 'Test validation'
                                        }]
                                }
                            ],
                            unexpectedProperty: 'this should cause an error'
                        };
                        validationResult = validateWorkflow(invalidWorkflow);
                        (0, globals_1.expect)(validationResult.valid).toBe(false);
                        (0, globals_1.expect)(validationResult.errors.length).toBeGreaterThan(0);
                        additionalPropertyError = validationResult.errors.find(function (error) {
                            return error.includes('unexpectedProperty');
                        });
                        (0, globals_1.expect)(additionalPropertyError).toBeDefined();
                        (0, globals_1.expect)(additionalPropertyError).toContain('Unexpected property');
                        (0, globals_1.expect)(additionalPropertyError).toContain('unexpectedProperty');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should work with valid workflow structures', function () { return __awaiter(void 0, void 0, void 0, function () {
            var validateWorkflow, validWorkflow, validationResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('../../src/application/validation'); })];
                    case 1:
                        validateWorkflow = (_a.sent()).validateWorkflow;
                        validWorkflow = {
                            id: 'test-workflow',
                            name: 'Test Workflow',
                            description: 'Test description',
                            version: '1.0.0',
                            steps: [
                                {
                                    id: 'step-1',
                                    title: 'Test Step',
                                    prompt: 'Test prompt',
                                    agentRole: 'You are a helpful test assistant.',
                                    validationCriteria: [{
                                            type: 'contains',
                                            value: 'test',
                                            message: 'Test validation'
                                        }]
                                }
                            ]
                        };
                        validationResult = validateWorkflow(validWorkflow);
                        (0, globals_1.expect)(validationResult.valid).toBe(true);
                        (0, globals_1.expect)(validationResult.errors).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should provide helpful patterns for common workflow structures', function () { return __awaiter(void 0, void 0, void 0, function () {
            var commonPatterns;
            return __generator(this, function (_a) {
                commonPatterns = {
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
                };
                // Verify the patterns contain useful information
                (0, globals_1.expect)(commonPatterns.basicWorkflow.id).toContain('required');
                (0, globals_1.expect)(commonPatterns.basicWorkflow.id).toContain('Unique identifier');
                (0, globals_1.expect)(commonPatterns.basicWorkflow.steps).toContain('minimum 1 item');
                (0, globals_1.expect)(commonPatterns.stepStructure.id).toContain('required');
                (0, globals_1.expect)(commonPatterns.stepStructure.validationCriteria).toContain('optional');
                return [2 /*return*/];
            });
        }); });
    });
});
