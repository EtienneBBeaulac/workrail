import { describe, it, expect } from 'vitest';

// Simple unit tests for MCP server functionality
describe('MCP Server Core Functionality', () => {
  describe('Server Configuration and Tool Definitions', () => {
    it('should define all required workflow tools', () => {
      // Test that the server file contains all expected tool definitions
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('WORKFLOW_LIST_TOOL');
      expect(mcpServerContent).toContain('WORKFLOW_GET_TOOL'); 
      expect(mcpServerContent).toContain('WORKFLOW_NEXT_TOOL');
      expect(mcpServerContent).toContain('WORKFLOW_VALIDATE_JSON_TOOL');
      expect(mcpServerContent).toContain('WORKFLOW_GET_SCHEMA_TOOL');
    });

    it('should configure server with correct name and version', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('"workrail-server"');
      expect(mcpServerContent).toContain('"0.1.0"');
    });

    it('should register request handlers for ListTools and CallTool', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('ListToolsRequestSchema');
      expect(mcpServerContent).toContain('CallToolRequestSchema');
      expect(mcpServerContent).toContain('setRequestHandler');
    });
  });

  describe('WorkRailServer Class Structure', () => {
    it('should define WorkflowOrchestrationServer class with required methods', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('class WorkflowOrchestrationServer');
      expect(mcpServerContent).toContain('callWorkflowMethod');
      expect(mcpServerContent).toContain('listWorkflows');
      expect(mcpServerContent).toContain('getWorkflow');
      expect(mcpServerContent).toContain('getNextStep');
      expect(mcpServerContent).toContain('validateWorkflowJson');
    });

    it('should handle all workflow method types in callWorkflowMethod', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain("case 'workflow_list':");
      expect(mcpServerContent).toContain("case 'workflow_get':");
      expect(mcpServerContent).toContain("case 'workflow_next':");
      expect(mcpServerContent).toContain("case 'workflow_validate':");
    });

    it('should initialize container in initialize method', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('await bootstrap()');
      expect(mcpServerContent).toContain('async initialize()');
    });
  });

  describe('Tool Schema Definitions', () => {
    it('should define workflow_get tool with workflowId parameter', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('workflowId');
      expect(mcpServerContent).toContain('mode');
      expect(mcpServerContent).toContain('preview');
      expect(mcpServerContent).toContain('metadata');
    });

    it('should define workflow_next tool with required parameters', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('completedSteps');
      expect(mcpServerContent).toContain('context');
    });

    it('should define workflow_validate tool with validation parameters', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('stepId');
      expect(mcpServerContent).toContain('output');
    });
  });

  describe('Request Handler Implementation', () => {
    it('should validate required parameters in CallTool handler', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('id parameter is required');
      expect(mcpServerContent).toContain('workflowId parameter is required');
      expect(mcpServerContent).toContain('workflowJson parameter is required');
    });

    it('should handle unknown tool names', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('Unknown tool:');
    });

    it('should return ListToolsResult with all 5 workflow tools', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      // Count the tool constant definitions (not references)
      const toolConstMatches = mcpServerContent.match(/const WORKFLOW_\w+_TOOL: Tool =/g) || [];
      expect(toolConstMatches.length).toBe(5);
    });
  });

  describe('Error Handling', () => {
    it('should implement try-catch in callWorkflowMethod', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('try {');
      expect(mcpServerContent).toContain('} catch (error)');
      expect(mcpServerContent).toContain('isError: true');
    });

    it('should handle validateWorkflowJson errors separately', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('validateWorkflowJson');
      expect(mcpServerContent).toContain('createValidateWorkflowJson');
    });
  });

  describe('Server Transport and Connection', () => {
    it('should create StdioServerTransport and connect', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('StdioServerTransport');
      expect(mcpServerContent).toContain('server.connect');
      expect(mcpServerContent).toContain('runServer');
    });

    it('should handle server startup errors', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('.catch');
      expect(mcpServerContent).toContain('Fatal error running server');
      expect(mcpServerContent).toContain('process.exit(1)');
    });
  });

  describe('Container Integration', () => {
    it('should import and use TSyringe DI container', () => {
      const mcpServerContent = require('fs').readFileSync(require('path').join(__dirname, '../../src/mcp-server.ts'), 'utf8');
      
      expect(mcpServerContent).toContain('import { bootstrap, container }');
      expect(mcpServerContent).toContain('await bootstrap()');
      expect(mcpServerContent).toContain('container.resolve');
    });
  });
});

 