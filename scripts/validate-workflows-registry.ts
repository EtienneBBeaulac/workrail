#!/usr/bin/env node

/**
 * Registry-centric workflow validator for CI.
 *
 * Runs validation under all feature-flag variants defined in
 * scripts/workflow-validation-variants.json.
 *
 * For each variant:
 * 1. Builds the storage chain with the variant's feature flags
 * 2. Passes storage.getStorageInstances() to buildRegistrySnapshot()
 * 3. Calls validateRegistry() on the snapshot
 *
 * Exits non-zero if any variant has failures.
 *
 * Usage:
 *   npm run build && node scripts/validate-workflows-registry.ts
 *   npm run validate:registry
 */

// tsyringe (used by ValidationEngine and EnhancedLoopValidator) requires this polyfill
import 'reflect-metadata';

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// All imports come from the built output (same pattern as other scripts)
import { EnvironmentFeatureFlagProvider, CustomEnvFeatureFlagProvider } from '../dist/config/feature-flags.js';
import { createEnhancedMultiSourceWorkflowStorage } from '../dist/infrastructure/storage/enhanced-multi-source-workflow-storage.js';
import { buildRegistrySnapshot, validateRegistry } from '../dist/application/use-cases/validate-workflow-registry.js';
import { validateWorkflowSchema } from '../dist/application/validation.js';
import { ValidationEngine } from '../dist/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../dist/application/services/enhanced-loop-validator.js';
import { WorkflowCompiler } from '../dist/application/services/workflow-compiler.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../dist/v2/read-only/v1-to-v2-shim.js';

import type { RegistryValidationReport, Tier1Outcome } from '../dist/application/use-cases/validate-workflow-registry.js';
import type { ValidationOutcomePhase1a } from '../dist/application/services/workflow-validation-pipeline.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface VariantConfig {
  readonly name: string;
  readonly env: Record<string, string>;
}

interface VariantsFile {
  readonly variants: readonly VariantConfig[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Deps Construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the validation pipeline dependencies from concrete instances.
 * No DI container needed — this is a standalone script.
 */
function buildPipelineDeps() {
  const loopValidator = new EnhancedLoopValidator();
  const validationEngine = new ValidationEngine(loopValidator);
  const compiler = new WorkflowCompiler();

  return {
    schemaValidate: validateWorkflowSchema,
    structuralValidate: validationEngine.validateWorkflowStructureOnly.bind(validationEngine),
    compiler,
    normalizeToExecutable: normalizeV1WorkflowToPinnedSnapshot,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatPhase1aOutcome(outcome: ValidationOutcomePhase1a): string {
  switch (outcome.kind) {
    case 'schema_failed':
      return `schema: FAIL (${outcome.errors.map(e => e.message ?? e.keyword).join(', ')})`;
    case 'structural_failed':
      return `structural: FAIL (${outcome.issues.join(', ')})`;
    case 'v1_compilation_failed':
      return `v1-compile: FAIL (${outcome.cause.message})`;
    case 'normalization_failed':
      return `normalize: FAIL (${outcome.cause.message})`;
    case 'phase1a_valid':
      return 'schema:ok structural:ok v1-compile:ok normalize:ok';
  }
}

function formatTier1Outcome(outcome: Tier1Outcome): string {
  switch (outcome.kind) {
    case 'tier1_unparseable':
      return `unparseable (${outcome.parseError})`;
    case 'schema_failed':
      return `schema: FAIL`;
    case 'structural_failed':
      return `structural: FAIL`;
    case 'tier1_passed':
      return 'passed';
  }
}

function printVariantSummary(variantName: string, report: RegistryValidationReport): void {
  console.log(`  Resolved workflows: ${report.validResolvedCount}/${report.totalResolvedWorkflows} valid`);
  console.log(`  Raw files:          ${report.tier1PassedRawFiles}/${report.totalRawFiles} passed Tier 1`);
  console.log(`  Duplicate IDs:      ${report.duplicateIds.length}`);

  // Print per-workflow status
  for (const entry of report.resolvedResults) {
    const status = entry.outcome.kind === 'phase1a_valid' ? 'ok' : 'FAIL';
    const mark = status === 'ok' ? '+' : '-';
    const phases = formatPhase1aOutcome(entry.outcome as ValidationOutcomePhase1a);
    console.log(`    [${mark}] ${entry.workflowId.padEnd(45)} ${phases}`);
  }

  // Print raw file failures (only failures, to keep output clean)
  const rawFailures = report.rawFileResults.filter(e => e.tier1Outcome.kind !== 'tier1_passed');
  if (rawFailures.length > 0) {
    console.log(`  Raw file failures:`);
    for (const entry of rawFailures) {
      const winner = entry.isResolvedWinner ? ' (resolved winner!)' : '';
      console.log(`    [-] ${entry.relativeFilePath.padEnd(55)} ${formatTier1Outcome(entry.tier1Outcome)}${winner}`);
    }
  }

  // Print duplicates
  if (report.duplicateIds.length > 0) {
    console.log(`  Duplicate IDs:`);
    for (const dup of report.duplicateIds) {
      console.log(`    [-] ${dup.workflowId} (sources: ${dup.sourceRefs.join(', ')})`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const variantsPath = path.join(scriptDir, 'workflow-validation-variants.json');

  if (!fs.existsSync(variantsPath)) {
    console.error(`Variants config not found: ${variantsPath}`);
    process.exit(1);
  }

  const variantsFile: VariantsFile = JSON.parse(fs.readFileSync(variantsPath, 'utf-8'));
  const variants = variantsFile.variants;

  if (variants.length === 0) {
    console.error('No variants defined in workflow-validation-variants.json');
    process.exit(1);
  }

  // Build pipeline deps once (stateless, reusable across variants)
  const deps = buildPipelineDeps();

  console.log(`Registry-centric workflow validation (${variants.length} variant(s))\n`);

  let totalFailures = 0;

  for (const variant of variants) {
    console.log(`=== Variant: ${variant.name} ===`);

    // Build feature flag provider with this variant's env overrides
    const mergedEnv: Record<string, string | undefined> = { ...process.env, ...variant.env };
    const featureFlagProvider = CustomEnvFeatureFlagProvider
      ? new CustomEnvFeatureFlagProvider(mergedEnv)
      : EnvironmentFeatureFlagProvider.withEnv(mergedEnv);

    // Build storage chain with the variant's feature flags
    const storage = createEnhancedMultiSourceWorkflowStorage({}, featureFlagProvider);

    // Get the underlying storage instances for snapshot building
    const storageInstances = storage.getStorageInstances();

    // Build registry snapshot from those instances
    const snapshot = await buildRegistrySnapshot(storageInstances);

    // Validate the registry
    const report = validateRegistry(snapshot, deps);

    // Print summary
    printVariantSummary(variant.name, report);

    // Determine if this variant has real failures.
    // Hard failures: resolved workflows that don't pass validation, raw files that fail Tier 1.
    // Duplicates are informational — bundled/project overlap is expected in development.
    const hasValidationFailures = report.invalidResolvedCount > 0;
    const hasRawFileFailures = report.tier1FailedRawFiles > 0;

    if (hasValidationFailures || hasRawFileFailures) {
      totalFailures++;
    }

    console.log('');
  }

  // Final summary
  console.log('='.repeat(60));
  if (totalFailures === 0) {
    console.log(`All ${variants.length} variant(s) passed validation`);
    process.exit(0);
  } else {
    console.error(`${totalFailures} of ${variants.length} variant(s) had failures`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error during registry validation:', err);
  process.exit(1);
});
