import fs from 'fs/promises';
import path from 'path';
import type { WorkflowDefinition } from '../../types/workflow-definition.js';

// _____________________________________________________________________________
// Shared File Discovery
// _____________________________________________________________________________

/**
 * Find all JSON files in a directory recursively.
 *
 * Shared pure function used by both FileWorkflowStorage and the raw file scanner.
 * Philosophy: "Single source of truth" -- not reimplemented.
 */
export async function findWorkflowJsonFiles(baseDirReal: string): Promise<string[]> {
  const files: string[] = [];

  async function scan(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
    const subDirs = entries.filter((e) => e.isDirectory() && e.name !== 'examples');

    for (const f of jsonFiles) {
      files.push(path.join(currentDir, f.name));
    }

    // Fan out subdirectory scans in parallel. Per-entry catch isolates ENOENT
    // (directory removed between readdir and scan) so one disappearing dir
    // does not abort the entire scan.
    await Promise.all(
      subDirs.map((d) =>
        scan(path.join(currentDir, d.name)).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }),
      ),
    );
  }

  await scan(baseDirReal);
  // Sort after parallel scan to ensure deterministic ordering regardless of
  // I/O completion order.
  files.sort();
  return files;
}

// _____________________________________________________________________________
// Raw Workflow File Types
// _____________________________________________________________________________

export type VariantKind = 'lean' | 'v2' | 'agentic' | 'standard';

/**
 * A successfully parsed workflow file with metadata.
 */
export interface ParsedRawWorkflowFile {
  readonly kind: 'parsed';
  readonly filePath: string;
  readonly relativeFilePath: string;
  readonly definition: WorkflowDefinition;
  readonly variantKind: VariantKind;
}

/**
 * A file that exists but could not be parsed (invalid JSON, missing structure, etc).
 */
export interface UnparseableRawWorkflowFile {
  readonly kind: 'unparseable';
  readonly filePath: string;
  readonly relativeFilePath: string;
  readonly error: string;
}

export type RawWorkflowFile = ParsedRawWorkflowFile | UnparseableRawWorkflowFile;

// _____________________________________________________________________________
// Raw File Scanner
// _____________________________________________________________________________

/**
 * Scan raw workflow files from a directory.
 *
 * Returns all discovered .json files, both parsed and unparseable.
 * Unparseable files are never silently dropped -- they are reported so the
 * validator can enforce that invalid variant files fail CI.
 *
 * Detects variant from filename:
 * - `.v2.json` -> 'v2' variant
 * - `.agentic.json` -> 'agentic' variant
 * - `.json` (no variant marker) -> 'standard' variant
 */
export async function scanRawWorkflowFiles(baseDirReal: string): Promise<RawWorkflowFile[]> {
  const allJsonFiles = await findWorkflowJsonFiles(baseDirReal);
  const results: RawWorkflowFile[] = [];

  for (const filePath of allJsonFiles) {
    const relativeFilePath = path.relative(baseDirReal, filePath);

    try {
      // Enforce file size limit
      const stats = await fs.stat(filePath);
      if (stats.size > 1_000_000) {
        results.push({
          kind: 'unparseable',
          filePath,
          relativeFilePath,
          error: `File exceeds size limit (1MB): ${stats.size} bytes`,
        });
        continue;
      }

      // Read and parse
      const raw = await fs.readFile(filePath, 'utf-8');
      const definition = JSON.parse(raw) as unknown;

      // Validate structure
      if (!isWorkflowDefinition(definition)) {
        results.push({
          kind: 'unparseable',
          filePath,
          relativeFilePath,
          error: 'Invalid workflow definition structure (missing required fields)',
        });
        continue;
      }

      // Detect variant from filename
      const variantKind = detectVariantKind(relativeFilePath);

      results.push({
        kind: 'parsed',
        filePath,
        relativeFilePath,
        definition,
        variantKind,
      });
    } catch (e) {
      results.push({
        kind: 'unparseable',
        filePath,
        relativeFilePath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}

/**
 * Detect variant kind from filename.
 *
 * Rules:
 * - Contains `.lean.` -> 'lean'
 * - Contains `.v2.` -> 'v2'
 * - Contains `.agentic.` -> 'agentic'
 * - Otherwise -> 'standard'
 */
function detectVariantKind(relativeFilePath: string): VariantKind {
  const normalized = relativeFilePath.replace(/\\/g, '/'); // normalize path separators
  if (normalized.includes('.lean.')) return 'lean';
  if (normalized.includes('.v2.')) return 'v2';
  if (normalized.includes('.agentic.')) return 'agentic';
  return 'standard';
}

/**
 * Type guard: check if an object looks like a WorkflowDefinition.
 */
function isWorkflowDefinition(obj: unknown): obj is WorkflowDefinition {
  if (!obj || typeof obj !== 'object') return false;
  const def = obj as Record<string, unknown>;
  // Minimal structure check: must have id and either prompt/promptBlocks/templateCall on steps
  return typeof def.id === 'string' && Array.isArray(def.steps);
}
