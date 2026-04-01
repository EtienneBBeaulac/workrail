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
