import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

type Finding =
  | {
      readonly kind: 'changed';
      readonly filePath: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'skipped';
      readonly filePath: string;
      readonly detail: string;
    };

function shouldSkipFile(filePath: string): boolean {
  return filePath.includes('/dist/') || filePath.includes('/node_modules/') || filePath.includes('/.worktrees/');
}

function isIdentifierNamed(node: Node | undefined, name: string): boolean {
  return !!node && Node.isIdentifier(node) && node.getText() === name;
}

function hasTokenCodecPortsIdentifierInScope(call: Node): boolean {
  const sf = call.getSourceFile();
  // Fast syntactic heuristic: if file contains an identifier tokenCodecPorts, assume it exists in scope somewhere.
  // We intentionally keep this conservative to avoid introducing broken edits.
  return sf.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === 'tokenCodecPorts');
}

function migrateInFile(sf: SourceFile): { changed: boolean; findings: Finding[] } {
  let changed = false;
  const findings: Finding[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const calleeText = expr.getText();
    const args = call.getArguments();

    // parseTokenV1Binary(token, bech32m, base32) -> parseTokenV1Binary(token, { bech32m, base32 })
    if (calleeText === 'parseTokenV1Binary' && args.length === 3) {
      if (isIdentifierNamed(args[1], 'bech32m') && isIdentifierNamed(args[2], 'base32')) {
        call.removeArgument(2);
        call.removeArgument(1);
        call.insertArgument(1, '{ bech32m, base32 }');
        changed = true;
        findings.push({ kind: 'changed', filePath: sf.getFilePath(), detail: 'Migrated parseTokenV1Binary callsite' });
      }
    }

    // verifyTokenSignatureV1Binary(parsed, keyring, hmac, base64url) -> verifyTokenSignatureV1Binary(parsed, { keyring, hmac, base64url })
    if (calleeText === 'verifyTokenSignatureV1Binary' && args.length === 4) {
      if (isIdentifierNamed(args[1], 'keyring') && isIdentifierNamed(args[2], 'hmac') && isIdentifierNamed(args[3], 'base64url')) {
        call.removeArgument(3);
        call.removeArgument(2);
        call.removeArgument(1);
        call.insertArgument(1, '{ keyring, hmac, base64url }');
        changed = true;
        findings.push({ kind: 'changed', filePath: sf.getFilePath(), detail: 'Migrated verifyTokenSignatureV1Binary callsite' });
      }
    }

    // signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32) -> signTokenV1Binary(payload, tokenCodecPorts)
    // NOTE: we only do this when tokenCodecPorts appears to exist in the file; otherwise we skip.
    if (calleeText === 'signTokenV1Binary' && args.length === 6) {
      if (
        isIdentifierNamed(args[1], 'keyring') &&
        isIdentifierNamed(args[2], 'hmac') &&
        isIdentifierNamed(args[3], 'base64url') &&
        isIdentifierNamed(args[4], 'bech32m') &&
        isIdentifierNamed(args[5], 'base32')
      ) {
        if (!hasTokenCodecPortsIdentifierInScope(call)) {
          findings.push({
            kind: 'skipped',
            filePath: sf.getFilePath(),
            detail: 'Found old signTokenV1Binary callsite but no tokenCodecPorts identifier detected; skipped',
          });
          continue;
        }

        call.removeArgument(5);
        call.removeArgument(4);
        call.removeArgument(3);
        call.removeArgument(2);
        call.removeArgument(1);
        call.insertArgument(1, 'tokenCodecPorts');
        changed = true;
        findings.push({ kind: 'changed', filePath: sf.getFilePath(), detail: 'Migrated signTokenV1Binary callsite' });
      }
    }
  }

  return { changed, findings };
}

export async function runTokenCallsMod(args: { readonly project: Project; readonly write: boolean }): Promise<void> {
  const allFindings: Finding[] = [];
  const touched = new Set<string>();

  for (const sf of args.project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (shouldSkipFile(filePath)) continue;

    const res = migrateInFile(sf);
    if (res.changed) touched.add(filePath);
    allFindings.push(...res.findings);
  }

  if (args.write && touched.size > 0) {
    await args.project.save();
  }

  const summary = {
    changedFiles: touched.size,
    changed: allFindings.filter((f) => f.kind === 'changed').length,
    skipped: allFindings.filter((f) => f.kind === 'skipped').length,
  };

  // Intentionally JSON for easy piping/CI usage.
  // (No legacy/deprecation mentions; this is an AST migration tool.)
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ summary, findings: allFindings }, null, 2));
}
