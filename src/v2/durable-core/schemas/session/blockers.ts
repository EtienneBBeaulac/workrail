import { z } from 'zod';
import {
  MAX_BLOCKERS,
  MAX_BLOCKER_MESSAGE_BYTES,
  MAX_BLOCKER_SUGGESTED_FIX_BYTES,
  DELIMITER_SAFE_ID_PATTERN,
} from '../../constants.js';
import { utf8ByteLength } from '../lib/utf8-byte-length.js';

export const BlockerCodeSchema = z.enum([
  'USER_ONLY_DEPENDENCY',
  'MISSING_REQUIRED_OUTPUT',
  'INVALID_REQUIRED_OUTPUT',
  'MISSING_REQUIRED_NOTES',
  'MISSING_CONTEXT_KEY',
  'CONTEXT_BUDGET_EXCEEDED',
  'REQUIRED_CAPABILITY_UNKNOWN',
  'REQUIRED_CAPABILITY_UNAVAILABLE',
  'INVARIANT_VIOLATION',
  'STORAGE_CORRUPTION_DETECTED',
]);

// Lock: blocker pointer identifiers must be delimiter-safe where applicable
export const BlockerPointerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context_key'), key: z.string().min(1).regex(DELIMITER_SAFE_ID_PATTERN, 'context_key must be delimiter-safe: [a-z0-9_-]+') }),
  z.object({ kind: z.literal('context_budget') }),
  z.object({ kind: z.literal('output_contract'), contractRef: z.string().min(1) }),
  z.object({ kind: z.literal('capability'), capability: z.enum(['delegation', 'web_browsing']) }),
  z.object({ kind: z.literal('workflow_step'), stepId: z.string().min(1).regex(DELIMITER_SAFE_ID_PATTERN, 'stepId must be delimiter-safe: [a-z0-9_-]+') }),
]);

export const BlockerSchema = z.object({
  code: BlockerCodeSchema,
  pointer: BlockerPointerSchema,
  // Locked: message is bounded by UTF-8 bytes (not code units).
  message: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= MAX_BLOCKER_MESSAGE_BYTES, {
      message: `Blocker message exceeds ${MAX_BLOCKER_MESSAGE_BYTES} bytes (UTF-8)`,
    }),
  // Locked: suggestedFix is bounded by UTF-8 bytes (not code units).
  suggestedFix: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= MAX_BLOCKER_SUGGESTED_FIX_BYTES, {
      message: `Blocker suggestedFix exceeds ${MAX_BLOCKER_SUGGESTED_FIX_BYTES} bytes (UTF-8)`,
    })
    .optional(),
});

export const BlockerReportV1Schema = z
  .object({
    blockers: z.array(BlockerSchema).min(1).max(MAX_BLOCKERS).readonly(),
  })
  .superRefine((v, ctx) => {
    // Deterministic ordering lock: (code, pointer.kind, pointer.* stable fields) ascending.
    const keyFor = (b: z.infer<typeof BlockerSchema>): string => {
      const p = b.pointer;
      let ptrStable: string;
      switch (p.kind) {
        case 'context_key':
          ptrStable = p.key;
          break;
        case 'output_contract':
          ptrStable = p.contractRef;
          break;
        case 'capability':
          ptrStable = p.capability;
          break;
        case 'workflow_step':
          ptrStable = p.stepId;
          break;
        case 'context_budget':
          ptrStable = '';
          break;
        default:
          const _exhaustive: never = p;
          ptrStable = _exhaustive;
      }
      return `${b.code}|${p.kind}|${String(ptrStable)}`;
    };

    for (let i = 1; i < v.blockers.length; i++) {
      if (keyFor(v.blockers[i - 1]!) > keyFor(v.blockers[i]!)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'blockers must be deterministically sorted',
          path: ['blockers'],
        });
        break;
      }
    }
  });

export type BlockerV1 = z.infer<typeof BlockerSchema>;
export type BlockerReportV1 = z.infer<typeof BlockerReportV1Schema>;
