import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { IWorkflowStorage } from '../../types/storage';
import { 
  Workflow, 
  WorkflowSummary, 
  WorkflowDefinition,
  WorkflowSource,
  createWorkflow,
  toWorkflowSummary,
  createBundledSource
} from '../../types/workflow';
import {
  InvalidWorkflowError,
  SecurityError
} from '../../core/error-handler';
import { IFeatureFlagProvider, EnvironmentFeatureFlagProvider } from '../../config/feature-flags';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeId(id: string): string {
  if (id.includes('\u0000')) {
    throw new SecurityError('Null byte detected in identifier', 'sanitizeId');
  }

  const normalised = id.normalize('NFC');
  const valid = /^[a-zA-Z0-9_-]+$/.test(normalised);
  if (!valid) {
    throw new InvalidWorkflowError(id, 'Invalid characters in workflow id');
  }
  return normalised;
}

function assertWithinBase(resolvedPath: string, baseDir: string): void {
  if (!resolvedPath.startsWith(baseDir + path.sep) && resolvedPath !== baseDir) {
    throw new SecurityError('Path escapes storage sandbox', 'file-access');
  }
}

interface CacheEntry {
  workflow: Workflow;
  expires: number;
}

interface WorkflowIndexEntry {
  id: string;
  filename: string;
  definition: WorkflowDefinition;
  lastModified: number;
}

interface FileWorkflowStorageOptions {
  /** Reject files larger than this size (bytes). Default 1_000_000 */
  maxFileSizeBytes?: number;
  /** Cache entry TTL in milliseconds. 0 to disable. Default 5000 */
  cacheTTLms?: number;
  /** Maximum cached workflows before evicting LRU. Default 100 */
  cacheSize?: number;
  /** Index cache TTL in milliseconds. Default 30000 (30 seconds) */
  indexCacheTTLms?: number;
  /** Feature flag provider (required) */
  featureFlagProvider: IFeatureFlagProvider;
}

/**
 * Optimized file-system based workflow storage with intelligent caching.
 * Uses an index cache to avoid repeatedly scanning directories and 
 * reading files unnecessarily.
 * 
 * Each instance is bound to a single WorkflowSource, injected at construction.
 */
export class FileWorkflowStorage implements IWorkflowStorage {
  public readonly kind = 'single' as const;
  public readonly source: WorkflowSource;
  
  private readonly baseDirReal: string;
  private readonly maxFileSize: number;
  private readonly cacheTTL: number;
  private readonly cacheLimit: number;
  private readonly indexCacheTTL: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly featureFlags: IFeatureFlagProvider;
  
  // Index cache to avoid expensive directory scans
  private workflowIndex: Map<string, WorkflowIndexEntry> | null = null;
  private indexExpires: number = 0;

  constructor(
    directory: string, 
    source: WorkflowSource,
    featureFlagProvider: IFeatureFlagProvider,
    options: Omit<FileWorkflowStorageOptions, 'featureFlagProvider'> = {}
  ) {
    this.source = source;
    this.baseDirReal = path.resolve(directory);
    this.maxFileSize = options.maxFileSizeBytes ?? 1_000_000; // 1 MB default
    this.cacheTTL = options.cacheTTLms ?? 5000;
    this.cacheLimit = options.cacheSize ?? 100;
    this.indexCacheTTL = options.indexCacheTTLms ?? 30000; // 30 seconds
    this.featureFlags = featureFlagProvider;
  }

  /**
   * Recursively find all JSON files in a directory
   */
  private async findJsonFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    async function scan(currentDir: string) {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          // Skip examples directory
          if (entry.name === 'examples') {
            continue;
          }
          await scan(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          files.push(fullPath);
        }
      }
    }
    
    await scan(dir);
    return files;
  }

  /**
   * Build or refresh the workflow index by scanning the directory recursively
   */
  private async buildWorkflowIndex(): Promise<Map<string, WorkflowIndexEntry>> {
    const allJsonFiles = await this.findJsonFiles(this.baseDirReal);
    
    // Filter files relative to baseDir for processing
    const relativeFiles = allJsonFiles.map(f => path.relative(this.baseDirReal, f));
    
    const index = new Map<string, WorkflowIndexEntry>();

    // First pass: Create map of ID -> Filename to detect overrides
    const idToFiles = new Map<string, { file: string; definition: WorkflowDefinition }[]>();

    // Scan all files first to map IDs
    for (const file of relativeFiles) {
      try {
        // Skip agentic routines if flag is disabled
        if (!this.featureFlags.isEnabled('agenticRoutines')) {
          if (file.includes('routines/') || path.basename(file).startsWith('routine-')) {
            continue;
          }
        }

        const filePathRaw = path.resolve(this.baseDirReal, file);
        assertWithinBase(filePathRaw, this.baseDirReal);

        const stats = statSync(filePathRaw);
        if (stats.size > this.maxFileSize) continue;

        const raw = await fs.readFile(filePathRaw, 'utf-8');
        const definition = JSON.parse(raw) as WorkflowDefinition;
        if (!definition.id) continue;

        const files = idToFiles.get(definition.id) || [];
        files.push({ file, definition });
        idToFiles.set(definition.id, files);
      } catch {
        continue;
      }
    }

    // Second pass: Select correct file for each ID
    for (const [id, files] of idToFiles) {
      let selected = files[0]!;

      // Agentic Override Logic
      if (this.featureFlags.isEnabled('agenticRoutines')) {
        const agenticEntry = files.find(f => f.file.includes('.agentic.'));
        if (agenticEntry) {
          selected = agenticEntry;
        }
      } else {
        // Ensure we DON'T pick the agentic file if flag is off
        const standardEntry = files.find(f => !f.file.includes('.agentic.'));
        if (standardEntry) {
          selected = standardEntry;
        }
      }

      // Add to index
      const filePath = path.resolve(this.baseDirReal, selected.file);
      const stats = statSync(filePath);
      
      index.set(id, {
        id: selected.definition.id,
        filename: selected.file,
        definition: selected.definition,
        lastModified: stats.mtimeMs,
      });
    }

    return index;
  }

  /**
   * Get the workflow index, building it if necessary
   */
  private async getWorkflowIndex(): Promise<Map<string, WorkflowIndexEntry>> {
    const now = Date.now();
    
    if (this.workflowIndex && this.indexExpires > now) {
      return this.workflowIndex;
    }

    // Rebuild index
    this.workflowIndex = await this.buildWorkflowIndex();
    this.indexExpires = now + this.indexCacheTTL;
    
    return this.workflowIndex;
  }

  /**
   * Load a specific workflow definition from file
   */
  private async loadDefinitionFromFile(filename: string): Promise<WorkflowDefinition | null> {
    const filePath = path.resolve(this.baseDirReal, filename);
    assertWithinBase(filePath, this.baseDirReal);

    try {
      const stats = statSync(filePath);
      if (stats.size > this.maxFileSize) {
        throw new SecurityError('Workflow file exceeds size limit', 'file-size');
      }

      const raw = await fs.readFile(filePath, 'utf-8');
      const definition = JSON.parse(raw) as WorkflowDefinition;
      return definition;
    } catch (err) {
      console.warn(`[FileWorkflowStorage] Failed to load workflow from ${filename}:`, err);
      return null;
    }
  }

  /**
   * Load *all* workflows from the configured directory.
   * Returns Workflow objects with source attached.
   */
  public async loadAllWorkflows(): Promise<readonly Workflow[]> {
    const index = await this.getWorkflowIndex();
    const workflows: Workflow[] = [];

    // Use cached definitions from index when available
    for (const entry of index.values()) {
      const workflow = createWorkflow(entry.definition, this.source);
      workflows.push(workflow);
    }

    return workflows;
  }

  public async getWorkflowById(id: string): Promise<Workflow | null> {
    const safeId = sanitizeId(id);

    // Try cache first
    const cached = this.cache.get(safeId);
    if (cached && cached.expires > Date.now()) {
      return cached.workflow;
    }

    // Check index for the workflow
    const index = await this.getWorkflowIndex();
    const indexEntry = index.get(safeId);
    
    if (!indexEntry) {
      return null; // Workflow doesn't exist
    }

    // Use definition from index (already loaded)
    const definition = indexEntry.definition;

    // Verify ID matches (security check)
    if (definition.id !== safeId) {
      throw new InvalidWorkflowError(safeId, 'ID mismatch between index and workflow.id');
    }

    // Create workflow with source
    const workflow = createWorkflow(definition, this.source);

    // Cache the result
    if (this.cacheTTL > 0) {
      if (this.cache.size >= this.cacheLimit) {
        // Evict oldest (first inserted)
        const firstKey = this.cache.keys().next().value as string;
        this.cache.delete(firstKey);
      }
      this.cache.set(safeId, { workflow, expires: Date.now() + this.cacheTTL });
    }

    return workflow;
  }

  public async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    const workflows = await this.loadAllWorkflows();
    return workflows.map(toWorkflowSummary);
  }

  public async save(definition: WorkflowDefinition): Promise<void> {
    // Validate the definition has required fields
    if (!definition.id || !definition.name || !definition.steps) {
      throw new InvalidWorkflowError(
        definition.id || 'unknown',
        'Definition must have id, name, and steps'
      );
    }

    const safeId = sanitizeId(definition.id);
    const filename = `${safeId}.json`;
    const filePath = path.resolve(this.baseDirReal, filename);
    
    assertWithinBase(filePath, this.baseDirReal);

    const content = JSON.stringify(definition, null, 2);
    await fs.writeFile(filePath, content, 'utf-8');

    // Invalidate caches
    this.cache.delete(safeId);
    this.workflowIndex = null;
  }
}

/**
 * @deprecated Use DI container: container.resolve(DI.Storage.Primary)
 */
export function createDefaultFileWorkflowStorage(): never {
  throw new Error(
    'createDefaultFileWorkflowStorage() is removed. ' +
    'Use DI container: container.resolve(DI.Storage.Primary)'
  );
}
