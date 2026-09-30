export type ServingOutcome<T> =
  | Readonly<{ kind: 'served'; value: T }>
  | Readonly<{ kind: 'refused'; reason: 'closing' | 'capacity' }>
  | Readonly<{ kind: 'failed'; message: string }>;

/** Completed exchanges are released; shutdown seals before awaiting accepted work. */
export class ServingAdmission {
  private phase: 'open' | 'closing' = 'open';
  private readonly pending = new Set<Promise<void>>();
  static readonly maximumConcurrent = 128;

  async serve<T>(operation: () => Promise<T>): Promise<ServingOutcome<T>> {
    if (this.phase === 'closing') return { kind: 'refused', reason: 'closing' };
    if (this.pending.size >= ServingAdmission.maximumConcurrent) return { kind: 'refused', reason: 'capacity' };
    const result = Promise.resolve().then(operation).then(
      value => ({ kind: 'served' as const, value }),
      error => ({ kind: 'failed' as const, message: error instanceof Error ? error.message : String(error) }),
    );
    const settled = result.then(() => {});
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    return result;
  }

  async close(): Promise<void> {
    this.phase = 'closing';
    await Promise.all(this.pending);
  }
}
