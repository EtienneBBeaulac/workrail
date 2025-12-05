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
var storage_1 = require("../../src/infrastructure/storage");
var globals_1 = require("@jest/globals");
(0, globals_1.describe)('FileWorkflowStorage', function () {
    var storage = (0, storage_1.createDefaultWorkflowStorage)();
    (0, globals_1.it)('should load workflows from disk', function () { return __awaiter(void 0, void 0, void 0, function () {
        var workflows, wf;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, storage.loadAllWorkflows()];
                case 1:
                    workflows = _a.sent();
                    (0, globals_1.expect)(Array.isArray(workflows)).toBe(true);
                    (0, globals_1.expect)(workflows.length).toBeGreaterThan(0);
                    wf = workflows[0];
                    (0, globals_1.expect)(wf).toHaveProperty('id');
                    (0, globals_1.expect)(wf).toHaveProperty('steps');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, globals_1.it)('should cache workflows and provide hit/miss stats', function () { return __awaiter(void 0, void 0, void 0, function () {
        var statsBefore, statsAfterFirst, statsAfterSecond;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    statsBefore = storage.getCacheStats();
                    // First call – should be a miss or at least not decrease counts
                    return [4 /*yield*/, storage.loadAllWorkflows()];
                case 1:
                    // First call – should be a miss or at least not decrease counts
                    _a.sent();
                    statsAfterFirst = storage.getCacheStats();
                    (0, globals_1.expect)(statsAfterFirst.misses).toBeGreaterThanOrEqual(statsBefore.misses);
                    // Second call – should hit cache
                    return [4 /*yield*/, storage.loadAllWorkflows()];
                case 2:
                    // Second call – should hit cache
                    _a.sent();
                    statsAfterSecond = storage.getCacheStats();
                    (0, globals_1.expect)(statsAfterSecond.hits).toBeGreaterThanOrEqual(statsAfterFirst.hits + 1);
                    return [2 /*return*/];
            }
        });
    }); });
});
