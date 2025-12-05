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
var validation_engine_1 = require("../../src/application/services/validation-engine");
var error_handler_1 = require("../../src/core/error-handler");
(0, globals_1.describe)('ValidationEngine', function () {
    var engine;
    (0, globals_1.beforeEach)(function () {
        engine = new validation_engine_1.ValidationEngine();
    });
    (0, globals_1.describe)('basic validation', function () {
        (0, globals_1.it)('should validate empty criteria with non-empty output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, engine.validate('some output', [])];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        (0, globals_1.expect)(result.suggestions).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail validation with empty criteria and empty output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, engine.validate('', [])];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Output is empty or invalid.');
                        (0, globals_1.expect)(result.suggestions).toContain('Provide valid output content.');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail validation with empty criteria and whitespace-only output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, engine.validate('   \n\t  ', [])];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Output is empty or invalid.');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('contains validation', function () {
        (0, globals_1.it)('should pass when output contains required value', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'contains', value: 'hello', message: 'Must contain hello' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail when output does not contain required value', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'contains', value: 'goodbye', message: 'Must contain goodbye' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Must contain goodbye');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should use default message when none provided', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'contains', value: 'missing', message: '' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Output must include "missing"');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle undefined value', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'contains', message: 'Must contain value' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Must contain value');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('regex validation', function () {
        (0, globals_1.it)('should pass when output matches regex pattern', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'regex', pattern: '^hello.*world$', message: 'Must match pattern' }
                        ];
                        return [4 /*yield*/, engine.validate('hello beautiful world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail when output does not match regex pattern', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'regex', pattern: '^goodbye.*world$', message: 'Must match pattern' }
                        ];
                        return [4 /*yield*/, engine.validate('hello beautiful world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Must match pattern');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should support regex flags', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'regex', pattern: 'HELLO', flags: 'i', message: 'Must match case-insensitive' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should use default message when none provided', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'regex', pattern: 'missing', message: '' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Pattern mismatch: missing');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw ValidationError for invalid regex pattern', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'regex', pattern: '[invalid', message: 'Invalid regex' }
                        ];
                        return [4 /*yield*/, (0, globals_1.expect)(engine.validate('hello world', rules)).rejects.toThrow(error_handler_1.ValidationError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('length validation', function () {
        (0, globals_1.it)('should pass when output length is within bounds', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'length', min: 5, max: 15, message: 'Must be 5-15 characters' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail when output is too short', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'length', min: 15, message: 'Too short' }
                        ];
                        return [4 /*yield*/, engine.validate('hello', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Too short');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail when output is too long', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'length', max: 5, message: 'Too long' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Too long');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should use default message for min length', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'length', min: 15, message: '' }
                        ];
                        return [4 /*yield*/, engine.validate('hello', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Output shorter than minimum length 15');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should use default message for max length', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'length', max: 5, message: '' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Output exceeds maximum length 5');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle only min constraint', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'length', min: 5, message: 'Must be at least 5 characters' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle only max constraint', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'length', max: 15, message: 'Must be at most 15 characters' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('legacy string-based rules', function () {
        (0, globals_1.it)('should support legacy string regex rules', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = ['hello.*world'];
                        return [4 /*yield*/, engine.validate('hello beautiful world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail legacy string regex rules that do not match', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = ['goodbye.*world'];
                        return [4 /*yield*/, engine.validate('hello beautiful world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Output does not match pattern: goodbye.*world');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('multiple validation rules', function () {
        (0, globals_1.it)('should pass when all rules pass', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'contains', value: 'hello', message: 'Must contain hello' },
                            { type: 'length', min: 5, max: 20, message: 'Must be 5-20 characters' },
                            { type: 'regex', pattern: 'world$', message: 'Must end with world' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail when any rule fails', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'contains', value: 'hello', message: 'Must contain hello' },
                            { type: 'contains', value: 'missing', message: 'Must contain missing' },
                            { type: 'length', min: 5, max: 20, message: 'Must be 5-20 characters' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Must contain missing');
                        (0, globals_1.expect)(result.issues).toHaveLength(1); // Only the failing rule
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should collect all failing rules', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'contains', value: 'missing1', message: 'Must contain missing1' },
                            { type: 'contains', value: 'missing2', message: 'Must contain missing2' },
                            { type: 'length', min: 50, message: 'Must be at least 50 characters' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toHaveLength(3);
                        (0, globals_1.expect)(result.issues).toContain('Must contain missing1');
                        (0, globals_1.expect)(result.issues).toContain('Must contain missing2');
                        (0, globals_1.expect)(result.issues).toContain('Must be at least 50 characters');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('error handling', function () {
        (0, globals_1.it)('should throw ValidationError for unsupported rule type', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'unsupported', message: 'Unsupported rule' }
                        ];
                        return [4 /*yield*/, (0, globals_1.expect)(engine.validate('hello world', rules)).rejects.toThrow(error_handler_1.ValidationError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should throw ValidationError for invalid rule format', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [42];
                        return [4 /*yield*/, (0, globals_1.expect)(engine.validate('hello world', rules)).rejects.toThrow(error_handler_1.ValidationError)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should provide appropriate suggestions for failed validation', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'contains', value: 'missing', message: 'Must contain missing' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.suggestions).toContain('Review validation criteria and adjust output accordingly.');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('schema validation', function () {
        (0, globals_1.it)('should handle schema rule without schema property', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'schema', message: 'Schema validation failed' }
                        ];
                        return [4 /*yield*/, engine.validate('hello world', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Schema validation failed');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should validate valid JSON against object schema', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, validJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'schema',
                                schema: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        age: { type: 'number' }
                                    },
                                    required: ['name', 'age']
                                },
                                message: 'Object schema validation failed'
                            }
                        ];
                        validJson = '{"name": "John", "age": 30}';
                        return [4 /*yield*/, engine.validate(validJson, rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail validation for invalid JSON against object schema', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, invalidJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'schema',
                                schema: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        age: { type: 'number' }
                                    },
                                    required: ['name', 'age']
                                },
                                message: 'Object schema validation failed'
                            }
                        ];
                        invalidJson = '{"name": "John"}';
                        return [4 /*yield*/, engine.validate(invalidJson, rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Object schema validation failed');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle non-JSON input for schema validation', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'schema',
                                schema: { type: 'object' },
                                message: 'Invalid JSON input'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('not json', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Invalid JSON input');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should validate array schema', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, validJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'schema',
                                schema: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    minItems: 1
                                },
                                message: 'Array schema validation failed'
                            }
                        ];
                        validJson = '["apple", "banana", "cherry"]';
                        return [4 /*yield*/, engine.validate(validJson, rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail validation for invalid array schema', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, invalidJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'schema',
                                schema: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    minItems: 1
                                },
                                message: 'Array schema validation failed'
                            }
                        ];
                        invalidJson = '[]';
                        return [4 /*yield*/, engine.validate(invalidJson, rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Array schema validation failed');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should provide detailed AJV error messages when custom message not provided', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, invalidJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'schema',
                                schema: {
                                    type: 'object',
                                    properties: {
                                        priority: { type: 'string', enum: ['Low', 'Medium', 'High'] }
                                    },
                                    required: ['priority']
                                },
                                message: '' // Use empty message to test default AJV error formatting
                            }
                        ];
                        invalidJson = '{"priority": "Invalid"}';
                        return [4 /*yield*/, engine.validate(invalidJson, rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues[0]).toContain('Validation Error at');
                        (0, globals_1.expect)(result.issues[0]).toContain('priority');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should cache compiled schemas for performance', function () { return __awaiter(void 0, void 0, void 0, function () {
            var schema, rules, result1, result2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        schema = {
                            type: 'object',
                            properties: { name: { type: 'string' } }
                        };
                        rules = [
                            { type: 'schema', schema: schema, message: 'Schema validation failed' }
                        ];
                        return [4 /*yield*/, engine.validate('{"name": "test"}', rules)];
                    case 1:
                        result1 = _a.sent();
                        (0, globals_1.expect)(result1.valid).toBe(true);
                        return [4 /*yield*/, engine.validate('{"name": "test2"}', rules)];
                    case 2:
                        result2 = _a.sent();
                        (0, globals_1.expect)(result2.valid).toBe(true);
                        // Verify both validations worked correctly
                        (0, globals_1.expect)(result1.issues).toHaveLength(0);
                        (0, globals_1.expect)(result2.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle invalid JSON schema definition', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'schema',
                                schema: {
                                    type: 'invalid_type' // invalid schema type
                                },
                                message: 'Schema validation failed'
                            }
                        ];
                        return [4 /*yield*/, (0, globals_1.expect)(engine.validate('{"test": "value"}', rules))
                                .rejects.toThrow('Invalid JSON schema')];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle multiple schema validations', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, validJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'schema',
                                schema: { type: 'object' },
                                message: 'Must be object'
                            },
                            {
                                type: 'schema',
                                schema: {
                                    type: 'object',
                                    properties: { name: { type: 'string' } },
                                    required: ['name']
                                },
                                message: 'Must have name property'
                            }
                        ];
                        validJson = '{"name": "John"}';
                        return [4 /*yield*/, engine.validate(validJson, rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle basic JSON types validation', function () { return __awaiter(void 0, void 0, void 0, function () {
            var stringRules, stringResult, numberRules, numberResult, booleanRules, booleanResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        stringRules = [
                            { type: 'schema', schema: { type: 'string' }, message: 'Must be string' }
                        ];
                        return [4 /*yield*/, engine.validate('"hello"', stringRules)];
                    case 1:
                        stringResult = _a.sent();
                        (0, globals_1.expect)(stringResult.valid).toBe(true);
                        numberRules = [
                            { type: 'schema', schema: { type: 'number' }, message: 'Must be number' }
                        ];
                        return [4 /*yield*/, engine.validate('42', numberRules)];
                    case 2:
                        numberResult = _a.sent();
                        (0, globals_1.expect)(numberResult.valid).toBe(true);
                        booleanRules = [
                            { type: 'schema', schema: { type: 'boolean' }, message: 'Must be boolean' }
                        ];
                        return [4 /*yield*/, engine.validate('true', booleanRules)];
                    case 3:
                        booleanResult = _a.sent();
                        (0, globals_1.expect)(booleanResult.valid).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('context-aware validation', function () {
        (0, globals_1.it)('should apply rule when condition is met', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, validResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'ticket-creation',
                            userRole: 'admin'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'tickets',
                                condition: { var: 'taskType', equals: 'ticket-creation' },
                                message: 'Must contain tickets for ticket creation'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Created tickets successfully', rules, context)];
                    case 1:
                        validResult = _a.sent();
                        (0, globals_1.expect)(validResult.valid).toBe(true);
                        (0, globals_1.expect)(validResult.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should skip rule when condition is not met', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'documentation',
                            userRole: 'admin'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'tickets',
                                condition: { var: 'taskType', equals: 'ticket-creation' },
                                message: 'Must contain tickets for ticket creation'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Created documentation successfully', rules, context)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle multiple conditional rules', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, validResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'ticket-creation',
                            outputLevel: 'verbose',
                            userRole: 'admin'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'tickets',
                                condition: { var: 'taskType', equals: 'ticket-creation' },
                                message: 'Must contain tickets for ticket creation'
                            },
                            {
                                type: 'length',
                                min: 50,
                                condition: { var: 'outputLevel', equals: 'verbose' },
                                message: 'Verbose output must be at least 50 characters'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Created tickets successfully with detailed information about the process', rules, context)];
                    case 1:
                        validResult = _a.sent();
                        (0, globals_1.expect)(validResult.valid).toBe(true);
                        (0, globals_1.expect)(validResult.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle complex conditional logic with AND operator', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, validResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'ticket-creation',
                            userRole: 'admin',
                            priority: 'high'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'urgent',
                                condition: {
                                    and: [
                                        { var: 'taskType', equals: 'ticket-creation' },
                                        { var: 'priority', equals: 'high' }
                                    ]
                                },
                                message: 'High priority ticket creation must mention urgency'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Created urgent tickets for high priority issues', rules, context)];
                    case 1:
                        validResult = _a.sent();
                        (0, globals_1.expect)(validResult.valid).toBe(true);
                        (0, globals_1.expect)(validResult.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle complex conditional logic with OR operator', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, validResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'bug-fix',
                            userRole: 'developer',
                            priority: 'medium'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'fix',
                                condition: {
                                    or: [
                                        { var: 'taskType', equals: 'bug-fix' },
                                        { var: 'taskType', equals: 'hotfix' }
                                    ]
                                },
                                message: 'Bug fixes must mention fix in output'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Applied fix for the reported bug', rules, context)];
                    case 1:
                        validResult = _a.sent();
                        (0, globals_1.expect)(validResult.valid).toBe(true);
                        (0, globals_1.expect)(validResult.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle NOT operator in conditions', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, validResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'documentation',
                            userRole: 'writer'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'written',
                                condition: {
                                    not: { var: 'taskType', equals: 'ticket-creation' }
                                },
                                message: 'Non-ticket tasks should mention written work'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Documentation has been written successfully', rules, context)];
                    case 1:
                        validResult = _a.sent();
                        (0, globals_1.expect)(validResult.valid).toBe(true);
                        (0, globals_1.expect)(validResult.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle numeric comparison conditions', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, validResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskComplexity: 8,
                            timeSpent: 45
                        };
                        rules = [
                            {
                                type: 'length',
                                min: 100,
                                condition: { var: 'taskComplexity', gt: 7 },
                                message: 'Complex tasks require detailed output'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('This is a very detailed output for a complex task that requires extensive documentation and explanation of the implementation approach and methodology used', rules, context)];
                    case 1:
                        validResult = _a.sent();
                        (0, globals_1.expect)(validResult.valid).toBe(true);
                        (0, globals_1.expect)(validResult.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle schema validation with context conditions', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, validJson, validResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            outputFormat: 'json',
                            includeMetadata: true
                        };
                        rules = [
                            {
                                type: 'schema',
                                schema: {
                                    type: 'object',
                                    properties: {
                                        tickets: { type: 'array' },
                                        metadata: { type: 'object' }
                                    },
                                    required: ['tickets', 'metadata']
                                },
                                condition: {
                                    and: [
                                        { var: 'outputFormat', equals: 'json' },
                                        { var: 'includeMetadata', equals: true }
                                    ]
                                },
                                message: 'JSON output with metadata flag must include metadata'
                            }
                        ];
                        validJson = '{"tickets": [{"id": 1, "title": "Test"}], "metadata": {"created": "2023-01-01"}}';
                        return [4 /*yield*/, engine.validate(validJson, rules, context)];
                    case 1:
                        validResult = _a.sent();
                        (0, globals_1.expect)(validResult.valid).toBe(true);
                        (0, globals_1.expect)(validResult.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle missing context variables gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'ticket-creation'
                            // Missing userRole
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'admin',
                                condition: { var: 'userRole', equals: 'admin' },
                                message: 'Admin users must mention admin in output'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Created tickets successfully', rules, context)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle empty context gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            {
                                type: 'contains',
                                value: 'test',
                                condition: { var: 'taskType', equals: 'testing' },
                                message: 'Testing tasks must mention test'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Some output without test', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should apply rules without conditions normally', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, validResult;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'ticket-creation'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'success',
                                message: 'Output must contain success'
                            },
                            {
                                type: 'contains',
                                value: 'tickets',
                                condition: { var: 'taskType', equals: 'ticket-creation' },
                                message: 'Must contain tickets for ticket creation'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Created tickets successfully', rules, context)];
                    case 1:
                        validResult = _a.sent();
                        (0, globals_1.expect)(validResult.valid).toBe(true);
                        (0, globals_1.expect)(validResult.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should fail validation when conditional rule fails', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'ticket-creation',
                            priority: 'high'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'urgent',
                                condition: { var: 'priority', equals: 'high' },
                                message: 'High priority tasks must mention urgency'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Created tickets successfully', rules, context)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('High priority tasks must mention urgency');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle condition evaluation errors gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            taskType: 'ticket-creation'
                        };
                        rules = [
                            {
                                type: 'contains',
                                value: 'tickets',
                                condition: {
                                    // Invalid condition structure - should be caught by condition evaluator
                                    invalidOperator: 'test'
                                },
                                message: 'Must contain tickets'
                            }
                        ];
                        return [4 /*yield*/, engine.validate('Created something successfully', rules, context)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('logical composition validation', function () {
        (0, globals_1.it)('should handle AND operator with all rules passing', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            and: [
                                { type: 'contains', value: 'success', message: 'Must contain success' },
                                { type: 'contains', value: 'completed', message: 'Must contain completed' },
                                { type: 'length', min: 10, message: 'Must be at least 10 characters' }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle AND operator with one rule failing', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            and: [
                                { type: 'contains', value: 'success', message: 'Must contain success' },
                                { type: 'contains', value: 'failed', message: 'Must contain failed' },
                                { type: 'length', min: 10, message: 'Must be at least 10 characters' }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Validation composition failed');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle OR operator with one rule passing', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            or: [
                                { type: 'contains', value: 'failed', message: 'Must contain failed' },
                                { type: 'contains', value: 'success', message: 'Must contain success' },
                                { type: 'contains', value: 'error', message: 'Must contain error' }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle OR operator with all rules failing', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            or: [
                                { type: 'contains', value: 'failed', message: 'Must contain failed' },
                                { type: 'contains', value: 'error', message: 'Must contain error' },
                                { type: 'contains', value: 'warning', message: 'Must contain warning' }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Validation composition failed');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle NOT operator with rule failing (composition passes)', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            not: { type: 'contains', value: 'error', message: 'Must not contain error' }
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle NOT operator with rule passing (composition fails)', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            not: { type: 'contains', value: 'success', message: 'Must not contain success' }
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Validation composition failed');
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle nested composition with AND and OR', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            and: [
                                { type: 'contains', value: 'Task', message: 'Must mention task' },
                                {
                                    or: [
                                        { type: 'contains', value: 'success', message: 'Must contain success' },
                                        { type: 'contains', value: 'completed', message: 'Must contain completed' }
                                    ]
                                }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle complex nested composition with multiple levels', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            or: [
                                {
                                    and: [
                                        { type: 'contains', value: 'error', message: 'Must contain error' },
                                        { type: 'contains', value: 'critical', message: 'Must contain critical' }
                                    ]
                                },
                                {
                                    and: [
                                        { type: 'contains', value: 'success', message: 'Must contain success' },
                                        {
                                            not: { type: 'contains', value: 'warning', message: 'Must not contain warning' }
                                        }
                                    ]
                                }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle composition with schema validation', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, validJson, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            and: [
                                {
                                    type: 'schema',
                                    schema: {
                                        type: 'object',
                                        properties: { status: { type: 'string' } },
                                        required: ['status']
                                    },
                                    message: 'Must be valid status object'
                                },
                                {
                                    or: [
                                        { type: 'contains', value: 'success', message: 'Must contain success' },
                                        { type: 'contains', value: 'completed', message: 'Must contain completed' }
                                    ]
                                }
                            ]
                        };
                        validJson = '{"status": "success"}';
                        return [4 /*yield*/, engine.validate(validJson, composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle composition with context-aware rules', function () { return __awaiter(void 0, void 0, void 0, function () {
            var context, composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        context = {
                            environment: 'production',
                            priority: 'high'
                        };
                        composition = {
                            and: [
                                { type: 'contains', value: 'completed', message: 'Must contain completed' },
                                {
                                    or: [
                                        {
                                            type: 'contains',
                                            value: 'urgent',
                                            condition: { var: 'priority', equals: 'high' },
                                            message: 'High priority must mention urgent'
                                        },
                                        {
                                            type: 'contains',
                                            value: 'normal',
                                            condition: { var: 'priority', equals: 'low' },
                                            message: 'Low priority must mention normal'
                                        }
                                    ]
                                }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Task completed with urgent priority', composition, context)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle empty composition gracefully', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {};
                        return [4 /*yield*/, engine.validate('Any output', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle NOT with nested composition', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            not: {
                                and: [
                                    { type: 'contains', value: 'error', message: 'Must contain error' },
                                    { type: 'contains', value: 'critical', message: 'Must contain critical' }
                                ]
                            }
                        };
                        return [4 /*yield*/, engine.validate('Task completed successfully', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle composition with different rule types', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            and: [
                                { type: 'length', min: 20, message: 'Must be detailed' },
                                {
                                    or: [
                                        { type: 'regex', pattern: 'success', message: 'Must match success pattern' },
                                        { type: 'contains', value: 'completed', message: 'Must contain completed' }
                                    ]
                                },
                                {
                                    not: { type: 'contains', value: 'error', message: 'Must not contain error' }
                                }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Task has been completed successfully with all requirements met', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should maintain backward compatibility with array format', function () { return __awaiter(void 0, void 0, void 0, function () {
            var arrayRules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        arrayRules = [
                            { type: 'contains', value: 'success', message: 'Must contain success' },
                            { type: 'length', min: 10, message: 'Must be at least 10 characters' }
                        ];
                        return [4 /*yield*/, engine.validate('Task completed successfully', arrayRules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle complex real-world composition scenario', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, validOutput, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            and: [
                                // Basic requirements
                                { type: 'contains', value: 'ticket', message: 'Must mention tickets' },
                                { type: 'length', min: 50, message: 'Must be detailed' },
                                // Status requirements (at least one must be true)
                                {
                                    or: [
                                        { type: 'contains', value: 'created', message: 'Must mention creation' },
                                        { type: 'contains', value: 'updated', message: 'Must mention update' },
                                        { type: 'contains', value: 'resolved', message: 'Must mention resolution' }
                                    ]
                                },
                                // Quality requirements (must not contain error indicators)
                                {
                                    not: {
                                        or: [
                                            { type: 'contains', value: 'error', message: 'Must not contain error' },
                                            { type: 'contains', value: 'failed', message: 'Must not contain failed' }
                                        ]
                                    }
                                }
                            ]
                        };
                        validOutput = 'Successfully created multiple tickets for the project. All tickets have been properly categorized and assigned to the appropriate team members. The ticket creation process completed without any issues.';
                        return [4 /*yield*/, engine.validate(validOutput, composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        (0, globals_1.expect)(result.issues).toHaveLength(0);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle composition validation with detailed error reporting', function () { return __awaiter(void 0, void 0, void 0, function () {
            var composition, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        composition = {
                            and: [
                                { type: 'contains', value: 'nonexistent', message: 'Must contain nonexistent' },
                                { type: 'length', min: 1000, message: 'Must be very long' }
                            ]
                        };
                        return [4 /*yield*/, engine.validate('Short output', composition)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(false);
                        (0, globals_1.expect)(result.issues).toContain('Validation composition failed');
                        (0, globals_1.expect)(result.suggestions).toContain('Review validation criteria and adjust output accordingly.');
                        return [2 /*return*/];
                }
            });
        }); });
    });
    (0, globals_1.describe)('edge cases', function () {
        (0, globals_1.it)('should handle null criteria', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, engine.validate('hello world', null)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle undefined criteria', function () { return __awaiter(void 0, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, engine.validate('hello world', undefined)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle empty string output with valid criteria', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'length', min: 0, message: 'Must be at least 0 characters' }
                        ];
                        return [4 /*yield*/, engine.validate('', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle very long output', function () { return __awaiter(void 0, void 0, void 0, function () {
            var longOutput, rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        longOutput = 'a'.repeat(10000);
                        rules = [
                            { type: 'length', min: 5000, message: 'Must be at least 5000 characters' }
                        ];
                        return [4 /*yield*/, engine.validate(longOutput, rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
        (0, globals_1.it)('should handle special characters in regex', function () { return __awaiter(void 0, void 0, void 0, function () {
            var rules, result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        rules = [
                            { type: 'regex', pattern: '\\$\\d+\\.\\d{2}', message: 'Must be currency format' }
                        ];
                        return [4 /*yield*/, engine.validate('$123.45', rules)];
                    case 1:
                        result = _a.sent();
                        (0, globals_1.expect)(result.valid).toBe(true);
                        return [2 /*return*/];
                }
            });
        }); });
    });
});
