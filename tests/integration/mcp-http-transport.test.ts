/**
 * Integration test: WorkRail MCP server over HTTP transport.
 * 
 * Verifies that a bot service can call start_workflow and continue_workflow
 * over HTTP exactly like an IDE does over stdio.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHttpServer } from '../../src/mcp/transports/http-entry.js';
import { resetContainer } from '../../src/di/container.js';
import fetch from 'node-fetch';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('MCP HTTP transport integration', () => {
  const HTTP_PORT = 13100; // Ephemeral port for tests
  let tempDataDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let mcpSessionId: string; // MCP transport session ID (not WorkRail SessionId)

  beforeAll(async () => {
    // Create isolated data directory
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-http-test-'));
    
    // Isolate environment
    originalEnv = { ...process.env };
    process.env.WORKRAIL_DATA_DIR = tempDataDir;
    process.env.WORKRAIL_ENABLE_V2_TOOLS = 'true';
    process.env.WORKRAIL_ENABLE_SESSION_TOOLS = 'false'; // HTTP-only, no dashboard

    // Start HTTP server
    await startHttpServer(HTTP_PORT);
    
    // Give server time to bind
    await new Promise((resolve) => setTimeout(resolve, 100));

    // MCP protocol: initialize the server first
    const initResponse = await fetch(`http://localhost:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'workrail-http-test',
            version: '1.0.0',
          },
        },
      }),
    });

    expect(initResponse.status).toBe(200);
    const initData: any = await initResponse.json();
    expect(initData.result).toBeDefined();

    // Extract the MCP transport session ID from the response headers
    const sessionHeader = initResponse.headers.get('mcp-session-id');
    if (!sessionHeader) {
      throw new Error('No Mcp-Session-Id header in initialize response');
    }
    mcpSessionId = sessionHeader;
  });

  afterAll(async () => {
    // Restore environment
    process.env = originalEnv;
    
    // Clean up temp data
    await fs.rm(tempDataDir, { recursive: true, force: true });
    
    // Reset DI for next test
    resetContainer();
  });

  it('can call list_workflows over HTTP', async () => {
    const workspacePath = process.cwd();
    const response = await fetch(`http://localhost:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'list_workflows',
          arguments: {
            workspacePath,
          },
        },
      }),
    });

    const data: any = await response.json();
    if (response.status !== 200) {
      console.error('Response status:', response.status);
      console.error('Response body:', JSON.stringify(data, null, 2));
    }
    expect(response.status).toBe(200);
    
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(1);
    expect(data.result).toBeDefined();
    expect(data.result.isError).not.toBe(true);
    expect(data.result.content).toBeDefined();
    expect(Array.isArray(data.result.content)).toBe(true);
  });

  it('can start and continue a workflow over HTTP', async () => {
    // Step 1: start_workflow
    const startResponse = await fetch(`http://localhost:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'start_workflow',
          arguments: {
            workflowId: 'test-session-persistence',
            workspacePath: process.cwd(),
          },
        },
      }),
    });

    expect(startResponse.status).toBe(200);
    const startData: any = await startResponse.json();
    
    expect(startData.result).toBeDefined();
    expect(startData.result.content).toBeDefined();
    
    // The MCP result is an array of content items
    const contentItem = startData.result.content[0];
    expect(contentItem).toBeDefined();
    expect(contentItem.type).toBe('text');
    
    // For WorkRail v2 tools, the response is already a JSON string in content[0].text
    // But it's actually a formatted markdown-style response. Let me check what's actually there.
    const text = contentItem.text;
    
    // WorkRail tools return structured data embedded in the text.
    // One-token path: formatted output now contains continueToken
    expect(text).toContain('continueToken');
    
    // Extract continueToken via regex
    const continueMatch = text.match(/"continueToken":\s*"([^"]+)"/);
    expect(continueMatch).toBeDefined();
    const continueToken = continueMatch![1];

    // Step 2: continue_workflow using one-token path
    const continueResponse = await fetch(`http://localhost:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'continue_workflow',
          arguments: {
            continueToken,
            output: { notesMarkdown: '## Step 1 complete\\n\\nTest output.' },
          },
        },
      }),
    });

    expect(continueResponse.status).toBe(200);
    const continueData: any = await continueResponse.json();
    
    expect(continueData.result).toBeDefined();
    expect(continueData.result.content).toBeDefined();
    
    // Workflow advanced successfully
    const continueText = continueData.result.content[0].text;
    expect(continueText).toContain('continueToken');
  });
});
