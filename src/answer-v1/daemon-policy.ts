import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const positiveInteger = z.number().int().positive().safe();
const absolutePath = z.string().min(1).refine(isAbsolute);
// Portable supported subset of Git branch names, deliberately excluding symbolic HEAD.
const branchName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_/-]*$/)
  .refine(value => value !== 'HEAD' && !value.endsWith('/') && !value.includes('//'));
const commit = z.discriminatedUnion('algorithm', [
  z.object({ algorithm: z.literal('sha1'), value: z.string().regex(/^[a-f0-9]{40}$/).refine(value => !/^0+$/.test(value)) }).strict(),
  z.object({ algorithm: z.literal('sha256'), value: z.string().regex(/^[a-f0-9]{64}$/).refine(value => !/^0+$/.test(value)) }).strict(),
]).readonly();
const checkout = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), name: branchName, commit }).strict(),
  z.object({ kind: z.literal('detached'), commit }).strict(),
]).readonly();
const workspace = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), workspacePath: absolutePath }).strict(),
  z.object({ kind: z.literal('worktree'), repositoryPath: absolutePath,
    workspacePath: absolutePath, checkout }).strict(),
]).readonly();

/** Resolved configuration only. Credentials and mutable trigger objects have no slot.
 * Decoding this value confers no ownership, execution, or restart capability. */
const policySchema = z.object({
  formatVersion: z.literal(1),
  profile: z.literal('daemon_answers_v1'),
  model: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('anthropic'), modelId: z.string().min(1) }).strict(),
    z.object({ provider: z.literal('amazon_bedrock'), modelId: z.string().min(1),
      region: z.string().min(1) }).strict(),
  ]).readonly(),
  systemPrompt: z.string().min(1).refine(value => new TextEncoder().encode(value).length <= 256 * 1024),
  limits: z.object({ expiresAtMs: positiveInteger, maxModelCalls: positiveInteger,
    maxOutputTokens: positiveInteger, stallTimeoutMs: positiveInteger,
    callTimeoutMs: positiveInteger }).strict(),
  workspace: workspace.refine(value => value.kind !== 'worktree' || resolve(value.repositoryPath) !== resolve(value.workspacePath)),
  // No delivery adapter is admitted until secret references and effect reconciliation exist.
  delivery: z.object({ kind: z.literal('none') }).strict(),
  // This version cannot attest cross-process elapsed time or quiescence.
  restart: z.object({ kind: z.literal('requires_explicit_reconciliation') }).strict(),
}).strict().readonly();

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type DaemonExecutionPolicy = Immutable<z.infer<typeof policySchema>>;
export type DecodeDaemonPolicyResult =
  | Readonly<{ kind: 'validated'; policy: DaemonExecutionPolicy }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_policy' | 'unsupported_version' }>;

/** Admission integration must additionally enforce its total byte limit. No defaults, migration,
 * truncation, or raw-input diagnostics; failure must not echo possible credentials. */
export function decodeDaemonExecutionPolicy(input: unknown): DecodeDaemonPolicyResult {
  const version = z.object({ formatVersion: z.number().int() }).safeParse(input);
  if (version.success && version.data.formatVersion !== 1) return { kind: 'refused', reason: 'unsupported_version' };
  const parsed = policySchema.safeParse(input);
  if (parsed.success) {
    const freeze = (value: unknown): void => {
      if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freeze); Object.freeze(value);
      }
    };
    freeze(parsed.data);
  }
  return parsed.success ? { kind: 'validated', policy: parsed.data } : { kind: 'refused', reason: 'invalid_policy' };
}
