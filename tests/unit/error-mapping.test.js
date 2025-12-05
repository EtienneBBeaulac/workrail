"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var globals_1 = require("@jest/globals");
var error_handler_1 = require("../../src/core/error-handler");
var error_handler_2 = require("../../src/core/error-handler");
var mcp_types_1 = require("../../src/types/mcp-types");
var handler = error_handler_1.ErrorHandler.getInstance();
(0, globals_1.describe)('ErrorHandler mapping', function () {
    (0, globals_1.it)('maps WorkflowNotFoundError to JSON-RPC error with correct code', function () {
        var _a;
        var err = new error_handler_2.WorkflowNotFoundError('missing');
        var resp = handler.handleError(err, 1);
        (0, globals_1.expect)((_a = resp.error) === null || _a === void 0 ? void 0 : _a.code).toBe(mcp_types_1.MCPErrorCodes.WORKFLOW_NOT_FOUND);
    });
    (0, globals_1.it)('maps ValidationError to JSON-RPC error with correct code', function () {
        var _a;
        var err = new error_handler_2.ValidationError('bad input');
        var resp = handler.handleError(err, 2);
        (0, globals_1.expect)((_a = resp.error) === null || _a === void 0 ? void 0 : _a.code).toBe(mcp_types_1.MCPErrorCodes.VALIDATION_ERROR);
    });
});
