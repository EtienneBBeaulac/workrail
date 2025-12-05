"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var globals_1 = require("@jest/globals");
// Simple unit tests for MCP server functionality
(0, globals_1.describe)('MCP Server Core Functionality', function () {
    (0, globals_1.describe)('Server Configuration and Tool Definitions', function () {
        (0, globals_1.it)('should define all required workflow tools', function () {
            // Test that the server file contains all expected tool definitions
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('WORKFLOW_LIST_TOOL');
            (0, globals_1.expect)(mcpServerContent).toContain('WORKFLOW_GET_TOOL');
            (0, globals_1.expect)(mcpServerContent).toContain('WORKFLOW_NEXT_TOOL');
            (0, globals_1.expect)(mcpServerContent).toContain('WORKFLOW_VALIDATE_TOOL');
            (0, globals_1.expect)(mcpServerContent).toContain('WORKFLOW_VALIDATE_JSON_TOOL');
        });
        (0, globals_1.it)('should configure server with correct name and version', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('"workrail-server"');
            (0, globals_1.expect)(mcpServerContent).toContain('"0.1.0"');
        });
        (0, globals_1.it)('should register request handlers for ListTools and CallTool', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('ListToolsRequestSchema');
            (0, globals_1.expect)(mcpServerContent).toContain('CallToolRequestSchema');
            (0, globals_1.expect)(mcpServerContent).toContain('setRequestHandler');
        });
    });
    (0, globals_1.describe)('WorkRailServer Class Structure', function () {
        (0, globals_1.it)('should define WorkRailServer class with required methods', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('class WorkRailServer');
            (0, globals_1.expect)(mcpServerContent).toContain('callWorkflowMethod');
            (0, globals_1.expect)(mcpServerContent).toContain('listWorkflows');
            (0, globals_1.expect)(mcpServerContent).toContain('getWorkflow');
            (0, globals_1.expect)(mcpServerContent).toContain('getNextStep');
            (0, globals_1.expect)(mcpServerContent).toContain('validateStep');
            (0, globals_1.expect)(mcpServerContent).toContain('validateWorkflowJson');
        });
        (0, globals_1.it)('should handle all workflow method types in callWorkflowMethod', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain("case 'workflow_list':");
            (0, globals_1.expect)(mcpServerContent).toContain("case 'workflow_get':");
            (0, globals_1.expect)(mcpServerContent).toContain("case 'workflow_next':");
            (0, globals_1.expect)(mcpServerContent).toContain("case 'workflow_validate':");
        });
        (0, globals_1.it)('should initialize container in constructor', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('createAppContainer()');
        });
    });
    (0, globals_1.describe)('Tool Schema Definitions', function () {
        (0, globals_1.it)('should define workflow_get tool with workflowId parameter', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('workflowId');
            (0, globals_1.expect)(mcpServerContent).toContain('mode');
            (0, globals_1.expect)(mcpServerContent).toContain('preview');
            (0, globals_1.expect)(mcpServerContent).toContain('metadata');
        });
        (0, globals_1.it)('should define workflow_next tool with required parameters', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('completedSteps');
            (0, globals_1.expect)(mcpServerContent).toContain('context');
        });
        (0, globals_1.it)('should define workflow_validate tool with validation parameters', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('stepId');
            (0, globals_1.expect)(mcpServerContent).toContain('output');
        });
    });
    (0, globals_1.describe)('Request Handler Implementation', function () {
        (0, globals_1.it)('should validate required parameters in CallTool handler', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('workflowId parameter is required');
            (0, globals_1.expect)(mcpServerContent).toContain('workflowId, stepId, and output parameters are required');
            (0, globals_1.expect)(mcpServerContent).toContain('workflowJson parameter is required');
        });
        (0, globals_1.it)('should handle unknown tool names', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('Unknown tool:');
        });
        (0, globals_1.it)('should return ListToolsResult with all 6 tools', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            // Count the tool constant definitions (not references)
            var toolConstMatches = mcpServerContent.match(/const WORKFLOW_\w+_TOOL: Tool =/g) || [];
            (0, globals_1.expect)(toolConstMatches.length).toBe(6);
        });
    });
    (0, globals_1.describe)('Error Handling', function () {
        (0, globals_1.it)('should implement try-catch in callWorkflowMethod', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('try {');
            (0, globals_1.expect)(mcpServerContent).toContain('} catch (error)');
            (0, globals_1.expect)(mcpServerContent).toContain('isError: true');
        });
        (0, globals_1.it)('should handle validateWorkflowJson errors separately', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('validateWorkflowJson');
            (0, globals_1.expect)(mcpServerContent).toContain('createValidateWorkflowJson');
        });
    });
    (0, globals_1.describe)('Server Transport and Connection', function () {
        (0, globals_1.it)('should create StdioServerTransport and connect', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('StdioServerTransport');
            (0, globals_1.expect)(mcpServerContent).toContain('server.connect');
            (0, globals_1.expect)(mcpServerContent).toContain('runServer');
        });
        (0, globals_1.it)('should handle server startup errors', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('.catch');
            (0, globals_1.expect)(mcpServerContent).toContain('Fatal error running server');
            (0, globals_1.expect)(mcpServerContent).toContain('process.exit(1)');
        });
    });
    (0, globals_1.describe)('Container Integration', function () {
        (0, globals_1.it)('should import and use createAppContainer', function () {
            var mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
            (0, globals_1.expect)(mcpServerContent).toContain('import { createAppContainer }');
            (0, globals_1.expect)(mcpServerContent).toContain('this.container = createAppContainer()');
        });
    });
});
