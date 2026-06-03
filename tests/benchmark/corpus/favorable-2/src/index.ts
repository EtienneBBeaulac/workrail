export interface RawRecord {
  readonly id: string;
  readonly name?: string;
  readonly value: string;
}

export interface RefinedRecord {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}

/**
 * Refines raw data records by running them through three stages:
 * Stage 1: Filter out records with empty or missing `id`.
 * Stage 2: Format name: if missing, set to "Unknown". Trim and capitalize the first letter.
 * Stage 3: Parse value as a number. If parsing fails (NaN), default the value to 0.
 */
export function refineData(records: readonly RawRecord[]): RefinedRecord[] {
  // TODO: Implement the 3-stage data refiner.
  return [];
}
