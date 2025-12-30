import { z } from 'zod';

/**
 * Creates a UTF-8 byte-bounded string schema.
 *
 * CRITICAL: Returns z.string().refine() ONLY.
 * NEVER wrap this in z.object() or other effects—use it as a field.
 *
 * Why: discriminatedUnion branches must be plain z.object() shapes.
 * Wrapping branches breaks discriminatedUnion and causes module-load errors.
 *
 * @param opts Configuration for the bounded string
 * @param opts.maxBytes Maximum UTF-8 bytes allowed
 * @param opts.label Human-readable field name for error messages
 * @param opts.minLength (Optional) Minimum string length in code units
 * @returns A Zod schema (ZodEffects<ZodString>) with UTF-8 byte-length enforcement
 *
 * @example
 * // Safe: use in a field, not as a wrapper
 * const schema = z.object({
 *   notes: utf8BoundedString({ maxBytes: 4096, label: 'notes', minLength: 1 })
 * });
 *
 * @example
 * // DANGEROUS: do not wrap discriminatedUnion branches
 * // ❌ WRONG:
 * const union = z.discriminatedUnion('kind', [
 *   utf8BoundedString(...).pipe(z.object({ ... }))  // BREAKS!
 * ]);
 * // ✅ CORRECT:
 * const union = z.discriminatedUnion('kind', [
 *   z.object({ field: utf8BoundedString(...) })  // Safe
 * ]);
 */
export function utf8BoundedString(opts: {
  readonly maxBytes: number;
  readonly label: string;
  readonly minLength?: number;
}): z.ZodEffects<z.ZodString, string, string> {
  const encoder = new TextEncoder();
  let schema = z.string();
  
  // Apply minLength constraint before refine if specified
  if (opts.minLength !== undefined && opts.minLength > 0) {
    schema = schema.min(opts.minLength);
  }
  
  return schema.refine(
    (s) => encoder.encode(s).length <= opts.maxBytes,
    { message: `${opts.label} exceeds ${opts.maxBytes} UTF-8 bytes` }
  );
}
