/** Nonblocking telemetry still has an owner. Closing seals admission and drains
 * accepted work before storage can be removed. Per-session ordering avoids lock
 * re-entrancy between start/end metric writers. */
export class BackgroundWork {
  private state: 'open' | 'closing' = 'open';
  private outcome: 'closed' | 'failed' = 'closed';
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly reportFailure: (error: unknown) => void) {}

  submit(key: string, operation: () => Promise<unknown>): 'accepted' | 'closed' {
    if (this.state === 'closing') {
      try { this.reportFailure({ kind: 'admission_closed', key }); } catch { /* reporting cannot reopen admission */ }
      return 'closed';
    }
    const previous = this.pending.get(key) ?? Promise.resolve();
    const task = previous.then(operation).then(() => {}, error => {
      this.outcome = 'failed';
      try { this.reportFailure(error); } catch { /* reporting cannot orphan the task */ }
    });
    this.pending.set(key, task);
    void task.then(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
    return 'accepted';
  }

  async close(signal: AbortSignal): Promise<'closed' | 'incomplete' | 'failed'> {
    this.state = 'closing';
    if (this.pending.size === 0) return this.outcome;
    if (signal.aborted) return 'incomplete';
    const drained = await waitForCompletion(Promise.all(this.pending.values()).then(() => {}), signal);
    return drained === 'closed' ? this.outcome : drained;
  }
}

/** A deadline ends the caller's wait, not the owned work or its drainage obligation. */
export async function waitForCompletion(work: Promise<void>, signal: AbortSignal): Promise<'closed' | 'incomplete' | 'failed'> {
  if (signal.aborted) {
    void work.catch(() => {}); // The caller has stopped waiting; a retry still observes failure.
    return 'incomplete';
  }
  let onAbort!: () => void;
  const cancelled = new Promise<'incomplete'>(resolve => {
    onAbort = () => resolve('incomplete');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work.then(() => 'closed' as const, () => 'failed' as const), cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
