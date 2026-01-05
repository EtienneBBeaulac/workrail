#!/usr/bin/env npx ts-node
/* eslint-disable no-console */

import path from 'path';
import process from 'process';
import { Project } from 'ts-morph';

import { runReportMod } from './mods/report';
import { runTokenCallsMod } from './mods/token-calls';
import { runV2ContextsMod } from './mods/v2-contexts';
import { runV2PruneMod } from './mods/v2-prune';
import { runGuardMod } from './mods/guard';
import { runTestPlatformGuardMod } from './mods/test-platform-guard';

function parseArgs(argv: readonly string[]) {
  const args = argv.slice(2);

  const getFlagValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    if (!next || next.startsWith('--')) return undefined;
    return next;
  };

  return {
    mod: getFlagValue('--mod') ?? 'report',
    tsconfig: getFlagValue('--tsconfig') ?? 'tsconfig.test.json',
    write: args.includes('--write'),
  } as const;
}

function fatal(message: string): never {
  console.error(`[codemod] ${message}`);
  process.exit(1);
}

async function main() {
  const parsed = parseArgs(process.argv);

  const tsconfigPath = path.resolve(process.cwd(), parsed.tsconfig);

  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  switch (parsed.mod) {
    case 'report':
      await runReportMod({ project });
      return;
    case 'token-calls':
      await runTokenCallsMod({ project, write: parsed.write });
      return;
    case 'v2-contexts':
      await runV2ContextsMod({ project, write: parsed.write });
      return;
    case 'v2-prune':
      await runV2PruneMod({ project, write: parsed.write });
      return;
    case 'guard':
      await runGuardMod({ project });
      return;
    case 'test-platform-guard':
      await runTestPlatformGuardMod({ project });
      return;
default:
      fatal(`Unknown --mod '${parsed.mod}'. Supported: report, token-calls, v2-contexts, v2-prune, guard, test-platform-guard`);
}
}

void main();
