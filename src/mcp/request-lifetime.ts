/** HTTP socket completion is not handler completion: a client can disconnect while
 * a tool still writes. Track accepted handlers at the protocol dispatch boundary. */
export class RequestLifetime {
  private sealed = false;
  private readonly pending = new Set<Promise<void>>();

  wrap<A extends unknown[], R>(handler: (...args: A) => Promise<R>) {
    return (...args: A): Promise<R | { isError: true; content: { type: 'text'; text: string }[] }> => {
      if (this.sealed) return Promise.resolve({ isError: true, content: [{ type: 'text', text: 'Server is closing; no work was admitted.' }] });
      const result = Promise.resolve().then(() => handler(...args));
      const settled = result.then(() => {}, () => {});
      this.pending.add(settled);
      void settled.then(() => this.pending.delete(settled));
      return result;
    };
  }

  async close(): Promise<void> {
    this.sealed = true;
    await Promise.all(this.pending);
  }
}
