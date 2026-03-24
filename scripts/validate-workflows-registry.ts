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
 * 4. Enforces per-variant timeout to prevent CI hangs
 *
 * Exits non-zero if any variant has failures.
 *
 * Usage:
 *   npm run build && node scripts/validate-workflows-registry.ts
 *   npm run validate:registry
 *   npm run validate:registry --json  # JSON output to stdout
 *
 * Options:
 *   --json              Emit structured JSON report to stdout (parseable by tools)
 *   --timeout=<ms>      Per-variant timeout in milliseconds (default: 30000)
 */

// tsyringe (used by ValidationEngine and EnhancedLoopValidator) requires this polyfill
import 'reflect-metadata';

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// All imports come from the built output (same pattern as other scripts)
import { CustomEnvFeatureFlagProvider } from '../dist/config/feature-flags.js';
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

interface ValidationJsonReport {
  readonly variants: readonly {
    readonly variant: string;
    readonly featureFlags: Record<string, string>;
    readonly resolvedWorkflows: RegistryValidationReport['resolvedResults'];
    readonly rawFiles: RegistryValidationReport['rawFileResults'];
    readonly duplicates: RegistryValidationReport['duplicateIds'];
    readonly summary: {
      readonly totalResolvedWorkflows: number;
      readonly validResolvedCount: number;
      readonly invalidResolvedCount: number;
      readonly totalRawFiles: number;
      readonly tier1PassedRawFiles: number;
      readonly tier1FailedRawFiles: number;
      readonly duplicateCount: number;
    };
  }[];
  readonly summary: {
    readonly totalVariants: number;
    readonly variantsWithFailures: number;
    readonly totalResolvedWorkflows: number;
    readonly totalResolvedValid: number;
    readonly totalResolvedInvalid: number;
    readonly totalRawFiles: number;
    readonly totalRawFilesTier1Failed: number;
    readonly totalDuplicateErrors: number;
  };
}

interface CliArgs {
  readonly json: boolean;
  readonly timeout: number;
}

interface PackageScopedReferenceViolation {
  readonly workflowFile: string;
  readonly referenceId: string;
  readonly source: string;
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
  let json = false;
  let timeout = 30000; // 30 seconds default

  for (const arg of argv.slice(2)) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--timeout=')) {
      const value = parseInt(arg.split('=')[1] ?? '', 10);
      if (!isNaN(value) && value > 0) {
        timeout = value;
      }
    }
  }

  return { json, timeout };
}

function listWorkflowJsonFiles(workflowsDir: string): string[] {
  return fs.readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(workflowsDir, name));
}

function isPathWithin(resolvedPath: string, basePath: string): boolean {
  const normalizedBase = path.resolve(basePath) + path.sep;
  const normalizedResolved = path.resolve(resolvedPath);
  return normalizedResolved === path.resolve(basePath) || normalizedResolved.startsWith(normalizedBase);
}

function validateBundledPackageScopedReferences(repoRoot: string): PackageScopedReferenceViolation[] {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { files?: string[] };
  const publishedRoots = (packageJson.files ?? []).map((entry) => path.resolve(repoRoot, entry));
  const workflowsDir = path.join(repoRoot, 'workflows');

  const violations: PackageScopedReferenceViolation[] = [];
  for (const workflowPath of listWorkflowJsonFiles(workflowsDir)) {
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8')) as {
      references?: Array<{ id?: string; source?: string; resolveFrom?: 'workspace' | 'package' }>;
    };

    for (const ref of workflow.references ?? []) {
      if (ref.resolveFrom !== 'package' || typeof ref.source !== 'string') continue;

      const resolvedRefPath = path.resolve(repoRoot, ref.source);
      const allowed = publishedRoots.some((publishedRoot) => isPathWithin(resolvedRefPath, publishedRoot));
      if (!allowed) {
        violations.push({
          workflowFile: path.relative(repoRoot, workflowPath),
          referenceId: ref.id ?? '(unknown)',
          source: ref.source,
          message: `package-scoped reference points outside published package roots (${(packageJson.files ?? []).join(', ')})`,
        });
      }
    }
  }

  return violations;
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
// Timeout Wrapper
// ─────────────────────────────────────────────────────────────────────────────

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms: ${label}`)), timeoutMs)
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON Sanitization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip the snapshot from ValidationOutcome for JSON serialization.
 * The snapshot includes the full workflow definition (all steps, all prompts),
 * making JSON output megabytes. We only need the outcome kind.
 */
function sanitizeOutcomeForJson(
  outcome: ValidationOutcomePhase1a
): Omit<ValidationOutcomePhase1a, 'snapshot'> {
  if (outcome.kind === 'phase1a_valid') {
    return {
      kind: outcome.kind,
      workflowId: outcome.workflowId,
      // snapshot omitted — too large for JSON output
    };
  }
  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting (Human-Readable)
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
    case 'executable_compilation_failed':
      return `exec-compile: FAIL (${outcome.cause.message})`;
    case 'phase1a_valid':
      return 'schema:ok structural:ok v1-compile:ok normalize:ok exec-compile:ok';
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

  // Print duplicates (distinguish bundled protection warnings from hard errors)
  if (report.duplicateIds.length > 0) {
    console.log(`  Duplicate IDs:`);
    for (const dup of report.duplicateIds) {
      const mark = dup.isBundledProtection ? '~' : '-';
      const suffix = dup.isBundledProtection ? ' (bundled protection, not error)' : '';
      console.log(`    [${mark}] ${dup.workflowId} (sources: ${dup.sourceRefs.join(', ')})${suffix}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
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

  const packageRefViolations = validateBundledPackageScopedReferences(repoRoot);
  if (packageRefViolations.length > 0) {
    if (args.json) {
      console.log(JSON.stringify({
        error: 'bundled_package_reference_validation_failed',
        violations: packageRefViolations,
      }, null, 2));
    } else {
      console.error('Bundled workflow package-reference validation failed:');
      for (const violation of packageRefViolations) {
        console.error(`  - ${violation.workflowFile} :: ${violation.referenceId} (${violation.source}) — ${violation.message}`);
      }
    }
    process.exit(1);
  }

  // Build pipeline deps once (stateless, reusable across variants)
  const deps = buildPipelineDeps();

  if (!args.json) {
    console.log(`Registry-centric workflow validation (${variants.length} variant(s))\n`);
  }

  const allReports: { variant: string; env: Record<string, string>; report: RegistryValidationReport }[] = [];
  let totalFailures = 0;

  for (const variant of variants) {
    if (!args.json) {
      console.log(`=== Variant: ${variant.name} ===`);
    }

    try {
      // Build feature flag provider with this variant's env overrides
      const mergedEnv: Record<string, string | undefined> = { ...process.env, ...variant.env };
      const featureFlagProvider = new CustomEnvFeatureFlagProvider(mergedEnv);

      // Build storage chain with the variant's feature flags
      const storage = createEnhancedMultiSourceWorkflowStorage({}, featureFlagProvider);

      // Get the underlying storage instances for snapshot building
      const storageInstances = storage.getStorageInstances();

      // Build registry snapshot with timeout protection
      const snapshot = await withTimeout(
        buildRegistrySnapshot(storageInstances),
        args.timeout,
        `buildRegistrySnapshot (variant: ${variant.name})`
      );

      // Validate the registry (synchronous, no timeout needed)
      const report = validateRegistry(snapshot, deps);

      allReports.push({ variant: variant.name, env: variant.env, report });

      if (!args.json) {
        // Print summary
        printVariantSummary(variant.name, report);

        // Determine if this variant has real failures.
        const hasValidationFailures = report.invalidResolvedCount > 0;
        const hasRawFileFailures = report.tier1FailedRawFiles > 0;

        if (hasValidationFailures || hasRawFileFailures) {
          totalFailures++;
        }

        console.log('');
      }
    } catch (err) {
      // Timeout or other error during variant processing
      if (!args.json) {
        console.error(`  TIMEOUT or ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
      totalFailures++;
      
      // Create empty report for this variant to maintain structure
      allReports.push({
        variant: variant.name,
        env: variant.env,
        report: {
          totalRawFiles: 0,
          totalResolvedWorkflows: 0,
          validResolvedCount: 0,
          invalidResolvedCount: 0,
          tier1PassedRawFiles: 0,
          tier1FailedRawFiles: 0,
          duplicateIds: [],
          resolvedResults: [],
          rawFileResults: [],
          isValid: false,
        },
      });
    }
  }

  // Compute cross-variant totals
  if (args.json) {
    totalFailures = allReports.filter(r => !r.report.isValid).length;
  } else {
    // Recompute from reports (in case any variants timed out)
    totalFailures = allReports.filter(r => 
      r.report.invalidResolvedCount > 0 || r.report.tier1FailedRawFiles > 0
    ).length;
  }

  // Output
  if (args.json) {
    // Structured JSON output (strip snapshots to keep size reasonable)
    const jsonReport: ValidationJsonReport = {
      variants: allReports.map(({ variant, env, report }) => ({
        variant,
        featureFlags: env,
        resolvedWorkflows: report.resolvedResults.map(r => ({
          ...r,
          outcome: sanitizeOutcomeForJson(r.outcome),
        })),
        rawFiles: report.rawFileResults,
        duplicates: report.duplicateIds,
        summary: {
          totalResolvedWorkflows: report.totalResolvedWorkflows,
          validResolvedCount: report.validResolvedCount,
          invalidResolvedCount: report.invalidResolvedCount,
          totalRawFiles: report.totalRawFiles,
          tier1PassedRawFiles: report.tier1PassedRawFiles,
          tier1FailedRawFiles: report.tier1FailedRawFiles,
          duplicateCount: report.duplicateIds.length,
        },
      })),
      summary: {
        totalVariants: variants.length,
        variantsWithFailures: totalFailures,
        totalResolvedWorkflows: allReports.reduce((sum, r) => sum + r.report.totalResolvedWorkflows, 0),
        totalResolvedValid: allReports.reduce((sum, r) => sum + r.report.validResolvedCount, 0),
        totalResolvedInvalid: allReports.reduce((sum, r) => sum + r.report.invalidResolvedCount, 0),
        totalRawFiles: allReports.reduce((sum, r) => sum + r.report.totalRawFiles, 0),
        totalRawFilesTier1Failed: allReports.reduce((sum, r) => sum + r.report.tier1FailedRawFiles, 0),
        totalDuplicateErrors: allReports.reduce((sum, r) => sum + r.report.duplicateIds.filter(d => !d.isBundledProtection).length, 0),
      },
    };

    console.log(JSON.stringify(jsonReport, null, 2));
    process.exit(totalFailures > 0 ? 1 : 0);
  } else {
    // Human-readable summary
    console.log('='.repeat(60));
    if (totalFailures === 0) {
      console.log(`All ${variants.length} variant(s) passed validation`);
      process.exit(0);
    } else {
      console.error(`${totalFailures} of ${variants.length} variant(s) had failures`);
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Fatal error during registry validation:', err);
  process.exit(1);
});
