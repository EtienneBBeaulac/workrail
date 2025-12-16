import type { ShutdownEvent, ShutdownEvents, Unsubscribe } from '../ports/shutdown-events.js';

/**
 * In-memory ShutdownEvents implementation.
 * Safe for tests and single-process usage.
 */
export class InMemoryShutdownEvents implements ShutdownEvents {
  private readonly listeners = new Set<(event: ShutdownEvent) => void>();

  onShutdown(listener: (event: ShutdownEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ShutdownEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
