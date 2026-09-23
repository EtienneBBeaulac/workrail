import { readFile, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import type {
  RunStudyOptions,
  StudyReport,
  StageAStudyReport,
  StageBStudyReport,
  HostRecord,
  StageAScoreReport,
  UnresolvedStudyReport,
  RejectedBytesReason,
} from './study-runner-contract.js';
import type {
  TrialRequest,
  AgentEvent,
  AgentTransport,
  LedgerRecord,
} from './trial-executor-contract.js';
import type {
  PreflightTraceRecord,
  PreflightAdmissionReceipt,
  PreflightedExecutionResult,
} from './trial-preflight-contract.js';
import { executePreflightedStudy } from './trial-preflight.mjs';
import {
  computeSha256,
  validateStudyManifest,
  verifyManifestArtifacts,
  type ValidatedStudyManifest,
} from './study-manifest.mjs';
import type { StageBScorerReport } from './stage-b-scorer-contract.js';
import {
  type PlannedSlot,
  type SlotDisposition,
  type StreamOrderEntry,
  type JournalParseOutcome,
  parseLedgerRecords,
  parseHostRecords,
  parseStreamOrder,
  normalizeStudy,
  resolveFailureSlotDispositions,
  buildPlannedSlots,
} from './study-runner-normalization.mjs';

class HostJournalingTransport implements AgentTransport {
  private storageError: unknown | null = null;
  private nextSeq = 0;

  constructor(
    private readonly transport: RunStudyOptions['transport'],
    private readonly hostHandle: FileHandle,
    private readonly streamHandle: FileHandle,
  ) {}

  hasStorageError(): boolean {
    return this.storageError !== null;
  }

  getStorageError(): unknown | null {
    return this.storageError;
  }

  async *startFresh(request: TrialRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    if (signal.aborted) {
      return;
    }

    const stream = this.transport.startFresh(request, signal);
    const iterator = stream[Symbol.asyncIterator]();

    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<{ readonly aborted: true }>((resolveAbort) => {
      abortListener = () => resolveAbort({ aborted: true });
      signal.addEventListener('abort', abortListener, { once: true });
    });

    try {
      while (true) {
        if (signal.aborted) {
          return;
        }

        const nextResultPromise = iterator.next().then(
          (res) => ({ aborted: false as const, res }),
          (err: unknown) => ({ aborted: false as const, err }),
        );

        const outcome = await Promise.race([nextResultPromise, abortPromise]);
        if (outcome.aborted || signal.aborted) {
          return;
        }

        if ('err' in outcome) {
          throw outcome.err;
        }

        const { res } = outcome;
        if (res.done) {
          return;
        }

        if (signal.aborted) {
          return;
        }

        const item = res.value;
        if (item.type === 'host') {
          if (signal.aborted) {
            return;
          }
          const hostLine = JSON.stringify(item.record) + '\n';
          const streamEntry: StreamOrderEntry = {
            seq: this.nextSeq++,
            runId: request.runId,
            arm: request.arm,
            type: 'host',
            recordId: item.record.recordId,
            kind: item.record.kind,
            hostRunId: item.record.runId,
            atMs: item.record.atMs,
            conversationId:
              'conversationId' in item.record && typeof item.record.conversationId === 'string'
                ? item.record.conversationId
                : undefined,
          };
          const streamLine = JSON.stringify(streamEntry) + '\n';
          try {
            await this.hostHandle.appendFile(hostLine, 'utf8');
            await this.streamHandle.appendFile(streamLine, 'utf8');
          } catch (writeErr: unknown) {
            this.storageError = writeErr;
            throw writeErr;
          }
        } else if (item.type === 'agent') {
          if (signal.aborted) {
            return;
          }
          const streamEntry: StreamOrderEntry = {
            seq: this.nextSeq++,
            runId: request.runId,
            arm: request.arm,
            type: 'agent',
            eventType: item.event.type,
            conversationId:
              'conversationId' in item.event && typeof item.event.conversationId === 'string'
                ? item.event.conversationId
                : undefined,
            priorConversationId:
              'priorConversationId' in item.event &&
              typeof item.event.priorConversationId === 'string'
                ? item.event.priorConversationId
                : undefined,
          };
          const streamLine = JSON.stringify(streamEntry) + '\n';
          try {
            await this.streamHandle.appendFile(streamLine, 'utf8');
          } catch (writeErr: unknown) {
            this.storageError = writeErr;
            throw writeErr;
          }
          yield item.event;
        }
      }
    } finally {
      if (abortListener !== undefined) {
        signal.removeEventListener('abort', abortListener);
      }
      if (typeof iterator.return === 'function') {
        try {
          await iterator.return();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}

function createUnreadableManifestReport(
  options: RunStudyOptions,
): UnresolvedStudyReport {
  return {
    version: 1,
    scope: 'orchestration_only',
    trialAuthorization: false,
    manifestPath: options.manifestPath,
    stage: 'unresolved',
    status: 'failed',
    failureKind: 'unreadable_manifest',
    manifestSha256: null,
    scoreReport: null,
    trials: [],
    preflight: null,
    preflightTraces: [],
    agentLedger: [],
    hostLedger: [],
    slots: [],
  };
}

function createRejectedBytesReport(
  options: RunStudyOptions,
  manifestSha256: string,
  reason: RejectedBytesReason,
  slots: UnresolvedStudyReport['slots'],
): UnresolvedStudyReport {
  return {
    version: 1,
    scope: 'orchestration_only',
    trialAuthorization: false,
    manifestPath: options.manifestPath,
    stage: 'unresolved',
    status: 'failed',
    failureKind: 'rejected_bytes',
    manifestSha256,
    reason,
    scoreReport: null,
    trials: [],
    preflight: null,
    preflightTraces: [],
    agentLedger: [],
    hostLedger: [],
    slots,
  };
}

const rawArmSlotSchema = z.object({
  runId: z.string().min(1),
}).passthrough();

const rawManifestSlotSchema = z.object({
  pairs: z.array(
    z.record(z.string(), z.unknown()).and(
      z.object({
        armOrder: z.array(z.string()),
      }),
    ),
  ),
}).passthrough();

function buildNotAttemptedSlots(
  manifestJson: unknown,
): UnresolvedStudyReport['slots'] {
  const parsed = rawManifestSlotSchema.safeParse(manifestJson);
  if (!parsed.success) {
    return [];
  }
  const slots: Extract<SlotDisposition, { readonly status: 'not_attempted' }>[] = [];
  const seen = new Set<string>();
  for (const pair of parsed.data.pairs) {
    for (const arm of pair.armOrder) {
      const armValue = pair[arm];
      const armParsed = rawArmSlotSchema.safeParse(armValue);
      if (armParsed.success && !seen.has(armParsed.data.runId)) {
        seen.add(armParsed.data.runId);
        slots.push({ runId: armParsed.data.runId, status: 'not_attempted' });
      }
    }
  }
  return slots;
}

function toNotAttemptedSlots(slots: readonly PlannedSlot[]): readonly SlotDisposition[] {
  return slots.map((s) => ({ runId: s.runId, status: 'not_attempted' }));
}

function hasErrorCode(err: object): err is { readonly code: unknown } {
  return 'code' in err;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && hasErrorCode(err) && err.code === 'ENOENT';
}

async function writeReport(handle: FileHandle, report: StudyReport): Promise<boolean> {
  try {
    await handle.writeFile(JSON.stringify(report), 'utf8');
    await handle.sync();
    return true;
  } catch {
    return false;
  }
}

async function safeExclusivePersist(outputDir: string, report: StudyReport): Promise<boolean> {
  const ownership = await claimOutputOwnership(outputDir);
  if (ownership.kind === 'conflict') return false;
  try {
    return await writeReport(ownership.reportHandle, report);
  } finally {
    await ownership.cleanup();
  }
}

type ClaimOutcome =
  | {
      readonly kind: 'claimed';
      readonly hostHandle: FileHandle;
      readonly streamHandle: FileHandle;
      readonly reportHandle: FileHandle;
      readonly cleanup: () => Promise<void>;
    }
  | {
      readonly kind: 'conflict';
    };

async function claimOutputOwnership(outputDir: string): Promise<ClaimOutcome> {
  try {
    await mkdir(outputDir, { recursive: true });
  } catch {
    return { kind: 'conflict' };
  }

  const hostObservationsPath = join(outputDir, 'host-observations.ndjson');
  const streamOrderPath = join(outputDir, 'stream-order.ndjson');
  const studyReportPath = join(outputDir, 'study-report.json');
  const attemptsPath = join(outputDir, 'attempts.ndjson');

  try {
    const handle = await open(attemptsPath, 'r');
    await handle.close();
    return { kind: 'conflict' };
  } catch (err: unknown) {
    if (!isEnoent(err)) {
      return { kind: 'conflict' };
    }
  }

  let streamHandle: FileHandle | null = null;
  let streamCreated = false;
  try {
    streamHandle = await open(streamOrderPath, 'ax');
    streamCreated = true;
  } catch {
    return { kind: 'conflict' };
  }

  let hostHandle: FileHandle | null = null;
  let hostCreated = false;
  try {
    hostHandle = await open(hostObservationsPath, 'ax');
    hostCreated = true;
  } catch {
    if (streamHandle !== null) {
      try {
        await streamHandle.close();
      } catch {}
      if (streamCreated) {
        try {
          await unlink(streamOrderPath);
        } catch {}
      }
    }
    return { kind: 'conflict' };
  }

  let reportHandle: FileHandle | null = null;
  try {
    reportHandle = await open(studyReportPath, 'wx');
  } catch {
    if (hostHandle !== null) {
      try {
        await hostHandle.close();
      } catch {}
      if (hostCreated) {
        try {
          await unlink(hostObservationsPath);
        } catch {}
      }
    }
    if (streamHandle !== null) {
      try {
        await streamHandle.close();
      } catch {}
      if (streamCreated) {
        try {
          await unlink(streamOrderPath);
        } catch {}
      }
    }
    return { kind: 'conflict' };
  }

  const cleanup = async (): Promise<void> => {
    try {
      await hostHandle.close();
    } catch {}
    try {
      await streamHandle.close();
    } catch {}
    try {
      await reportHandle.close();
    } catch {}
  };

  return {
    kind: 'claimed',
    hostHandle,
    streamHandle,
    reportHandle,
    cleanup,
  };
}

function createFailedReport(
  options: RunStudyOptions,
  stage: 'A' | 'B',
  manifestSha256: string,
  preflight: PreflightAdmissionReceipt | null,
  preflightTraces: readonly PreflightTraceRecord[],
  agentLedger: readonly LedgerRecord[],
  hostLedger: readonly HostRecord[],
  slots: readonly SlotDisposition[],
): StudyReport {
  if (stage === 'A') {
    return {
      version: 1,
      scope: 'orchestration_only',
      trialAuthorization: false,
      manifestPath: options.manifestPath,
      manifestSha256,
      status: 'failed',
      preflight,
      preflightTraces,
      agentLedger,
      hostLedger,
      stage: 'A',
      slots,
      trials: [],
      scoreReport: null,
    };
  }

  return {
    version: 1,
    scope: 'orchestration_only',
    trialAuthorization: false,
    manifestPath: options.manifestPath,
    manifestSha256,
    status: 'failed',
    preflight,
    preflightTraces,
    agentLedger,
    hostLedger,
    stage: 'B',
    slots,
    trials: [],
    scoreReport: null,
  };
}

async function handleStorageFailure(
  options: RunStudyOptions,
  manifest: ValidatedStudyManifest,
  manifestSha256: string,
  preflightResult: Extract<PreflightedExecutionResult, { readonly status: 'admitted' }>,
  plannedSlots: readonly PlannedSlot[],
  outputDir: string,
  reportHandle: FileHandle,
): Promise<StudyReport> {
  const attemptsPath = join(outputDir, 'attempts.ndjson');
  const hostObservationsPath = join(outputDir, 'host-observations.ndjson');

  let agentLedger: readonly LedgerRecord[] = [];
  try {
    const content = await readFile(attemptsPath, 'utf8');
    const outcome = parseLedgerRecords(content);
    agentLedger = outcome.ok ? outcome.records : outcome.validPrefix;
  } catch {
    agentLedger = [];
  }

  let hostLedger: readonly HostRecord[] = [];
  try {
    const content = await readFile(hostObservationsPath, 'utf8');
    const outcome = parseHostRecords(content);
    hostLedger = outcome.ok ? outcome.records : outcome.validPrefix;
  } catch {
    hostLedger = [];
  }

  const slots = resolveFailureSlotDispositions(
    plannedSlots,
    preflightResult.trialExecution.attempted,
    agentLedger,
    'failed',
  );

  const report = createFailedReport(
    options,
    manifest.stage,
    manifestSha256,
    preflightResult.admissionReceipt,
    preflightResult.retainedTraces,
    agentLedger,
    hostLedger,
    slots,
  );

  await writeReport(reportHandle, report);
  return report;
}

export async function runStudy(options: RunStudyOptions): Promise<StudyReport> {
  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(resolve(options.manifestPath));
  } catch {
    const report = createUnreadableManifestReport(options);
    await safeExclusivePersist(options.outputDir, report);
    return report;
  }

  const manifestSha256 = computeSha256(rawBytes);
  if (manifestSha256 !== options.expectedManifestSha256) {
    let manifestJson: unknown = null;
    try {
      manifestJson = JSON.parse(rawBytes.toString('utf8'));
    } catch {
      // ignore
    }
    const failedSlots = buildNotAttemptedSlots(manifestJson);
    const report = createRejectedBytesReport(
      options,
      manifestSha256,
      'hash_mismatch',
      failedSlots,
    );
    await safeExclusivePersist(options.outputDir, report);
    return report;
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(rawBytes.toString('utf8'));
  } catch {
    const report = createRejectedBytesReport(
      options,
      manifestSha256,
      'invalid_json',
      [],
    );
    await safeExclusivePersist(options.outputDir, report);
    return report;
  }

  const declarative = validateStudyManifest(manifestJson);
  if (declarative.kind !== 'valid') {
    const failedSlots = buildNotAttemptedSlots(manifestJson);
    const report = createRejectedBytesReport(
      options,
      manifestSha256,
      'invalid_declaration',
      failedSlots,
    );
    await safeExclusivePersist(options.outputDir, report);
    return report;
  }

  const manifest: ValidatedStudyManifest = declarative.manifest;

  const plannedSlots = buildPlannedSlots(manifest);

  const verifiedArtifacts = new Map<string, Buffer | string>();
  const cachingReader = async (filePath: string, signal?: AbortSignal) => {
    if (signal?.aborted) {
      throw new Error(String(signal.reason ?? 'aborted'));
    }
    const norm = resolve(filePath);
    const content = await readFile(norm);
    verifiedArtifacts.set(norm, content);
    verifiedArtifacts.set(filePath, content);
    return content;
  };

  const artifactResult = await verifyManifestArtifacts(
    manifest,
    cachingReader,
    options.signal,
  );

  if (artifactResult.kind !== 'verified') {
    const slots = toNotAttemptedSlots(plannedSlots);
    const report = createFailedReport(
      options,
      manifest.stage,
      manifestSha256,
      null,
      [],
      [],
      [],
      slots,
    );
    await safeExclusivePersist(options.outputDir, report);
    return report;
  }

  const ownership = await claimOutputOwnership(options.outputDir);
  if (ownership.kind === 'conflict') {
    const slots = toNotAttemptedSlots(plannedSlots);
    return createFailedReport(
      options,
      manifest.stage,
      manifestSha256,
      null,
      [],
      [],
      [],
      slots,
    );
  }

  try {
    const hostObservationsPath = join(options.outputDir, 'host-observations.ndjson');
    const attemptsPath = join(options.outputDir, 'attempts.ndjson');
    const streamOrderPath = join(options.outputDir, 'stream-order.ndjson');

    const adaptedTransport = new HostJournalingTransport(
      options.transport,
      ownership.hostHandle,
      ownership.streamHandle,
    );

    const preflightResult = await executePreflightedStudy(
      manifest,
      options.outputDir,
      adaptedTransport,
      options.effects,
      options.signal,
      options.clock,
    );

    if (preflightResult.status !== 'admitted') {
      const slots = toNotAttemptedSlots(plannedSlots);
      const report = createFailedReport(
        options,
        manifest.stage,
        manifestSha256,
        null,
        preflightResult.retainedTraces,
        [],
        [],
        slots,
      );
      await writeReport(ownership.reportHandle, report);
      return report;
    }

    let isStorageFailed = false;
    try {
      await ownership.hostHandle.sync();
      await ownership.streamHandle.sync();
    } catch {
      isStorageFailed = true;
    }

    if (
      isStorageFailed ||
      adaptedTransport.hasStorageError() ||
      (preflightResult.trialExecution.status === 'halted' &&
        preflightResult.trialExecution.reason === 'storage_failed')
    ) {
      return await handleStorageFailure(
        options,
        manifest,
        manifestSha256,
        preflightResult,
        plannedSlots,
        options.outputDir,
        ownership.reportHandle,
      );
    }

    let agentOutcome: JournalParseOutcome<LedgerRecord>;
    try {
      const content = await readFile(attemptsPath, 'utf8');
      agentOutcome = parseLedgerRecords(content);
    } catch (err: unknown) {
      agentOutcome = {
        ok: false,
        kind: 'corrupted',
        error: { lineNumber: 0, rawLine: '', reason: err instanceof Error ? err.message : 'Cannot read attempts.ndjson' },
        validPrefix: [],
      };
    }

    let hostOutcome: JournalParseOutcome<HostRecord>;
    try {
      const content = await readFile(hostObservationsPath, 'utf8');
      hostOutcome = parseHostRecords(content);
    } catch (err: unknown) {
      hostOutcome = {
        ok: false,
        kind: 'corrupted',
        error: { lineNumber: 0, rawLine: '', reason: err instanceof Error ? err.message : 'Cannot read host-observations.ndjson' },
        validPrefix: [],
      };
    }

    let streamOutcome: JournalParseOutcome<StreamOrderEntry>;
    try {
      const content = await readFile(streamOrderPath, 'utf8');
      streamOutcome = parseStreamOrder(content);
    } catch (err: unknown) {
      streamOutcome = {
        ok: false,
        kind: 'corrupted',
        error: { lineNumber: 0, rawLine: '', reason: err instanceof Error ? err.message : 'Cannot read stream-order.ndjson' },
        validPrefix: [],
      };
    }

    if (!agentOutcome.ok || !hostOutcome.ok || !streamOutcome.ok) {
      const validAgentLedger = agentOutcome.ok
        ? agentOutcome.records
        : agentOutcome.validPrefix;
      const validHostLedger = hostOutcome.ok
        ? hostOutcome.records
        : hostOutcome.validPrefix;

      const slots = resolveFailureSlotDispositions(
        plannedSlots,
        preflightResult.trialExecution.attempted,
        validAgentLedger,
        'invalid_evidence',
      );

      const corruptedReport: StudyReport = manifest.stage === 'A'
        ? {
            version: 1,
            scope: 'orchestration_only',
            trialAuthorization: false,
            manifestPath: options.manifestPath,
            manifestSha256,
            status: 'incomplete_evidence',
            preflight: preflightResult.admissionReceipt,
            preflightTraces: preflightResult.retainedTraces,
            agentLedger: validAgentLedger,
            hostLedger: validHostLedger,
            stage: 'A',
            slots,
            trials: [],
            scoreReport: null,
          }
        : {
            version: 1,
            scope: 'orchestration_only',
            trialAuthorization: false,
            manifestPath: options.manifestPath,
            manifestSha256,
            status: 'incomplete_evidence',
            preflight: preflightResult.admissionReceipt,
            preflightTraces: preflightResult.retainedTraces,
            agentLedger: validAgentLedger,
            hostLedger: validHostLedger,
            stage: 'B',
            slots,
            trials: [],
            scoreReport: null,
          };

      await writeReport(ownership.reportHandle, corruptedReport);
      return corruptedReport;
    }

    const agentLedger = agentOutcome.records;
    const hostLedger = hostOutcome.records;
    const streamLedger = streamOutcome.records;

    const normalization =
      manifest.stage === 'A'
        ? normalizeStudy({
            manifest,
            cachedArtifacts: verifiedArtifacts,
            agentLedger,
            hostLedger,
            streamLedger,
            plannedSlots: buildPlannedSlots(manifest),
          })
        : normalizeStudy({
            manifest,
            cachedArtifacts: verifiedArtifacts,
            agentLedger,
            hostLedger,
            streamLedger,
            plannedSlots: buildPlannedSlots(manifest),
          });


    const report: StudyReport =
      normalization.stage === 'A'
        ? {
            version: 1,
            scope: 'orchestration_only',
            trialAuthorization: false,
            manifestPath: options.manifestPath,
            manifestSha256,
            status: normalization.reportStatus,
            preflight: preflightResult.admissionReceipt,
            preflightTraces: preflightResult.retainedTraces,
            agentLedger,
            hostLedger,
            stage: 'A',
            slots: normalization.slots,
            trials: normalization.trials,
            scoreReport: normalization.scoreReport,
          }
        : {
            version: 1,
            scope: 'orchestration_only',
            trialAuthorization: false,
            manifestPath: options.manifestPath,
            manifestSha256,
            status: normalization.reportStatus,
            preflight: preflightResult.admissionReceipt,
            preflightTraces: preflightResult.retainedTraces,
            agentLedger,
            hostLedger,
            stage: 'B',
            slots: normalization.slots,
            trials: normalization.trials,
            scoreReport: normalization.scoreReport,
          };

    const ok = await writeReport(ownership.reportHandle, report);
    if (!ok) {
      return createFailedReport(
        options,
        manifest.stage,
        manifestSha256,
        preflightResult.admissionReceipt,
        preflightResult.retainedTraces,
        agentLedger,
        hostLedger,
        normalization.slots,
      );
    }
    return report;
  } finally {
    await ownership.cleanup();
  }
}
