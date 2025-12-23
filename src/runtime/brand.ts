/**
 * Brand helper for "parse, don't validate".
 *
 * A branded type proves validation happened at a boundary.
 *
 * NOTE: Use a string-keyed marker instead of a `unique symbol` to avoid TS4023
 * ("cannot be named") errors when Zod schemas that transform into branded types
 * are exported.
 *
 * Brands are erased at runtime (zero cost).
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };
