/**
 * Shared error type for all v2 projection functions.
 * 
 * Centralized to maintain consistency across the projection layer.
 */
export type ProjectionError =
  | { readonly code: 'PROJECTION_INVARIANT_VIOLATION'; readonly message: string }
  | { readonly code: 'PROJECTION_CORRUPTION_DETECTED'; readonly message: string };
