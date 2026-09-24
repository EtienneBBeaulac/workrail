import { z } from 'zod';

const positiveInteger = z.number().int().positive().safe();
const pathValue = z.string().min(1);
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
  z.object({ kind: z.literal('existing'), workspacePath: pathValue }).strict(),
  z.object({ kind: z.literal('worktree'), repositoryPath: pathValue,
    workspacePath: pathValue, checkout }).strict(),
]).readonly();

/** Resolved configuration only. Credentials and mutable trigger objects have no slot.
 * Decoding this value confers no ownership, execution, or restart capability. */
export const DaemonExecutionPolicySchema = z.object({
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
    callTimeoutMs: positiveInteger }).strict().readonly(),
  workspace,
  // No delivery adapter is admitted until secret references and effect reconciliation exist.
  delivery: z.object({ kind: z.literal('none') }).strict().readonly(),
  // This version cannot attest cross-process elapsed time or quiescence.
  restart: z.object({ kind: z.literal('requires_explicit_reconciliation') }).strict().readonly(),
}).strict().readonly();

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type DaemonExecutionPolicy = Immutable<z.infer<typeof DaemonExecutionPolicySchema>>;
