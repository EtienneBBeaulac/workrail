import type { HostInspectorPort, EvidenceChunk, EvidenceCursor, ReceiptRef } from './contracts/answer-contract.js';
import type { HostEnrollment } from './contracts/invocation-contract.js';
import type { AnswerReadEngine } from './engine-composition.js';
import { capability, readHostState, inspectionView } from './host-state.js';
/** Read authority is validated against the task fixed by host composition. */
export function createInspector(engine: AnswerReadEngine, enrollment: HostEnrollment): HostInspectorPort {
    return {
        scope: 'host_bound',
        async inspect(read, signal) {
            if (signal.aborted)
                return { kind: 'unavailable', reason: 'cancelled' };
            const loaded = await readHostState(engine, enrollment);
            if (loaded.kind !== 'loaded' || read !== capability(engine, loaded.state, 'read'))
                return { kind: 'unavailable', reason: 'invalid_scope' };
            const view = await inspectionView(engine, loaded.state);
            return view.kind === 'unavailable' ? { kind: 'unavailable', reason: view.detail } : view;
        },
        async inspectReceipt(read, receipt, signal, cursor) {
            if (signal.aborted)
                return { kind: 'refused', reason: 'storage_unavailable' };
            const loaded = await readHostState(engine, enrollment);
            if (loaded.kind !== 'loaded')
                return { kind: 'refused', reason: 'storage_unavailable' };
            const state = loaded.state;
            if (read !== capability(engine, state, 'read'))
                return { kind: 'refused', reason: 'invalid_scope' };
            const record = state.records.find(r => (r.kind === 'committed' || r.kind === 'review_committed' || r.kind === 'review_partial' || r.kind === 'review_correction' || r.kind === 'rejected') && r.receipt === receipt);
            if (!record || (record.kind !== 'committed' && record.kind !== 'review_committed' && record.kind !== 'review_partial' && record.kind !== 'review_correction' && record.kind !== 'rejected'))
                return { kind: 'refused', reason: 'invalid_scope' };
            const text = record.kind === 'committed' ? JSON.stringify({ notes: record.notes }) : record.rawAnswer;
            let offset = 0;
            if (cursor) {
                const parts = cursor.split(':');
                const value = Number(parts[0]);
                if (parts.length !== 2 || !Number.isSafeInteger(value) || value < 0 || parts[1] !== capability(engine, state, 'cursor', `${receipt}:${value}`))
                    return { kind: 'refused', reason: 'invalid_scope' };
                offset = value;
            }
            const bytes = Buffer.from(text);
            if (offset > bytes.length)
                return { kind: 'refused', reason: 'invalid_scope' };
            let end = Math.min(offset + 4096, bytes.length);
            while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80)
                end--;
            const chunk = bytes.subarray(offset, end).toString('utf8') as EvidenceChunk;
            const base = { receipt: record.receipt as ReceiptRef, disposition: record.kind === 'committed' || record.kind === 'review_committed' ? 'accepted' as const : record.kind === 'review_partial' ? 'partial' as const : 'rejected' as const, encoding: record.kind === 'rejected' ? record.encoding : 'canonical_json' as const, chunk };
            return end === bytes.length ? { ...base, kind: 'complete' } : { ...base, kind: 'more', next: `${end}:${capability(engine, state, 'cursor', `${receipt}:${end}`)}` as EvidenceCursor };
        },
    };
}
