import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewVerdictArtifactV1Schema } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
import { verifyStudyManifest } from './study-manifest.mjs';
import { createStageBFixture, sampleReview, makeEffects } from './study-runner-fixture.js';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import { buildExpectedStageATrials, makePositiveStream } from './study-runner-stream-fixture.js';
import { scoreInput } from './usability-scorer.mjs';
import type { TrialRequest } from './trial-executor-contract.js';
describe('study runner fixture validity without candidate runtime', () => {
 it('uses valid review artifacts and physically pinned manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'study-fixture-'));
  try {
   expect(ReviewVerdictArtifactV1Schema.safeParse(sampleReview).success).toBe(true);
   const {manifest, manifestPath} = await createStageBFixture(root);
   const verified = await verifyStudyManifest(JSON.parse(await readFile(manifestPath, 'utf8')), p => readFile(p));
   expect(verified.kind).toBe('manifest_verified');
   for (const pair of manifest.pairs) {
    const fixture = JSON.parse(await readFile(pair.fixture.path, 'utf8'));
    expect(fixture.expectedReview).toEqual(sampleReview);
   }
   const effects = makeEffects(manifest);
   const checker = manifest.preflights.observationCheckerProof;
   const receipt = await effects.executePreflight({kind:'observation_checker', invocationId:'fixture-control', proofId:checker.proofId, targetArtifactPath:checker.path}, new AbortController().signal);
   expect(receipt.status).toBe('executed');
   if (receipt.status !== 'executed') throw new Error('fixture receipt absent');
   expect(receipt.controls.map(c => [c.checkId, c.outcome])).toEqual([
    ['checker_intact','accepted'],['checker_removed','rejected'],['checker_duplicate','rejected'],['checker_artifact_mismatch','rejected'],['checker_wrong_run','rejected'],['checker_unmatched_fault','rejected']
   ]);
  } finally { await rm(root, {recursive:true, force:true}); }
 });
 it('constructs all sixty streams with ordered, uniquely identified host facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'study-streams-'));
  try {
   for (const stage of ['A', 'B'] as const) {
    const {manifest} = await createUnverifiedStudyFixture(join(root, stage), stage);
    if (manifest.stage === 'A') {
     const scored = scoreInput({version:1, stage:'A', trials:buildExpectedStageATrials(manifest)});
     expect(scored.kind).toBe('scored');
     if (scored.kind !== 'scored') throw new Error('invalid oracle');
     expect(scored.report.status).toBe('inconclusive');
     expect(scored.report.measurements).toHaveLength(40);
     expect(scored.report.measurements.every(m => m.success)).toBe(true);
    }
    let count = 0;
    for (const pair of manifest.pairs) for (const arm of pair.armOrder) {
     const request: TrialRequest = {...pair[arm], arm, scenario:pair.scenario, repetition:pair.repetition, fixture:pair.fixture, expectedObservations:pair.expectedObservations, requestedEnvironment:manifest.environment[arm], budgets:manifest.budgets};
     const events = [];
     for await (const event of makePositiveStream(request)) events.push(event);
     let currentConversation: string | undefined;
     let restarts = 0;
     let recreationIndex = -1;
     for (const [index,event] of events.entries()) {
      if (event.type === 'agent' && event.event.type === 'started') currentConversation = event.event.conversationId;
      if (event.type === 'host' && event.record.kind === 'engine_recreated') {
       expect(event.record.priorInstanceId).not.toBe(event.record.instanceId);
       expect(event.record.priorConversationId).toBe(currentConversation);
       recreationIndex = index;
      }
      if (event.type === 'agent' && event.event.type === 'conversation_restarted') {
       expect(event.event.priorConversationId).toBe(currentConversation);
       expect(event.event.conversationId).not.toBe(currentConversation);
       expect(recreationIndex).toBeGreaterThan(-1);
       expect(recreationIndex).toBeLessThan(index);
       currentConversation = event.event.conversationId;
       restarts++;
      }
      if (event.type === 'host' && 'conversationId' in event.record) expect(event.record.conversationId).toBe(currentConversation);
     }
     expect(restarts).toBe(pair.scenario === 'recovery_after_partial_work' ? 1 : 0);
     const host = events.flatMap(e => e.type === 'host' ? [e.record] : []);
     expect(new Set(host.map(h => h.recordId)).size).toBe(host.length);
     expect(host.every((h,i) => h.runId === request.runId && (i === 0 || h.atMs >= host[i-1]!.atMs))).toBe(true);
     expect(host[0]).toMatchObject({kind:'coverage',status:'opened'});
     expect(host[host.length-1]).toMatchObject({kind:'coverage',status:'closed'});
     for (const h of host) if (h.kind === 'accepted_review' || h.kind === 'submitted_review') expect(ReviewVerdictArtifactV1Schema.safeParse(h.artifact).success).toBe(true);
     count++;
    }
    expect(count).toBe(stage === 'A' ? 40 : 20);
   }
  } finally { await rm(root, {recursive:true, force:true}); }
 });

 it('persistence assertion rejects absent ledger before pulling another event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'study-persistence-'));
  try {
   const {manifest} = await createUnverifiedStudyFixture(root, 'A');
   const pair = manifest.pairs[0]!; const arm = pair.armOrder[0]!;
   const request: TrialRequest = {...pair[arm], arm, scenario:pair.scenario, repetition:pair.repetition, fixture:pair.fixture, expectedObservations:pair.expectedObservations, requestedEnvironment:manifest.environment[arm], budgets:manifest.budgets};
   const outputDir = join(root, 'output');
   const missing = makePositiveStream(request, {assertPersistedDir:outputDir});
   expect((await missing.next()).value).toMatchObject({type:'host',record:{kind:'coverage',status:'opened'}});
   await expect(missing.next()).rejects.toMatchObject({code:'ENOENT'});
   await mkdir(outputDir);
   const retained = makePositiveStream(request, {assertPersistedDir:outputDir});
   const first = (await retained.next()).value;
   if (!first || first.type !== 'host') throw new Error('missing coverage');
   await writeFile(join(outputDir,'host-observations.ndjson'), JSON.stringify(first.record)+'\n');
   expect((await retained.next()).value).toMatchObject({type:'agent',event:{type:'started'}});
   await retained.return(undefined);
  } finally { await rm(root,{recursive:true,force:true}); }
 });

});
