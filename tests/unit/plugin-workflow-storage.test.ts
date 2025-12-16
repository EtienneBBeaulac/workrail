import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

// Mock modules - vi.mock is hoisted, so we can't use variables declared in the same file
// Instead we use vi.hoisted() to create mocks that will be hoisted along with vi.mock
const { mockFs, mockExistsSync, mockSecurity } = vi.hoisted(() => {
  return {
    mockFs: {
      readdir: vi.fn(),
      readFile: vi.fn(),
      stat: vi.fn(),
    },
    mockExistsSync: vi.fn(),
    mockSecurity: {
      sanitizeId: vi.fn((id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_')),
      assertWithinBase: vi.fn(),
      validateFileSize: vi.fn(),
      validateSecurityOptions: vi.fn((opts: any) => ({ maxFileSizeBytes: opts?.maxFileSizeBytes || 1024 * 1024 })),
    },
  };
});

vi.mock('fs/promises', () => ({
  default: mockFs,
  readdir: mockFs.readdir,
  readFile: mockFs.readFile,
  stat: mockFs.stat,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  default: {
    existsSync: mockExistsSync,
  },
}));

vi.mock('../../src/utils/storage-security', () => ({
  sanitizeId: mockSecurity.sanitizeId,
  assertWithinBase: mockSecurity.assertWithinBase,
  validateFileSize: mockSecurity.validateFileSize,
  validateSecurityOptions: mockSecurity.validateSecurityOptions,
}));

// Import after mocks are set up
import { PluginWorkflowStorage } from '../../src/infrastructure/storage/plugin-workflow-storage';
import { StorageError, InvalidWorkflowError, SecurityError } from '../../src/core/error-handler';
import { createPluginSource, createWorkflow, WorkflowDefinition } from '../../src/types/workflow';

describe('PluginWorkflowStorage', () => {
  let storage: PluginWorkflowStorage;
  const testPluginPath = '/test/node_modules';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mock behavior
    mockExistsSync.mockReturnValue(true);
    mockFs.readdir.mockResolvedValue([]);
    mockSecurity.assertWithinBase.mockImplementation(() => {});
    mockSecurity.validateFileSize.mockImplementation(() => {});
    mockSecurity.sanitizeId.mockImplementation((id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_'));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Configuration and Initialization', () => {
    it('should initialize with default configuration', () => {
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        return pathStr.includes('node_modules');
      });
      
      storage = new PluginWorkflowStorage();
      const config = storage.getConfig();
      
      expect(config.scanInterval).toBeGreaterThanOrEqual(30000);
      expect(config.maxFileSize).toBe(1024 * 1024);
      expect(config.maxFiles).toBe(50);
      expect(config.maxPlugins).toBe(20);
      expect(Array.isArray(config.pluginPaths)).toBe(true);
    });

    it('should accept custom configuration with valid paths', () => {
      storage = new PluginWorkflowStorage({
        pluginPaths: [testPluginPath],
        scanInterval: 60000,
        maxFileSize: 2 * 1024 * 1024,
        maxFiles: 100,
        maxPlugins: 50
      });
      const config = storage.getConfig();
      
      expect(config.pluginPaths).toEqual([testPluginPath]);
      expect(config.scanInterval).toBe(60000);
      expect(config.maxFileSize).toBe(2 * 1024 * 1024);
      expect(config.maxFiles).toBe(100);
      expect(config.maxPlugins).toBe(50);
    });

    it('should enforce minimum scan interval', () => {
      storage = new PluginWorkflowStorage({
        pluginPaths: [testPluginPath],
        scanInterval: 10000
      });
      const config = storage.getConfig();
      
      expect(config.scanInterval).toBe(30000);
    });

    // NOTE: Predefined config presets were removed; config normalization is tested above.
  });

  describe('Security Features', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: [testPluginPath],
        maxFileSize: 1024 * 1024,
        maxFiles: 5,
        maxPlugins: 3
      });
    });

    it('should prevent scanning too many plugins', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath || pathStr.endsWith('node_modules')) {
          return Promise.resolve([
            'workrail-workflows-plugin1',
            'workrail-workflows-plugin2', 
            'workrail-workflows-plugin3',
            'workrail-workflows-plugin4'
          ]);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['workflow.json']);
        }
        return Promise.resolve([]);
      });

      const mockPackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        workrail: { workflows: true }
      };
      
      const mockWorkflow = { id: 'test', name: 'Test', version: '1.0.0', steps: [] };
      
      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        if (pathStr.endsWith('.json')) {
          return Promise.resolve(JSON.stringify(mockWorkflow));
        }
        return Promise.resolve('[]');
      });

      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
    });

    it('should validate file sizes during scanning', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['test-workflow.json']);
        }
        return Promise.resolve([]);
      });

      const mockPackageJson = {
        name: 'test-plugin',
        version: '1.0.0', 
        workrail: { workflows: true }
      };

      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve('{"id": "test", "name": "Test"}');
      });

      // Make validateFileSize throw for workflow files
      mockSecurity.validateFileSize.mockImplementation((size: number, maxSize: number, filename: string) => {
        if (filename.endsWith('.json') && !filename.endsWith('package.json')) {
          throw new SecurityError(`File ${filename} (${size} bytes) exceeds size limit (${maxSize} bytes)`);
        }
      });

      await expect(storage.loadAllWorkflows()).rejects.toThrow(SecurityError);
    });

    it('should validate workflow file counts', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve([
            'workflow1.json', 'workflow2.json', 'workflow3.json',
            'workflow4.json', 'workflow5.json', 'workflow6.json'
          ]);
        }
        return Promise.resolve([]);
      });

      const mockPackageJson = {
        name: 'workrail-workflows-test',
        version: '1.0.0',
        workrail: { workflows: true }
      };

      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve('{"id": "test", "name": "Test"}');
      });

      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
    });

    it('should validate package.json size limits', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue(['workrail-workflows-test']);
      mockFs.stat.mockResolvedValue({ size: 1000 });

      // Make validateFileSize throw for package.json
      mockSecurity.validateFileSize.mockImplementation((size: number, maxSize: number, filename: string) => {
        if (filename === 'package.json') {
          throw new SecurityError(`File ${filename} exceeds size limit`);
        }
      });

      await expect(storage.loadAllWorkflows()).rejects.toThrow(SecurityError);
    });

    it('should validate workflow IDs for security', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['malicious.json']);
        }
        return Promise.resolve([]);
      });

      const mockPackageJson = {
        name: 'workrail-workflows-test',
        version: '1.0.0',
        workrail: { workflows: true }
      };

      const maliciousWorkflow = {
        id: '../../../malicious',
        name: 'Malicious Workflow',
        version: '1.0.0'
      };

      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve(JSON.stringify(maliciousWorkflow));
      });

      // The ID will be sanitized to _________malicious which won't match the original
      // InvalidWorkflowError is wrapped in StorageError when propagating up
      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
    });
  });

  describe('Plugin Detection and Loading', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: [testPluginPath],
        maxPlugins: 10
      });
    });

    it('should detect workrail workflow plugins correctly', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve([
            'workrail-workflows-coding',
            '@workrail/workflows-ai',
            'regular-package',
            'workrail-other-package'
          ]);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['workflow.json']);
        }
        return Promise.resolve([]);
      });

      const mockPackageJson = {
        name: 'workrail-workflows-coding',
        version: '1.0.0',
        workrail: { workflows: true }
      };

      const mockWorkflow = { id: 'test', name: 'Test', version: '1.0.0', steps: [] };

      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.includes('workrail-workflows-coding') && pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        if (pathStr.includes('@workrail/workflows-ai') && pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify({
            ...mockPackageJson,
            name: '@workrail/workflows-ai'
          }));
        }
        if (pathStr.endsWith('.json')) {
          return Promise.resolve(JSON.stringify(mockWorkflow));
        }
        return Promise.resolve('[]');
      });

      await storage.loadAllWorkflows();
      
      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringContaining('workrail-workflows-coding'),
        'utf-8'
      );
    });

    it('should handle invalid package.json gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue(['workrail-workflows-invalid']);
      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockResolvedValue('invalid json content');

      // InvalidWorkflowError is wrapped in StorageError when propagating up
      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
    });

    it('should ignore plugins without workrail.workflows flag', async () => {
      const mockPackageJson = {
        name: 'workrail-workflows-test',
        version: '1.0.0'
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue(['workrail-workflows-test']);
      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));

      const workflows = await storage.loadAllWorkflows();
      expect(workflows).toEqual([]);
    });

    it('should validate package name format', async () => {
      const mockPackageJson = {
        version: '1.0.0',
        workrail: { workflows: true }
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue(['workrail-workflows-test']);
      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));

      // InvalidWorkflowError is wrapped in StorageError when propagating up
      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
    });
  });

  describe('Workflow Loading and Validation', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: [testPluginPath]
      });
    });

    it('should successfully load valid workflows', async () => {
      const mockDefinition: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '1.0.0',
        steps: []
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['test-workflow.json']);
        }
        return Promise.resolve([]);
      });

      const mockPackageJson = {
        name: 'workrail-workflows-test',
        version: '1.0.0',
        workrail: { workflows: true },
        author: 'Test Author',
        description: 'Test plugin'
      };

      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        if (pathStr.endsWith('test-workflow.json')) {
          return Promise.resolve(JSON.stringify(mockDefinition));
        }
        return Promise.resolve('[]');
      });

      // Mock sanitizeId to return unchanged for valid IDs
      mockSecurity.sanitizeId.mockImplementation((id: string) => id);

      const workflows = await storage.loadAllWorkflows();
      expect(workflows).toEqual([
        createWorkflow(mockDefinition, createPluginSource('workrail-workflows-test', '1.0.0'))
      ]);
    });

    it('should find workflow by ID correctly', async () => {
      const mockDefinition: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '1.0.0',
        steps: []
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['test-workflow.json']);
        }
        return Promise.resolve([]);
      });

      const mockPackageJson = {
        name: 'workrail-workflows-test',
        version: '1.0.0',
        workrail: { workflows: true }
      };

      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve(JSON.stringify(mockDefinition));
      });

      // Mock sanitizeId to return unchanged for valid IDs
      mockSecurity.sanitizeId.mockImplementation((id: string) => id);

      const found = await storage.getWorkflowById('test-workflow');
      expect(found).toEqual(
        createWorkflow(mockDefinition, createPluginSource('workrail-workflows-test', '1.0.0'))
      );

      const notFound = await storage.getWorkflowById('nonexistent');
      expect(notFound).toBeNull();
    });

    it('should handle invalid workflow JSON gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['invalid.json']);
        }
        return Promise.resolve([]);
      });

      const mockPackageJson = {
        name: 'workrail-workflows-test',
        version: '1.0.0',
        workrail: { workflows: true }
      };

      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve('invalid json content');
      });

      // InvalidWorkflowError is wrapped in StorageError when propagating up
      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: [testPluginPath]
      });
    });

    it('should handle directory access errors gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockRejectedValue(new Error('Permission denied'));

      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
    });

    it('should throw error for save operations', async () => {
      await expect(storage.save()).rejects.toThrow(StorageError);
    });

    it('should handle file system errors during loading', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        return Promise.resolve([]);
      });

      mockFs.stat.mockRejectedValue(new Error('File system error'));

      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
    });
  });

  describe('Caching and Performance', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: [testPluginPath],
        scanInterval: 60000
      });
    });

    it('should respect scan interval for caching', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue([]);

      await storage.loadAllWorkflows();
      expect(mockFs.readdir).toHaveBeenCalledTimes(1);

      await storage.loadAllWorkflows();
      expect(mockFs.readdir).toHaveBeenCalledTimes(1);

      const originalDateNow = Date.now;
      Date.now = vi.fn(() => originalDateNow() + 70000);

      await storage.loadAllWorkflows();
      expect(mockFs.readdir).toHaveBeenCalledTimes(2);

      Date.now = originalDateNow;
    });

    it('should provide access to loaded plugins', async () => {
      const mockPackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        workrail: { workflows: true },
        author: 'Test Author'
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: any) => {
        const pathStr = String(dirPath);
        if (pathStr === testPluginPath) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['workflow.json']);
        }
        return Promise.resolve([]);
      });

      mockFs.stat.mockResolvedValue({ size: 1000 });
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = String(filePath);
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve(JSON.stringify({ id: 'test', name: 'Test', version: '1.0.0', steps: [] }));
      });

      // Mock sanitizeId to return unchanged for valid IDs
      mockSecurity.sanitizeId.mockImplementation((id: string) => id);

      await storage.loadAllWorkflows();
      
      const plugins = storage.getLoadedPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]!.name).toBe('test-plugin');
      expect(plugins[0]!.metadata?.author).toBe('Test Author');
    });
  });
});
