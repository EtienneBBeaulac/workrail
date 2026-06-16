import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Result, ok, err } from 'neverthrow';

import type { CliResult } from '../types/cli-result.js';
import { successMessage, failure } from '../types/cli-result.js';
import { LocalDataDirV2 } from '../../v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../v2/infra/local/session-store/index.js';
import { asSessionId } from '../../v2/durable-core/ids/index.js';

const execFileAsync = promisify(execFile);

export interface WorktrainExportArtifactCommandOpts {
  readonly sessionId: string;
  readonly artifactName: string;
  readonly destPath?: string;
}

/**
 * Gets the nearest parent directory of a path that exists.
 */
function getNearestExistingParent(filePath: string): string {
  let current = path.resolve(filePath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

/**
 * Validates that targetPath resides inside rootPath.
 * Checks resolved real paths, normalized separators, and asserts that
 * no path segment is a symlink to prevent escapes.
 */
function validatePathContainment(targetPath: string, rootPath: string): Result<string, Error> {
  try {
    const resolvedRoot = fs.realpathSync(rootPath);
    const nearestParent = getNearestExistingParent(targetPath);
    const resolvedNearestParent = fs.realpathSync(nearestParent);

    const normalizedRoot = path.normalize(resolvedRoot).toLowerCase();
    const normalizedNearestParent = path.normalize(resolvedNearestParent).toLowerCase();

    // Verify containment using relative path check (avoids suffix-based startsWith bypass)
    const relative = path.relative(normalizedRoot, normalizedNearestParent);
    const isContained = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!isContained) {
      return err(new Error(`Path is outside root: ${targetPath}`));
    }

    // Verify no segment is a symlink (using case-normalized comparison for case-insensitive filesystems)
    let current = path.resolve(targetPath);
    const resolvedRootNormalized = path.resolve(resolvedRoot).toLowerCase();
    while (current.toLowerCase() !== resolvedRootNormalized && current !== path.dirname(current)) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          return err(new Error(`Path segment is a symbolic link: ${current}`));
        }
      } catch (e) {
        // Segment doesn't exist yet, which is fine
      }
      current = path.dirname(current);
    }

    return ok(path.resolve(targetPath));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Stages a file in Git with exponential backoff on lock collisions.
 */
async function gitAddWithRetry(
  workspacePath: string,
  filePath: string,
  maxRetries = 5,
): Promise<Result<void, Error>> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await execFileAsync('git', ['add', filePath], {
        cwd: workspacePath,
        timeout: 10000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return ok(undefined);
    } catch (e: any) {
      const errText = String(e.stdout || '') + '\n' + String(e.stderr || '') + '\n' + String(e.message || '');
      if (
        errText.includes('index.lock') ||
        errText.includes('Another git process seems to be running')
      ) {
        attempt++;
        if (attempt >= maxRetries) {
          return err(new Error(`Failed to stage file in Git due to persistent lock collisions: ${errText}`));
        }
        const backoff = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms, 1600ms...
        await new Promise((resolve) => setTimeout(resolve, backoff));
      } else {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
  return err(new Error('Unreachable retry end'));
}

/**
 * Export a shadow artifact to the workspace and stage it in Git.
 */
export async function executeWorktrainExportArtifactCommand(
  opts: WorktrainExportArtifactCommandOpts,
): Promise<CliResult> {
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);

  const sessionId = asSessionId(opts.sessionId);

  // Load session truth
  const truthRes = await sessionStore.load(sessionId);
  if (truthRes.isErr()) {
    return failure(`Failed to load session ${opts.sessionId}: ${truthRes.error.message}`);
  }

  const truth = truthRes.value;

  // Resolve workspace root
  let workspacePath: string | undefined;
  for (const e of truth.events) {
    if (e.kind === 'observation_recorded' && e.data.key === 'repo_root') {
      workspacePath = e.data.value.value;
      break;
    }
  }

  // Fallback to process.cwd() if not found in event log
  if (!workspacePath) {
    workspacePath = process.cwd();
  }

  const shadowArtifactDir = path.join(workspacePath, '.workrail', 'artifacts', String(sessionId));
  const sourceFileRaw = path.join(shadowArtifactDir, opts.artifactName);

  // Validate source path containment and ensure it is inside shadowArtifactDir
  const sourceContainmentRes = validatePathContainment(sourceFileRaw, shadowArtifactDir);
  if (sourceContainmentRes.isErr()) {
    return failure(`Security violation: source path validation failed: ${sourceContainmentRes.error.message}`);
  }
  const sourceFile = sourceContainmentRes.value;

  if (!fs.existsSync(sourceFile)) {
    return failure(`Artifact not found: ${opts.artifactName} (expected at ${sourceFile})`);
  }

  // Resolve destination file path
  let finalDestRaw = opts.destPath
    ? path.resolve(workspacePath, opts.destPath)
    : path.join(workspacePath, opts.artifactName);

  if (fs.existsSync(finalDestRaw) && fs.statSync(finalDestRaw).isDirectory()) {
    finalDestRaw = path.join(finalDestRaw, opts.artifactName);
  }

  // Validate destination path containment inside workspaceRoot
  const destContainmentRes = validatePathContainment(finalDestRaw, workspacePath);
  if (destContainmentRes.isErr()) {
    return failure(`Security violation: destination path validation failed: ${destContainmentRes.error.message}`);
  }
  const finalDest = destContainmentRes.value;

  // Perform safe file copy
  try {
    fs.mkdirSync(path.dirname(finalDest), { recursive: true });
    fs.copyFileSync(sourceFile, finalDest);
  } catch (e: any) {
    return failure(`Failed to copy artifact to destination: ${e.message}`);
  }

  // Stage the exported file in Git
  const gitRes = await gitAddWithRetry(workspacePath, finalDest);
  if (gitRes.isErr()) {
    return failure(`Copied file successfully, but failed to stage in Git: ${gitRes.error.message}`);
  }

  return successMessage(`Successfully exported artifact ${opts.artifactName} to ${finalDest} and staged in Git.`);
}
