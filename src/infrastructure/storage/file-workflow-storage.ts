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
import { validateWorkflowIdForSave } from '../../domain/workflow-id-policy';
import { assertWithinBase as assertWithinBaseSafe } from '../../utils/storage-security';
import { selectVariant, type VariantCandidate } from './workflow-resolution';
import { findWorkflowJsonFiles } from '../../application/use-cases/raw-workflow-file-scanner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeId(id: string): string {
  if (id.includes('\u0000')) {
    throw new SecurityError('Null byte detected in identifier', 'sanitizeId');
  }

  const normalised = id.normalize('NFC');
  // Allow dotted workflow IDs for v2 namespaced IDs (namespace.name).
  // Still disallow path separators and other unsafe characters.
  const valid = /^[a-zA-Z0-9_.-]+$/.test(normalised);
  if (!valid) {
    throw new InvalidWorkflowError(id, 'Invalid characters in workflow id');
  }
  return normalised;
}

function assertWithinBase(resolvedPath: string, baseDir: string): void {
  assertWithinBaseSafe(resolvedPath, baseDir);
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
   * Build or refresh the workflow index by scanning the directory recursively.
   * Uses the shared findWorkflowJsonFiles() — same function the raw file scanner uses.
   */
  private async buildWorkflowIndex(): Promise<Map<string, WorkflowIndexEntry>> {
    const allJsonFiles = await findWorkflowJsonFiles(this.baseDirReal);
    
    // Filter files relative to baseDir for processing
    const relativeFiles = allJsonFiles.map(f => path.relative(this.baseDirReal, f));
    
    const index = new Map<string, WorkflowIndexEntry>();

    // First pass: Create map of ID -> Filename to detect overrides
    const idToFiles = new Map<string, { file: string; definition: WorkflowDefinition }[]>();

    // Scan all files first to map IDs
    for (const file of relativeFiles) {
      try {
        // Skip routines if agentic features are disabled
        if (!this.featureFlags.isEnabled('agenticRoutines')) {
          const normalizedFile = file.replace(/\\/g, '/');
          if (normalizedFile.includes('routines/') || path.basename(file).startsWith('routine-')) {
            continue;
          }
        }
        // Skip lean workflow variants unless lean workflows are enabled.
        if (!this.featureFlags.isEnabled('leanWorkflows') && file.includes('.lean.')) {
          continue;
        }
        // Skip v2-only workflow variants unless v2 tools are enabled.
        if (!this.featureFlags.isEnabled('v2Tools') && file.includes('.v2.')) {
          continue;
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

    // Second pass: Select correct variant for each ID using the shared pure function.
    // This is the SAME function the registry validator uses — single source of truth.
    const flags = {
      v2Tools: this.featureFlags.isEnabled('v2Tools'),
      agenticRoutines: this.featureFlags.isEnabled('agenticRoutines'),
      leanWorkflows: this.featureFlags.isEnabled('leanWorkflows'),
    };

    for (const [id, files] of idToFiles) {
      // Build variant candidates from file entries
      const candidates: VariantCandidate[] = files.map(f => ({
        variantKind: f.file.includes('.lean.') ? 'lean' as const
                   : f.file.includes('.v2.') ? 'v2' as const
                   : f.file.includes('.agentic.') ? 'agentic' as const
                   : 'standard' as const,
        identifier: f.file,
      }));

      const selection = selectVariant(candidates, flags);
      const selected = files.find(f => f.file === selection.selectedIdentifier) ?? files[0]!;

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

    // v2 lock: saving new workflows requires namespaced IDs; legacy IDs remain loadable.
    validateWorkflowIdForSave(definition.id, this.source.kind);

    const safeId = sanitizeId(definition.id);

    // NOTE: this storage uses the workflow id as filename stem.
    // This must remain delimiter-safe and OS-portable.
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
