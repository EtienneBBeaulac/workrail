import type { Project } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

const FORBIDDEN_V2_FIELDS = new Set(['keyring', 'hmac', 'base64url', 'base32', 'bech32m']);

type Finding =
  | {
      readonly kind: 'forbidden_v2_field_access';
      readonly filePath: string;
      readonly line: number;
      readonly column: number;
      readonly field: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'forbidden_v2_object_property';
      readonly filePath: string;
      readonly line: number;
      readonly column: number;
      readonly field: string;
      readonly detail: string;
    };

function shouldSkipFile(filePath: string): boolean {
  return filePath.includes('/dist/') || filePath.includes('/node_modules/') || filePath.includes('/.worktrees/');
}

function positionFor(node: Node) {
  const sourceFile = node.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return { filePath: sourceFile.getFilePath(), line, column };
}

function isV2Access(expr: import('ts-morph').Expression): boolean {
  // Match something like: ctx.v2.<field> or <anything>.v2.<field>
  if (!Node.isPropertyAccessExpression(expr)) return false;
  const inner = expr.getExpression();
  return Node.isPropertyAccessExpression(inner) && inner.getName() === 'v2';
}

export async function runGuardMod(args: { readonly project: Project }): Promise<void> {
  const findings: Finding[] = [];

  for (const sf of args.project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (shouldSkipFile(filePath)) continue;

    // Guard: forbid ctx.v2.<loosePort>
    for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const field = pa.getName();
      if (!FORBIDDEN_V2_FIELDS.has(field)) continue;
      if (!isV2Access(pa)) continue;

      const { filePath: fp, line, column } = positionFor(pa);
      findings.push({
        kind: 'forbidden_v2_field_access',
        filePath: fp,
        line,
        column,
        field,
        detail: `Forbidden v2 field access: use v2.tokenCodecPorts (or a Pick<...> capability) instead of v2.${field}`,
      });
    }

    // Guard: forbid v2: { keyring/hmac/base64url/base32/bech32m } object properties
    for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (prop.getName() !== 'v2') continue;
      const init = prop.getInitializer();
      if (!init || !Node.isObjectLiteralExpression(init)) continue;

      for (const p of init.getProperties()) {
        const name = (() => {
          if (Node.isPropertyAssignment(p)) return p.getName();
          if (Node.isShorthandPropertyAssignment(p)) return p.getName();
          return null;
        })();
        if (!name || !FORBIDDEN_V2_FIELDS.has(name)) continue;

        const { filePath: fp, line, column } = positionFor(p);
        findings.push({
          kind: 'forbidden_v2_object_property',
          filePath: fp,
          line,
          column,
          field: name,
          detail: `Forbidden v2 object property '${name}': expose token deps only via tokenCodecPorts`,
        });
      }
    }
  }

  const summary = { total: findings.length };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ summary, findings }, null, 2));

  if (findings.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[codemod:guard] Found ${findings.length} forbidden v2 loose-port usages.`);
    process.exit(1);
  }
}
