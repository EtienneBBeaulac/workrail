/**
 * SessionWatcherService - Manages file watching for session files.
 * 
 * Extracted from SessionManager to follow Single Responsibility Principle.
 * 
 * Responsibilities:
 * - Watch session files for changes
 * - Debounce rapid file changes
 * - Emit events on updates
 * - Circuit breaker for failing sessions
 * - Resource cleanup
 * 
 * KEY FIX: Timer and watcher are stored together in WatcherState,
 * ensuring they're cleaned up atomically in disposeWatcherState().
 */

import { inject, singleton } from 'tsyringe';
import { DI } from '../../di/tokens.js';
import fsSync from 'fs';
import fs from 'fs/promises';
import { EventEmitter } from 'events';
import type { WorkflowId, SessionId, SessionWatcherKey } from '../../types/session-identifiers';
import { SessionWatcherKey as SWK } from '../../types/session-identifiers';
import type { WatcherState } from '../../types/session-watcher-state';
import { 
  createWatcherState, 
  disposeWatcherState, 
  isTransientError 
} from '../../types/session-watcher-state';
import type { Logger, ILoggerFactory } from '../../core/logging/index.js';

/**
 * Configuration for watcher behavior.
 */
export interface SessionWatcherConfig {
  readonly debounceMs: number;
  readonly maxTransientErrors: number;
  readonly maxPermanentErrors: number;
  readonly circuitBreakerThreshold: number;
  readonly circuitBreakerResetMs: number;
}

const DEFAULT_CONFIG: SessionWatcherConfig = {
  debounceMs: 100,
  maxTransientErrors: 10,
  maxPermanentErrors: 3,
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 60000  // 1 minute
};

/**
 * Circuit breaker state for a session.
 * Prevents rapid re-registration of failing sessions.
 */
interface CircuitBreakerState {
  readonly lastFailure: Date;
  readonly consecutiveFailures: number;
}

/**
 * SessionWatcherService manages file watching for session files.
 * 
 * Features:
 * - Type-safe API (branded WorkflowId/SessionId types)
 * - Atomic cleanup (timer + watcher together)
 * - Circuit breaker (prevents thrashing on failing sessions)
 * - Error categorization (transient vs permanent)
 * - Event emission (compatible with SessionManager's EventEmitter)
 * 
 * Events emitted:
 * - 'session:updated': { workflowId, sessionId, session }
 * - 'session:watch-error': { workflowId, sessionId, error, isTransient }
 */
@singleton()
export class SessionWatcherService extends EventEmitter {
  private readonly logger: Logger;
  private readonly config: SessionWatcherConfig;
  private watchers = new Map<string, WatcherState>();
  private circuitBreakers = new Map<string, CircuitBreakerState>();
  private _isDisposed = false;
  
  constructor(
    @inject(DI.Logging.Factory) loggerFactory: ILoggerFactory,
    config: Partial<SessionWatcherConfig> = {},
  ) {
    super();
    this.logger = loggerFactory.create('SessionWatcherService');
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    this.logger.info({
      debounceMs: this.config.debounceMs,
      maxTransientErrors: this.config.maxTransientErrors,
      maxPermanentErrors: this.config.maxPermanentErrors,
    }, 'SessionWatcherService initialized');
  }
  
  get isDisposed(): boolean {
    return this._isDisposed;
  }
  
  /**
   * Start watching a session file.
   * Idempotent - safe to call multiple times for same session.
   * 
   * @param workflowId - Type-safe workflow identifier
   * @param sessionId - Type-safe session identifier  
   * @param filePath - Absolute path to session file
   * 
   * @throws if service is disposed
   * @throws if circuit breaker is open for this session
   */
  watch(
    workflowId: WorkflowId,
    sessionId: SessionId,
    filePath: string
  ): void {
    this.assertNotDisposed();
    
    const key = SWK.create(workflowId, sessionId);
    const keyStr = SWK.serialize(key);
    
    // Idempotent - already watching
    if (this.watchers.has(keyStr)) {
      this.logger.debug({ workflowId, sessionId }, 'Already watching session, skipping');
      return;
    }
    
    // Check circuit breaker
    this.checkCircuitBreaker(keyStr);
    
    try {
      // Create file watcher
      const fsWatcher = fsSync.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          this.handleFileChange(keyStr, key, filePath);
        }
      });
      
      // Handle watcher-level errors
      fsWatcher.on('error', (error) => {
        this.logger.error({ err: error, workflowId, sessionId }, 'Watcher error');
        this.handleError(keyStr, key, error, false);  // Watcher errors are permanent
      });
      
      // Store watcher state
      const state = createWatcherState(fsWatcher);
      this.watchers.set(keyStr, state);
      
      this.logger.debug({ workflowId, sessionId, filePath }, 'Started watching session');
      
    } catch (error) {
      this.logger.error({ err: error, workflowId, sessionId, filePath }, 'Failed to start watching');
      this.handleError(keyStr, key, error as Error, false);
      throw error;  // Re-throw to caller
    }
  }
  
  /**
   * Stop watching a session file.
   * Idempotent - safe to call even if not watching.
   * 
   * @param workflowId - Type-safe workflow identifier
   * @param sessionId - Type-safe session identifier
   */
  unwatch(workflowId: WorkflowId, sessionId: SessionId): void {
    const key = SWK.create(workflowId, sessionId);
    const keyStr = SWK.serialize(key);
    
    const state = this.watchers.get(keyStr);
    if (!state) {
      this.logger.debug({ workflowId, sessionId }, 'Session not being watched, nothing to unwatch');
      return;
    }
    
    this.logger.debug({ workflowId, sessionId }, 'Stopping watch on session');
    
    // ✅ BUG FIX: disposeWatcherState() clears BOTH timer and watcher
    disposeWatcherState(state);
    this.watchers.delete(keyStr);
  }
  
  /**
   * Stop watching all sessions.
   * Called during service shutdown.
   */
  unwatchAll(): void {
    this.logger.info({ count: this.watchers.size }, 'Unwatching all sessions');
    
    // Dispose in reverse order (LIFO - last registered, first disposed)
    const entries = Array.from(this.watchers.entries()).reverse();
    
    for (const [, state] of entries) {
      disposeWatcherState(state);
    }
    
    this.watchers.clear();
  }
  
  /**
   * Dispose all resources and mark service as disposed.
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    
    this.logger.info('Disposing SessionWatcherService');
    
    this.unwatchAll();
    this.circuitBreakers.clear();
    this.removeAllListeners();
  }
  
  /**
   * Get count of active watchers (for monitoring).
   */
  getActiveWatcherCount(): number {
    return this.watchers.size;
  }
  
  /**
   * Get circuit breaker status for a session.
   * Returns null if no circuit breaker active.
   */
  getCircuitBreakerStatus(
    workflowId: WorkflowId,
    sessionId: SessionId
  ): { failures: number; lastFailure: Date; canRetryIn: number } | null {
    const key = SWK.create(workflowId, sessionId);
    const keyStr = SWK.serialize(key);
    const breaker = this.circuitBreakers.get(keyStr);
    
    if (!breaker) return null;
    
    const timeSinceFailure = Date.now() - breaker.lastFailure.getTime();
    const canRetryIn = Math.max(0, this.config.circuitBreakerResetMs - timeSinceFailure);
    
    return {
      failures: breaker.consecutiveFailures,
      lastFailure: breaker.lastFailure,
      canRetryIn
    };
  }
  
  /**
   * Handle file change with debouncing.
   */
  private handleFileChange(
    keyStr: string,
    key: SessionWatcherKey,
    filePath: string
  ): void {
    const state = this.watchers.get(keyStr);
    if (!state) return;  // Disposed mid-callback
    
    // Clear existing timer (debouncing)
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    
    // Schedule new timer
    state.timer = setTimeout(async () => {
      // Clear timer reference immediately
      if (state.timer !== null) {
        state.timer = null;
      }
      
      // Defensive check - might have been disposed during timer delay
      if (this._isDisposed || !this.watchers.has(keyStr)) {
        return;
      }
      
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        
        // Success - reset error counts
        state.transientErrorCount = 0;
        state.permanentErrorCount = 0;
        
        // Clear circuit breaker on success
        this.circuitBreakers.delete(keyStr);
        
        this.logger.debug({ 
          workflowId: key.workflowId, 
          sessionId: key.sessionId,
        }, 'Session updated');
        
        // Emit event (compatible with SessionManager's EventEmitter)
        this.emit('session:updated', {
          workflowId: key.workflowId,
          sessionId: key.sessionId,
          session: data
        });
        
      } catch (error) {
        const err = error as Error;
        const transient = isTransientError(err);
        
        this.logger.warn({ 
          workflowId: key.workflowId,
          sessionId: key.sessionId,
          error: err.message,
          isTransient: transient,
        }, 'Error reading session file');
        
        this.handleError(keyStr, key, err, transient);
      }
    }, this.config.debounceMs);
  }
  
  /**
   * Handle errors with circuit breaker logic.
   * 
   * Categorizes errors as transient or permanent.
   * Disposes watcher after too many consecutive errors.
   * Records failures for circuit breaker.
   */
  private handleError(
    keyStr: string,
    key: SessionWatcherKey,
    error: Error,
    isTransient: boolean
  ): void {
    const state = this.watchers.get(keyStr);
    if (!state) return;
    
    let shouldDispose = false;
    
    if (isTransient) {
      state.transientErrorCount++;
      if (state.transientErrorCount >= this.config.maxTransientErrors) {
        this.logger.warn({
          workflowId: key.workflowId,
          sessionId: key.sessionId,
          errorCount: state.transientErrorCount,
        }, 'Max transient errors reached, disposing watcher');
        shouldDispose = true;
      }
    } else {
      state.permanentErrorCount++;
      if (state.permanentErrorCount >= this.config.maxPermanentErrors) {
        this.logger.warn({
          workflowId: key.workflowId,
          sessionId: key.sessionId,
          errorCount: state.permanentErrorCount,
        }, 'Max permanent errors reached, disposing watcher');
        shouldDispose = true;
      }
    }
    
    if (shouldDispose) {
      this.recordCircuitBreakerFailure(keyStr);
      this.unwatch(key.workflowId, key.sessionId);
    }
    
    // Emit error event
    this.emit('session:watch-error', {
      workflowId: key.workflowId,
      sessionId: key.sessionId,
      error,
      isTransient
    });
  }
  
  /**
   * Record a failure for circuit breaker.
   */
  private recordCircuitBreakerFailure(keyStr: string): void {
    const existing = this.circuitBreakers.get(keyStr);
    this.circuitBreakers.set(keyStr, {
      lastFailure: new Date(),
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1
    });
    
    this.logger.debug({
      key: keyStr,
      failures: this.circuitBreakers.get(keyStr)!.consecutiveFailures,
    }, 'Circuit breaker failure recorded');
  }
  
  /**
   * Check if circuit breaker is open for a session.
   * 
   * @throws Error if circuit breaker is open (too many recent failures)
   */
  private checkCircuitBreaker(keyStr: string): void {
    const breaker = this.circuitBreakers.get(keyStr);
    if (!breaker) return;
    
    if (breaker.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      const timeSinceFailure = Date.now() - breaker.lastFailure.getTime();
      
      if (timeSinceFailure < this.config.circuitBreakerResetMs) {
        const waitSec = Math.ceil((this.config.circuitBreakerResetMs - timeSinceFailure) / 1000);
        const errorMsg = 
          `Circuit breaker open for ${keyStr}: ${breaker.consecutiveFailures} consecutive failures. ` +
          `Retry in ${waitSec}s`;
        
        this.logger.warn({
          key: keyStr,
          failures: breaker.consecutiveFailures,
          waitSec,
        }, 'Circuit breaker blocking registration');
        
        throw new Error(errorMsg);
      }
      
      // Timeout elapsed - clear breaker
      this.logger.info({
        key: keyStr,
        hadFailures: breaker.consecutiveFailures,
      }, 'Circuit breaker reset');
      this.circuitBreakers.delete(keyStr);
    }
  }
  
  /**
   * Assert service is not disposed.
   * @throws Error if service is disposed
   */
  private assertNotDisposed(): void {
    if (this._isDisposed) {
      throw new Error('SessionWatcherService is disposed');
    }
  }
}
