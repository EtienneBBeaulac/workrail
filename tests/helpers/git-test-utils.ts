/**
 * Git test utilities
 *
 * Helpers for setting up test git repositories with proper identity.
 */

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function gitExec(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const res = await execFileAsync('git', [...args], { cwd });
  return { stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

export function gitExecSync(cwd: string, args: readonly string[], options: { silent?: boolean } = {}): void {
  const stdio = options.silent ? 'ignore' : 'pipe';
  execFileSync('git', [...args], { cwd, stdio });
}

export function gitExecStdoutSync(cwd: string, args: readonly string[], options: { silent?: boolean } = {}): string {
  const stdio: any = options.silent ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'pipe'];
  const res = execFileSync('git', [...args], { cwd, stdio, encoding: 'utf8' });
  return String(res ?? '');
}

/**
 * Initialize a git repository with test identity (sync version).
 * 
 * @param cwd - Directory to initialize
 * @param options - Additional options
 */
export function initGitRepoSync(cwd: string, options: { silent?: boolean } = {}): void {
  gitExecSync(cwd, ['init'], options);
  gitExecSync(cwd, ['config', 'user.name', 'Test User'], options);
  gitExecSync(cwd, ['config', 'user.email', 'test@test.com'], options);
}

/**
 * Initialize a git repository with test identity (async version).
 * 
 * @param cwd - Directory to initialize
 */
export async function initGitRepo(cwd: string): Promise<void> {
  await gitExec(cwd, ['init']);
  await gitExec(cwd, ['config', 'user.name', 'Test User']);
  await gitExec(cwd, ['config', 'user.email', 'test@test.com']);
}

/**
 * Configure git identity in an existing repository.
 * 
 * @param cwd - Repository directory
 */
export async function configureGitIdentity(cwd: string): Promise<void> {
  await gitExec(cwd, ['config', 'user.name', 'Test User']);
  await gitExec(cwd, ['config', 'user.email', 'test@test.com']);
}

/**
 * Configure git identity in an existing repository (sync version).
 * 
 * @param cwd - Repository directory
 * @param options - Additional options
 */
export function configureGitIdentitySync(cwd: string, options: { silent?: boolean } = {}): void {
  gitExecSync(cwd, ['config', 'user.name', 'Test User'], options);
  gitExecSync(cwd, ['config', 'user.email', 'test@test.com'], options);
}
