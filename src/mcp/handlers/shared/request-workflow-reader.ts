import path from 'path';
import { fileURLToPath } from 'url';
import type { IWorkflowReader } from '../../../types/storage.js';
import type { IFeatureFlagProvider } from '../../../config/feature-flags.js';
import { EnhancedMultiSourceWorkflowStorage } from '../../../infrastructure/storage/enhanced-multi-source-workflow-storage.js';
import { SchemaValidatingCompositeWorkflowStorage } from '../../../infrastructure/storage/schema-validating-workflow-storage.js';

export interface RequestWorkflowReaderOptions {
  readonly featureFlags: IFeatureFlagProvider;
  readonly workspacePath?: string;
  readonly resolvedRootUris?: readonly string[];
  readonly serverCwd?: string;
}

export function hasRequestWorkspaceSignal(options: {
  readonly workspacePath?: string;
  readonly resolvedRootUris?: readonly string[];
}): boolean {
  return Boolean(options.workspacePath) || (options.resolvedRootUris?.length ?? 0) > 0;
}

export function resolveRequestWorkspaceDirectory(options: {
  readonly workspacePath?: string;
  readonly resolvedRootUris?: readonly string[];
  readonly serverCwd?: string;
}): string {
  if (options.workspacePath && path.isAbsolute(options.workspacePath)) {
    return options.workspacePath;
  }

  const rootUri = options.resolvedRootUris?.[0];
  if (rootUri) {
    const fsPath = fileUriToFsPath(rootUri);
    if (fsPath) {
      return fsPath;
    }
  }

  return options.serverCwd ?? process.cwd();
}

export function toProjectWorkflowDirectory(workspaceDirectory: string): string {
  return path.basename(workspaceDirectory) === 'workflows'
    ? workspaceDirectory
    : path.join(workspaceDirectory, 'workflows');
}

export function createWorkflowReaderForRequest(
  options: RequestWorkflowReaderOptions,
): IWorkflowReader {
  const workspaceDirectory = resolveRequestWorkspaceDirectory(options);
  const projectWorkflowDirectory = toProjectWorkflowDirectory(workspaceDirectory);
  const storage = new EnhancedMultiSourceWorkflowStorage(
    { projectPath: projectWorkflowDirectory },
    options.featureFlags,
  );
  return new SchemaValidatingCompositeWorkflowStorage(storage);
}

function fileUriToFsPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
