#!/usr/bin/env node
/*
 * Validates that workflows are discoverable via the same surface area as the MCP tools:
 * - workflow_list: listWorkflowSummaries()
 * - workflow_get: getWorkflowById()
 *
 * Runs across a configurable set of env "variants" so we can validate feature-flagged behavior.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to read JSON file at ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function requireDistModule(relativePathFromRepoRoot) {
  const full = path.resolve(__dirname, '..', relativePathFromRepoRoot);
  if (!fs.existsSync(full)) {
    throw new Error(
      `Missing ${relativePathFromRepoRoot}. ` +
        `Did you build first (npm run build) or download dist artifact in CI? (expected at: ${full})`
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(full);
}

function loadVariants(variantsPath) {
  const json = readJsonFile(variantsPath);

  if (!json || typeof json !== 'object') {
    throw new Error(`Invalid variants config (expected object): ${variantsPath}`);
  }

  const variants = json.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error(`Invalid variants config (expected non-empty variants array): ${variantsPath}`);
  }

  const validated = variants.map((v, idx) => {
    if (!v || typeof v !== 'object') {
      throw new Error(`Invalid variant at index ${idx} (expected object): ${variantsPath}`);
    }
    if (typeof v.name !== 'string' || v.name.trim().length === 0) {
      throw new Error(`Invalid variant.name at index ${idx} (expected non-empty string): ${variantsPath}`);
    }
    if (v.env === undefined || v.env === null || typeof v.env !== 'object' || Array.isArray(v.env)) {
      throw new Error(`Invalid variant.env for '${v.name}' (expected object): ${variantsPath}`);
    }

    /** @type {Record<string, string | null>} */
    const env = {};
    for (const [k, raw] of Object.entries(v.env)) {
      if (raw === null) {
        env[k] = null;
        continue;
      }
      if (typeof raw === 'string') {
        env[k] = raw;
        continue;
      }
      if (typeof raw === 'boolean' || typeof raw === 'number') {
        env[k] = String(raw);
        continue;
      }
      throw new Error(
        `Invalid env value for '${v.name}' at key '${k}' (expected string|number|boolean|null): ${variantsPath}`
      );
    }

    return { name: v.name, env };
  });

  // Ensure unique names
  const names = new Set();
  for (const v of validated) {
    if (names.has(v.name)) {
      throw new Error(`Duplicate variant name '${v.name}' in ${variantsPath}`);
    }
    names.add(v.name);
  }

  return validated;
}

function applyEnvDelta(delta) {
  for (const [k, v] of Object.entries(delta)) {
    if (v === null) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function restoreEnvSnapshot(snapshot) {
  // Remove keys not present in snapshot
  for (const k of Object.keys(process.env)) {
    if (!(k in snapshot)) {
      delete process.env[k];
    }
  }
  // Restore snapshot values
  for (const [k, v] of Object.entries(snapshot)) {
    process.env[k] = v;
  }
}

function shouldSkipWorkflowFile(relativePath, isAgenticEnabled) {
  // Mirror FileWorkflowStorage behavior
  if (relativePath.split(path.sep).includes('examples')) {
    return true;
  }

  if (!isAgenticEnabled) {
    if (relativePath.includes(`routines${path.sep}`) || path.basename(relativePath).startsWith('routine-')) {
      return true;
    }
  }

  return false;
}

function collectWorkflowFiles(dir) {
  /** @type {string[]} */
  const results = [];

  /** @param {string} current */
  function scan(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) {
        results.push(full);
      }
    }
  }

  scan(dir);
  return results;
}

function buildExpectedIdsFromRepoWorkflowsDir({ workflowsDir, isAgenticEnabled }) {
  const allFiles = collectWorkflowFiles(workflowsDir);

  /** @type {Map<string, Array<{file: string, isAgentic: boolean}>>} */
  const byId = new Map();

  for (const filePath of allFiles) {
    const relative = path.relative(workflowsDir, filePath);

    if (shouldSkipWorkflowFile(relative, isAgenticEnabled)) {
      continue;
    }

    let parsed;
    try {
      parsed = readJsonFile(filePath);
    } catch (e) {
      throw new Error(`Invalid JSON in workflow file: ${relative}`);
    }

    const id = parsed && typeof parsed === 'object' ? parsed.id : undefined;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`Workflow file missing a valid 'id': ${relative}`);
    }

    const list = byId.get(id) ?? [];
    list.push({ file: relative, isAgentic: relative.includes('.agentic.') });
    byId.set(id, list);
  }

  /** @type {Map<string, string>} */
  const chosenFileById = new Map();

  for (const [id, files] of byId.entries()) {
    // Mirror FileWorkflowStorage "Agentic Override Logic"
    let selected = files[0];

    if (isAgenticEnabled) {
      const agentic = files.find((f) => f.isAgentic);
      if (agentic) selected = agentic;
    } else {
      const standard = files.find((f) => !f.isAgentic);
      if (standard) selected = standard;
    }

    chosenFileById.set(id, selected.file);
  }

  return chosenFileById;
}

async function validateVariant(variant) {
  const envSnapshot = { ...process.env };

  try {
    applyEnvDelta(variant.env);

    const isAgenticEnabled = (process.env.WORKRAIL_ENABLE_AGENTIC_ROUTINES ?? '').toLowerCase() === 'true' ||
      process.env.WORKRAIL_ENABLE_AGENTIC_ROUTINES === '1';

    const { resetContainer, initializeContainer, container } = requireDistModule('dist/di/container.js');
    const { DI } = requireDistModule('dist/di/tokens.js');

    resetContainer();
    await initializeContainer({ runtimeMode: { kind: 'test' } });

    const workflowService = container.resolve(DI.Services.Workflow);

    const summaries = await workflowService.listWorkflowSummaries();
    const ids = summaries.map((s) => s.id);

    /** @type {string[]} */
    const errors = [];

    // 1) For every id in list, we must be able to get it
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const wf = await workflowService.getWorkflowById(id);
      if (!wf) {
        errors.push(`workflow_get returned null for id '${id}' (present in workflow_list)`);
      }
    }

    // 2) For every eligible workflow file in repo workflows dir, it must show up in list
    const repoWorkflowsDir = path.resolve(__dirname, '..', 'workflows');
    if (!fs.existsSync(repoWorkflowsDir)) {
      errors.push(`Missing workflows directory at ${repoWorkflowsDir}`);
    } else {
      const expected = buildExpectedIdsFromRepoWorkflowsDir({
        workflowsDir: repoWorkflowsDir,
        isAgenticEnabled,
      });

      const listed = new Set(ids);
      for (const [id, file] of expected.entries()) {
        if (!listed.has(id)) {
          errors.push(`Workflow id '${id}' from '${file}' did not appear in workflow_list`);
        }
      }
    }

    return { ok: errors.length === 0, errors, count: summaries.length };
  } finally {
    restoreEnvSnapshot(envSnapshot);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const variantsFlagIndex = argv.indexOf('--variants');

  const variantsPath = variantsFlagIndex >= 0
    ? argv[variantsFlagIndex + 1]
    : 'scripts/workflow-validation-variants.json';

  if (!variantsPath || variantsPath.startsWith('--')) {
    throw new Error('Usage: node scripts/validate-workflow-discovery.js --variants <path-to-variants.json>');
  }

  const resolvedVariantsPath = path.resolve(process.cwd(), variantsPath);
  const variants = loadVariants(resolvedVariantsPath);

  process.stdout.write(`Workflow discovery validation (variants: ${variants.length})\n`);
  process.stdout.write(`Using variants config: ${path.relative(process.cwd(), resolvedVariantsPath)}\n\n`);

  /** @type {Array<{name: string, ok: boolean, errors: string[], count: number}>} */
  const results = [];

  for (const variant of variants) {
    process.stdout.write(`=== Variant: ${variant.name} ===\n`);

    // eslint-disable-next-line no-await-in-loop
    const res = await validateVariant(variant);
    results.push({ name: variant.name, ...res });

    if (res.ok) {
      process.stdout.write(`PASS (workflows listed: ${res.count})\n\n`);
    } else {
      process.stdout.write(`FAIL\n`);
      for (const e of res.errors) {
        process.stdout.write(`- ${e}\n`);
      }
      process.stdout.write('\n');
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    fail(`Discovery validation failed for ${failed.length}/${results.length} variants.`);
  } else {
    process.stdout.write(`Discovery validation passed for ${results.length}/${results.length} variants.\n`);
  }
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
