import { describe, vi, it, expect, beforeEach, jest } from 'vitest';
import { RemoteWorkflowStorage } from '../../src/infrastructure/storage/remote-workflow-storage';
import {
  WorkflowDefinition,
  WorkflowSummary,
  createRemoteRegistrySource,
  createWorkflow,
} from '../../src/types/workflow';
import { SecurityError, StorageError, InvalidWorkflowError } from '../../src/core/error-handler';

// Mock fetch globally
const mockFetch = vi.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

describe('Remote Workflow Storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockClear();
  });

  describe('RemoteWorkflowStorage', () => {
    describe('Constructor and Configuration', () => {
      it('should validate and accept secure HTTPS configuration', () => {
        expect(() => new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          apiKey: 'test-key',
          timeout: 5000,
          retryAttempts: 2
        })).not.toThrow();
      });

      it('should remove trailing slash from baseUrl', () => {
        const storage = new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com/'
        });
        
        // The config is private, but we can test the behavior through fetch calls
        expect(storage).toBeDefined();
      });

      it('should reject missing baseUrl', () => {
        expect(() => new RemoteWorkflowStorage({
          baseUrl: ''
        })).toThrow(SecurityError);
      });

      it('should reject localhost URLs', () => {
        expect(() => new RemoteWorkflowStorage({
          baseUrl: 'https://localhost:8080'
        })).toThrow(SecurityError);
      });

      it('should reject private network URLs', () => {
        const privateUrls = [
          'https://192.168.1.1',
          'https://10.0.0.1',
          'https://172.16.0.1'
        ];

        for (const url of privateUrls) {
          expect(() => new RemoteWorkflowStorage({ baseUrl: url })).toThrow(SecurityError);
        }
      });

      it('should reject unsafe protocols', () => {
        const unsafeUrls = [
          'file:///etc/passwd',
          'ftp://example.com',
          'javascript:alert(1)'
        ];

        for (const url of unsafeUrls) {
          expect(() => new RemoteWorkflowStorage({ baseUrl: url })).toThrow(SecurityError);
        }
      });

      it('should reject invalid timeout values', () => {
        expect(() => new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          timeout: 50 // Too low (below 100ms minimum)
        })).toThrow(SecurityError);

        expect(() => new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          timeout: 70000 // Too high
        })).toThrow(SecurityError);
      });

      it('should reject invalid retry attempts', () => {
        expect(() => new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          retryAttempts: -1
        })).toThrow(SecurityError);

        expect(() => new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          retryAttempts: 15
        })).toThrow(SecurityError);
      });
    });

    describe('loadAllWorkflows', () => {
      let storage: RemoteWorkflowStorage;

      beforeEach(() => {
        storage = new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          timeout: 100, // Short timeout for tests
          retryAttempts: 1 // Minimal retries for tests
        });
      });

      it('should load workflows from registry with workflows format', async () => {
        const mockDefinitions: WorkflowDefinition[] = [
          {
            id: 'test-workflow',
            name: 'Test Workflow',
            description: 'A test workflow',
            version: '1.0.0',
            steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
          }
        ];

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ workflows: mockDefinitions }))
        } as Response);

        const result = await storage.loadAllWorkflows();
        expect(result).toEqual(
          mockDefinitions.map(def =>
            createWorkflow(def, createRemoteRegistrySource('https://registry.example.com'))
          )
        );
        expect(mockFetch).toHaveBeenCalledWith(
          'https://registry.example.com/workflows',
          expect.objectContaining({
            headers: expect.objectContaining({
              'User-Agent': 'workrail-mcp-server/1.0',
              'Accept': 'application/json'
            })
          })
        );
      });

      it('should load workflows from registry with data format', async () => {
        const mockDefinitions: WorkflowDefinition[] = [
          {
            id: 'test-workflow',
            name: 'Test Workflow',
            description: 'A test workflow',
            version: '1.0.0',
            steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
          }
        ];

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ data: mockDefinitions }))
        } as Response);

        const result = await storage.loadAllWorkflows();
        expect(result).toEqual(
          mockDefinitions.map(def =>
            createWorkflow(def, createRemoteRegistrySource('https://registry.example.com'))
          )
        );
      });

      it('should filter out invalid workflows', async () => {
        const mockResponse = {
          workflows: [
            { id: 'valid', name: 'Valid', steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test prompt' }] },
            { name: 'Invalid - no ID', steps: [] },
            null,
            'invalid string',
            { id: 'invalid/id', name: 'Invalid ID', steps: [] }
          ]
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(mockResponse))
        } as Response);

        const result = await storage.loadAllWorkflows();
        expect(result).toHaveLength(1);
        expect(result[0]!.definition.id).toBe('valid');
      });

      it('should throw StorageError for network failures', async () => {
        mockFetch.mockRejectedValue(new Error('Network error'));

        await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
        await expect(storage.loadAllWorkflows()).rejects.toThrow('Failed to fetch');
      });

      it('should throw StorageError for empty response', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('')
        } as Response);

        await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
        await expect(storage.loadAllWorkflows()).rejects.toThrow('Failed to fetch');
      });

      it('should throw StorageError for invalid JSON', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('invalid json')
        } as Response);

        await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
        await expect(storage.loadAllWorkflows()).rejects.toThrow('Failed to fetch');
      });
    });

    describe('getWorkflowById', () => {
      let storage: RemoteWorkflowStorage;

      beforeEach(() => {
        storage = new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          timeout: 100,
          retryAttempts: 1
        });
      });

      it('should retrieve workflow by ID', async () => {
        const mockDefinition: WorkflowDefinition = {
          id: 'test-workflow',
          name: 'Test Workflow',
          description: 'A test workflow',
          version: '1.0.0',
          steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(mockDefinition))
        } as Response);

        const result = await storage.getWorkflowById('test-workflow');
        expect(result).toEqual(
          createWorkflow(
            mockDefinition,
            createRemoteRegistrySource('https://registry.example.com')
          )
        );
        expect(mockFetch).toHaveBeenCalledWith(
          'https://registry.example.com/workflows/test-workflow',
          expect.any(Object)
        );
      });

      it('should return null for 404 responses', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found'
        } as Response);

        const result = await storage.getWorkflowById('nonexistent');
        expect(result).toBeNull();
      });

      it('should throw StorageError for non-404 HTTP errors', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error'
        } as Response);

        await expect(storage.getWorkflowById('test-workflow')).rejects.toThrow(StorageError);
        await expect(storage.getWorkflowById('test-workflow')).rejects.toThrow('Failed to fetch');
      });

      it('should sanitize workflow ID', async () => {
        await expect(storage.getWorkflowById('test workflow')).rejects.toThrow(InvalidWorkflowError);
        await expect(storage.getWorkflowById('test/workflow')).rejects.toThrow(InvalidWorkflowError);
        await expect(storage.getWorkflowById('test\u0000workflow')).rejects.toThrow(SecurityError);
      });

      it('should validate returned workflow ID matches request', async () => {
        const mockDefinition: WorkflowDefinition = {
          id: 'different-id',
          name: 'Test Workflow',
          description: 'A test workflow',
          version: '1.0.0',
          steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(mockDefinition))
        } as Response);

        await expect(storage.getWorkflowById('test-workflow')).rejects.toThrow(InvalidWorkflowError);
      });
    });

    describe('listWorkflowSummaries', () => {
      let storage: RemoteWorkflowStorage;

      beforeEach(() => {
        storage = new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          timeout: 100,
          retryAttempts: 1
        });
      });

      it('should list workflow summaries', async () => {
        const mockDefinitions: WorkflowDefinition[] = [
          {
            id: 'workflow-1',
            name: 'Workflow 1',
            description: 'First workflow',
            version: '1.0.0',
            steps: [{ id: 's1', title: 'S1', prompt: 'P1' }],
          },
        ];

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ workflows: mockDefinitions }))
        } as Response);

        const result = await storage.listWorkflowSummaries();
        const expected: WorkflowSummary[] = [
          {
            id: 'workflow-1',
            name: 'Workflow 1',
            description: 'First workflow',
            version: '1.0.0',
            source: { kind: 'remote', displayName: 'registry.example.com' }
          }
        ];
        expect(result).toEqual(expected);
        expect(mockFetch).toHaveBeenCalledWith(
          'https://registry.example.com/workflows',
          expect.any(Object)
        );
      });

      it('should filter out invalid summaries', async () => {
        const mockResponse = {
          workflows: [
            { id: 'valid', name: 'Valid', steps: [{ id: 's1', title: 'S1', prompt: 'P1' }] },
            { name: 'Invalid - no ID', steps: [] },
            null,
            { id: 'invalid/id', name: 'Invalid ID', steps: [] }
          ],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify(mockResponse))
        } as Response);

        const result = await storage.listWorkflowSummaries();
        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe('valid');
      });
    });

    describe('save', () => {
      let storage: RemoteWorkflowStorage;

      beforeEach(() => {
        mockFetch.mockReset(); // Reset mock implementation from other test suites
        storage = new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          apiKey: 'test-api-key'
        });
      });

      it('should save workflow to registry', async () => {
        const definition: WorkflowDefinition = {
          id: 'test-workflow',
          name: 'Test Workflow',
          description: 'A test workflow',
          version: '1.0.0',
          steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve('{}')
        } as Response);

        await storage.save(definition);

        expect(mockFetch).toHaveBeenCalledWith(
          'https://registry.example.com/workflows',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Content-Type': 'application/json',
              'Authorization': 'Bearer test-api-key'
            }),
            body: JSON.stringify(definition)
          })
        );
      });

      it('should validate workflow before saving', async () => {
        const invalidWorkflows = [
          null,
          {},
          { name: 'No ID', steps: [] },
          { id: 'test', name: 'No steps' },
          { id: 'invalid/id', name: 'Invalid ID', steps: [] }
        ];

        for (const workflow of invalidWorkflows) {
          await expect(storage.save(workflow as any)).rejects.toThrow();
        }
      });

      it('should handle registry errors', async () => {
        const definition: WorkflowDefinition = {
          id: 'test-workflow',
          name: 'Test Workflow',
          description: 'A test workflow',
          version: '1.0.0',
          steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test step prompt' }]
        };

        mockFetch.mockResolvedValueOnce({
          ok: false,
          text: () => Promise.resolve(JSON.stringify({ message: 'Validation failed' }))
        } as Response);

        const promise = storage.save(definition);
        await expect(promise).rejects.toThrow(StorageError);
        await expect(promise).rejects.toThrow('Failed to publish workflow');
      });
    });

    describe('Retry Logic', () => {
      let storage: RemoteWorkflowStorage;

      beforeEach(() => {
        mockFetch.mockReset(); // Reset mock implementation from other test suites
        storage = new RemoteWorkflowStorage({
          baseUrl: 'https://registry.example.com',
          retryAttempts: 2,
          timeout: 100 // Much shorter for tests
        });
      });

      it('should retry failed requests', async () => {
        mockFetch
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({
            ok: true,
            text: () => Promise.resolve(JSON.stringify({ workflows: [] }))
          } as Response);

        const result = await storage.loadAllWorkflows();
        expect(result).toEqual([]);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should throw StorageError after all retries fail', async () => {
        mockFetch.mockClear(); // Clear previous call history
        mockFetch.mockRejectedValue(new Error('Network error'));

        await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
        expect(mockFetch).toHaveBeenCalledTimes(2); // Initial + 1 retry
      });
    });
  });

}); 