import { waitForCompletion } from '../background-work.js';
export type CloseOutcome = 'closed' | 'incomplete' | 'failed';
export interface TransportClosePorts {
  readonly closeRequests: () => Promise<void>;
  readonly stopListener: () => Promise<void>;
  readonly closeProtocol: () => Promise<void>;
  readonly drainBackground: () => Promise<CloseOutcome>;
}
/** Seal request admission before stopping transport. Socket failures must not skip
 * draining accepted handlers or their writes. A deadline ends only this caller's wait. */
export function createTransportClose(ports: TransportClosePorts): (signal: AbortSignal) => Promise<CloseOutcome> {
  let closing: Promise<'closed' | 'failed'> | undefined;
  const attempt = async (): Promise<'closed' | 'failed'> => {
    const requests = Promise.resolve().then(ports.closeRequests).then(() => true, () => false);
    const listener = await Promise.resolve().then(ports.stopListener).then(() => true, () => false);
    const drained = await requests;
    const protocol = await Promise.resolve().then(ports.closeProtocol).then(() => true, () => false);
    const background = await Promise.resolve().then(ports.drainBackground).catch(() => 'failed' as const);
    return listener && drained && protocol && background === 'closed' ? 'closed' : 'failed';
  };
  return async signal => {
    const owned = closing ??= attempt();
    const waited = await waitForCompletion(owned.then(() => {}), signal);
    if (waited !== 'closed') return waited;
    const outcome = await owned;
    if (outcome === 'failed' && closing === owned) closing = undefined;
    return outcome;
  };
}

/** Process shutdown is a boundary: unfinished cleanup must never exit as success. */
export async function drainBeforeTerminate(
  close: (signal: AbortSignal) => Promise<CloseOutcome>,
  signal: AbortSignal,
): Promise<void> {
  const outcome = await close(signal);
  if (outcome !== 'closed') throw new Error(`Transport shutdown ${outcome}`);
}
