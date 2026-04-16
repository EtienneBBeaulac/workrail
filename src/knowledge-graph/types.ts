/**
 * Knowledge Graph: Domain Types
 *
 * Why branded NodeId: prevents passing a raw string where a node ID is required.
 * The brand is erased at runtime (no overhead) but enforced at compile time.
 *
 * Why union kinds instead of enums: discriminated unions are exhaustiveness-safe
 * and don't require a runtime import.
 */

import * as path from 'path';

// ---------------------------------------------------------------------------
// Branded ID type
// ---------------------------------------------------------------------------

/** A path-relative node identifier, normalized to forward slashes + .ts extension. */
export type NodeId = string & { readonly __brand: 'NodeId' };

// ---------------------------------------------------------------------------
// Domain kinds
// ---------------------------------------------------------------------------

export type NodeKind = 'file' | 'cli_command';

export type EdgeKind = 'import';

// ---------------------------------------------------------------------------
// Domain interfaces (immutable)
// ---------------------------------------------------------------------------

export interface Node {
  readonly id: NodeId;
  readonly file: string;
  readonly name: string;
  readonly kind: NodeKind;
  readonly scope: string | null;
}

export interface Edge {
  readonly from_id: NodeId;
  readonly to_id: NodeId;
  readonly kind: EdgeKind;
  readonly line: number | null;
}

// ---------------------------------------------------------------------------
// Result types for buildIndex
// ---------------------------------------------------------------------------

export interface IndexResult {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly skippedExternalImports: number;
}

export type IndexErrorKind =
  | { readonly kind: 'db_error'; readonly message: string }
  | { readonly kind: 'indexer_error'; readonly message: string };

export type IndexError = IndexErrorKind;

export type QueryError =
  | { readonly kind: 'db_error'; readonly message: string }
  | { readonly kind: 'not_found' };

// ---------------------------------------------------------------------------
// Path normalization (invariant: single function, used everywhere)
// ---------------------------------------------------------------------------

/**
 * Converts an absolute TypeScript file path to a canonical node ID.
 *
 * Why: ts-morph returns absolute paths; queries use srcDir-relative IDs.
 * Why .js -> .ts: this repo imports with .js suffixes; ts-morph resolves to .ts.
 * Applied once at ingestion and identically at query time.
 */
export function normalizeNodeId(srcDir: string, absolutePath: string): NodeId {
  const rel = path.relative(srcDir, absolutePath);
  // Normalize OS path separators to forward slash
  const normalized = rel.split(path.sep).join('/');
  // Strip .js suffix if present (ts-morph resolves .js imports to .ts files)
  return normalized.replace(/\.js$/, '.ts') as NodeId;
}
