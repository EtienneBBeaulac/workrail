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

export interface AssessmentValidationOutcome {
  readonly contractRef: typeof ASSESSMENT_CONTRACT_REF;
  readonly validation: ValidationResult;
  readonly acceptedArtifact: AssessmentArtifactV1 | undefined;
  readonly acceptedArtifactIndex: number | undefined;
  readonly recordedAssessment: RecordedAssessmentV1 | undefined;
}

export interface RecordedAssessmentDimensionV1 {
  readonly dimensionId: string;
  readonly level: string;
  readonly rationale?: string;
  readonly normalization: 'exact' | 'normalized';
}

export interface RecordedAssessmentV1 {
  readonly assessmentId: string;
  readonly summary?: string;
  readonly dimensions: readonly RecordedAssessmentDimensionV1[];
  readonly normalizationNotes: readonly string[];
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

function buildDefinitionLookup(
  assessments: readonly AssessmentDefinition[] | undefined,
  step: WorkflowStepDefinition,
): { readonly definition: AssessmentDefinition | undefined; readonly issues: readonly string[]; readonly suggestions: readonly string[] } {
  const refs = step.assessmentRefs ?? [];
  if (refs.length === 0) {
    return {
      definition: undefined,
      issues: [],
      suggestions: [],
    };
  }

  if (!assessments || assessments.length === 0) {
    return {
      definition: undefined,
      issues: [`Step "${step.id}" expects assessment input, but the workflow declares no assessments.`],
      suggestions: ['Update the workflow definition to declare the assessments referenced by this step.'],
    };
  }

  if (refs.length > 1) {
    return {
      definition: undefined,
      issues: [`Step "${step.id}" declares multiple assessmentRefs. Assessment boundary validation currently supports exactly one assessment per step.`],
      suggestions: ['Reduce assessmentRefs to a single assessment for this step in v1.'],
    };
  }

  const definition = assessments.find((assessment) => assessment.id === refs[0]);
  if (!definition) {
    return {
      definition: undefined,
      issues: [`Step "${step.id}" references undeclared assessment "${refs[0]}".`],
      suggestions: [`Declare assessment "${refs[0]}" on the workflow or remove the step reference.`],
    };
  }

  return { definition, issues: [], suggestions: [] };
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

export function validateAssessmentForStep(args: {
  readonly step: WorkflowStepDefinition;
  readonly assessments: readonly AssessmentDefinition[] | undefined;
  readonly artifacts: readonly unknown[];
}): AssessmentValidationOutcome | undefined {
  if (!args.step.assessmentRefs || args.step.assessmentRefs.length === 0) return undefined;

  const lookup = buildDefinitionLookup(args.assessments, args.step);
  if (!lookup.definition) {
    return {
      contractRef: ASSESSMENT_CONTRACT_REF,
      acceptedArtifact: undefined,
      acceptedArtifactIndex: undefined,
      recordedAssessment: undefined,
      validation: {
        valid: false,
        issues: [...lookup.issues],
        suggestions: [...lookup.suggestions],
      },
    };
  }

  const assessmentArtifacts = args.artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter(({ artifact }) => typeof artifact === 'object' && artifact !== null && (artifact as Record<string, unknown>).kind === 'wr.assessment');
  if (assessmentArtifacts.length === 0) {
    return {
      contractRef: ASSESSMENT_CONTRACT_REF,
      acceptedArtifact: undefined,
      acceptedArtifactIndex: undefined,
      recordedAssessment: undefined,
      validation: {
        valid: false,
        issues: [`This step requires an assessment submission for "${lookup.definition.id}".`],
        suggestions: [
          `Provide an artifact with kind "wr.assessment" for assessment "${lookup.definition.id}".`,
          `Include dimension values for: ${lookup.definition.dimensions.map((dimension) => `${dimension.id} (${dimension.levels.join(' | ')})`).join(', ')}.`,
        ],
      },
    };
  }

  const acceptedCandidate = assessmentArtifacts[0]!;
  const parsed = parseAssessmentArtifact(acceptedCandidate.artifact);
  if (!parsed) {
    return {
      contractRef: ASSESSMENT_CONTRACT_REF,
      acceptedArtifact: undefined,
      acceptedArtifactIndex: undefined,
      recordedAssessment: undefined,
      validation: {
        valid: false,
        issues: ['Assessment artifact is malformed or does not match the expected shape.'],
        suggestions: [
          `Use an artifact with kind "wr.assessment", a dimensions object, and canonical dimension values for assessment "${lookup.definition.id}".`,
        ],
      },
    };
  }

  if (parsed.assessmentId && parsed.assessmentId !== lookup.definition.id) {
    return {
      contractRef: ASSESSMENT_CONTRACT_REF,
      acceptedArtifact: undefined,
      acceptedArtifactIndex: undefined,
      recordedAssessment: undefined,
      validation: {
        valid: false,
        issues: [`Assessment artifact targets "${parsed.assessmentId}", but this step expects "${lookup.definition.id}".`],
        suggestions: [`Set assessmentId to "${lookup.definition.id}" or omit it and provide the correct dimensions.`],
      },
    };
  }

  const issues: string[] = [];
  const suggestions: string[] = [];
  const warnings: string[] = [];
  const recordedDimensions: RecordedAssessmentDimensionV1[] = [];

  for (const dimension of lookup.definition.dimensions) {
    validateDimension(dimension, parsed, issues, suggestions, warnings, recordedDimensions);
  }

  const allowedDimensionIds = new Set(lookup.definition.dimensions.map((dimension) => dimension.id));
  for (const submittedDimensionId of Object.keys(parsed.dimensions)) {
    if (!allowedDimensionIds.has(submittedDimensionId)) {
      issues.push(`Unknown assessment dimension "${submittedDimensionId}" for assessment "${lookup.definition.id}".`);
      suggestions.push(`Remove "${submittedDimensionId}" and use only: ${lookup.definition.dimensions.map((dimension) => dimension.id).join(', ')}.`);
    }
  }

  return {
    contractRef: ASSESSMENT_CONTRACT_REF,
    acceptedArtifact: issues.length === 0 ? parsed : undefined,
    acceptedArtifactIndex: issues.length === 0 ? acceptedCandidate.index : undefined,
    recordedAssessment: issues.length === 0
      ? {
          assessmentId: lookup.definition.id,
          summary: parsed.summary,
          dimensions: recordedDimensions,
          normalizationNotes: warnings,
        }
      : undefined,
    validation: {
      valid: issues.length === 0,
      issues,
      suggestions,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
  };
}
