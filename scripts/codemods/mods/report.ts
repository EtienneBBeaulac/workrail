import { Node, type Project, SyntaxKind } from 'ts-morph';

type ReportItem =
  | {
      readonly kind: 'token_callsite_needs_migration';
      readonly filePath: string;
      readonly line: number;
      readonly column: number;
      readonly callee: 'parseTokenV1Binary' | 'verifyTokenSignatureV1Binary' | 'signTokenV1Binary';
      readonly detail: string;
    }
  | {
      readonly kind: 'v2_context_missing_tokenCodecPorts';
      readonly filePath: string;
      readonly line: number;
      readonly column: number;
      readonly detail: string;
    };

function positionFor(node: Node) {
  const sourceFile = node.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return { filePath: sourceFile.getFilePath(), line, column };
}

function isIdentifierNamed(node: Node | undefined, name: string): boolean {
  return !!node && Node.isIdentifier(node) && node.getText() === name;
}

function reportTokenCallsites(project: Project): ReportItem[] {
  const results: ReportItem[] = [];

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();

    // Skip generated/output directories if they slipped into the project.
    if (filePath.includes('/dist/') || filePath.includes('/node_modules/') || filePath.includes('/.worktrees/')) {
      continue;
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      const calleeText = expr.getText();
      const args = call.getArguments();

      if (calleeText === 'parseTokenV1Binary' && args.length === 3) {
        if (isIdentifierNamed(args[1], 'bech32m') && isIdentifierNamed(args[2], 'base32')) {
          const { line, column } = sf.getLineAndColumnAtPos(call.getStart());
          results.push({
            kind: 'token_callsite_needs_migration',
            filePath,
            line,
            column,
            callee: 'parseTokenV1Binary',
            detail: 'Expected parseTokenV1Binary(token, { bech32m, base32 })',
          });
        }
      }

      if (calleeText === 'verifyTokenSignatureV1Binary' && args.length === 4) {
        if (isIdentifierNamed(args[1], 'keyring') && isIdentifierNamed(args[2], 'hmac') && isIdentifierNamed(args[3], 'base64url')) {
          const { line, column } = sf.getLineAndColumnAtPos(call.getStart());
          results.push({
            kind: 'token_callsite_needs_migration',
            filePath,
            line,
            column,
            callee: 'verifyTokenSignatureV1Binary',
            detail: 'Expected verifyTokenSignatureV1Binary(parsed, { keyring, hmac, base64url })',
          });
        }
      }

      if (calleeText === 'signTokenV1Binary' && args.length === 6) {
        // payload, keyring, hmac, base64url, bech32m, base32
        if (
          isIdentifierNamed(args[1], 'keyring') &&
          isIdentifierNamed(args[2], 'hmac') &&
          isIdentifierNamed(args[3], 'base64url') &&
          isIdentifierNamed(args[4], 'bech32m') &&
          isIdentifierNamed(args[5], 'base32')
        ) {
          const { line, column } = sf.getLineAndColumnAtPos(call.getStart());
          results.push({
            kind: 'token_callsite_needs_migration',
            filePath,
            line,
            column,
            callee: 'signTokenV1Binary',
            detail: 'Expected signTokenV1Binary(payload, tokenCodecPorts)',
          });
        }
      }
    }
  }

  return results;
}

function reportV2ContextsMissingTokenCodecPorts(project: Project): ReportItem[] {
  const results: ReportItem[] = [];

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (filePath.includes('/dist/') || filePath.includes('/node_modules/') || filePath.includes('/.worktrees/')) {
      continue;
    }

    // Heuristic: find object literals assigned to a property named "v2".
    // We only report when we see all 5 ports AND no tokenCodecPorts property.
    for (const propAccess of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const name = propAccess.getName();
      if (name !== 'v2') continue;

      const init = propAccess.getInitializer();
      if (!init || !Node.isObjectLiteralExpression(init)) continue;

      const props = init.getProperties();
      const has = (propName: string) =>
        props.some((p) => {
          if (Node.isPropertyAssignment(p)) return p.getName() === propName;
          if (Node.isShorthandPropertyAssignment(p)) return p.getName() === propName;
          return false;
        });

      const hasAll =
        has('keyring') && has('hmac') && has('base64url') && has('base32') && has('bech32m');
      const hasGrouped = has('tokenCodecPorts');

      if (hasAll && !hasGrouped) {
        const { filePath: fp, line, column } = positionFor(propAccess);
        results.push({
          kind: 'v2_context_missing_tokenCodecPorts',
          filePath: fp,
          line,
          column,
          detail: 'v2 object has keyring/hmac/base64url/base32/bech32m but no tokenCodecPorts',
        });
      }
    }
  }

  return results;
}

export async function runReportMod(args: { readonly project: Project }): Promise<void> {
  const tokenCalls = reportTokenCallsites(args.project);
  const v2Contexts = reportV2ContextsMissingTokenCodecPorts(args.project);
  const all: readonly ReportItem[] = [...tokenCalls, ...v2Contexts].sort((a, b) =>
    a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath)
  );

  const summary = {
    token_callsite_needs_migration: tokenCalls.length,
    v2_context_missing_tokenCodecPorts: v2Contexts.length,
    total: all.length,
  };

  console.log(JSON.stringify({ summary, findings: all }, null, 2));
}
