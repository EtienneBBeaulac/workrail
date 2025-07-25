import { PluginWorkflowStorage, PLUGIN_WORKFLOW_CONFIGS } from '../../src/infrastructure/storage/plugin-workflow-storage';
import { StorageError, InvalidWorkflowError, SecurityError } from '../../src/core/error-handler';
import { Workflow } from '../../src/types/mcp-types';
import fs from 'fs/promises';
import { existsSync, Dirent, PathLike } from 'fs';
import path from 'path';

// Helper function to create mock Dirent objects
function createMockDirent(name: string, isDirectory = true): any {
  return {
    name,
    isFile: () => !isDirectory,
    isDirectory: () => isDirectory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false
  };
}

// Mock dependencies
jest.mock('fs/promises');
jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

describe('PluginWorkflowStorage', () => {
  let storage: PluginWorkflowStorage;
  let mockPluginPath: string;
  let mockWorkflowsPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPluginPath = '/test/node_modules/workrail-workflows-test';
    mockWorkflowsPath = path.join(mockPluginPath, 'workflows');
    
    // Default mock behavior
    mockExistsSync.mockReturnValue(true);
    mockFs.readdir.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('Configuration and Initialization', () => {
    it('should initialize with default configuration', () => {
      storage = new PluginWorkflowStorage();
      const config = storage.getConfig();
      
      expect(config.scanInterval).toBeGreaterThanOrEqual(30000);
      expect(config.maxFileSize).toBe(1024 * 1024); // 1MB
      expect(config.maxFiles).toBe(50);
      expect(config.maxPlugins).toBe(20);
      expect(config.pluginPaths).toEqual(expect.arrayContaining([
        expect.stringContaining('node_modules')
      ]));
    });

    it('should accept custom configuration', () => {
      const customConfig = {
        pluginPaths: ['/custom/path'],
        scanInterval: 60000,
        maxFileSize: 2 * 1024 * 1024,
        maxFiles: 100,
        maxPlugins: 50
      };

      storage = new PluginWorkflowStorage(customConfig);
      const config = storage.getConfig();
      
      expect(config.pluginPaths).toEqual(['/custom/path']);
      expect(config.scanInterval).toBe(60000);
      expect(config.maxFileSize).toBe(2 * 1024 * 1024);
      expect(config.maxFiles).toBe(100);
      expect(config.maxPlugins).toBe(50);
    });

    it('should enforce minimum configuration values', () => {
      const invalidConfig = {
        scanInterval: 10000, // below minimum
        maxFiles: 0, // below minimum
        maxPlugins: 0 // below minimum
      };

      storage = new PluginWorkflowStorage(invalidConfig);
      const config = storage.getConfig();
      
      expect(config.scanInterval).toBe(30000); // enforced minimum
      expect(config.maxFiles).toBe(1); // enforced minimum
      expect(config.maxPlugins).toBe(1); // enforced minimum
    });

    it('should use predefined configurations correctly', () => {
      expect(PLUGIN_WORKFLOW_CONFIGS.development.scanInterval).toBe(60000);
      expect(PLUGIN_WORKFLOW_CONFIGS.production.maxFileSize).toBe(1024 * 1024);
    });
  });

  describe('Security Features', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: ['/test/node_modules'],
        maxFileSize: 1024 * 1024,
        maxFiles: 5,
        maxPlugins: 3
      });
    });

    it('should prevent scanning too many plugins', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue([
        createMockDirent('workrail-workflows-plugin1'),
        createMockDirent('workrail-workflows-plugin2'), 
        createMockDirent('workrail-workflows-plugin3'),
        createMockDirent('workrail-workflows-plugin4') // exceeds limit of 3
      ]);

      // Mock plugin loading to simulate finding valid plugins
      const mockPackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        workrail: { workflows: true }
      };
      
      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockImplementation(((filePath: any) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve('[]');
      }) as any);

      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/Too many plugins found/);
    });

    it('should validate file sizes during scanning', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation(((dirPath: any) => {
        const pathStr = dirPath.toString();
        if (pathStr.endsWith('node_modules')) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['test-workflow.json']);
        }
        return Promise.resolve([]);
      }) as any);

      const mockPackageJson = {
        name: 'test-plugin',
        version: '1.0.0', 
        workrail: { workflows: true }
      };

      mockFs.stat.mockImplementation(((filePath: any) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve({ size: 1000 } as any);
        }
        // Oversized workflow file
        return Promise.resolve({ size: 2 * 1024 * 1024 } as any); // 2MB, exceeds 1MB limit
      }) as any);

      mockFs.readFile.mockImplementation(((filePath: any) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve('{"id": "test", "name": "Test"}');
      }) as any);

      await expect(storage.loadAllWorkflows()).rejects.toThrow(SecurityError);
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/exceeds size limit/);
    });

    it('should validate workflow file counts', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation(((dirPath: any) => {
        const pathStr = dirPath.toString();
        if (pathStr.endsWith('node_modules')) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          // Return more files than the limit of 5
          return Promise.resolve([
            'workflow1.json', 'workflow2.json', 'workflow3.json',
            'workflow4.json', 'workflow5.json', 'workflow6.json'
          ]);
        }
        return Promise.resolve([]);
      }) as any);

      const mockPackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        workrail: { workflows: true }
      };

      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockImplementation(((filePath: any) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve('{"id": "test", "name": "Test"}');
      }) as any);

      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/Too many workflow files/);
    });

    it('should validate package.json size limits', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue([createMockDirent('workrail-workflows-test')]);

      // Oversized package.json (over 64KB limit)
      mockFs.stat.mockImplementation(((filePath: any) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve({ size: 128 * 1024 } as any); // 128KB
        }
        return Promise.resolve({ size: 1000 } as any);
      }) as any);

      await expect(storage.loadAllWorkflows()).rejects.toThrow(SecurityError);
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/exceeds size limit/);
    });

    it('should validate workflow IDs for security', async () => {
      const maliciousWorkflow = {
        id: '../../../malicious', // path traversal attempt
        name: 'Malicious Workflow',
        version: '1.0.0'
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation(((dirPath: any) => {
        const pathStr = dirPath.toString();
        if (pathStr.endsWith('node_modules')) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        if (pathStr.endsWith('workflows')) {
          return Promise.resolve(['malicious.json']);
        }
        return Promise.resolve([]);
      }) as any);

      const mockPackageJson = {
        name: 'test-plugin',
        version: '1.0.0',
        workrail: { workflows: true }
      };

      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockImplementation(((filePath: any) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve(JSON.stringify(maliciousWorkflow));
      }) as any);

      await expect(storage.loadAllWorkflows()).rejects.toThrow(InvalidWorkflowError);
    });
  });

  describe('Plugin Detection and Loading', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: ['/test/node_modules'],
        maxPlugins: 10
      });
    });

    it('should detect workrail workflow plugins correctly', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue([
        createMockDirent('workrail-workflows-coding'), // should be detected
        createMockDirent('@workrail/workflows-ai'), // should be detected
        createMockDirent('regular-package'), // should be ignored
        createMockDirent('workrail-other-package') // should be ignored
      ]);

      const mockPackageJson = {
        name: 'workrail-workflows-coding',
        version: '1.0.0',
        workrail: { workflows: true }
      };

      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockImplementation((filePath: any) => {
        const pathStr = filePath.toString();
        if (pathStr.includes('workrail-workflows-coding') && pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        if (pathStr.includes('@workrail/workflows-ai') && pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify({
            ...mockPackageJson,
            name: '@workrail/workflows-ai'
          }));
        }
        return Promise.resolve('[]');
      });

      const plugins = storage.getLoadedPlugins();
      // Should only process the 2 workrail workflow packages
      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringContaining('workrail-workflows-coding'),
        'utf-8'
      );
    });

    it('should handle invalid package.json gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue([createMockDirent('workrail-workflows-invalid')]);

      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockResolvedValue('invalid json content');

      await expect(storage.loadAllWorkflows()).rejects.toThrow(InvalidWorkflowError);
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/Invalid package.json/);
    });

    it('should ignore plugins without workrail.workflows flag', async () => {
      const mockPackageJson = {
        name: 'workrail-workflows-test',
        version: '1.0.0'
        // missing workrail.workflows flag
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue([createMockDirent('workrail-workflows-test')]);
      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));

      const workflows = await storage.loadAllWorkflows();
      expect(workflows).toEqual([]);
    });

    it('should validate package name format', async () => {
      const mockPackageJson = {
        // missing name field
        version: '1.0.0',
        workrail: { workflows: true }
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue([createMockDirent('workrail-workflows-test')]);
      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));

      await expect(storage.loadAllWorkflows()).rejects.toThrow(InvalidWorkflowError);
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/Invalid package name/);
    });
  });

  describe('Workflow Loading and Validation', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: ['/test/node_modules']
      });
    });

    it('should successfully load valid workflows', async () => {
      const mockWorkflow: Workflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '1.0.0',
        steps: []
      };

      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: fs.PathLike) => {
        const pathStr = dirPath.toString();
        if (pathStr.endsWith('node_modules')) {
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

      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockImplementation((filePath: fs.PathLike | fs.FileHandle) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        if (pathStr.endsWith('test-workflow.json')) {
          return Promise.resolve(JSON.stringify(mockWorkflow));
        }
        return Promise.resolve('[]');
      });

      const workflows = await storage.loadAllWorkflows();
      expect(workflows).toEqual([mockWorkflow]);

      const summaries = await storage.listWorkflowSummaries();
      expect(summaries).toEqual([{
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        category: 'plugin',
        version: '1.0.0'
      }]);
    });

    it('should find workflow by ID correctly', async () => {
      const mockWorkflow: Workflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '1.0.0',
        steps: []
      };

      // Setup successful workflow loading
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: fs.PathLike) => {
        const pathStr = dirPath.toString();
        if (pathStr.endsWith('node_modules')) {
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

      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockImplementation((filePath: fs.PathLike | fs.FileHandle) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve(JSON.stringify(mockWorkflow));
      });

      const found = await storage.getWorkflowById('test-workflow');
      expect(found).toEqual(mockWorkflow);

      const notFound = await storage.getWorkflowById('nonexistent');
      expect(notFound).toBeNull();
    });

    it('should handle invalid workflow JSON gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: fs.PathLike) => {
        const pathStr = dirPath.toString();
        if (pathStr.endsWith('node_modules')) {
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

      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockImplementation((filePath: fs.PathLike | fs.FileHandle) => {
        const pathStr = filePath.toString();
        if (pathStr.endsWith('package.json')) {
          return Promise.resolve(JSON.stringify(mockPackageJson));
        }
        return Promise.resolve('invalid json content');
      });

      await expect(storage.loadAllWorkflows()).rejects.toThrow(InvalidWorkflowError);
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/Invalid JSON in workflow file/);
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      storage = new PluginWorkflowStorage({
        pluginPaths: ['/test/node_modules']
      });
    });

    it('should handle directory access errors gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockRejectedValue(new Error('Permission denied'));

      await expect(storage.loadAllWorkflows()).rejects.toThrow(StorageError);
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/Failed to scan plugin directory/);
    });

    it('should throw error for save operations', async () => {
      await expect(storage.save()).rejects.toThrow(StorageError);
      await expect(storage.save()).rejects.toThrow(/read-only/);
    });

    it('should handle file system errors during loading', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockImplementation((dirPath: fs.PathLike) => {
        const pathStr = dirPath.toString();
        if (pathStr.endsWith('node_modules')) {
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
        pluginPaths: ['/test/node_modules'],
        scanInterval: 60000 // 1 minute
      });
    });

    it('should respect scan interval for caching', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFs.readdir.mockResolvedValue([]);

      // First call should trigger scan
      await storage.loadAllWorkflows();
      expect(mockFs.readdir).toHaveBeenCalledTimes(1);

      // Second call within interval should use cache
      await storage.loadAllWorkflows();
      expect(mockFs.readdir).toHaveBeenCalledTimes(1); // No additional calls

      // Mock time passage
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => originalDateNow() + 70000); // 70 seconds later

      // Third call after interval should trigger new scan
      await storage.loadAllWorkflows();
      expect(mockFs.readdir).toHaveBeenCalledTimes(2);

      // Restore Date.now
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
      mockFs.readdir.mockImplementation((dirPath: fs.PathLike) => {
        const pathStr = dirPath.toString();
        if (pathStr.endsWith('node_modules')) {
          return Promise.resolve(['workrail-workflows-test']);
        }
        return Promise.resolve([]);
      });

      mockFs.stat.mockResolvedValue({ size: 1000 } as any);
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockPackageJson));

      await storage.loadAllWorkflows();
      
      const plugins = storage.getLoadedPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]!.name).toBe('test-plugin');
      expect(plugins[0]!.metadata?.author).toBe('Test Author');
    });
  });
}); 