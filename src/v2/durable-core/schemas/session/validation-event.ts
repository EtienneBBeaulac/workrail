import { z } from 'zod';
import {
  MAX_VALIDATION_ISSUE_ITEM_BYTES,
  MAX_VALIDATION_SUGGESTION_ITEM_BYTES,
  MAX_VALIDATION_ISSUES_BYTES,
  MAX_VALIDATION_SUGGESTIONS_BYTES,
} from '../../constants.js';
import { utf8BoundedString } from '../lib/utf8-bounded-string.js';
import { utf8ByteLength } from '../lib/utf8-byte-length.js';

const ValidationIssueV1Schema = utf8BoundedString({
  label: 'validation issue',
  minLength: 1,
  maxBytes: MAX_VALIDATION_ISSUE_ITEM_BYTES,
});

const ValidationSuggestionV1Schema = utf8BoundedString({
  label: 'validation suggestion',
  minLength: 1,
  maxBytes: MAX_VALIDATION_SUGGESTION_ITEM_BYTES,
});

export const ValidationPerformedResultV1Schema = z
  .object({
    valid: z.boolean(),
    issues: z.array(ValidationIssueV1Schema).readonly(),
    suggestions: z.array(ValidationSuggestionV1Schema).readonly(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issuesBytes = v.issues.reduce((sum, s) => sum + utf8ByteLength(s), 0);
    if (issuesBytes > MAX_VALIDATION_ISSUES_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `validation issues exceed ${MAX_VALIDATION_ISSUES_BYTES} bytes (UTF-8)`,
        path: ['issues'],
      });
    }

    const suggestionsBytes = v.suggestions.reduce((sum, s) => sum + utf8ByteLength(s), 0);
    if (suggestionsBytes > MAX_VALIDATION_SUGGESTIONS_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `validation suggestions exceed ${MAX_VALIDATION_SUGGESTIONS_BYTES} bytes (UTF-8)`,
        path: ['suggestions'],
      });
    }
  });

export const ValidationPerformedDataV1Schema = z
  .object({
    validationId: z.string().min(1),
    attemptId: z.string().min(1),
    contractRef: z.string().min(1),
    result: ValidationPerformedResultV1Schema,
  })
  .strict();

export type ValidationPerformedDataV1 = z.infer<typeof ValidationPerformedDataV1Schema>;
export type ValidationPerformedResultV1 = z.infer<typeof ValidationPerformedResultV1Schema>;
