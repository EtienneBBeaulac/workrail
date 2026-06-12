/**
 * Integration test: WorkRail MCP server over in-process stdio memory streams.
 * 
 * Verifies that we can instantiate the composeServer root, connect it to
 * StdioServerTransport passing memory stream fakes, and run JSON-RPC loops
 * in sub-10ms with zero OS process overhead and isolated session storage.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { composeServer } from '../../src/mcp/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PassThrough } from 'stream';
import { resetContainer } from '../../src/di/container.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('MCP Stdio In-Process Integration', () => {
  let tempDataDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    // Isolate environment and data directories to prevent collision
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-stdio-inprocess-test-'));
    originalEnv = { ...process.env };
    process.env.WORKRAIL_DATA_DIR = tempDataDir;
    process.env.WORKRAIL_ENABLE_V2_TOOLS = 'true';
    process.env.WORKRAIL_ENABLE_SESSION_TOOLS = 'false';
  });

  afterAll(async () => {
    process.env = originalEnv;
    await fs.rm(tempDataDir, { recursive: true, force: true });
    resetContainer();
  });

  it('can list tools and run initialize over memory duplex streams', async () => {
    // 1. Compose the server
    const { server } = await composeServer();

    // 2. Create in-memory stream mock fakes
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();

    // 3. Connect via SDK transport passing our fakes
    const transport = new StdioServerTransport(mockStdin, mockStdout);
    await server.connect(transport);

    // Helper to write a request and read the response
    const sendRequest = (req: any): Promise<any> => {
      return new Promise((resolve, reject) => {
        let outputBuffer = '';
        const onData = (chunk: Buffer) => {
          outputBuffer += chunk.toString();
          // Stdio protocol: messages are separated by newlines
          if (outputBuffer.endsWith('\n')) {
            mockStdout.off('data', onData);
            try {
              resolve(JSON.parse(outputBuffer.trim()));
            } catch (e) {
              reject(e);
            }
          }
        };
        mockStdout.on('data', onData);

        // Send the request over mock stdin
        mockStdin.write(JSON.stringify(req) + '\n');
      });
    };

    // 4. Send initialize request
    const initResponse = await sendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'in-process-test', version: '1.0.0' },
      },
    });

    expect(initResponse.result).toBeDefined();

    // 5. Send list tools request
    const toolsResponse = await sendRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    expect(toolsResponse.result).toBeDefined();
    expect(toolsResponse.result.tools).toBeDefined();
    const toolNames = toolsResponse.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('list_workflows');

    // 6. Cleanup
    await transport.close();
  });
});
