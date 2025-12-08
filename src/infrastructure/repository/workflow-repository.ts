/**
 * Workflow Repository Implementation
 * 
 * CTC Pattern: Type-state + repository-owned persistence + caching.
 * 
 * Philosophy:
 * - Type-state: IRepositoryInitializer → IReadyRepository
 * - Ownership: Repository owns persistence (4 private methods)
 * - Ownership: Repository owns caching (no decorator needed)
 * - Simplicity: One file, clear responsibilities
 * - Immutability: All workflows frozen
 * - Result: No exceptions, explicit error handling
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Result, ok, err } from 'neverthrow';
import type {
  IRepositoryInitializer,
  IReadyRepository,
  IWorkflowProvider,
  PersistenceConfig,
} from '../../types/repository.js';
import type {
  WorkflowId,
  Workflow,
  WorkflowSummary,
  RepositorySnapshot,
  PersistedSnapshot,
  DataSource,
} from '../../types/schemas.js';
import {
  WorkflowSchema,
  PersistedSnapshotSchema,
  createSnapshot,
  getWorkflowsArray,
  getWorkflowIdsAsStrings,
} from '../../types/schemas.js';
import type {
  AppError,
  StartupFailedError,
  WorkflowNotFoundError,
} from '../../core/errors/index.js';
import { Err } from '../../core/errors/index.js';
import { validateJSONLoad } from '../../core/errors/index.js';
import type { Logger } from '../../core/logging/index.js';

// =============================================================================
// Repository Initializer (Type-State: Before Init)
// =============================================================================

/**
 * Repository initializer - can ONLY initialize, cannot query.
 * 
 * Owns:
 * - Persistence (4 private methods)
 * - Provider orchestration
 * - Graceful degradation logic
 */
export class RepositoryInitializer implements IRepositoryInitializer {
  constructor(
    private readonly provider: IWorkflowProvider,
    private readonly persistenceConfig: PersistenceConfig,
    private readonly logger: Logger
  ) {}
  
  async initialize(): Promise<Result<IReadyRepository, StartupFailedError>> {
    console.log('[RepositoryInitializer] initialize() called');
    
    // 1. Try load persisted snapshot
    console.log('[RepositoryInitializer] Loading persisted snapshot...');
    const persisted = await this.loadPersistedSnapshot();
    console.log('[RepositoryInitializer] Persisted snapshot:', persisted ? 'found' : 'not found');
    if (persisted && this.isFresh(persisted)) {
      this.logger.info('Using persisted snapshot (fresh)');
      console.log('[RepositoryInitializer] Using fresh persisted snapshot');
      return ok(new ReadyRepository(this.deserialize(persisted), this.logger));
    }
    
    // 2. Fetch from provider
    this.logger.info('Fetching from provider');
    console.log('[RepositoryInitializer] Fetching from provider...');
    const fetchResult = await this.fetchFromProvider();
    console.log('[RepositoryInitializer] Provider fetch result:', fetchResult.isOk() ? 'OK' : 'ERR');
    if (fetchResult.isOk()) {
      console.log('[RepositoryInitializer] Saving snapshot and returning ReadyRepository');
      await this.savePersistedSnapshot(fetchResult.value);
      return ok(new ReadyRepository(fetchResult.value, this.logger));
    }
    
    // 3. Graceful degradation - use stale snapshot
    if (persisted) {
      this.logger.warn({ age: Date.now() - persisted.timestamp }, 'Using stale snapshot (provider failed)');
      return ok(new ReadyRepository(this.deserialize(persisted), this.logger, true));
    }
    
    // 4. Total failure
    return err(Err.startupFailed(
      'repository',
      'No snapshot available and provider failed',
      fetchResult.error.cause
    ));
  }
  
  async refresh(): Promise<Result<IReadyRepository, StartupFailedError>> {
    // Always fetch fresh (ignore cache)
    this.logger.info('Refreshing from provider');
    const fetchResult = await this.fetchFromProvider();
    if (fetchResult.isOk()) {
      await this.savePersistedSnapshot(fetchResult.value);
      return ok(new ReadyRepository(fetchResult.value, this.logger));
    }
    
    return err(Err.startupFailed('refresh', 'Provider fetch failed', fetchResult.error.cause));
  }
  
  // ===========================================================================
  // Private: Persistence (Repository Owns This - CTC Pattern)
  // ===========================================================================
  
  private async loadPersistedSnapshot(): Promise<PersistedSnapshot | null> {
    if (!this.persistenceConfig.enabled) return null;
    
    try {
      const content = await fs.readFile(this.persistenceConfig.path, 'utf-8');
      const parsed = JSON.parse(content);
      
      // Zod validation (brands everything, deep validation)
      const validated = validateJSONLoad(PersistedSnapshotSchema, parsed, this.persistenceConfig.path);
      return validated.isOk() ? validated.value : null;
    } catch (error) {
      this.logger.debug({ err: error }, 'Failed to load persisted snapshot');
      return null;  // Treat errors as cache miss
    }
  }
  
  private async savePersistedSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    if (!this.persistenceConfig.enabled) return;
    
    // Atomic write: temp file + rename (POSIX atomic)
    const tempPath = `${this.persistenceConfig.path}.${process.pid}.${Date.now()}.tmp`;
    
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.persistenceConfig.path), { recursive: true });
      
      // Serialize snapshot
      // Brands lost during JSON.stringify, re-validated on load
      const persisted = JSON.parse(JSON.stringify({
        version: this.persistenceConfig.version,
        timestamp: Date.now(),
        workflows: getWorkflowsArray(snapshot),
      }));
      
      // Write to temp
      await fs.writeFile(tempPath, JSON.stringify(persisted, null, 2));
      
      // Atomic rename
      await fs.rename(tempPath, this.persistenceConfig.path);
      
      this.logger.debug('Snapshot persisted');
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to persist snapshot (best-effort)');
      // Best-effort - don't fail initialization if persistence fails
    }
  }
  
  private isFresh(snapshot: PersistedSnapshot): boolean {
    const versionMatch = snapshot.version === this.persistenceConfig.version;
    const notExpired = Date.now() - snapshot.timestamp < this.persistenceConfig.ttlMs;
    return versionMatch && notExpired;
  }
  
  private deserialize(persisted: PersistedSnapshot): RepositorySnapshot {
    // Persisted snapshot validated by Zod (workflows have brands)
    // Metadata needs branding
    return createSnapshot(
      persisted.workflows,
      'disk',
      {
        version: persisted.version as any,  // TODO: validate and brand
        timestamp: persisted.timestamp as any,  // TODO: validate and brand
      }
    );
  }
  
  private async fetchFromProvider(): Promise<Result<RepositorySnapshot, StartupFailedError>> {
    const result = await this.provider.fetchAll();
    if (result.isErr()) {
      const cause = 'cause' in result.error ? (result.error as any).cause : undefined;
      return err(Err.startupFailed('provider-fetch', result.error.message, cause));
    }
    
    return ok(createSnapshot(
      result.value,
      'provider',
      {
        version: this.persistenceConfig.version as any,  // TODO: brand after validation
        timestamp: Date.now() as any,  // TODO: brand after validation
      }
    ));
  }
}

// =============================================================================
// Ready Repository (Type-State: After Init)
// =============================================================================

interface CacheEntry {
  workflow: Workflow;
  timestamp: number;
}

/**
 * Ready repository - can ONLY query, cannot initialize.
 * 
 * Owns:
 * - In-memory cache (moved from decorator)
 * - Fuzzy search (for suggestions)
 */
export class ReadyRepository implements IReadyRepository {
  private readonly cache = new Map<any, CacheEntry>();  // TODO: WorkflowId key
  private readonly CACHE_TTL_MS = 300_000;  // 5 minutes
  
  constructor(
    private readonly snapshot: RepositorySnapshot,
    private readonly logger: Logger,
    private readonly isStale: boolean = false
  ) {
    Object.freeze(this.snapshot);
  }
  
  async getById(id: WorkflowId): Promise<Result<Workflow, AppError>> {
    // Check cache
    const cached = this.cache.get(id as any);  // TODO: fix typing
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      this.logger.trace({ workflowId: id }, 'Cache hit');
      return ok(cached.workflow);
    }
    
    // Lookup in snapshot
    const workflow = this.snapshot.workflows.get(id);
    if (!workflow) {
      const suggestions = await this.findSimilar(id);
      const topWorkflows = getWorkflowsArray(this.snapshot)
        .slice(0, 5)
        .map(w => ({ id: w.id as any as string, name: w.name }));  // TODO: fix casting
      
      return err(Err.workflowNotFound(
        id as any as string,  // TODO: WorkflowId → string for error
        suggestions,
        this.snapshot.workflows.size,
        topWorkflows
      ));
    }
    
    // Update cache
    this.cache.set(id as any, { workflow, timestamp: Date.now() });
    
    return ok(workflow);
  }
  
  async getAll(): Promise<Result<readonly Workflow[], never>> {
    return ok(getWorkflowsArray(this.snapshot));
  }
  
  async getSummaries(): Promise<Result<readonly WorkflowSummary[], never>> {
    const summaries = getWorkflowsArray(this.snapshot).map(wf => ({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      version: wf.version,
      category: 'general',  // TODO: Add category to workflow schema
    }));
    return ok(summaries);
  }
  
  async exists(id: WorkflowId): Promise<boolean> {
    return this.snapshot.workflows.has(id);
  }
  
  async getCount(): Promise<number> {
    return this.snapshot.workflows.size;
  }
  
  getSnapshot(): RepositorySnapshot {
    return this.snapshot;
  }
  
  // ===========================================================================
  // Private: Fuzzy Matching for Suggestions
  // ===========================================================================
  
  private async findSimilar(targetId: WorkflowId): Promise<readonly string[]> {
    const allIds = getWorkflowIdsAsStrings(this.snapshot);
    return this.fuzzyMatch(targetId as any as string, allIds, 5, 0.3);
  }
  
  private fuzzyMatch(
    target: string,
    candidates: readonly string[],
    limit: number,
    threshold: number
  ): readonly string[] {
    // Simple similarity scoring
    const scored = candidates.map(candidate => ({
      id: candidate,
      score: this.similarity(target.toLowerCase(), candidate.toLowerCase()),
    }));
    
    return scored
      .filter(item => item.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.id);
  }
  
  private similarity(a: string, b: string): number {
    // Exact match
    if (a === b) return 1.0;
    
    // Substring match
    if (a.includes(b) || b.includes(a)) return 0.8;
    
    // Common prefix
    let commonPrefix = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) commonPrefix++;
      else break;
    }
    const prefixScore = commonPrefix / Math.max(a.length, b.length);
    
    // Levenshtein distance
    const distance = this.levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    const distanceScore = 1 - (distance / maxLen);
    
    return prefixScore * 0.4 + distanceScore * 0.6;
  }
  
  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= a.length; j++) {
      matrix[0]![j] = j;
    }
    
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i]![j] = matrix[i - 1]![j - 1]!;
        } else {
          matrix[i]![j] = Math.min(
            matrix[i - 1]![j - 1]! + 1,
            matrix[i]![j - 1]! + 1,
            matrix[i - 1]![j]! + 1
          );
        }
      }
    }
    
    return matrix[b.length]![a.length]!;
  }
}
