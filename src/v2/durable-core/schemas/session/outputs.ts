import { z } from 'zod';
import { MAX_OUTPUT_NOTES_MARKDOWN_BYTES, SHA256_DIGEST_PATTERN } from '../../constants.js';
import { utf8ByteLength } from '../lib/utf8-byte-length.js';

const sha256DigestSchema = z
  .string()
  .regex(SHA256_DIGEST_PATTERN, 'Expected sha256:<64 hex chars>')
  .describe('sha256 digest in WorkRail v2 format');

export const OutputChannelSchema = z.enum(['recap', 'artifact']);

export const NotesPayloadV1Schema = z.object({
  payloadKind: z.literal('notes'),
  // Locked: notesMarkdown is bounded by UTF-8 bytes (not code units).
  // NOTE: Keep the discriminator branch as a ZodObject (discriminatedUnion requires it),
  // so we refine the string field instead of wrapping the object in effects.
  notesMarkdown: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= MAX_OUTPUT_NOTES_MARKDOWN_BYTES, {
      message: `notesMarkdown exceeds max ${MAX_OUTPUT_NOTES_MARKDOWN_BYTES} UTF-8 bytes`,
    }),
});

export const ArtifactRefPayloadV1Schema = z.object({
  payloadKind: z.literal('artifact_ref'),
  sha256: sha256DigestSchema,
  contentType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  // Optional inline artifact content (for small artifacts < 1KB)
  // Large artifacts omit this and use external blob store
  content: z.unknown().optional(),
});

export const OutputPayloadV1Schema = z.discriminatedUnion('payloadKind', [NotesPayloadV1Schema, ArtifactRefPayloadV1Schema]);

export const NodeOutputAppendedDataV1Schema = z
  .object({
    outputId: z.string().min(1),
    supersedesOutputId: z.string().min(1).optional(),
    outputChannel: OutputChannelSchema,
    payload: OutputPayloadV1Schema,
  })
  .superRefine((v, ctx) => {
    // Locked: recap channel must use notes payload.
    if (v.outputChannel === 'recap' && v.payload.payloadKind !== 'notes') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'outputChannel=recap requires payloadKind=notes',
        path: ['payload', 'payloadKind'],
      });
    }
  });
