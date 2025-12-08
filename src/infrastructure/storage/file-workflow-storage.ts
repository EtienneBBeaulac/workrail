/**
 * File-Based Workflow Provider
 * 
 * Loads workflows from filesystem with intelligent caching and indexing.
 * 
 * Philosophy:
 * - Result-based (no exceptions in main paths)
 * - Zod validation at boundaries (file → memory)
 * - Immutable workflows (Object.freeze)
 * - Graceful degradation (skip invalid files, warn)
 */

import fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { Result, ok, err } from 'neverthrow';
import type { WorkflowId, Workflow } from '../../types/schemas.js';
import { WorkflowSchema } from '../../types/schemas.js';
import type { IWorkflowProvider } from '../../types/repository.js';
import type { AppError } from '../../core/errors/index.js';
import { Err } from '../../core/errors/index.js';
import { validateJSONLoad } from '../../core/errors/index.js';
import { IFeatureFlagProvider, createFeatureFlagProvider } from '../../config/feature-flags.js';
import type { Logger } from '../../core/logging/index.js';

interface FileWorkflowProviderOptions {
  maxFileSizeBytes?: number;
  featureFlagProvider?: IFeatureFlagProvider;
  logger?: Logger;
}

interface WorkflowIndexEntry {
  id: WorkflowId;
  filename: string;
  lastModified: number;
}

/**
 * File-based workflow provider with indexing and caching.
 */
export class FileWorkflowProvider implements IWorkflowProvider {
  private readonly baseDirReal: string;
  private readonly maxFileSize: number;
  private readonly featureFlags: IFeatureFlagProvider;
  private readonly logger?: Logger;
  
  // Index cache (avoid expensive directory scans)
  private workflowIndex: Map<any, WorkflowIndexEntry> | null = null;  // TODO: WorkflowId key
  private indexExpires: number = 0;
  private readonly INDEX_CACHE_TTL = 60000; // 1 minute

  constructor(directory: string, options: FileWorkflowProviderOptions = {}) {
    this.baseDirReal = path.resolve(directory);
    this.maxFileSize = options.maxFileSizeBytes ?? 1_000_000;
    this.featureFlags = options.featureFlagProvider ?? createFeatureFlagProvider();
    this.logger = options.logger;
  }

  async fetchAll(): Promise<Result<readonly Workflow[], AppError>> {
    try {
      // Build/refresh index
      const index = await this.getWorkflowIndex();
      
      // Load all workflows (parallel)
      const results = await Promise.allSettled(
        Array.from(index.values()).map(entry => this.loadWorkflowFromFile(entry.filename))
      );
      
      // Collect successes (graceful degradation - skip failures)
      const workflows = results
        .filter((r): r is PromiseFulfilledResult<Workflow | null> => r.status === 'fulfilled')
        .map(r => r.value)
        .filter((wf): wf is Workflow => wf !== null);
      
      return ok(workflows);
    } catch (error) {
      return err(Err.unexpectedError('fetchAll', error as Error));
    }
  }

  async fetchById(id: WorkflowId): Promise<Result<Workflow, AppError>> {
    // Get index
    const index = await this.getWorkflowIndex();
    const entry = index.get(id as any);  // TODO: fix typing
    
    if (!entry) {
      // Not found - find similar for suggestions
      const allIds = Array.from(index.keys()).map(k => k as any as string);
      const suggestions = this.findSimilar(id as any as string, allIds);
      return err(Err.workflowNotFound(id as any as string, suggestions, allIds.length, []));
    }
    
    // Load workflow
    const workflow = await this.loadWorkflowFromFile(entry.filename);
    if (!workflow) {
      return err(Err.unexpectedError('load workflow', new Error('File load returned null')));
    }
    
    // Verify ID matches (security)
    if (workflow.id !== id) {
      return err(Err.schemaViolation(entry.filename, `id=${id}`, `id=${workflow.id}`));
    }
    
    return ok(workflow);
  }
  
  // ===========================================================================
  // Private: Index Management
  // ===========================================================================
  
  private async getWorkflowIndex(): Promise<Map<any, WorkflowIndexEntry>> {
    const now = Date.now();
    
    if (this.workflowIndex && this.indexExpires > now) {
      return this.workflowIndex;
    }
    
    // Rebuild index
    this.workflowIndex = await this.buildWorkflowIndex();
    this.indexExpires = now + this.INDEX_CACHE_TTL;
    
    return this.workflowIndex;
  }
  
  private async buildWorkflowIndex(): Promise<Map<any, WorkflowIndexEntry>> {
    const allFiles = await this.findJsonFiles(this.baseDirReal);
    const index = new Map<any, WorkflowIndexEntry>();
    const idToFiles = new Map<string, string[]>();
    
    // First pass: Map IDs to files
    for (const file of allFiles) {
      try {
        // Security check
        const filePath = path.resolve(this.baseDirReal, file);
        this.assertWithinBase(filePath);
        
        // Size check
        const stats = statSync(filePath);
        if (stats.size > this.maxFileSize) continue;
        
        // Read and parse
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        
        if (!parsed.id) continue;
        
        const files = idToFiles.get(parsed.id) || [];
        files.push(file);
        idToFiles.set(parsed.id, files);
      } catch {
        continue;  // Skip invalid files
      }
    }
    
    // Second pass: Select file per ID (agentic override logic)
    for (const [id, files] of idToFiles) {
      let selectedFile = files[0]!;
      
      if (this.featureFlags.isEnabled('agenticRoutines')) {
        const agenticFile = files.find(f => f.includes('.agentic.'));
        if (agenticFile) selectedFile = agenticFile;
      } else {
        const standardFile = files.find(f => !f.includes('.agentic.'));
        if (standardFile) selectedFile = standardFile;
      }
      
      // Load and validate for index
      const filePath = path.resolve(this.baseDirReal, selectedFile);
      const stats = statSync(filePath);
      const raw = await fs.readFile(filePath, 'utf-8');
      
      // Validate with Zod
      const validated = validateJSONLoad(WorkflowSchema, JSON.parse(raw), filePath);
      if (!validated.isOk()) continue;  // Skip invalid
      
      index.set(validated.value.id as any, {  // TODO: fix typing
        id: validated.value.id as any,  // TODO: fix typing
        filename: selectedFile,
        lastModified: stats.mtimeMs,
      });
    }
    
    return index;
  }
  
  private async findJsonFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    const scan = async (currentDir: string) => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          if (entry.name === 'examples') continue;  // Skip examples
          await scan(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          files.push(fullPath);
        }
      }
    };
    
    await scan(dir);
    return files;
  }
  
  // ===========================================================================
  // Private: File Loading
  // ===========================================================================
  
  private async loadWorkflowFromFile(filename: string): Promise<Workflow | null> {
    try {
      const filePath = path.resolve(this.baseDirReal, filename);
      this.assertWithinBase(filePath);
      
      // Size check
      const stats = statSync(filePath);
      if (stats.size > this.maxFileSize) {
        this.logger?.warn({ file: filename }, 'File exceeds size limit');
        return null;
      }
      
      // Read
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      
      // Validate with Zod
      const validated = validateJSONLoad(WorkflowSchema, parsed, filePath);
      if (!validated.isOk()) {
        this.logger?.warn({ file: filename, err: validated.error }, 'Invalid workflow schema');
        return null;
      }
      
      return validated.value;  // Already immutable from Zod
    } catch (error) {
      this.logger?.warn({ err: error, filename }, 'Failed to load workflow');
      return null;
    }
  }
  
  // ===========================================================================
  // Private: Security & Fuzzy Matching
  // ===========================================================================
  
  private assertWithinBase(resolvedPath: string): void {
    if (!resolvedPath.startsWith(this.baseDirReal + path.sep) && resolvedPath !== this.baseDirReal) {
      throw new Error('Path escapes storage sandbox');
    }
  }
  
  private findSimilar(target: string, candidates: string[]): string[] {
    const targetLower = target.toLowerCase();
    return candidates
      .filter(c => {
        const cLower = c.toLowerCase();
        return cLower.includes(targetLower) || targetLower.includes(cLower);
      })
      .slice(0, 3);
  }
}

// Alias for backward compat
export const FileWorkflowStorage = FileWorkflowProvider;

export function createDefaultFileWorkflowStorage(): FileWorkflowProvider {
  const DEFAULT_WORKFLOW_DIR = path.resolve(__dirname, '../../../workflows');
  const envPath = process.env['WORKFLOW_STORAGE_PATH'];
  const resolved = envPath ? path.resolve(envPath) : null;
  const directory = resolved && existsSync(resolved) ? resolved : DEFAULT_WORKFLOW_DIR;
  
  return new FileWorkflowProvider(directory);
}
