import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import { DaemonExecutionPolicySchema, type DaemonExecutionPolicy } from '../v2/durable-core/schemas/session/daemon-policy.js';
export type { DaemonExecutionPolicy } from '../v2/durable-core/schemas/session/daemon-policy.js';

export type DecodeDaemonPolicyResult =
  | Readonly<{ kind: 'validated'; policy: DaemonExecutionPolicy }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_policy' | 'unsupported_version' }>;

/** Admission integration must additionally enforce its total byte limit. No defaults, migration,
 * truncation, or raw-input diagnostics; failure must not echo possible credentials. */
export function decodeDaemonExecutionPolicy(input: unknown): DecodeDaemonPolicyResult {
  const version = z.object({ formatVersion: z.number().int() }).safeParse(input);
  if (version.success && version.data.formatVersion !== 1) return { kind: 'refused', reason: 'unsupported_version' };
  const parsed = DaemonExecutionPolicySchema.safeParse(input);
  if (parsed.success) {
    const workspace = parsed.data.workspace;
    const paths = workspace.kind === 'worktree' ? [workspace.repositoryPath, workspace.workspacePath] : [workspace.workspacePath];
    if (paths.some(value => !isAbsolute(value) || value.includes('\0'))
      || (workspace.kind === 'worktree' && resolve(workspace.repositoryPath) === resolve(workspace.workspacePath)))
      return { kind: 'refused', reason: 'invalid_policy' };
    const freeze = (value: unknown): void => {
      if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freeze); Object.freeze(value);
      }
    };
    freeze(parsed.data);
  }
  return parsed.success ? { kind: 'validated', policy: parsed.data } : { kind: 'refused', reason: 'invalid_policy' };
}
