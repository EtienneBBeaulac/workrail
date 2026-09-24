import * as path from 'node:path';

/** Preparation has no engine, token-store or registry capability. */
export type WorkspacePlan =
  | { readonly kind: 'existing'; readonly workspacePath: string; readonly worktreePath: string | undefined }
  | { readonly kind: 'create'; readonly repositoryPath: string; readonly worktreePath: string;
      readonly checkout: { readonly kind: 'branch'; readonly name: string; readonly base: string }
        | { readonly kind: 'detached'; readonly ref: string } };

/** Effects may be bound to the caller's cancellation scope. No session authority is available. */
export interface WorkspacePreparationEffects {
  readonly ensureDirectory: (directory: string) => Promise<void>;
  readonly git: (repository: string, args: readonly string[]) => Promise<void>;
}
export type CreatedWorkspace = Readonly<{
  kind: 'created'; plan: Extract<WorkspacePlan, { kind: 'create' }>;
  workspacePath: string; worktreePath: string;
}>;
export type WorkspacePreparationResult =
  | CreatedWorkspace
  | Readonly<{ kind: 'borrowed'; workspacePath: string; worktreePath: string | undefined }>
  | Readonly<{ kind: 'failed'; message: string }>;

export async function prepareSessionWorkspace(plan: WorkspacePlan, effects: WorkspacePreparationEffects): Promise<WorkspacePreparationResult> {
  if (plan.kind === 'existing') return { kind: 'borrowed', workspacePath: plan.workspacePath, worktreePath: plan.worktreePath };
  try {
    await effects.ensureDirectory(path.dirname(plan.worktreePath));
    const ref = plan.checkout.kind === 'branch' ? plan.checkout.base : plan.checkout.ref;
    await effects.git(plan.repositoryPath, ['fetch', 'origin', ref]);
    const checkout = plan.checkout.kind === 'branch'
      ? ['-b', plan.checkout.name, `origin/${ref}`] : ['--detach', `origin/${ref}`];
    await effects.git(plan.repositoryPath, ['worktree', 'add', plan.worktreePath, ...checkout]);
    return { kind: 'created', plan, workspacePath: plan.worktreePath, worktreePath: plan.worktreePath };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Only a workspace this preparation created can be rolled back through this capability. */
export async function rollbackPreparedWorkspace(workspace: CreatedWorkspace, effects: WorkspacePreparationEffects): Promise<'removed' | 'failed'> {
  try {
    await effects.git(workspace.plan.repositoryPath, ['worktree', 'remove', '--force', workspace.worktreePath]);
    return 'removed';
  } catch { return 'failed'; }
}
