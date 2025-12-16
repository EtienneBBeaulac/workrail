/**
 * Brand helper for "parse, don't validate".
 *
 * A branded type proves validation happened at a boundary.
 * Brands are erased at runtime (zero cost).
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
