import path from 'path';
import type { Workflow, WorkflowSourceInfo } from '../../../types/workflow.js';
import type { ICompositeWorkflowStorage, IWorkflowReader } from '../../../types/storage.js';
import type { RememberedRootRecordV2 } from '../../../v2/ports/remembered-roots-store.port.js';

export interface PublicWorkflowSource {
  readonly kind: WorkflowSourceInfo['kind'];
  readonly displayName: string;
}

export interface RootedSharingContext {
  readonly kind: 'remembered_root';
  readonly rootPath: string;
  readonly groupLabel: string;
}

export type WorkflowVisibilityCategory =
  | 'built_in'
  | 'personal'
  | 'legacy_project'
  | 'rooted_sharing'
  | 'external';

export interface WorkflowMigrationGuidance {
  readonly preferredSource: 'rooted_sharing';
  readonly currentSource: 'legacy_project';
  readonly reason: 'legacy_project_precedence';
  readonly summary: string;
}

export interface WorkflowVisibility {
  readonly category: WorkflowVisibilityCategory;
  readonly source: PublicWorkflowSource;
  readonly rootedSharing?: RootedSharingContext;
  readonly migration?: WorkflowMigrationGuidance;
}

export function toWorkflowVisibility(
  workflow: Workflow,
  rememberedRoots: readonly RememberedRootRecordV2[],
  options: {
    readonly migration?: WorkflowMigrationGuidance;
  } = {},
): WorkflowVisibility {
  const source = {
    kind: workflow.source.kind,
    displayName: workflow.source.kind === 'bundled'
      ? 'Built-in'
      : workflow.source.kind === 'user'
        ? 'User Library'
        : workflow.source.kind === 'project'
          ? 'Project'
          : workflow.source.kind === 'custom'
            ? workflow.source.label || 'Custom'
            : workflow.source.kind === 'git'
              ? workflow.source.repositoryUrl
              : workflow.source.kind === 'remote'
                ? workflow.source.registryUrl
                : workflow.source.pluginName,
  } as const;

  const rootedSharing = deriveRootedSharingContext(workflow, rememberedRoots);
  const category = deriveVisibilityCategory(workflow, rootedSharing);

  return {
    category,
    source,
    ...(rootedSharing ? { rootedSharing } : {}),
    ...(options.migration ? { migration: options.migration } : {}),
  };
}

export async function detectWorkflowMigrationGuidance(options: {
  readonly workflow: Workflow;
  readonly workflowReader: IWorkflowReader;
  readonly rememberedRoots: readonly RememberedRootRecordV2[];
}): Promise<WorkflowMigrationGuidance | undefined> {
  const { workflow, workflowReader, rememberedRoots } = options;
  if (workflow.source.kind !== 'project') return undefined;
  if (!isCompositeWorkflowReader(workflowReader)) return undefined;

  for (const storage of workflowReader.getStorageInstances()) {
    if (storage.source.kind !== 'custom') continue;

    const alternative = await storage.getWorkflowById(workflow.definition.id);
    if (!alternative) continue;

    const rootedSharing = deriveRootedSharingContext(alternative, rememberedRoots);
    if (!rootedSharing) continue;

    return {
      preferredSource: 'rooted_sharing',
      currentSource: 'legacy_project',
      reason: 'legacy_project_precedence',
      summary:
        'Project-scoped ./workflows currently overrides rooted .workrail/workflows during migration. Prefer rooted sharing for new team-shared workflows.',
    };
  }

  return undefined;
}

function isCompositeWorkflowReader(
  workflowReader: IWorkflowReader,
): workflowReader is ICompositeWorkflowStorage {
  return (
    (workflowReader as { kind?: unknown }).kind === 'composite' &&
    typeof (workflowReader as { getStorageInstances?: unknown }).getStorageInstances === 'function'
  );
}

function deriveRootedSharingContext(
  workflow: Workflow,
  rememberedRoots: readonly RememberedRootRecordV2[],
): RootedSharingContext | undefined {
  if (workflow.source.kind !== 'custom') return undefined;

  const sourcePath = path.resolve(workflow.source.directoryPath);
  for (const record of rememberedRoots) {
    const rootPath = path.resolve(record.path);
    const relative = path.relative(rootPath, sourcePath);
    const isUnderRoot =
      relative.length === 0 ||
      (!relative.startsWith('..') && !path.isAbsolute(relative));

    if (!isUnderRoot) continue;

    return {
      kind: 'remembered_root',
      rootPath,
      groupLabel: deriveGroupLabel(rootPath, sourcePath),
    };
  }

  return undefined;
}

function deriveVisibilityCategory(
  workflow: Workflow,
  rootedSharing: RootedSharingContext | undefined,
): WorkflowVisibilityCategory {
  switch (workflow.source.kind) {
    case 'bundled':
      return 'built_in';
    case 'user':
      return 'personal';
    case 'project':
      return 'legacy_project';
    case 'custom':
      return rootedSharing ? 'rooted_sharing' : 'external';
    case 'git':
    case 'remote':
    case 'plugin':
      return 'external';
  }
}

function deriveGroupLabel(rootPath: string, sourcePath: string): string {
  const relative = path.relative(rootPath, sourcePath);
  if (!relative || relative === '.workrail/workflows') {
    return path.basename(rootPath);
  }

  const segments = relative.split(path.sep).filter(Boolean);
  const workrailIndex = segments.indexOf('.workrail');
  if (workrailIndex <= 0) {
    return path.basename(rootPath);
  }

  return segments[workrailIndex - 1]!;
}
