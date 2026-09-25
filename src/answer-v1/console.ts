import { isAbsolute } from 'node:path';
import { asSessionId, type SessionId } from '../v2/durable-core/ids/index.js';
import type { HostEnrollment, ExecutionRef } from './contracts/invocation-contract.js';
import type { ReadRef, RecoveryRef } from './contracts/answer-contract.js';
import type { ConsoleReadConfig, CreateConsoleReadRuntimeResult, ConsoleReadRuntime } from './contracts/console-composition.js';
import type { ConsoleHostScopedAnswerReader } from './contracts/console-contract.js';
import { composeAnswerReader, composeAnswerReaderFromDataDir, type AnswerReadEngine } from './reader-composition.js';
import { capability, readHostState, inspectionView } from './host-state.js';
import { createInspector } from './inspector.js';

/** Dedicated projections never initialize the runtime, acquire an owner or mint a reply
 * for the console. Session selectors are not host authority: binding is trusted injection. */
export async function createConsoleReadRuntime(config: ConsoleReadConfig, lifetime: AbortSignal): Promise<CreateConsoleReadRuntimeResult> {
  if (lifetime.aborted) return { kind: 'refused', reason: 'cancelled', detail: 'Reader cancelled' };
  if (![config?.storage?.journalRootDir, config?.storage?.hostIndexRootDir, config?.keyringPath, config?.workflowStoragePath].every(path => typeof path === 'string' && isAbsolute(path)))
    return { kind: 'refused', reason: 'missing_authority', detail: 'Explicit absolute authority paths required' };
  const composed = await composeAnswerReader(config);
  if (composed.kind !== 'ready') return { kind: 'refused', reason: 'storage_unavailable', detail: 'Existing reader authority unavailable' };
  return { kind: 'created', runtime: createConsoleReadRuntimeFromEngine(composed.engine, lifetime) };
}

/** Existing console composition can project its own authority without initializing a
 * second engine. The boundary accepts read capabilities only. */
export function createConsoleReadRuntimeFromEngine(engine: AnswerReadEngine, lifetime: AbortSignal): ConsoleReadRuntime {
  let closed = false;
  const available = (signal?: AbortSignal) => !closed && !lifetime.aborted && !signal?.aborted;
  const boundReader = (enrollment: HostEnrollment): ConsoleHostScopedAnswerReader => {
    const sessionId = asSessionId(enrollment.execution);
    return {
      scope: 'host_bound', boundSessionId: sessionId,
      async getAnswer(signal) {
        if (!available(signal)) return { kind: 'unavailable', sessionId, reason: 'storage_unavailable' };
        const loaded = await readHostState(engine, enrollment);
        if (loaded.kind !== 'loaded') return { kind: 'unavailable', sessionId, reason: loaded.reason };
        const view = await inspectionView(engine, loaded.state);
        if (!available(signal) || view.kind === 'unavailable') return { kind: 'unavailable', sessionId, reason: 'storage_unavailable' };
        return { kind: 'loaded', sessionId, view };
      },
      async getReceipt(receipt, cursor, signal) {
        if (!available(signal)) return { kind: 'unavailable', sessionId, receipt, reason: 'storage_unavailable' };
        const loaded = await readHostState(engine, enrollment);
        if (loaded.kind !== 'loaded') return { kind: 'unavailable', sessionId, receipt, reason: loaded.reason };
        const read = capability(engine, loaded.state, 'read') as ReadRef;
        const page = await createInspector(engine, enrollment).inspectReceipt(read, receipt, signal ? AbortSignal.any([signal, lifetime]) : lifetime, cursor);
        if (!available(signal)) return { kind: 'unavailable', sessionId, receipt, reason: 'storage_unavailable' };
        if (page.kind === 'refused') return (page.reason === 'storage_unavailable' || page.reason === 'corrupt')
          ? { kind: 'unavailable', sessionId, receipt, reason: page.reason }
          : { kind: 'refused', sessionId, receipt, reason: page.reason };
        return { kind: 'loaded', sessionId, receipt, page };
      },
    };
  };
  const selectUnbound = async (sessionId: SessionId, signal?: AbortSignal) => {
    if (!available(signal)) return { kind: 'unavailable' as const, reason: 'storage_unavailable' as const };
    if (!/^sess_[a-z0-9]+$/.test(sessionId)) return { kind: 'refused' as const, reason: 'invalid_scope' as const };
    const loaded = await engine.sessionStore.load(sessionId);
    if (loaded.isErr()) return { kind: 'unavailable' as const, reason: loaded.error.code === 'SESSION_STORE_CORRUPTION_DETECTED'
      ? loaded.error.reason.code === 'unknown_schema_version' ? 'unsupported_version' as const : 'corrupt' as const
      : 'storage_unavailable' as const };
    const entries = loaded.value.events.filter(e => e.kind === 'answer_host_recorded' && e.data.kind === 'enrolled');
    if (loaded.value.events.length === 0) return { kind: 'unavailable' as const, reason: 'missing' as const };
    if (entries.length === 0) return { kind: 'not_enrolled' as const, reason: 'legacy_workflow' as const };
    const entry = entries[0];
    if (entries.length !== 1 || entry?.kind !== 'answer_host_recorded' || entry.data.kind !== 'enrolled')
      return { kind: 'unavailable' as const, reason: 'corrupt' as const };
    if (entry.data.mode === 'host_bound') return { kind: 'refused' as const, reason: 'bound_session_required' as const };
    // Canonical unbound enrollment is the authority source, never caller pairing.
    const enrollment = { execution: sessionId as string as ExecutionRef, recovery: entry.data.recovery as RecoveryRef } as HostEnrollment;
    return { kind: 'reader' as const, reader: boundReader(enrollment) };
  };
  return {
    unboundReader: {
      scope: 'unbound',
      async getAnswer(sessionId, signal) {
        const selected = await selectUnbound(sessionId, signal);
        return selected.kind === 'reader' ? selected.reader.getAnswer(signal) : { ...selected, sessionId };
      },
      async getReceipt(sessionId, receipt, cursor, signal) {
        const selected = await selectUnbound(sessionId, signal);
        return selected.kind === 'reader' ? selected.reader.getReceipt(receipt, cursor, signal)
          : selected.kind === 'not_enrolled' ? { ...selected, sessionId } : { ...selected, sessionId, receipt };
      },
    },
    async bindHost(enrollment, signal) {
      if (!available(signal)) return { kind: 'refused', reason: 'cancelled', detail: 'Reader unavailable' };
      const loaded = await readHostState(engine, enrollment);
      if (loaded.kind !== 'loaded') return { kind: 'refused', reason: loaded.reason, detail: 'Enrollment unavailable' };
      if (loaded.state.mode !== 'host_bound') return { kind: 'refused', reason: 'missing', detail: 'Host enrollment required' };
      if (!available(signal)) return { kind: 'refused', reason: 'cancelled', detail: 'Reader unavailable' };
      return { kind: 'bound', reader: boundReader(enrollment) };
    },
    async close() { closed = true; return { kind: 'closed' }; },
  };
}

/** Resolve existing authority per request so a console started before its first
 * session becomes useful without restarting or creating keys on the read path. */
export function createStandaloneAnswerReader(
  dataDir: import('../v2/ports/data-dir.port.js').DataDirPortV2,
  lifetime: AbortSignal,
): import('./contracts/console-contract.js').ConsoleSessionAnswerReader {
  const load = async (signal?: AbortSignal) => {
    if (lifetime.aborted || signal?.aborted) return undefined;
    const composed = await composeAnswerReaderFromDataDir(dataDir);
    if (composed.kind !== 'ready' || lifetime.aborted || signal?.aborted) return undefined;
    return createConsoleReadRuntimeFromEngine(composed.engine, lifetime).unboundReader;
  };
  return {
    scope: 'unbound',
    async getAnswer(sessionId, signal) {
      const reader = await load(signal);
      return reader ? reader.getAnswer(sessionId, signal)
        : { kind: 'unavailable', sessionId, reason: 'storage_unavailable' };
    },
    async getReceipt(sessionId, receipt, cursor, signal) {
      const reader = await load(signal);
      return reader ? reader.getReceipt(sessionId, receipt, cursor, signal)
        : { kind: 'unavailable', sessionId, receipt, reason: 'storage_unavailable' };
    },
  };
}
