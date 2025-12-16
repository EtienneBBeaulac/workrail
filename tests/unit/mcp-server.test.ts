import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Unit tests for MCP server module structure
// These tests verify the new modular architecture
describe('MCP Server Core Functionality', () => {
  const mcpDir = path.join(__dirname, '../../src/mcp');
  const entryPoint = path.join(__dirname, '../../src/mcp-server.ts');

  describe('Module Structure', () => {
    it('should have entry point that delegates to mcp/server.ts', () => {
      const content = fs.readFileSync(entryPoint, 'utf8');
      
      expect(content).toContain("import { startServer } from './mcp/server.js'");
      expect(content).toContain('startServer()');
      expect(content).toContain('process.exit(1)');
    });

    it('should have all required module files', () => {
      expect(fs.existsSync(path.join(mcpDir, 'types.ts'))).toBe(true);
      expect(fs.existsSync(path.join(mcpDir, 'tools.ts'))).toBe(true);
      expect(fs.existsSync(path.join(mcpDir, 'server.ts'))).toBe(true);
      expect(fs.existsSync(path.join(mcpDir, 'handlers/workflow.ts'))).toBe(true);
      expect(fs.existsSync(path.join(mcpDir, 'handlers/session.ts'))).toBe(true);
    });
  });

  describe('Tool Definitions (src/mcp/tools.ts)', () => {
    const toolsContent = fs.readFileSync(path.join(mcpDir, 'tools.ts'), 'utf8');

    it('should define workflow tool annotations', () => {
      expect(toolsContent).toContain('WORKFLOW_TOOL_ANNOTATIONS');
      expect(toolsContent).toContain('workflow_list');
      expect(toolsContent).toContain('workflow_get');
      expect(toolsContent).toContain('workflow_next');
      expect(toolsContent).toContain('workflow_validate_json');
      expect(toolsContent).toContain('workflow_get_schema');
    });

    it('should define all session tools', () => {
      expect(toolsContent).toContain('createSessionTool');
      expect(toolsContent).toContain('updateSessionTool');
      expect(toolsContent).toContain('readSessionTool');
      expect(toolsContent).toContain('openDashboardTool');
    });

    it('should use Zod schemas for input validation', () => {
      expect(toolsContent).toContain("import { z } from 'zod'");
      expect(toolsContent).toContain('z.object');
      expect(toolsContent).toContain('z.string');
      expect(toolsContent).toContain('.array('); // Method call syntax
    });

    it('should define tool annotations for safety hints', () => {
      expect(toolsContent).toContain('readOnlyHint');
      expect(toolsContent).toContain('destructiveHint');
      expect(toolsContent).toContain('idempotentHint');
    });

    it('should define workflow tool titles', () => {
      expect(toolsContent).toContain('WORKFLOW_TOOL_TITLES');
      expect(toolsContent).toContain("'List Available Workflows'");
      expect(toolsContent).toContain("'Get Workflow Details'");
      expect(toolsContent).toContain("'Execute Next Workflow Step'");
    });

    it('should export session tools collection', () => {
      expect(toolsContent).toContain('export const sessionTools');
    });
  });

  describe('Tool Description System', () => {
    it('should have tool description types', () => {
      const typesPath = path.join(mcpDir, 'types/tool-description-types.ts');
      expect(fs.existsSync(typesPath)).toBe(true);
      
      const typesContent = fs.readFileSync(typesPath, 'utf8');
      expect(typesContent).toContain('DESCRIPTION_MODES');
      expect(typesContent).toContain('WORKFLOW_TOOL_NAMES');
      expect(typesContent).toContain('DescriptionMode');
      expect(typesContent).toContain('WorkflowToolName');
    });

    it('should have tool descriptions for all modes', () => {
      const descriptionsPath = path.join(mcpDir, 'tool-descriptions.ts');
      expect(fs.existsSync(descriptionsPath)).toBe(true);
      
      const descriptionsContent = fs.readFileSync(descriptionsPath, 'utf8');
      expect(descriptionsContent).toContain('standard:');
      expect(descriptionsContent).toContain('authoritative:');
      expect(descriptionsContent).toContain('workflow_list');
      expect(descriptionsContent).toContain('workflow_next');
    });

    it('should have tool description provider', () => {
      const providerPath = path.join(mcpDir, 'tool-description-provider.ts');
      expect(fs.existsSync(providerPath)).toBe(true);
      
      const providerContent = fs.readFileSync(providerPath, 'utf8');
      expect(providerContent).toContain('IToolDescriptionProvider');
      expect(providerContent).toContain('ToolDescriptionProvider');
      expect(providerContent).toContain('getDescription');
    });

    it('should have tool factory', () => {
      const factoryPath = path.join(mcpDir, 'tool-factory.ts');
      expect(fs.existsSync(factoryPath)).toBe(true);
      
      const factoryContent = fs.readFileSync(factoryPath, 'utf8');
      expect(factoryContent).toContain('createToolFactory');
      expect(factoryContent).toContain('ToolBuilder');
      expect(factoryContent).toContain('ToolConfig');
    });
  });

  describe('Type Definitions (src/mcp/types.ts)', () => {
    const typesContent = fs.readFileSync(path.join(mcpDir, 'types.ts'), 'utf8');

    it('should define ToolResult discriminated union', () => {
      expect(typesContent).toContain('type ToolResult<T>');
      expect(typesContent).toContain('ToolSuccess');
      expect(typesContent).toContain('ToolError');
    });

    it('should define ErrorCode type', () => {
      expect(typesContent).toContain('type ErrorCode');
      expect(typesContent).toContain('VALIDATION_ERROR');
      expect(typesContent).toContain('NOT_FOUND');
      expect(typesContent).toContain('INTERNAL_ERROR');
    });

    it('should define ToolContext interface', () => {
      expect(typesContent).toContain('interface ToolContext');
      expect(typesContent).toContain('workflowService');
      expect(typesContent).toContain('featureFlags');
      expect(typesContent).toContain('sessionManager');
    });

    it('should export success and error helpers', () => {
      expect(typesContent).toContain('export const success');
      expect(typesContent).toContain('export const error');
    });
  });

  describe('Server Composition (src/mcp/server.ts)', () => {
    const serverContent = fs.readFileSync(path.join(mcpDir, 'server.ts'), 'utf8');

    it('should configure server with correct name and version', () => {
      expect(serverContent).toContain("name: 'workrail-server'");
      expect(serverContent).toContain("version: '0.1.0'");
    });

    it('should register request handlers', () => {
      expect(serverContent).toContain('ListToolsRequestSchema');
      expect(serverContent).toContain('CallToolRequestSchema');
      expect(serverContent).toContain('setRequestHandler');
    });

    it('should create tool context from DI container', () => {
      expect(serverContent).toContain('createToolContext');
      expect(serverContent).toContain('bootstrap(');
      expect(serverContent).toContain('container.resolve');
    });

    it('should use StdioServerTransport', () => {
      expect(serverContent).toContain('StdioServerTransport');
      expect(serverContent).toContain('server.connect');
    });

    it('should conditionally register session tools', () => {
      expect(serverContent).toContain("featureFlags.isEnabled('sessionTools')");
    });

    it('should convert Zod schemas to JSON Schema', () => {
      expect(serverContent).toContain('zodToJsonSchema');
      expect(serverContent).toContain('toMcpTool');
    });
  });

  describe('Workflow Handlers (src/mcp/handlers/workflow.ts)', () => {
    const workflowContent = fs.readFileSync(path.join(mcpDir, 'handlers/workflow.ts'), 'utf8');

    it('should export all workflow handlers', () => {
      expect(workflowContent).toContain('export async function handleWorkflowList');
      expect(workflowContent).toContain('export async function handleWorkflowGet');
      expect(workflowContent).toContain('export async function handleWorkflowNext');
      expect(workflowContent).toContain('export async function handleWorkflowValidateJson');
      expect(workflowContent).toContain('export async function handleWorkflowGetSchema');
    });

    it('should use ToolResult return type', () => {
      expect(workflowContent).toContain('Promise<ToolResult<');
      expect(workflowContent).toContain('success(');
      expect(workflowContent).toContain('error(');
    });

    it('should implement timeout handling', () => {
      expect(workflowContent).toContain('withTimeout');
      expect(workflowContent).toContain('TIMEOUT_MS');
    });

    it('should define output types', () => {
      expect(workflowContent).toContain('interface WorkflowListOutput');
      expect(workflowContent).toContain('interface WorkflowGetOutput');
      expect(workflowContent).toContain('interface WorkflowNextOutput');
    });
  });

  describe('Session Handlers (src/mcp/handlers/session.ts)', () => {
    const sessionContent = fs.readFileSync(path.join(mcpDir, 'handlers/session.ts'), 'utf8');

    it('should export all session handlers', () => {
      expect(sessionContent).toContain('export async function handleCreateSession');
      expect(sessionContent).toContain('export async function handleUpdateSession');
      expect(sessionContent).toContain('export async function handleReadSession');
      expect(sessionContent).toContain('export async function handleOpenDashboard');
    });

    it('should guard against disabled session tools', () => {
      expect(sessionContent).toContain('requireSessionTools');
      expect(sessionContent).toContain('PRECONDITION_FAILED');
    });

    it('should handle $schema special query', () => {
      expect(sessionContent).toContain("'$schema'");
      expect(sessionContent).toContain('SESSION_SCHEMA_OVERVIEW');
    });

    it('should define output types', () => {
      expect(sessionContent).toContain('interface CreateSessionOutput');
      expect(sessionContent).toContain('interface UpdateSessionOutput');
      expect(sessionContent).toContain('interface ReadSessionOutput');
    });
  });

  describe('Zod to JSON Schema Converter', () => {
    const converterContent = fs.readFileSync(path.join(mcpDir, 'zod-to-json-schema.ts'), 'utf8');

    it('should export zodToJsonSchema function', () => {
      expect(converterContent).toContain('export function zodToJsonSchema');
    });

    it('should handle common Zod types', () => {
      expect(converterContent).toContain('ZodObject');
      expect(converterContent).toContain('ZodString');
      expect(converterContent).toContain('ZodNumber');
      expect(converterContent).toContain('ZodArray');
      expect(converterContent).toContain('ZodEnum');
    });

    it('should handle optional and default values', () => {
      expect(converterContent).toContain('ZodOptional');
      expect(converterContent).toContain('ZodDefault');
    });
  });
});
