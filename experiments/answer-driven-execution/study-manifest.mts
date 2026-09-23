import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGES = ['A', 'B'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_A_SCENARIOS = [
  'ordinary',
  'malformed',
  'lost_response',
  'finished_recovery',
] as const;
export type StageAScenario = (typeof STAGE_A_SCENARIOS)[number];

export const STAGE_B_SCENARIOS = [
  'missing_summary',
  'recovery_after_partial_work',
] as const;
export type StageBScenario = (typeof STAGE_B_SCENARIOS)[number];

export const ALL_SCENARIOS = [
  ...STAGE_A_SCENARIOS,
  ...STAGE_B_SCENARIOS,
] as const;
export type Scenario = (typeof ALL_SCENARIOS)[number];

export const ARMS = ['baseline', 'candidate'] as const;
export type Arm = (typeof ARMS)[number];

export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
export const sha256Schema = z
  .string()
  .regex(SHA256_HEX_REGEX, 'Must be a 64-character lowercase hex SHA-256 hash');

export const GIT_COMMIT_REGEX = /^[0-9a-f]{40}$/;
export const gitCommitSchema = z
  .string()
  .regex(GIT_COMMIT_REGEX, 'Must be a 40-character lowercase hex git commit hash');

export const observationSchema = z
  .object({
    id: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;

export const gitSpecSchema = z
  .object({
    commit: gitCommitSchema,
    dirty: z.literal(false),
  })
  .strict();
export type GitSpec = z.infer<typeof gitSpecSchema>;

export const protocolRefSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
  })
  .strict();
export type ProtocolRef = z.infer<typeof protocolRefSchema>;

export const executableArtifactSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    adapterVersion: z.string().min(1),
  })
  .strict();
export type ExecutableArtifact = z.infer<typeof executableArtifactSchema>;

export const executablesSpecSchema = z
  .object({
    baseline: executableArtifactSchema,
    candidate: executableArtifactSchema,
  })
  .strict();
export type ExecutablesSpec = z.infer<typeof executablesSpecSchema>;

export const workflowArtifactSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    workflowId: z.string().min(1),
  })
  .strict();
export type WorkflowArtifact = z.infer<typeof workflowArtifactSchema>;

export const workflowsSpecSchema = z
  .object({
    baseline: workflowArtifactSchema,
    candidate: workflowArtifactSchema,
  })
  .strict();
export type WorkflowsSpec = z.infer<typeof workflowsSpecSchema>;

export const armSettingsSchema = z
  .object({
    model: z.string().min(1),
    effort: z.string().min(1),
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1).optional(),
    maxContextTokens: z.number().int().positive().optional(),
  })
  .strict();
export type ArmSettings = z.infer<typeof armSettingsSchema>;

export const environmentSpecSchema = z
  .object({
    agyVersion: z.string().min(1),
    baseline: armSettingsSchema,
    candidate: armSettingsSchema,
  })
  .strict();
export type EnvironmentSpec = z.infer<typeof environmentSpecSchema>;

export const budgetsSpecSchema = z
  .object({
    maxCallsPerConversation: z.number().int().min(1).max(20),
    maxElapsedMsPerConversation: z.number().int().min(1).max(300_000),
    maxCallTimeoutMs: z.number().int().min(1).max(60_000),
    maxCumulativeMinutes: z.number().int().min(1),
    allowedTools: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type BudgetsSpec = z.infer<typeof budgetsSpecSchema>;

export const faultKindSchema = z.enum([
  'none',
  'malformed',
  'lost_response',
  'missing_summary',
  'recovery_after_partial_work',
]);
export type FaultKind = z.infer<typeof faultKindSchema>;

export const preflightProofSchema = z
  .object({
    proofId: z.string().min(1),
    path: z.string().min(1),
    sha256: sha256Schema,
  })
  .strict();
export type PreflightProof = z.infer<typeof preflightProofSchema>;

export const PERMITTED_INVALIDATION_REASONS = [
  'provider_outage',
  'shared_fault_proxy_malfunction',
] as const;
export type PermittedInvalidationReason =
  (typeof PERMITTED_INVALIDATION_REASONS)[number];

export const REQUIRED_DISALLOWED_EXCLUSIONS = [
  'candidate_failure',
  'candidate_timeout',
  'missing_candidate_evidence',
] as const;

export const invalidationPolicySchema = z
  .object({
    permittedReasons: z.array(z.enum(PERMITTED_INVALIDATION_REASONS)).min(1),
    maxReplacementsPerPair: z.literal(1),
    requireAllAttemptsReported: z.literal(true),
    disallowedExclusions: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type InvalidationPolicy = z.infer<typeof invalidationPolicySchema>;

export const pairFixtureSchema = z
  .object({
    fixtureId: z.string().min(1),
    path: z.string().min(1),
    sha256: sha256Schema,
  })
  .strict();
export type PairFixture = z.infer<typeof pairFixtureSchema>;

export const armRunSpecSchema = z
  .object({
    runId: z.string().min(1),
    workspacePath: z.string().min(1),
  })
  .strict();
export type ArmRunSpec = z.infer<typeof armRunSpecSchema>;

// Stage A specific schemas
export const stageAFaultEquivalenceProofSchema = z
  .object({
    scenario: z.enum(['malformed', 'lost_response']),
    proofId: z.string().min(1),
    path: z.string().min(1),
    sha256: sha256Schema,
  })
  .strict();

export const stageAPreflightsSpecSchema = z
  .object({
    observationCheckerProof: preflightProofSchema,
    timeoutEnforcementProof: preflightProofSchema,
    faultEquivalenceProofs: z.array(stageAFaultEquivalenceProofSchema).min(1),
  })
  .strict();

export const stageAFaultDefinitionSchema = z
  .object({
    scenario: z.enum(STAGE_A_SCENARIOS),
    kind: faultKindSchema,
    injectionPoint: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const stageAPairSpecSchema = z
  .object({
    scenario: z.enum(STAGE_A_SCENARIOS),
    repetition: z.number().int().min(1).max(5),
    fixture: pairFixtureSchema,
    expectedObservations: z.array(observationSchema).length(2),
    armOrder: z.tuple([z.enum(ARMS), z.enum(ARMS)]),
    baseline: armRunSpecSchema,
    candidate: armRunSpecSchema,
  })
  .strict();

// Stage B specific schemas
export const stageBFaultEquivalenceProofSchema = z
  .object({
    scenario: z.enum(['missing_summary', 'recovery_after_partial_work']),
    proofId: z.string().min(1),
    path: z.string().min(1),
    sha256: sha256Schema,
  })
  .strict();

export const stageBPreflightsSpecSchema = z
  .object({
    observationCheckerProof: preflightProofSchema,
    timeoutEnforcementProof: preflightProofSchema,
    faultEquivalenceProofs: z.array(stageBFaultEquivalenceProofSchema).min(1),
    stageBReviewObligationsProof: preflightProofSchema,
  })
  .strict();

export const stageBFaultDefinitionSchema = z
  .object({
    scenario: z.enum(STAGE_B_SCENARIOS),
    kind: faultKindSchema,
    injectionPoint: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const stageBPairSpecSchema = z
  .object({
    scenario: z.enum(STAGE_B_SCENARIOS),
    repetition: z.number().int().min(1).max(5),
    fixture: pairFixtureSchema,
    expectedObservations: z.array(observationSchema).length(2),
    armOrder: z.tuple([z.enum(ARMS), z.enum(ARMS)]),
    baseline: armRunSpecSchema,
    candidate: armRunSpecSchema,
  })
  .strict();

const baseManifestFields = {
  version: z.literal(1),
  seed: z.union([z.number().int(), z.string().min(1)]),
  protocol: protocolRefSchema,
  git: gitSpecSchema,
  executables: executablesSpecSchema,
  workflows: workflowsSpecSchema,
  environment: environmentSpecSchema,
  budgets: budgetsSpecSchema,
  invalidationPolicy: invalidationPolicySchema,
};

export const stageAManifestSchema = z
  .object({
    ...baseManifestFields,
    stage: z.literal('A'),
    faultDefinitions: z.array(stageAFaultDefinitionSchema).min(1),
    preflights: stageAPreflightsSpecSchema,
    pairs: z.array(stageAPairSpecSchema).min(1),
  })
  .strict();

export const stageBManifestSchema = z
  .object({
    ...baseManifestFields,
    stage: z.literal('B'),
    faultDefinitions: z.array(stageBFaultDefinitionSchema).min(1),
    preflights: stageBPreflightsSpecSchema,
    pairs: z.array(stageBPairSpecSchema).min(1),
  })
  .strict();

export const manifestSchema = z.discriminatedUnion('stage', [
  stageAManifestSchema,
  stageBManifestSchema,
]);

export type DeepReadonly<T> = T extends Function
  ? T
  : T extends (infer R)[]
  ? ReadonlyArray<DeepReadonly<R>>
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export type StageAManifest = DeepReadonly<z.infer<typeof stageAManifestSchema>>;
export type StageBManifest = DeepReadonly<z.infer<typeof stageBManifestSchema>>;
export type StageAManifestInput = z.input<typeof stageAManifestSchema>;
export type StageBManifestInput = z.input<typeof stageBManifestSchema>;
export type StudyManifest = DeepReadonly<z.infer<typeof manifestSchema>>;
declare const validatedManifestBrand: unique symbol;
/** Issued only after declaration validation; raw manifests cannot enter trusted I/O. */
export type ValidatedStudyManifest = StudyManifest & { readonly [validatedManifestBrand]: never };
export type StudyManifestInput = z.input<typeof manifestSchema>;

export type ManifestValidationError =
  | { readonly kind: 'schema_error'; readonly path: string; readonly message: string }
  | { readonly kind: 'unmatched_environment'; readonly field: string; readonly baseline: unknown; readonly candidate: unknown }
  | { readonly kind: 'invalid_stage_scenario'; readonly stage: Stage; readonly scenario: string; readonly reason: string }
  | { readonly kind: 'missing_scenario_pair'; readonly scenario: string; readonly repetition: number }
  | { readonly kind: 'duplicate_scenario_pair'; readonly scenario: string; readonly repetition: number }
  | { readonly kind: 'invalid_arm_order'; readonly scenario: string; readonly repetition: number }
  | { readonly kind: 'duplicate_run_id'; readonly runId: string }
  | { readonly kind: 'duplicate_workspace_path'; readonly workspacePath: string }
  | { readonly kind: 'invalid_workspace_path'; readonly workspacePath: string; readonly reason: string }
  | { readonly kind: 'overlapping_workspace_path'; readonly pathA: string; readonly pathB: string; readonly reason: string }
  | { readonly kind: 'invalid_artifact_path'; readonly path: string; readonly reason: string }
  | { readonly kind: 'shared_observation_value'; readonly observationId: string; readonly value: string }
  | { readonly kind: 'budget_exceeded'; readonly budget: string; readonly value: number; readonly limit: number }
  | { readonly kind: 'invalid_invalidation_policy'; readonly reason: string }
  | { readonly kind: 'missing_preflight_proof'; readonly proofType: string; readonly detail?: string }
  | { readonly kind: 'duplicate_preflight_proof'; readonly proofType: string; readonly scenario?: string }
  | { readonly kind: 'out_of_stage_preflight_proof'; readonly stage: Stage; readonly scenario: string }
  | { readonly kind: 'disallowed_stage_proof'; readonly stage: Stage; readonly proofType: string; readonly detail: string }
  | { readonly kind: 'unsupported_fault_schedule'; readonly scenario: string; readonly detail: string }
  | { readonly kind: 'duplicate_fault_definition'; readonly scenario: string }
  | { readonly kind: 'out_of_stage_fault_definition'; readonly stage: Stage; readonly scenario: string }
  | { readonly kind: 'conflicting_artifact_hash'; readonly path: string; readonly expectedSha256A: string; readonly expectedSha256B: string };

export type DeclarativeValidationResult =
  | { readonly kind: 'valid'; readonly manifest: ValidatedStudyManifest }
  | { readonly kind: 'invalid'; readonly errors: readonly ManifestValidationError[] };

export type ArtifactVerificationError =
  | { readonly kind: 'read_error'; readonly path: string; readonly message: string }
  | { readonly kind: 'invalid_content_type'; readonly path: string; readonly message: string }
  | { readonly kind: 'hash_mismatch'; readonly path: string; readonly expectedSha256: string; readonly actualSha256: string };

export interface VerifiedArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly roles: readonly string[];
}

export type ArtifactVerificationResult =
  | {
      readonly kind: 'verified';
      readonly verifiedArtifactCount: number;
      readonly artifacts: readonly VerifiedArtifact[];
    }
  | {
      readonly kind: 'verification_failed';
      readonly errors: readonly ArtifactVerificationError[];
    }
  | {
      readonly kind: 'cancelled';
      readonly message: string;
    };

export type ManifestVerificationResult =
  | {
      readonly kind: 'manifest_verified';
      readonly scope: 'declaration_and_artifact_bytes_only';
      readonly trialAuthorization: false;
      readonly stage: Stage;
      readonly seed: string | number;
      readonly totalPlannedTrials: number;
      readonly verifiedArtifactCount: number;
      readonly manifest: DeepReadonly<StudyManifest>;
    }
  | {
      readonly kind: 'rejected';
      readonly phase: 'declarative';
      readonly errors: readonly ManifestValidationError[];
    }
  | {
      readonly kind: 'rejected';
      readonly phase: 'artifacts';
      readonly errors: readonly ArtifactVerificationError[];
    }
  | {
      readonly kind: 'cancelled';
      readonly message: string;
    };

export type ArtifactContent = Uint8Array | string;
export type ArtifactReader = (
  path: string,
  signal?: AbortSignal
) => Promise<ArtifactContent> | ArtifactContent;

export interface ArtifactEntry {
  readonly rawPath: string;
  readonly path: string;
  readonly expectedSha256: string;
  readonly role: string;
}

export function computeSha256(content: Uint8Array | string): string {
  const hasher = createHash('sha256');
  if (typeof content === 'string') {
    hasher.update(content, 'utf8');
  } else {
    hasher.update(content);
  }
  return hasher.digest('hex');
}

export function deepFreeze<T>(obj: T): DeepReadonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj as DeepReadonly<T>;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj as DeepReadonly<T>;
}

function normalizeWorkspacePath(rawPath: string): string {
  const norm = normalize(rawPath);
  return norm.length > 1 && norm.endsWith('/') ? norm.replace(/\/+$/, '') : norm;
}

function checkWorkspacePathsOverlap(normA: string, normB: string): boolean {
  if (normA === normB) return true;
  const prefixA = normA === '/' ? '/' : normA + '/';
  const prefixB = normB === '/' ? '/' : normB + '/';
  return normB.startsWith(prefixA) || normA.startsWith(prefixB);
}

export function extractManifestArtifacts(
  manifest: DeepReadonly<StudyManifest>
): readonly ArtifactEntry[] {
  const toEntry = (rawPath: string, expectedSha256: string, role: string): ArtifactEntry => ({
    rawPath,
    path: normalize(rawPath),
    expectedSha256,
    role,
  });

  const list: ArtifactEntry[] = [
    toEntry(manifest.protocol.path, manifest.protocol.sha256, 'protocol'),
    toEntry(manifest.executables.baseline.path, manifest.executables.baseline.sha256, 'executable_baseline'),
    toEntry(manifest.executables.candidate.path, manifest.executables.candidate.sha256, 'executable_candidate'),
    toEntry(manifest.workflows.baseline.path, manifest.workflows.baseline.sha256, 'workflow_baseline'),
    toEntry(manifest.workflows.candidate.path, manifest.workflows.candidate.sha256, 'workflow_candidate'),
    toEntry(manifest.preflights.observationCheckerProof.path, manifest.preflights.observationCheckerProof.sha256, 'preflight_observation_checker'),
    toEntry(manifest.preflights.timeoutEnforcementProof.path, manifest.preflights.timeoutEnforcementProof.sha256, 'preflight_timeout_enforcement'),
  ];

  for (const fep of manifest.preflights.faultEquivalenceProofs) {
    list.push(toEntry(fep.path, fep.sha256, `preflight_fault_equivalence:${fep.scenario}`));
  }

  if (manifest.stage === 'B') {
    list.push(toEntry(
      manifest.preflights.stageBReviewObligationsProof.path,
      manifest.preflights.stageBReviewObligationsProof.sha256,
      'preflight_stage_b_review_obligations',
    ));
  }

  for (const pair of manifest.pairs) {
    list.push(toEntry(
      pair.fixture.path,
      pair.fixture.sha256,
      `fixture:${pair.fixture.fixtureId}`,
    ));
  }

  return list;
}

export function validateStudyManifest(input: unknown): DeclarativeValidationResult {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      errors: parsed.error.issues.map(i => ({
        kind: 'schema_error' as const,
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }

  const manifest = structuredClone(parsed.data);
  const errors: ManifestValidationError[] = [];

  // 1. Model / Effort / Settings equivalence
  const baseEnv = manifest.environment.baseline;
  const candEnv = manifest.environment.candidate;
  if (baseEnv.model !== candEnv.model) {
    errors.push({ kind: 'unmatched_environment', field: 'model', baseline: baseEnv.model, candidate: candEnv.model });
  }
  if (baseEnv.effort !== candEnv.effort) {
    errors.push({ kind: 'unmatched_environment', field: 'effort', baseline: baseEnv.effort, candidate: candEnv.effort });
  }
  if (baseEnv.temperature !== candEnv.temperature) {
    errors.push({ kind: 'unmatched_environment', field: 'temperature', baseline: baseEnv.temperature, candidate: candEnv.temperature });
  }
  if (baseEnv.topP !== candEnv.topP) {
    errors.push({ kind: 'unmatched_environment', field: 'topP', baseline: baseEnv.topP, candidate: candEnv.topP });
  }
  if (baseEnv.maxContextTokens !== candEnv.maxContextTokens) {
    errors.push({ kind: 'unmatched_environment', field: 'maxContextTokens', baseline: baseEnv.maxContextTokens, candidate: candEnv.maxContextTokens });
  }

  // 2. Stage budget limits
  if (manifest.stage === 'A' && manifest.budgets.maxCumulativeMinutes > 200) {
    errors.push({ kind: 'budget_exceeded', budget: 'maxCumulativeMinutes', value: manifest.budgets.maxCumulativeMinutes, limit: 200 });
  }
  if (manifest.stage === 'B' && manifest.budgets.maxCumulativeMinutes > 100) {
    errors.push({ kind: 'budget_exceeded', budget: 'maxCumulativeMinutes', value: manifest.budgets.maxCumulativeMinutes, limit: 100 });
  }

  // 3. Stage scenarios and pairs
  const requiredScenarios = manifest.stage === 'A' ? STAGE_A_SCENARIOS : STAGE_B_SCENARIOS;
  const disallowedScenarios = manifest.stage === 'A' ? STAGE_B_SCENARIOS : STAGE_A_SCENARIOS;

  for (const pair of manifest.pairs) {
    if ((disallowedScenarios as readonly string[]).includes(pair.scenario)) {
      errors.push({
        kind: 'invalid_stage_scenario',
        stage: manifest.stage,
        scenario: pair.scenario,
        reason: `Scenario ${pair.scenario} belongs to Stage ${manifest.stage === 'A' ? 'B' : 'A'}, not Stage ${manifest.stage}`,
      });
    }
  }

  for (const scenario of requiredScenarios) {
    for (let rep = 1; rep <= 5; rep++) {
      const matches = manifest.pairs.filter(p => p.scenario === scenario && p.repetition === rep);
      if (matches.length === 0) {
        errors.push({ kind: 'missing_scenario_pair', scenario, repetition: rep });
      } else if (matches.length > 1) {
        errors.push({ kind: 'duplicate_scenario_pair', scenario, repetition: rep });
      }
    }
  }

  // 4. Pairs validation (armOrder, observations, runIds, workspacePaths)
  const seenRunIds = new Set<string>();
  const seenObsValues = new Set<string>();
  const seenNormWorkspacePaths = new Set<string>();
  const recordedWorkspaces: string[] = [];

  for (const pair of manifest.pairs) {
    // Arm order: both arms must be present
    if (pair.armOrder[0] === pair.armOrder[1]) {
      errors.push({ kind: 'invalid_arm_order', scenario: pair.scenario, repetition: pair.repetition });
    }

    // Run ID uniqueness
    if (pair.baseline.runId === pair.candidate.runId) {
      errors.push({ kind: 'duplicate_run_id', runId: pair.baseline.runId });
    }
    for (const runId of [pair.baseline.runId, pair.candidate.runId]) {
      if (seenRunIds.has(runId)) {
        errors.push({ kind: 'duplicate_run_id', runId });
      }
      seenRunIds.add(runId);
    }

    // Lexical directory isolation only.
    // Requires absolute paths, compares normalized forms, and rejects exact aliases or ancestor/descendant nesting.
    // Note: This does not guarantee symlink or process isolation.
    for (const rawWs of [pair.baseline.workspacePath, pair.candidate.workspacePath]) {
      if (!isAbsolute(rawWs)) {
        errors.push({
          kind: 'invalid_workspace_path',
          workspacePath: rawWs,
          reason: 'Workspace path must be an absolute path',
        });
        continue;
      }
      const norm = normalizeWorkspacePath(rawWs);
      if (seenNormWorkspacePaths.has(norm)) {
        errors.push({
          kind: 'duplicate_workspace_path',
          workspacePath: norm,
        });
      } else {
        for (const recorded of recordedWorkspaces) {
          if (checkWorkspacePathsOverlap(recorded, norm)) {
            errors.push({
              kind: 'overlapping_workspace_path',
              pathA: recorded,
              pathB: norm,
              reason: 'Workspace paths have ancestor/descendant lexical nesting',
            });
          }
        }
        seenNormWorkspacePaths.add(norm);
        recordedWorkspaces.push(norm);
      }
    }

    // Expected observations within pair
    if (pair.expectedObservations[0].id === pair.expectedObservations[1].id) {
      errors.push({
        kind: 'schema_error',
        path: `pairs.${pair.scenario}.${pair.repetition}.expectedObservations`,
        message: `Duplicate observation id '${pair.expectedObservations[0].id}' within pair`,
      });
    }

    // Observation rotation across tasks
    for (const obs of pair.expectedObservations) {
      if (seenObsValues.has(obs.value)) {
        errors.push({ kind: 'shared_observation_value', observationId: obs.id, value: obs.value });
      }
      seenObsValues.add(obs.value);
    }
  }

  // 5. Fault definitions: reject duplicate or out-of-stage entries
  const seenFaultScenarios = new Set<string>();
  for (const fd of manifest.faultDefinitions) {
    if (seenFaultScenarios.has(fd.scenario)) {
      errors.push({
        kind: 'duplicate_fault_definition',
        scenario: fd.scenario,
      });
    }
    seenFaultScenarios.add(fd.scenario);

    if ((disallowedScenarios as readonly string[]).includes(fd.scenario)) {
      errors.push({
        kind: 'out_of_stage_fault_definition',
        stage: manifest.stage,
        scenario: fd.scenario,
      });
    }
  }

  for (const scenario of requiredScenarios) {
    const fd = manifest.faultDefinitions.find(f => f.scenario === scenario);
    if (!fd) {
      errors.push({
        kind: 'unsupported_fault_schedule',
        scenario,
        detail: `Missing fault definition for scenario '${scenario}'`,
      });
    } else {
      const expectedKind: FaultKind =
        scenario === 'ordinary' || scenario === 'finished_recovery'
          ? 'none'
          : scenario === 'malformed'
          ? 'malformed'
          : scenario === 'lost_response'
          ? 'lost_response'
          : scenario === 'missing_summary'
          ? 'missing_summary'
          : 'recovery_after_partial_work';
      if (fd.kind !== expectedKind) {
        errors.push({
          kind: 'unsupported_fault_schedule',
          scenario,
          detail: `Expected fault kind '${expectedKind}' for scenario '${scenario}', got '${fd.kind}'`,
        });
      }
    }
  }

  // 6. Preflight references: StageA disallows StageB proofs; StageB requires review proof
  const injectedScenarios =
    manifest.stage === 'A'
      ? (['malformed', 'lost_response'] as const)
      : (['missing_summary', 'recovery_after_partial_work'] as const);

  const seenProofScenarios = new Set<string>();
  for (const fep of manifest.preflights.faultEquivalenceProofs) {
    if (seenProofScenarios.has(fep.scenario)) {
      errors.push({
        kind: 'duplicate_preflight_proof',
        proofType: 'fault_equivalence',
        scenario: fep.scenario,
      });
    }
    seenProofScenarios.add(fep.scenario);

    if ((disallowedScenarios as readonly string[]).includes(fep.scenario)) {
      errors.push({
        kind: 'out_of_stage_preflight_proof',
        stage: manifest.stage,
        scenario: fep.scenario,
      });
    }
  }

  for (const injected of injectedScenarios) {
    if (!seenProofScenarios.has(injected)) {
      errors.push({
        kind: 'missing_preflight_proof',
        proofType: 'fault_equivalence',
        detail: `Missing preflight fault equivalence proof for injected scenario '${injected}'`,
      });
    }
  }

  // 7. Invalidation policy
  const invalidation = manifest.invalidationPolicy;
  for (const reason of invalidation.permittedReasons) {
    if (!(PERMITTED_INVALIDATION_REASONS as readonly string[]).includes(reason)) {
      errors.push({
        kind: 'invalid_invalidation_policy',
        reason: `Permitted reason '${reason}' is not allowed by comparison protocol`,
      });
    }
  }
  for (const reqDisallowed of REQUIRED_DISALLOWED_EXCLUSIONS) {
    if (!invalidation.disallowedExclusions.includes(reqDisallowed)) {
      errors.push({
        kind: 'invalid_invalidation_policy',
        reason: `Missing required disallowed exclusion: '${reqDisallowed}'`,
      });
    }
  }

  // 8. Artifact paths: absolute path check, normalization, and conflicting hash detection
  const artifacts = extractManifestArtifacts(manifest);
  const pathHashes = new Map<string, { expectedSha256: string; rawPath: string }>();

  for (const art of artifacts) {
    if (!isAbsolute(art.rawPath)) {
      errors.push({
        kind: 'invalid_artifact_path',
        path: art.rawPath,
        reason: 'Artifact path must be an absolute path',
      });
      continue;
    }

    const existing = pathHashes.get(art.path);
    if (existing && existing.expectedSha256 !== art.expectedSha256) {
      errors.push({
        kind: 'conflicting_artifact_hash',
        path: art.path,
        expectedSha256A: existing.expectedSha256,
        expectedSha256B: art.expectedSha256,
      });
    } else if (!existing) {
      pathHashes.set(art.path, { expectedSha256: art.expectedSha256, rawPath: art.rawPath });
    }
  }

  if (errors.length > 0) {
    return { kind: 'invalid', errors };
  }

  return { kind: 'valid', manifest: deepFreeze(manifest) as ValidatedStudyManifest };
}

export async function verifyManifestArtifacts(
  manifest: ValidatedStudyManifest,
  reader: ArtifactReader,
  signal?: AbortSignal,
): Promise<ArtifactVerificationResult> {
  if (signal?.aborted) {
    return {
      kind: 'cancelled',
      message: signal.reason ? String(signal.reason) : 'Verification aborted before reading artifacts',
    };
  }

  const artifacts = extractManifestArtifacts(manifest);
  // Group by normalized physical path to dedup physical reads/hashes while retaining every role
  const artifactsByPath = new Map<string, { expectedSha256: string; roles: string[] }>();

  for (const art of artifacts) {
    const existing = artifactsByPath.get(art.path);
    if (existing) {
      existing.roles.push(art.role);
    } else {
      artifactsByPath.set(art.path, { expectedSha256: art.expectedSha256, roles: [art.role] });
    }
  }

  const errors: ArtifactVerificationError[] = [];
  const verified: VerifiedArtifact[] = [];

  for (const [normPath, entry] of artifactsByPath) {
    if (signal?.aborted) {
      return {
        kind: 'cancelled',
        message: signal.reason ? String(signal.reason) : 'Verification aborted between artifact reads',
      };
    }

    let content: unknown;
    try {
      content = await reader(normPath, signal);
    } catch (err) {
      const isAbort =
        signal?.aborted ||
        (err instanceof Error && err.name === 'AbortError');
      if (isAbort) {
        return {
          kind: 'cancelled',
          message: err instanceof Error ? err.message : 'Verification aborted during artifact read',
        };
      }
      errors.push({
        kind: 'read_error',
        path: normPath,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (signal?.aborted) {
      return {
        kind: 'cancelled',
        message: signal.reason ? String(signal.reason) : 'Verification aborted after artifact read',
      };
    }

    // Validate injected I/O return type
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
      errors.push({
        kind: 'invalid_content_type',
        path: normPath,
        message: `Reader returned invalid content type for ${normPath}: expected string or Uint8Array, got ${content === null ? 'null' : typeof content}`,
      });
      continue;
    }

    const actualSha256 = computeSha256(content);
    if (actualSha256 !== entry.expectedSha256) {
      errors.push({
        kind: 'hash_mismatch',
        path: normPath,
        expectedSha256: entry.expectedSha256,
        actualSha256,
      });
    } else {
      verified.push({
        path: normPath,
        sha256: actualSha256,
        roles: entry.roles,
      });
    }
  }

  if (errors.length > 0) {
    return {
      kind: 'verification_failed',
      errors,
    };
  }

  return {
    kind: 'verified',
    verifiedArtifactCount: verified.length,
    artifacts: verified,
  };
}

export async function verifyStudyManifest(
  input: unknown,
  reader: ArtifactReader,
  signal?: AbortSignal,
): Promise<ManifestVerificationResult> {
  if (signal?.aborted) {
    return {
      kind: 'cancelled',
      message: signal.reason ? String(signal.reason) : 'Study verification aborted before start',
    };
  }

  const declarative = validateStudyManifest(input);
  if (declarative.kind === 'invalid') {
    return {
      kind: 'rejected',
      phase: 'declarative',
      errors: declarative.errors,
    };
  }

  if (signal?.aborted) {
    return {
      kind: 'cancelled',
      message: signal.reason ? String(signal.reason) : 'Study verification aborted before artifact verification',
    };
  }

  const manifest = declarative.manifest;
  const artifactResult = await verifyManifestArtifacts(manifest, reader, signal);
  if (artifactResult.kind === 'cancelled') {
    return {
      kind: 'cancelled',
      message: artifactResult.message,
    };
  }
  if (artifactResult.kind === 'verification_failed') {
    return {
      kind: 'rejected',
      phase: 'artifacts',
      errors: artifactResult.errors,
    };
  }

  return {
    kind: 'manifest_verified',
    scope: 'declaration_and_artifact_bytes_only',
    trialAuthorization: false,
    stage: manifest.stage,
    seed: manifest.seed,
    totalPlannedTrials: manifest.pairs.length * 2,
    verifiedArtifactCount: artifactResult.verifiedArtifactCount,
    manifest,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifestPath = process.argv[2];
    if (!manifestPath) {
      process.stdout.write(JSON.stringify({ kind: 'input_error', message: 'Missing manifest file argument' }) + '\n');
      process.exitCode = 2;
    } else {
      const content = await readFile(resolve(manifestPath), 'utf8');
      const json = JSON.parse(content);
      const fileReader: ArtifactReader = async (filePath: string) => {
        return await readFile(resolve(filePath));
      };
      const result = await verifyStudyManifest(json, fileReader);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exitCode = result.kind === 'manifest_verified' ? 0 : 1;
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ kind: 'input_error', message: String(error) }) + '\n');
    process.exitCode = 2;
  }
}
