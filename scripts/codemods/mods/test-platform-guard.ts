import type { Project } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';
import path from 'path';

type Violation = {
  readonly kind: 'git_shell_chain' | 'invalid_file_url_template' | 'posix_tmp_literal' | 'string_git_exec';
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly detail: string;
};

function shouldSkipFile(filePath: string): boolean {
  return (
    filePath.includes(`${path.sep}node_modules${path.sep}`) ||
    filePath.includes(`${path.sep}dist${path.sep}`) ||
    filePath.includes(`${path.sep}.worktrees${path.sep}`)
  );
}

function positionFor(node: import('ts-morph').Node) {
  const sourceFile = node.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return { filePath: sourceFile.getFilePath(), line, column };
}

function scanTextLines(filePath: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;

    // Ban shell chaining (brittle on Windows)
    if (lineText.includes('&& git ')) {
      violations.push({
        kind: 'git_shell_chain',
        filePath,
        line: i + 1,
        column: lineText.indexOf('&& git ') + 1,
        detail: lineText.trim(),
      });
    }

    // Ban invalid Windows file URL templates
    if (lineText.includes('file://${')) {
      violations.push({
        kind: 'invalid_file_url_template',
        filePath,
        line: i + 1,
        column: lineText.indexOf('file://${') + 1,
        detail: lineText.trim(),
      });
    }

    // Intentionally narrow: only block /tmp/ literals (not /etc for URL-security tests).
    if (lineText.includes("'/tmp/") || lineText.includes('"/tmp/')) {
      const idx = Math.max(lineText.indexOf("'/tmp/"), lineText.indexOf('"/tmp/'));
      violations.push({
        kind: 'posix_tmp_literal',
        filePath,
        line: i + 1,
        column: idx + 1,
        detail: lineText.trim(),
      });
    }
  }

  return violations;
}

function extractStaticText(expr: import('ts-morph').Expression): string {
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getLiteralText();
  }

  if (Node.isTemplateExpression(expr)) {
    const head = expr.getHead().getLiteralText();
    const tails = expr.getTemplateSpans().map((s) => s.getLiteral().getLiteralText()).join('');
    return head + tails;
  }

  if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getText() === '+') {
    return extractStaticText(expr.getLeft()) + extractStaticText(expr.getRight());
  }

  return '';
}

function isStringGitExecCall(call: import('ts-morph').CallExpression): boolean {
  const callee = call.getExpression();

  // Identifier form: exec(...), execSync(...), execAsync(...)
  if (!Node.isIdentifier(callee)) return false;
  if (callee.getText() !== 'exec' && callee.getText() !== 'execSync' && callee.getText() !== 'execAsync') return false;

  const arg0 = call.getArguments()[0];
  if (!arg0 || !Node.isExpression(arg0)) return false;

  const staticText = extractStaticText(arg0);
  if (staticText.trim().length === 0) return false;

  // Match `git` as a command token, not `.git` in URLs/filenames.
  const token = /(^|\s|[;&|()])git(\s|$)/;
  return token.test(staticText.trim());
}

function scanStringGitExec(sf: import('ts-morph').SourceFile): Violation[] {
  const violations: Violation[] = [];

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isStringGitExecCall(call)) continue;

    const { filePath, line, column } = positionFor(call);
    violations.push({
      kind: 'string_git_exec',
      filePath,
      line,
      column,
      detail: call.getText().slice(0, 200),
    });
  }

  return violations;
}

export async function runTestPlatformGuardMod(args: { readonly project: Project }): Promise<void> {
  const violations: Violation[] = [];

  for (const sf of args.project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (shouldSkipFile(filePath)) continue;

    // Only guard tests.
    if (!filePath.includes(`${path.sep}tests${path.sep}`)) continue;

    const text = sf.getFullText();
    violations.push(...scanTextLines(filePath, text));
    violations.push(...scanStringGitExec(sf));
  }

  const summary = {
    total: violations.length,
    git_shell_chain: violations.filter((v) => v.kind === 'git_shell_chain').length,
    invalid_file_url_template: violations.filter((v) => v.kind === 'invalid_file_url_template').length,
    posix_tmp_literal: violations.filter((v) => v.kind === 'posix_tmp_literal').length,
    string_git_exec: violations.filter((v) => v.kind === 'string_git_exec').length,
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ summary, violations }, null, 2));

  if (violations.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[codemod:test-platform-guard] Found ${violations.length} cross-platform hazards in tests/.`);
    process.exit(1);
  }
}
