/**
 * Git test utilities
 *
 * Helpers for setting up test git repositories with proper identity.
 */

import { execSync } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

/**
 * Initialize a git repository with test identity (sync version).
 * 
 * @param cwd - Directory to initialize
 * @param options - Additional options
 */
export function initGitRepoSync(cwd: string, options: { silent?: boolean } = {}): void {
  const stdio = options.silent ? 'ignore' : 'pipe';
  
  execSync('git init', { cwd, stdio });
  execSync('git config user.name "Test User"', { cwd, stdio });
  execSync('git config user.email "test@test.com"', { cwd, stdio });
}

/**
 * Initialize a git repository with test identity (async version).
 * 
 * @param cwd - Directory to initialize
 */
export async function initGitRepo(cwd: string): Promise<void> {
  await execAsync('git init', { cwd });
  await execAsync('git config user.name "Test User"', { cwd });
  await execAsync('git config user.email "test@test.com"', { cwd });
}

/**
 * Configure git identity in an existing repository.
 * 
 * @param cwd - Repository directory
 */
export async function configureGitIdentity(cwd: string): Promise<void> {
  await execAsync('git config user.name "Test User"', { cwd });
  await execAsync('git config user.email "test@test.com"', { cwd });
}

/**
 * Configure git identity in an existing repository (sync version).
 * 
 * @param cwd - Repository directory
 * @param options - Additional options
 */
export function configureGitIdentitySync(cwd: string, options: { silent?: boolean } = {}): void {
  const stdio = options.silent ? 'ignore' : 'pipe';
  
  execSync('git config user.name "Test User"', { cwd, stdio });
  execSync('git config user.email "test@test.com"', { cwd, stdio });
}
