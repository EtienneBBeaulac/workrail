/**
 * Repository State Manager
 * 
 * CTC Pattern: Manages repository lifecycle with no-downtime refresh.
 * 
 * Features:
 * - Deduplicates concurrent refresh calls
 * - Always has valid repository (even during refresh)
 * - Type-state enforced
 */

import { Result } from 'neverthrow';
import type { IRepositoryInitializer, IReadyRepository } from '../../types/repository.js';
import type { StartupFailedError } from '../../core/errors/index.js';

type InternalState =
  | { _tag: 'ready'; repository: IReadyRepository }
  | { _tag: 'refreshing'; repository: IReadyRepository; promise: Promise<Result<IReadyRepository, StartupFailedError>> };

/**
 * Manages repository state with no-downtime refresh.
 */
export class RepositoryStateManager {
  private state!: InternalState;
  
  constructor(private readonly initializer: IRepositoryInitializer) {}
  
  /**
   * Initialize repository (call once at startup).
   */
  async initialize(): Promise<Result<IReadyRepository, StartupFailedError>> {
    console.log('[RepositoryStateManager] initialize() called');
    const result = await this.initializer.initialize();
    console.log('[RepositoryStateManager] initializer.initialize() returned:', result.isOk() ? 'OK' : 'ERR');
    if (result.isOk()) {
      console.log('[RepositoryStateManager] Setting state to ready');
      this.state = { _tag: 'ready', repository: result.value };
    } else {
      console.error('[RepositoryStateManager] Initialization failed:', result.error);
    }
    return result;
  }
  
  /**
   * Get current repository (always available).
   */
  get current(): IReadyRepository {
    if (!this.state) {
      console.error('[RepositoryStateManager] ERROR: Accessing .current but state is not initialized!');
      console.error('[RepositoryStateManager] You must call initialize() before accessing the repository.');
      throw new Error('Repository not initialized. Call initialize() first. Did startAsyncServices() run?');
    }
    return this.state.repository;
  }
  
  /**
   * Refresh repository (no downtime - serves old one during refresh).
   * Deduplicates concurrent refresh calls.
   */
  async refresh(): Promise<Result<IReadyRepository, StartupFailedError>> {
    // Already refreshing? Return existing promise (deduplication)
    if (this.state._tag === 'refreshing') {
      return this.state.promise;
    }
    
    // Create deferred promise
    const deferred = createDeferred<Result<IReadyRepository, StartupFailedError>>();
    const oldRepo = this.state.repository;
    
    // Transition to refreshing (MUST be sync before await)
    this.state = {
      _tag: 'refreshing',
      repository: oldRepo,  // Keep serving old one
      promise: deferred.promise
    };
    
    // Do refresh (async)
    const result = await this.initializer.refresh();
    
    // Update state
    if (result.isOk()) {
      this.state = { _tag: 'ready', repository: result.value };
    } else {
      this.state = { _tag: 'ready', repository: oldRepo };  // Keep old on failure
    }
    
    deferred.resolve(result);
    return result;
  }
}

// =============================================================================
// Utilities
// =============================================================================

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
