import type { Brand } from '../../../runtime/brand.js';

/**
 * Branded type: TokenStringV1 (opaque signed token string).
 *
 * Footgun prevented:
 * - Prevents accidentally treating arbitrary strings as signed tokens
 * - Makes token passing explicit in APIs
 *
 * How to construct:
 * - Only from token signing functions (e.g., signTokenV1)
 * - Do not construct manually without signature verification
 *
 * Example:
 * ```typescript
 * const token = asTokenStringV1('st1qpzry9x8gf2tvdw0s3jn54khce6mua7l...');
 * ```
 */
export type TokenStringV1 = Brand<string, 'v2.TokenStringV1'>;

export function asTokenStringV1(value: string): TokenStringV1 {
  return value as TokenStringV1;
}
