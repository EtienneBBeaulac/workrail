import * as path from 'node:path';
import type { RunId } from '../daemon-events.js';
import type { WorkflowTrigger } from '../types.js';
import { extractContextSlots } from '../types.js';
import type { WorkspacePlan } from './workspace-preparation.js';

export type WorkspacePlanResult =
  | { readonly kind: 'planned'; readonly plan: WorkspacePlan }
  | { readonly kind: 'failed'; readonly message: string };

export function planSessionWorkspace(
  trigger: Pick<WorkflowTrigger, 'workspacePath' | 'branchStrategy' | 'branchPrefix' | 'baseBranch' | 'context'>,
  sessionId: RunId, worktreesDir: string, inheritedWorkspace?: string,
): WorkspacePlanResult {
  const worktreePath = path.join(worktreesDir, sessionId);
  if (trigger.branchStrategy === 'worktree') return { kind: 'planned', plan: {
    kind: 'create', repositoryPath: trigger.workspacePath, worktreePath,
    checkout: { kind: 'branch', name: `${trigger.branchPrefix ?? 'worktrain/'}${sessionId}`, base: trigger.baseBranch ?? 'main' },
  } };
  if (trigger.branchStrategy === 'read-only') {
    const { prBranch } = extractContextSlots(trigger.context);
    if (typeof prBranch !== 'string' || !prBranch) return { kind: 'failed', message:
      'branchStrategy:read-only requires context.prBranch (the PR head branch). ' +
      'Ensure the trigger uses github_prs_poll with a reviewerLogin so prBranch is injected.' };
    return { kind: 'planned', plan: { kind: 'create', repositoryPath: trigger.workspacePath, worktreePath,
      checkout: { kind: 'detached', ref: prBranch } } };
  }
  // Keep the legacy precedence: an explicit branch strategy creates its own workspace.
  return { kind: 'planned', plan: { kind: 'existing', workspacePath: inheritedWorkspace ?? trigger.workspacePath, worktreePath: inheritedWorkspace } };
}

