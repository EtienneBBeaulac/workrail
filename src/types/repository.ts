/**
 * Repository Type-State Interfaces
 * 
 * CTC Pattern: Two interfaces prevent illegal states.
 * - IRepositoryInitializer: Before init (can ONLY initialize)
 * - IReadyRepository: After init (can ONLY query, CAN'T initialize)
 * 
 * Philosophy: Make illegal states unrepresentable at compile time.
 */

import { Result } from 'neverthrow';
import type {
  WorkflowId,
  Workflow,
  WorkflowSummary,
  RepositorySnapshot,
} from './schemas.js';
import type {
  AppError,
  StartupFailedError,
} from '../core/errors/index.js';

/**
 * Repository before initialization.
 * Can ONLY initialize or refresh, CANNOT query.
 */
export interface IRepositoryInitializer {
  initialize(): Promise<Result<IReadyRepository, StartupFailedError>>;
  refresh(): Promise<Result<IReadyRepository, StartupFailedError>>;
}

/**
 * Repository after initialization.
 * Can ONLY query, CANNOT initialize again.
 * 
 * Type-state ensures you can't query before init (compile error).
 */
export interface IReadyRepository {
  getById(id: WorkflowId): Promise<Result<Workflow, AppError>>;
  getAll(): Promise<Result<readonly Workflow[], AppError>>;
  getSummaries(): Promise<Result<readonly WorkflowSummary[], AppError>>;
  exists(id: WorkflowId): Promise<boolean>;
  getCount(): Promise<number>;
  getSnapshot(): RepositorySnapshot;
}

/**
 * Workflow provider interface.
 * Implementations fetch workflows from various sources.
 */
export interface IWorkflowProvider {
  fetchAll(): Promise<Result<readonly Workflow[], AppError>>;
  fetchById(id: WorkflowId): Promise<Result<Workflow, AppError>>;
}

/**
 * Persistence configuration.
 */
export interface PersistenceConfig {
  readonly enabled: boolean;
  readonly path: string;
  readonly ttlMs: number;
  readonly version: string;
}
