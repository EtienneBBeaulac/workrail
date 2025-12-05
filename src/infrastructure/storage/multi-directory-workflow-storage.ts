import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { IWorkflowStorage } from '../../types/storage';
import { Workflow, WorkflowSummary } from '../../types/mcp-types';
import { FileWorkflowStorage } from './file-workflow-storage';

/**
 * Multi-directory workflow storage that loads workflows from multiple directories
 * and merges them together. Supports:
 * - Bundled workflows (always included)
 * - User-specific workflows (~/.workrail/workflows)
 * - Project-specific workflows (./workflows or custom path)
 * - Multiple custom directories (colon-separated paths)
 */
export class MultiDirectoryWorkflowStorage implements IWorkflowStorage {
  private storageInstances: FileWorkflowStorage[] = [];

  constructor(options: MultiDirectoryOptions = {}) {
    const directories = this.resolveDirectories(options);
    
    // Create storage instances for each valid directory
    this.storageInstances = directories.map(dir => 
      new FileWorkflowStorage(dir, options.fileStorageOptions)
    );
  }

  private resolveDirectories(options: MultiDirectoryOptions): string[] {
    const directories: string[] = [];
    
    // 1. Always include bundled workflows (unless explicitly disabled)
    if (!options.excludeBundled) {
      // Prefer source workflows when running in workspace; fallback to dist
      const bundledSrcDir = path.resolve(__dirname, '../../../../workflows');
      const bundledDistDir = path.resolve(__dirname, '../../../workflows');
      if (existsSync(bundledSrcDir)) {
        directories.push(bundledSrcDir);
      } else if (existsSync(bundledDistDir)) {
        directories.push(bundledDistDir);
      }
    }
    
    // 2. User-specific workflows directory
    if (!options.excludeUser) {
      const userDir = path.join(os.homedir(), '.workrail', 'workflows');
      if (existsSync(userDir)) {
        directories.push(userDir);
      }
    }
    
    // 3. Project-specific workflows
    if (!options.excludeProject) {
      const projectDir = path.resolve(process.cwd(), 'workflows');
      if (existsSync(projectDir)) {
        directories.push(projectDir);
      }
    }
    
    // 4. Custom directories from environment variable
    const envPaths = process.env['WORKFLOW_STORAGE_PATH'];
    if (envPaths) {
      const customDirs = envPaths.split(path.delimiter)
        .map(dir => path.resolve(dir.trim()))
        .filter(dir => existsSync(dir));
      directories.push(...customDirs);
    }
    
    // 5. Additional custom directories
    if (options.additionalDirectories) {
      const additionalDirs = options.additionalDirectories
        .map(dir => path.resolve(dir))
        .filter(dir => existsSync(dir));
      directories.push(...additionalDirs);
    }
    
    // Remove duplicates while preserving order
    return [...new Set(directories)];
  }

  async loadAllWorkflows(): Promise<Workflow[]> {
    const allWorkflows: Workflow[] = [];
    const seenIds = new Set<string>();
    
    // Load from all directories, with later directories taking precedence
    for (const storage of this.storageInstances) {
      try {
        const workflows = await storage.loadAllWorkflows();
        
        // Add workflows, with later ones overriding earlier ones with same ID
        for (const workflow of workflows) {
          if (seenIds.has(workflow.id)) {
            // Replace existing workflow with same ID
            const existingIndex = allWorkflows.findIndex(wf => wf.id === workflow.id);
            if (existingIndex >= 0) {
              allWorkflows[existingIndex]! = workflow;
            }
          } else {
            allWorkflows.push(workflow);
            seenIds.add(workflow.id);
          }
        }
      } catch (error) {
        console.warn(`Failed to load workflows from storage:`, error);
      }
    }
    
    return allWorkflows;
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    // Search in reverse order (later directories take precedence)
    for (let i = this.storageInstances.length - 1; i >= 0; i--) {
      try {
        const storage = this.storageInstances[i];
        if (storage) {
          const workflow = await storage.getWorkflowById(id);
          if (workflow) {
            return workflow;
          }
        }
      } catch (error) {
        console.warn(`Failed to load workflow ${id} from storage:`, error);
      }
    }
    
    return null;
  }

  async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
    const workflows = await this.loadAllWorkflows();
    return workflows.map(workflow => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      category: 'default',
      version: workflow.version
    }));
  }

  async save?(_workflow: Workflow): Promise<void> {
    // Save to the first writable directory (usually user directory)
    for (const storage of this.storageInstances) {
      if (typeof storage.save === 'function') {
        try {
          await storage.save();
          return;
        } catch (error) {
          console.warn(`Failed to save workflow to storage:`, error);
        }
      }
    }
    
    throw new Error('No writable storage available');
  }

  /**
   * Get information about loaded directories
   */
  public getDirectoryInfo(): DirectoryInfo[] {
    return this.storageInstances.map((storage, index) => ({
      path: (storage as any).baseDirReal,
      index,
      type: this.getDirectoryType((storage as any).baseDirReal)
    }));
  }

  private getDirectoryType(dirPath: string): 'bundled' | 'user' | 'project' | 'custom' {
    if (dirPath.includes('/workflows') && dirPath.includes('dist')) {
      return 'bundled';
    }
    if (dirPath.includes('.workrail')) {
      return 'user';
    }
    if (dirPath.endsWith(path.join(process.cwd(), 'workflows'))) {
      return 'project';
    }
    return 'custom';
  }
}

export interface MultiDirectoryOptions {
  excludeBundled?: boolean;
  excludeUser?: boolean;
  excludeProject?: boolean;
  additionalDirectories?: string[];
  fileStorageOptions?: {
    maxFileSizeBytes?: number;
    cacheTTLms?: number;
    cacheSize?: number;
    indexCacheTTLms?: number;
  };
}

export interface DirectoryInfo {
  path: string;
  index: number;
  type: 'bundled' | 'user' | 'project' | 'custom';
}

/**
 * Create a multi-directory storage with sensible defaults
 */
export function createMultiDirectoryWorkflowStorage(options: MultiDirectoryOptions = {}): MultiDirectoryWorkflowStorage {
  return new MultiDirectoryWorkflowStorage({
    fileStorageOptions: {
      cacheTTLms: 10000,
      cacheSize: 200,
      indexCacheTTLms: 60000,
    },
    ...options
  });
}

/**
 * Initialize user workflow directory if it doesn't exist
 */
export async function initializeUserWorkflowDirectory(): Promise<string> {
  const userDir = path.join(os.homedir(), '.workrail', 'workflows');
  
  try {
    await fs.mkdir(userDir, { recursive: true });
    
    // Create a sample custom workflow if directory is empty
    const entries = await fs.readdir(userDir);
    if (entries.length === 0) {
      const sampleWorkflow = {
        id: 'my-custom-workflow',
        name: 'My Custom Workflow',
        description: 'A template for creating custom workflows',
        version: '1.0.0',
        steps: [
          {
            id: 'step-1',
            name: 'First Step',
            description: 'Replace this with your custom step',
            guidance: 'Add your specific instructions here'
          }
        ]
      };
      
      await fs.writeFile(
        path.join(userDir, 'my-custom-workflow.json'),
        JSON.stringify(sampleWorkflow, null, 2)
      );
    }
    
    return userDir;
  } catch (error) {
    console.warn('Failed to initialize user workflow directory:', error);
    throw error;
  }
} 