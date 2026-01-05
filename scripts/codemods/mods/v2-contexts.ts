import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

type Finding =
  | { readonly kind: 'changed'; readonly filePath: string; readonly detail: string }
  | { readonly kind: 'skipped'; readonly filePath: string; readonly detail: string };

function shouldSkipFile(filePath: string): boolean {
  return filePath.includes('/dist/') || filePath.includes('/node_modules/') || filePath.includes('/.worktrees/');
}

function findTokensIndexImport(sf: SourceFile): import('ts-morph').ImportDeclaration | null {
  const imports = sf.getImportDeclarations();
  for (const decl of imports) {
    const spec = decl.getModuleSpecifierValue();
    if (spec.endsWith('/v2/durable-core/tokens/index.js') || spec.endsWith('/v2/durable-core/tokens/index')) return decl;
    if (spec.includes('/v2/durable-core/tokens/index')) return decl;
  }
  return null;
}

function ensureImportUnsafeTokenCodecPorts(sf: SourceFile): boolean {
  const decl = findTokensIndexImport(sf);
  if (!decl) return false;

  const named = decl.getNamedImports();
  const already = named.some((n) => n.getName() === 'unsafeTokenCodecPorts');
  if (already) return true;

  decl.addNamedImport('unsafeTokenCodecPorts');
  return true;
}

function getPropValueExprText(obj: import('ts-morph').ObjectLiteralExpression, propName: string): string | null {
  for (const p of obj.getProperties()) {
    if (Node.isPropertyAssignment(p) && p.getName() === propName) {
      const init = p.getInitializer();
      return init ? init.getText() : null;
    }
    if (Node.isShorthandPropertyAssignment(p) && p.getName() === propName) {
      return p.getName();
    }
  }
  return null;
}

function hasProp(obj: import('ts-morph').ObjectLiteralExpression, propName: string): boolean {
  return obj.getProperties().some((p) => {
    if (Node.isPropertyAssignment(p)) return p.getName() === propName;
    if (Node.isShorthandPropertyAssignment(p)) return p.getName() === propName;
    return false;
  });
}

function maybeAddTokenCodecPortsToV2Object(sf: SourceFile): { changed: boolean; findings: Finding[] } {
  let changed = false;
  const findings: Finding[] = [];

  const importsOk = ensureImportUnsafeTokenCodecPorts(sf);

  for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (prop.getName() !== 'v2') continue;

    const init = prop.getInitializer();
    if (!init || !Node.isObjectLiteralExpression(init)) continue;

    if (hasProp(init, 'tokenCodecPorts')) continue;

    const keyring = getPropValueExprText(init, 'keyring');
    const hmac = getPropValueExprText(init, 'hmac');
    const base64url = getPropValueExprText(init, 'base64url');
    const base32 = getPropValueExprText(init, 'base32');
    const bech32m = getPropValueExprText(init, 'bech32m');

    if (!keyring || !hmac || !base64url || !base32 || !bech32m) continue;

    if (!importsOk) {
      findings.push({
        kind: 'skipped',
        filePath: sf.getFilePath(),
        detail: 'Found v2 object missing tokenCodecPorts but no tokens index import to attach unsafeTokenCodecPorts; skipped',
      });
      continue;
    }

    // Insert near crypto/keyring/hmac cluster: after crypto if present, else after keyring.
    const insertionIndex = (() => {
      const props = init.getProperties();
      const idxCrypto = props.findIndex((p) => Node.isPropertyAssignment(p) && p.getName() === 'crypto');
      if (idxCrypto !== -1) return idxCrypto + 1;
      const idxKeyring = props.findIndex((p) => Node.isPropertyAssignment(p) && p.getName() === 'keyring');
      if (idxKeyring !== -1) return idxKeyring + 1;
      return props.length;
    })();

    init.insertPropertyAssignment(insertionIndex, {
      name: 'tokenCodecPorts',
      initializer: `unsafeTokenCodecPorts({ keyring: ${keyring}, hmac: ${hmac}, base64url: ${base64url}, base32: ${base32}, bech32m: ${bech32m} })`,
    });

    changed = true;
    findings.push({ kind: 'changed', filePath: sf.getFilePath(), detail: 'Inserted tokenCodecPorts into v2 context object' });
  }

  return { changed, findings };
}

export async function runV2ContextsMod(args: { readonly project: Project; readonly write: boolean }): Promise<void> {
  const allFindings: Finding[] = [];
  const touched = new Set<string>();

  for (const sf of args.project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (shouldSkipFile(filePath)) continue;

    const res = maybeAddTokenCodecPortsToV2Object(sf);
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

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ summary, findings: allFindings }, null, 2));
}
