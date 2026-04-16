/**
 * Knowledge Graph: ts-morph Indexer
 *
 * Walks WorkRail's TypeScript source files and populates the DuckDB graph.
 *
 * Why ts-morph over tree-sitter: ts-morph wraps the real TypeScript Compiler API.
 * getModuleSpecifierSourceFile() resolves .js imports to actual .ts files with
 * full type information -- a generic parser cannot do this reliably.
 *
 * Why skipAddingFilesFromTsConfig: we control which files to index via glob;
 * tsconfig is used only for compiler options (path resolution, module config).
 *
 * Invariants:
 * - All node IDs are normalizeNodeId(srcDir, absolutePath) -- relative to srcDir,
 *   .js suffix replaced with .ts, forward slashes.
 * - External imports (getModuleSpecifierSourceFile() returns null) are skipped.
 * - CLI command extraction is scoped to cli.ts only to avoid false positives.
 * - Command names are trimmed to the first word (strips Commander arg syntax like <file>).
 */

import * as path from 'path';
import { Project, SyntaxKind } from 'ts-morph';
import type { DuckDBConnection } from './db.js';
import { insertNode, insertEdge } from './db.js';
import { normalizeNodeId } from './types.js';
import type { IndexResult, IndexError } from './types.js';

export type IndexerResult =
  | { readonly ok: true; readonly value: IndexResult }
  | { readonly ok: false; readonly error: IndexError };

/**
 * Index all TypeScript source files under srcDir into the provided DB connection.
 *
 * @param srcDir    Absolute path to the source directory (e.g. /project/src)
 * @param repoRoot  Absolute path to the repo root (contains tsconfig.json)
 * @param cliFile   Absolute path to cli.ts for CLI command extraction
 * @param connection DuckDB connection with schema already created
 */
export async function runIndexer(
  srcDir: string,
  repoRoot: string,
  cliFile: string,
  connection: DuckDBConnection,
): Promise<IndexerResult> {
  try {
    const project = new Project({
      tsConfigFilePath: path.join(repoRoot, 'tsconfig.json'),
      // We add files explicitly; tsconfig's include/exclude is for compilation only
      skipAddingFilesFromTsConfig: true,
    });

    project.addSourceFilesAtPaths(path.join(srcDir, '**/*.ts'));

    const sourceFiles = project.getSourceFiles();
    let nodeCount = 0;
    let edgeCount = 0;
    let skippedExternalImports = 0;

    for (const sourceFile of sourceFiles) {
      const absolutePath = sourceFile.getFilePath();
      const nodeId = normalizeNodeId(srcDir, absolutePath);

      // Emit a 'file' node for every source file
      await insertNode(connection, nodeId, nodeId, nodeId, 'file', null);
      nodeCount++;

      // Emit 'import' edges for each import declaration
      for (const importDecl of sourceFile.getImportDeclarations()) {
        const resolvedFile = importDecl.getModuleSpecifierSourceFile();

        if (resolvedFile === undefined) {
          // External import (node_modules, node: builtins, etc.) -- skip
          skippedExternalImports++;
          continue;
        }

        const resolvedPath = resolvedFile.getFilePath();

        // Skip if the resolved file is outside srcDir (e.g. resolves into node_modules types)
        if (!resolvedPath.startsWith(srcDir + path.sep)) {
          skippedExternalImports++;
          continue;
        }

        const toId = normalizeNodeId(srcDir, resolvedPath);
        const line = importDecl.getStartLineNumber();

        await insertEdge(connection, nodeId, toId, 'import', line);
        edgeCount++;
      }
    }

    // CLI command extraction: scoped to cli.ts only
    const cliSource = project.getSourceFile(cliFile);
    if (cliSource !== undefined) {
      const callExprs = cliSource.getDescendantsOfKind(SyntaxKind.CallExpression);

      for (const callExpr of callExprs) {
        const callee = callExpr.getExpression();

        // Match: <expr>.command('<name>') where first arg is a string literal
        if (
          callee.getKind() === SyntaxKind.PropertyAccessExpression &&
          callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName() === 'command'
        ) {
          const args = callExpr.getArguments();
          if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
            const rawName = args[0].asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
            // Strip Commander argument syntax: 'validate <file>' -> 'validate'
            const commandName = rawName.split(' ')[0];
            const commandId = `cli:${commandName}` as ReturnType<typeof normalizeNodeId>;
            const cliFileId = normalizeNodeId(srcDir, cliFile);

            await insertNode(connection, commandId, cliFileId, commandName, 'cli_command', null);
            nodeCount++;
          }
        }
      }
    }

    return { ok: true, value: { nodeCount, edgeCount, skippedExternalImports } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'indexer_error', message } };
  }
}
