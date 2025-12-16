export interface LoopPathFrame {
  readonly loopId: string;
  readonly iteration: number; // 0-based
}

export interface StepInstanceId {
  readonly stepId: string;
  readonly loopPath: readonly LoopPathFrame[];
}

/**
 * Canonical, stable key for a step instance.
 * This avoids ambiguity when step IDs repeat across loop iterations.
 */
export function toStepInstanceKey(id: StepInstanceId): string {
  const path = id.loopPath
    .map((f) => `${f.loopId}@${f.iteration}`)
    .join('/');
  return path.length === 0 ? id.stepId : `${path}::${id.stepId}`;
}
