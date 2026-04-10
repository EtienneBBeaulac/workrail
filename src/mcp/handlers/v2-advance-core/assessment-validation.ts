import type {
  AssessmentDefinition,
  AssessmentDimensionDefinition,
  WorkflowStepDefinition,
} from '../../../types/workflow-definition.js';
import type { ValidationResult } from '../../../types/validation.js';
import {
  ASSESSMENT_CONTRACT_REF,
  parseAssessmentArtifact,
  type AssessmentArtifactV1,
} from '../../../v2/durable-core/schemas/artifacts/index.js';
import type {
  RecordedAssessmentDimensionV1,
  RecordedAssessmentV1,
} from '../../../v2/durable-core/domain/assessment-record.js';

export interface AssessmentValidationOutcome {
  readonly contractRef: typeof ASSESSMENT_CONTRACT_REF;
  readonly validation: ValidationResult;
  /** All recorded assessments, one per assessmentRef, in assessmentRefs order. */
  readonly recordedAssessments: readonly RecordedAssessmentV1[];
  /** All accepted artifacts with their original artifact-array indices, one per assessmentRef. */
  readonly acceptedArtifacts: ReadonlyArray<{ readonly artifact: AssessmentArtifactV1; readonly artifactIndex: number }>;
}

function normalizeLevel(level: string, allowedLevels: readonly string[]): { readonly kind: 'exact'; readonly value: string } | { readonly kind: 'normalized'; readonly value: string; readonly note: string } | { readonly kind: 'ambiguous'; readonly message: string } | { readonly kind: 'invalid'; readonly message: string } {
  const exact = allowedLevels.find((candidate) => candidate === level);
  if (exact) return { kind: 'exact', value: exact };

  const normalizedInput = level.trim().toLowerCase();
  const normalizedMatches = allowedLevels.filter((candidate) => candidate.toLowerCase() === normalizedInput);
  if (normalizedMatches.length === 1) {
    return {
      kind: 'normalized',
      value: normalizedMatches[0]!,
      note: `Normalized level "${level}" to canonical value "${normalizedMatches[0]!}".`,
    };
  }
  if (normalizedMatches.length > 1) {
    return {
      kind: 'ambiguous',
      message: `Level "${level}" is ambiguous for this dimension. Allowed levels: ${allowedLevels.join(', ')}.`,
    };
  }

  return {
    kind: 'invalid',
    message: `Level "${level}" is not allowed. Allowed levels: ${allowedLevels.join(', ')}.`,
  };
}

function extractSubmittedLevel(value: AssessmentArtifactV1['dimensions'][string]): { readonly level: string; readonly hasRationale: boolean } {
  if (typeof value === 'string') {
    return { level: value, hasRationale: false };
  }
  return { level: value.level, hasRationale: typeof value.rationale === 'string' && value.rationale.trim().length > 0 };
}

function extractSubmittedRationale(value: AssessmentArtifactV1['dimensions'][string]): string | undefined {
  if (typeof value === 'string') return undefined;
  const trimmed = value.rationale?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function validateDimension(
  dimension: AssessmentDimensionDefinition,
  artifact: AssessmentArtifactV1,
  issues: string[],
  suggestions: string[],
  warnings: string[],
  recordedDimensions: RecordedAssessmentDimensionV1[],
): void {
  const submitted = artifact.dimensions[dimension.id];
  if (submitted === undefined) {
    if (dimension.required !== false) {
      issues.push(`Missing assessment dimension "${dimension.id}".`);
      suggestions.push(`Provide a value for "${dimension.id}". Allowed levels: ${dimension.levels.join(', ')}.`);
    }
    return;
  }

  const { level } = extractSubmittedLevel(submitted);
  const normalized = normalizeLevel(level, dimension.levels);
  switch (normalized.kind) {
    case 'exact':
      recordedDimensions.push({
        dimensionId: dimension.id,
        level: normalized.value,
        rationale: extractSubmittedRationale(submitted),
        normalization: 'exact',
      });
      return;
    case 'normalized':
      warnings.push(normalized.note);
      recordedDimensions.push({
        dimensionId: dimension.id,
        level: normalized.value,
        rationale: extractSubmittedRationale(submitted),
        normalization: 'normalized',
      });
      return;
    case 'ambiguous':
    case 'invalid':
      issues.push(`Dimension "${dimension.id}": ${normalized.message}`);
      suggestions.push(`Use one of the canonical levels for "${dimension.id}": ${dimension.levels.join(', ')}.`);
      return;
    default: {
      const _exhaustive: never = normalized;
      return _exhaustive;
    }
  }
}

/**
 * Validate a single assessment artifact against its definition.
 * Returns null when no matching artifact is found.
 */
function validateSingleAssessment(args: {
  readonly definition: AssessmentDefinition;
  readonly artifacts: readonly unknown[];
  readonly isSingleRef: boolean;
}): {
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
  readonly warnings: readonly string[];
  readonly acceptedArtifact: AssessmentArtifactV1 | undefined;
  readonly acceptedArtifactIndex: number | undefined;
  readonly recordedAssessment: RecordedAssessmentV1 | undefined;
} {
  const assessmentArtifacts = args.artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter(({ artifact }) => typeof artifact === 'object' && artifact !== null && (artifact as Record<string, unknown>).kind === 'wr.assessment');

  if (assessmentArtifacts.length === 0) {
    return {
      issues: [`This step requires an assessment submission for "${args.definition.id}".`],
      suggestions: [
        `Provide an artifact with kind "wr.assessment" for assessment "${args.definition.id}".`,
        `Include dimension values for: ${args.definition.dimensions.map((dimension) => `${dimension.id} (${dimension.levels.join(' | ')})`).join(', ')}.`,
      ],
      warnings: [],
      acceptedArtifact: undefined,
      acceptedArtifactIndex: undefined,
      recordedAssessment: undefined,
    };
  }

  // For single-ref steps: accept the first artifact (backward compat — assessmentId is optional).
  // For multi-ref steps: match by assessmentId only; unidentified artifacts are ambiguous.
  const candidateEntry = args.isSingleRef
    ? assessmentArtifacts[0]!
    : assessmentArtifacts.find(({ artifact }) => {
        const parsed = parseAssessmentArtifact(artifact);
        return parsed?.assessmentId === args.definition.id;
      });

  if (!candidateEntry) {
    return {
      issues: [`Missing assessment artifact for "${args.definition.id}". Provide an artifact with kind "wr.assessment" and assessmentId "${args.definition.id}".`],
      suggestions: [
        `Include dimension values for: ${args.definition.dimensions.map((d) => `${d.id} (${d.levels.join(' | ')})`).join(', ')}.`,
      ],
      warnings: [],
      acceptedArtifact: undefined,
      acceptedArtifactIndex: undefined,
      recordedAssessment: undefined,
    };
  }

  const parsed = parseAssessmentArtifact(candidateEntry.artifact);
  if (!parsed) {
    return {
      issues: ['Assessment artifact is malformed or does not match the expected shape.'],
      suggestions: [
        `Use an artifact with kind "wr.assessment", a dimensions object, and canonical dimension values for assessment "${args.definition.id}".`,
      ],
      warnings: [],
      acceptedArtifact: undefined,
      acceptedArtifactIndex: undefined,
      recordedAssessment: undefined,
    };
  }

  if (parsed.assessmentId && parsed.assessmentId !== args.definition.id) {
    return {
      issues: [`Assessment artifact targets "${parsed.assessmentId}", but this step expects "${args.definition.id}".`],
      suggestions: [`Set assessmentId to "${args.definition.id}" or omit it and provide the correct dimensions.`],
      warnings: [],
      acceptedArtifact: undefined,
      acceptedArtifactIndex: undefined,
      recordedAssessment: undefined,
    };
  }

  const issues: string[] = [];
  const suggestions: string[] = [];
  const warnings: string[] = [];
  const recordedDimensions: RecordedAssessmentDimensionV1[] = [];

  for (const dimension of args.definition.dimensions) {
    validateDimension(dimension, parsed, issues, suggestions, warnings, recordedDimensions);
  }

  const allowedDimensionIds = new Set(args.definition.dimensions.map((d) => d.id));
  for (const submittedDimensionId of Object.keys(parsed.dimensions)) {
    if (!allowedDimensionIds.has(submittedDimensionId)) {
      issues.push(`Unknown assessment dimension "${submittedDimensionId}" for assessment "${args.definition.id}".`);
      suggestions.push(`Remove "${submittedDimensionId}" and use only: ${args.definition.dimensions.map((d) => d.id).join(', ')}.`);
    }
  }

  const valid = issues.length === 0;
  return {
    issues,
    suggestions,
    warnings,
    acceptedArtifact: valid ? parsed : undefined,
    acceptedArtifactIndex: valid ? candidateEntry.index : undefined,
    recordedAssessment: valid
      ? {
          assessmentId: args.definition.id,
          summary: parsed.summary,
          dimensions: recordedDimensions,
          normalizationNotes: warnings,
        }
      : undefined,
  };
}

export function validateAssessmentForStep(args: {
  readonly step: WorkflowStepDefinition;
  readonly assessments: readonly AssessmentDefinition[] | undefined;
  readonly artifacts: readonly unknown[];
}): AssessmentValidationOutcome | undefined {
  if (!args.step.assessmentRefs || args.step.assessmentRefs.length === 0) return undefined;

  const refs = args.step.assessmentRefs;

  if (!args.assessments || args.assessments.length === 0) {
    return {
      contractRef: ASSESSMENT_CONTRACT_REF,
      recordedAssessments: [],
      acceptedArtifacts: [],
      validation: {
        valid: false,
        issues: refs.map((ref) => `Step expects assessment input for "${ref}", but the workflow declares no assessments.`),
        suggestions: ['Update the workflow definition to declare the assessments referenced by this step.'],
      },
    };
  }

  // Check all refs resolve to declared assessments.
  const allIssues: string[] = [];
  const allSuggestions: string[] = [];
  const definitions: AssessmentDefinition[] = [];
  for (const ref of refs) {
    const definition = args.assessments.find((a) => a.id === ref);
    if (!definition) {
      allIssues.push(`Step references undeclared assessment "${ref}".`);
      allSuggestions.push(`Declare assessment "${ref}" on the workflow or remove the step reference.`);
    } else {
      definitions.push(definition);
    }
  }

  if (allIssues.length > 0) {
    return {
      contractRef: ASSESSMENT_CONTRACT_REF,
      recordedAssessments: [],
      acceptedArtifacts: [],
      validation: { valid: false, issues: allIssues, suggestions: allSuggestions },
    };
  }

  const isSingleRef = refs.length === 1;
  const perRefResults = definitions.map((definition) =>
    validateSingleAssessment({ definition, artifacts: args.artifacts, isSingleRef })
  );

  const combinedIssues = perRefResults.flatMap((r) => r.issues);
  const combinedSuggestions = perRefResults.flatMap((r) => r.suggestions);
  const combinedWarnings = perRefResults.flatMap((r) => r.warnings);
  const allValid = combinedIssues.length === 0;

  const recordedAssessments: RecordedAssessmentV1[] = [];
  const acceptedArtifacts: Array<{ artifact: AssessmentArtifactV1; artifactIndex: number }> = [];

  if (allValid) {
    for (const result of perRefResults) {
      if (result.recordedAssessment) recordedAssessments.push(result.recordedAssessment);
      if (result.acceptedArtifact !== undefined && result.acceptedArtifactIndex !== undefined) {
        acceptedArtifacts.push({ artifact: result.acceptedArtifact, artifactIndex: result.acceptedArtifactIndex });
      }
    }
  }

  return {
    contractRef: ASSESSMENT_CONTRACT_REF,
    recordedAssessments,
    acceptedArtifacts,
    validation: {
      valid: allValid,
      issues: combinedIssues,
      suggestions: combinedSuggestions,
      ...(combinedWarnings.length > 0 ? { warnings: combinedWarnings } : {}),
    },
  };
}
