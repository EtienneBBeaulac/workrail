import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';

const root = resolve(__dirname, '../..');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}
function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}
function moduleReferences(source: ts.SourceFile): string[] {
  const references: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      references.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0];
      // Computed imports can conceal forbidden boundaries, so fail closed.
      references.push(argument && ts.isStringLiteral(argument) ? argument.text : '<computed-module>');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

describe('MCP model-routing ownership', () => {
  it('MCP source does not import daemon/trigger implementation or hide imports behind computed names', () => {
    const violations = sources(resolve(root, 'src/mcp')).flatMap(path => moduleReferences(parse(path)).flatMap(reference => {
      const target = reference.startsWith('.') ? relative(root, resolve(dirname(path), reference)) : reference;
      return reference === '<computed-module>' || /^(?:@anthropic-ai\/|openai(?:\/|$)|@aws-sdk\/client-bedrock)/.test(reference) || /(?:^|\/)src\/(?:daemon|trigger)\//.test(target) || /^(?:daemon|trigger)\//.test(target)
        ? [`${relative(root, path)} -> ${reference}`] : [];
    }));
    expect(violations).toEqual([]);
  });

  it('the routing core imports only schemas and has no ambient host/global configuration effects', () => {
    const source = parse(resolve(root, 'src/v2/durable-core/domain/model-selection.ts'));
    expect(moduleReferences(source).sort()).toEqual(['../schemas/session/index.js', 'zod']);
    const forbidden: string[] = [];
    const ambient = new Set(['process', 'globalThis', 'global', 'fetch', 'require', 'eval', 'Function', 'Date', 'setTimeout', 'setInterval']);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && ambient.has(node.text)) forbidden.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(forbidden).toEqual([]);
  });
});
