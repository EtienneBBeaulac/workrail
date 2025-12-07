import { GitWorkflowStorage, GitWorkflowConfig } from '../../src/infrastructure/storage/git-workflow-storage.js';
import { FakeLogger } from './FakeLogger.js';

/**
 * Helper to create GitWorkflowStorage for tests.
 * Provides a fake logger to avoid dependency on DI.
 */
export function createGitWorkflowStorage(config: GitWorkflowConfig): GitWorkflowStorage {
  const logger = new FakeLogger() as any;
  return new GitWorkflowStorage(config, logger);
}
