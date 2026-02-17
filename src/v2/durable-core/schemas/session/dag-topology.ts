import { z } from 'zod';
import { asSha256Digest, asSnapshotRef, asWorkflowHash } from '../../ids/index.js';
import { SHA256_DIGEST_PATTERN } from '../../constants.js';

const sha256DigestSchema = z
  .string()
  .regex(SHA256_DIGEST_PATTERN, 'Expected sha256:<64 hex chars>')
  .describe('sha256 digest in WorkRail v2 format');

const workflowHashSchema = sha256DigestSchema
  .transform((v) => asWorkflowHash(asSha256Digest(v)))
  .describe('WorkflowHash (sha256 digest of workflow definition)');

const snapshotRefSchema = sha256DigestSchema
  .transform((v) => asSnapshotRef(asSha256Digest(v)))
  .describe('SnapshotRef (content-addressed sha256 ref)');

export const NodeKindSchema = z.enum(['step', 'checkpoint', 'blocked_attempt']);

export const NodeCreatedDataV1Schema = z.object({
  nodeKind: NodeKindSchema,
  parentNodeId: z.string().min(1).nullable(),
  workflowHash: workflowHashSchema,
  snapshotRef: snapshotRefSchema,
});

export const EdgeKindSchema = z.enum(['acked_step', 'checkpoint']);
export const EdgeCauseKindSchema = z.enum(['idempotent_replay', 'intentional_fork', 'non_tip_advance', 'checkpoint_created']);
export const EdgeCauseSchema = z.object({
  kind: EdgeCauseKindSchema,
  eventId: z.string().min(1),
});

export const EdgeCreatedDataV1Schema = z
  .object({
    edgeKind: EdgeKindSchema,
    fromNodeId: z.string().min(1),
    toNodeId: z.string().min(1),
    cause: EdgeCauseSchema,
  })
  .superRefine((v, ctx) => {
    // Lock: for checkpoint edges, cause.kind must be checkpoint_created.
    if (v.edgeKind === 'checkpoint' && v.cause.kind !== 'checkpoint_created') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'edgeKind=checkpoint requires cause.kind=checkpoint_created',
        path: ['cause', 'kind'],
      });
    }
  });
