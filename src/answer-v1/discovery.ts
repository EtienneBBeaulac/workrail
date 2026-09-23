import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { answerDataDir } from './engine-composition.js';
import { NodeFileSystemV2 } from '../v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../v2/infra/local/session-store/index.js';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import type { CreateHostDiscoveryResult, HostDiscoveryConfig, HostDiscoveryCursor, HostScanResult, DiscoveredSessionEntry } from './contracts/host-discovery-contract.js';
import { MAX_HOST_DISCOVERY_ENTRIES } from './contracts/host-discovery-contract.js';
export { MAX_HOST_DISCOVERY_ENTRIES };
const Key = z.object({ alg: z.literal('hmac_sha256'), keyBase64Url: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const Keyring = z.object({ v: z.literal(1), current: Key, previous: Key.nullable() });
/** This composition only reads. It cannot initialize authority or acquire session ownership. */
export async function createHostDiscovery(config: HostDiscoveryConfig, signal: AbortSignal): Promise<CreateHostDiscoveryResult> {
    if (signal.aborted)
        return { kind: 'cancelled' };
    if (![config.storage.journalRootDir, config.storage.hostIndexRootDir, config.keyringPath, config.workflowStoragePath].every(isAbsolute))
        return { kind: 'refused', reason: 'missing_authority', detail: 'Explicit absolute authority paths required' };
    try {
        const raw: unknown = JSON.parse(await readFile(config.keyringPath, 'utf8'));
        if (!Keyring.safeParse(raw).success)
            return { kind: 'refused', reason: 'missing_authority', detail: 'Invalid configured authority' };
    }
    catch (error) {
        return { kind: 'refused', reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_authority' : 'storage_unavailable', detail: 'Cannot read configured authority' };
    }
    const store = new LocalSessionEventLogStoreV2(answerDataDir(config), new NodeFileSystemV2(), new NodeSha256V2());
    const positions = new WeakMap<HostDiscoveryCursor, number>();
    let ids: readonly string[] | undefined;
    let closed = false;
    async function entry(id: string): Promise<DiscoveredSessionEntry> {
        const sessionId = asSessionId(id);
        try {
            if (!(await stat(join(config.storage.journalRootDir, id))).isDirectory())
                return { kind: 'unavailable', sessionId, reason: 'storage_unavailable', detail: 'Session path is not a directory' };
        }
        catch (error) {
            return { kind: 'unavailable', sessionId, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'storage_unavailable', detail: 'Cannot read enumerated session' };
        }
        const result = await store.load(sessionId);
        if (result.isErr())
            return { kind: 'unavailable', sessionId, reason: result.error.code === 'SESSION_STORE_CORRUPTION_DETECTED'
                    ? result.error.reason.code === 'unknown_schema_version' ? 'unsupported_version' : 'corrupt' : 'storage_unavailable', detail: result.error.message };
        const enrolled = result.value.events.filter(e => e.kind === 'answer_host_recorded' && e.data.kind === 'enrolled');
        const enrollment = enrolled[0];
        if (enrolled.length > 1)
            return { kind: 'unavailable', sessionId, reason: 'corrupt', detail: 'Multiple host enrollments' };
        if (enrollment?.kind === 'answer_host_recorded' && enrollment.data.kind === 'enrolled' && enrollment.data.mode === 'unbound')
            return { kind: 'unbound', sessionId };
        if (enrollment?.kind === 'answer_host_recorded' && enrollment.data.kind === 'enrolled')
            return { kind: 'host', sessionId, pointer: { formatVersion: 1, executionId: id, recoveryLocator: enrollment.data.recovery } };
        return { kind: 'legacy', sessionId };
    }
    return { kind: 'created', scanner: {
            async scan(cursor, signal): Promise<HostScanResult> {
                if (signal.aborted)
                    return { kind: 'cancelled' };
                if (closed)
                    return { kind: 'refused', reason: 'scanner_closed', detail: 'Scanner is closed' };
                const offset = cursor === undefined ? 0 : positions.get(cursor);
                if (offset === undefined)
                    return { kind: 'refused', reason: 'invalid_cursor', detail: 'Cursor belongs to another scanner' };
                if (!ids) {
                    try {
                        const enumerated = (await readdir(config.storage.journalRootDir, { withFileTypes: true })).filter(e => e.isDirectory() && /^sess_[a-z0-9]+$/.test(e.name)).map(e => e.name).sort();
                        ids ??= enumerated;
                    }
                    catch (error) {
                        return { kind: 'unavailable', reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'storage_unavailable', detail: 'Cannot enumerate canonical sessions' };
                    }
                }
                const entries: DiscoveredSessionEntry[] = [];
                for (const id of ids.slice(offset, offset + MAX_HOST_DISCOVERY_ENTRIES)) {
                    if (signal.aborted)
                        return { kind: 'cancelled' };
                    entries.push(await entry(id));
                }
                if (closed)
                    return { kind: 'refused', reason: 'scanner_closed', detail: 'Scanner closed during scan' };
                if (offset + entries.length >= ids.length)
                    return { kind: 'page', page: { kind: 'end', entries } };
                const nextCursor = Object.freeze({}) as HostDiscoveryCursor;
                positions.set(nextCursor, offset + entries.length);
                return { kind: 'page', page: { kind: 'more', entries: entries as [
                            DiscoveredSessionEntry,
                            ...DiscoveredSessionEntry[]
                        ], nextCursor } };
            },
            async close(signal) {
                if (signal.aborted)
                    return { kind: 'incomplete', reason: 'cancelled', detail: 'Close cancelled' };
                closed = true;
                return { kind: 'closed' };
            },
        } };
}
