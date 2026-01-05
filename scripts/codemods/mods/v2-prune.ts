import type { Project, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

type Finding =
  | { readonly kind: 'changed'; readonly filePath: string; readonly detail: string }
  | { readonly kind: 'skipped'; readonly filePath: string; readonly detail: string };

const PRUNE_PROPS = new Set(['keyring', 'hmac', 'base64url', 'base32', 'bech32m']);

function shouldSkipFile(filePath: string): boolean {
  return filePath.includes('/dist/') || filePath.includes('/node_modules/') || filePath.includes('/.worktrees/');
}

function pruneV2Object(sf: SourceFile): { changed: boolean; findings: Finding[] } {
  let changed = false;
  const findings: Finding[] = [];

  // IMPORTANT: collect v2 property assignments up-front.
  // We mutate (remove) descendant nodes in this pass; iterating all PropertyAssignments would
  // later hit removed nodes and throw.
  const v2Props = sf
    .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    .filter((p) => p.getName() === 'v2');

  for (const prop of v2Props) {

    const init = prop.getInitializer();
    if (!init || !Node.isObjectLiteralExpression(init)) continue;

    // Only prune when tokenCodecPorts is present; otherwise this may be a non-token v2 shape.
    const hasTokenCodecPorts = init.getProperties().some((p) => {
      if (Node.isPropertyAssignment(p)) return p.getName() === 'tokenCodecPorts';
      if (Node.isShorthandPropertyAssignment(p)) return p.getName() === 'tokenCodecPorts';
      return false;
    });
    if (!hasTokenCodecPorts) continue;

    const props = init.getProperties();
    for (const p of props) {
      const name = (() => {
        if (Node.isPropertyAssignment(p)) return p.getName();
        if (Node.isShorthandPropertyAssignment(p)) return p.getName();
        return null;
      })();
      if (!name) continue;
      if (!PRUNE_PROPS.has(name)) continue;

      p.remove();
      changed = true;
    }

    if (changed) {
      findings.push({
        kind: 'changed',
        filePath: sf.getFilePath(),
        detail: 'Pruned loose token ports from v2 object literal',
      });
    }
  }

  return { changed, findings };
}

export async function runV2PruneMod(args: { readonly project: Project; readonly write: boolean }): Promise<void> {
  const allFindings: Finding[] = [];
  const touched = new Set<string>();

  for (const sf of args.project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (shouldSkipFile(filePath)) continue;

    const res = pruneV2Object(sf);
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
