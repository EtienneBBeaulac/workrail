import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SessionJournal } from '../../../answer-v1/journal.js';
import type { OwnerFence } from '../../../answer-v1/contracts/invocation-contract.js';
import type { ExecutionDeadline } from '../../../answer-v1/execution-deadline.js';
import { owns } from '../../../answer-v1/host-state.js';
import { beginSupervisorCleanup } from '../../../answer-v1/supervisor-cleanup.js';
import { reserveSupervisor, retainSupervisorTransition } from '../../../answer-v1/supervisor-journal.js';
import { CommandSchema, ScratchPathSchema, decodeLinuxScratchProfile, type ScratchOutcome } from './contract.js';
import { DockerCli } from './docker-cli.js';
import { ScratchChannel } from './channel.js';
import { supervisorSource, inspectionSource } from './supervisor-source.js';

const LABEL='workrail.linux-scratch';
const Info=z.object({ID:z.string().min(1),OSType:z.literal('linux')});
const Image=z.array(z.object({Architecture:z.enum(['arm64','amd64']),Os:z.literal('linux'),
  Config:z.object({Volumes:z.record(z.unknown()).nullable().optional()})})).length(1);
const Inspection=z.object({format:z.literal('workrail-scratch-observation-v1'),
  files:z.array(z.object({path:ScratchPathSchema,base64:z.string().max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict()).max(256),
}).strict();
const Environment=z.array(z.object({Id:z.string(),State:z.object({Running:z.boolean()}),
  Config:z.object({Labels:z.record(z.string()).nullable()}),
})).length(1);
const parse=<T>(bytes:Buffer,schema:z.ZodType<T>):T|undefined=>{try{return schema.parse(JSON.parse(bytes.toString('utf8')));}catch{return undefined;}};
export type ScratchFinish=Readonly<{
  inspection:Readonly<{kind:'retained';path:string;sha256:string;meaning:'observed_files_not_atomic_snapshot'}>|Readonly<{kind:'unavailable'}>;
  cleanup:'removed'|'unconfirmed';
}>;
export interface LinuxScratchWorkspace {
  /** Host-owned lifecycle identity, never a model argument or resume token. */
  readonly supervisor:string;
  execute(name:string,input:unknown,signal:AbortSignal):Promise<ScratchOutcome>;
  finish(signal:AbortSignal):Promise<ScratchFinish>;
}
export type CreateScratchResult=
  | Readonly<{kind:'ready';workspace:LinuxScratchWorkspace}>
  | Readonly<{kind:'refused';reason:'invalid_profile'|'preflight_failed'|'deadline_stopped'|'intent_unacknowledged'}>
  | Readonly<{kind:'unknown';supervisor:string;cleanup:'unconfirmed'}>;

/** Trusted opt-in source composition, not public enrollment or installed runtime activation.
 * Recovery may inspect the journal; it cannot mint this live process capability. */
export async function createLinuxScratchWorkspace(options:Readonly<{
  journal:SessionJournal;owner:OwnerFence;deadline:ExecutionDeadline;profile:unknown;
  docker:Pick<DockerCli,'run'|'stream'>;artifactDirectory:string;
}>):Promise<CreateScratchResult>{
  const {journal,owner,deadline,docker,artifactDirectory}=options;
  const decoded=decodeLinuxScratchProfile(options.profile);
  if(decoded.kind!=='validated')return decoded;
  const {profile,digest}=decoded;
  if(deadline.check().kind!=='active')return {kind:'refused',reason:'deadline_stopped'};
  const signal=deadline.signal;
  const [infoReply,imageReply]=await Promise.all([
    docker.run(['info','--format','{{json .}}'],signal),docker.run(['image','inspect',profile.image],signal),
  ]);
  const info=infoReply.kind==='completed'?parse(infoReply.bytes,Info):undefined;
  const image=imageReply.kind==='completed'?parse(imageReply.bytes,Image):undefined;
  if(!info||!image||`linux/${image[0]!.Architecture}`!==profile.platform||Object.keys(image[0]!.Config.Volumes??{}).length!==0)
    return {kind:'refused',reason:'preflight_failed'};
  const configuration=[
    '--platform',profile.platform,'--user','0:0','--network=none','--read-only','--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--cap-add=CHOWN','--cap-add=DAC_OVERRIDE','--security-opt=no-new-privileges',
    '--pids-limit=32','--memory=64m','--cpus=0.5','--ipc=private','--log-driver=none',
    '--tmpfs','/workspace:rw,nosuid,nodev,size=8388608,mode=1777','--entrypoint','python3',profile.image,
    '-I','-u','-c','import time; time.sleep(86400)' ] as const;
  const configurationDigest=createHash('sha256').update(digest).update(JSON.stringify(configuration))
    .update(supervisorSource).update(inspectionSource).digest('hex');
  const reservation=await reserveSupervisor(journal,owner,{configurationDigest,daemon:info.ID},signal);
  if(reservation.kind!=='reserved')return {kind:'refused',reason:'intent_unacknowledged'};
  const supervisor=reservation.supervisor;
  const unknown=()=>({kind:'unknown' as const,supervisor,cleanup:'unconfirmed' as const});
  // Name derives from the retained identity: lost create replies leave an inspectable orphan,
  // never permission to create a replacement. No subsequent name-based command grants execution.
  const name='workrail-scratch-'+createHash('sha256').update(supervisor).digest('hex').slice(0,32);
  const created=await docker.run(['create','--pull=never','--name',name,'--label',`${LABEL}=${supervisor}`,
    ...configuration],signal);
  if(created.kind!=='completed')return unknown();
  const cid=created.bytes.toString('utf8').trim();
  if(!/^[a-f0-9]{64}$/.test(cid))return unknown();
  const binding={daemon:info.ID,environment:cid};
  const retain=(kind:'supervisor_created'|'supervisor_start_intended'|'supervisor_started'|'supervisor_stop_intended'|'supervisor_process_stopped',scope:AbortSignal)=>
    retainSupervisorTransition(journal,owner,{kind,supervisor,binding},scope);
  if((await retain('supervisor_created',signal)).kind!=='retained')return unknown();
  if((await retain('supervisor_start_intended',signal)).kind!=='retained')return unknown();
  if((await docker.run(['start',cid],signal)).kind!=='completed')return unknown();
  let channel:ScratchChannel;
  try {channel=new ScratchChannel(docker.stream(['exec','-i',cid,'python3','-I','-u','-c',supervisorSource]));}
  catch {return unknown();}
  const fail=()=>{channel.close();return unknown();};
  const hello=await channel.receive(signal,10000);
  if(hello?.kind!=='hello')return fail();
  const nonce=hello.nonce;
  if(!channel.send({kind:'init',nonce,files:profile.snapshot.files}))return fail();
  const ready=await channel.receive(signal,10000);
  if(ready?.kind!=='ready'||ready.nonce!==nonce)return fail();
  if((await retain('supervisor_started',signal)).kind!=='retained')return fail();
  type State='ready'|'busy'|'halted'|'finishing'|'finished';
  let state:State='ready',seq=0;
  const stop=()=>{state='halted';channel.close();};
  signal.addEventListener('abort',stop,{once:true});
  if(signal.aborted)stop();
  let finished:Promise<ScratchFinish>|undefined;
  return {kind:'ready',workspace:{supervisor,
    async execute(name,input,callSignal){
      if(state!=='ready'){stop();return {kind:'refused',reason:'closed'};}
      const command=CommandSchema.safeParse({name,input});
      if(!command.success){stop();return {kind:'refused',reason:'invalid_command'};}
      state='busy';
      const abort=()=>stop();callSignal.addEventListener('abort',abort,{once:true});
      try {
      if(callSignal.aborted){stop();return {kind:'refused',reason:'deadline_stopped'};}
      const ownerCurrent=await journal.locked(callSignal,false,async s=>owns(s,owner));
      if(!ownerCurrent){stop();return {kind:'refused',reason:'stale_owner'};}
      const remaining=deadline.check();
      if(remaining.kind!=='active'||callSignal.aborted){stop();return {kind:'refused',reason:'deadline_stopped'};}
        const current=++seq,timeoutMs=Math.min(10000,Math.floor(remaining.remainingMs));
        if(!channel.send({nonce,seq:current,command:command.data,timeoutMs})){stop();return {kind:'unknown'};}
        const reply=await channel.receive(callSignal,timeoutMs);
        if(reply?.kind!=='completed'||reply.nonce!==nonce||reply.seq!==current||callSignal.aborted||deadline.check().kind!=='active'
          || (state as State)!=='busy'){stop();return {kind:'unknown'};}
        state='ready';return {kind:'completed',text:reply.text,isError:reply.isError};
      }catch {stop();return {kind:'unknown'};}
      finally{callSignal.removeEventListener('abort',abort);}
    },
    finish(requestedCleanupSignal){
      if(finished)return finished;
      const wasReady=state==='ready';state='finishing';channel.close();signal.removeEventListener('abort',stop);
      finished=(async():Promise<ScratchFinish>=>{
        let inspection:ScratchFinish['inspection']={kind:'unavailable'};
        const uncertain=():ScratchFinish=>({inspection,cleanup:'unconfirmed'});
        const cleanup=beginSupervisorCleanup(journal,owner,supervisor,binding,requestedCleanupSignal);
        if(!cleanup)return uncertain();
        const cleanupSignal=cleanup.signal;
        try {
        const fresh=await docker.run(['info','--format','{{json .}}'],cleanupSignal);
        const daemon=fresh.kind==='completed'?parse(fresh.bytes,Info):undefined;
        const inspected=await docker.run(['inspect',cid],cleanupSignal);
        const env=inspected.kind==='completed'?parse(inspected.bytes,Environment)?.[0]:undefined;
        if(daemon?.ID!==binding.daemon||env?.Id!==cid||env.Config.Labels?.[LABEL]!==supervisor)return uncertain();
        // Do not grant command authority for harvest. The fixed program has no agent command input; files are never extracted on host.
        // Live descendants may write: this is explicitly an observation, not an atomic snapshot.
        if(wasReady){
          const archive=await docker.run(['exec',cid,'python3','-I','-u','-c',inspectionSource],cleanupSignal,2097152);
          if(archive.kind==='completed'&&parse(archive.bytes,Inspection)){
            try {
              await mkdir(artifactDirectory,{recursive:true});
              const sha256=createHash('sha256').update(archive.bytes).digest('hex');
              const path=join(artifactDirectory,`${name}.json`);
              const file=await open(path,'wx',0o600);
              try{await file.writeFile(archive.bytes);await file.sync();}finally{await file.close();}
              const directory=await open(artifactDirectory,'r');
              try{await directory.sync();}finally{await directory.close();}
              inspection={kind:'retained',path,sha256,meaning:'observed_files_not_atomic_snapshot'};
            }catch {/* Explicit unavailable result; never successful export text. */}
          }
        }
        if((await cleanup.retainStopIntent()).kind!=='retained')return uncertain();
        if(env.State.Running && (await docker.run(['stop','--time','1',cid],cleanupSignal)).kind!=='completed')return uncertain();
        const after=await docker.run(['inspect',cid],cleanupSignal);
        const stopped=after.kind==='completed'?parse(after.bytes,Environment)?.[0]:undefined;
        if(!stopped||stopped.Id!==cid||stopped.State.Running||stopped.Config.Labels?.[LABEL]!==supervisor)return uncertain();
        if((await cleanup.retainProcessStopped()).kind!=='retained')return uncertain();
        if((await docker.run(['rm',cid],cleanupSignal)).kind!=='completed')return uncertain();
        state='finished';return {inspection,cleanup:'removed'};
        } catch { return uncertain(); } finally { cleanup.close(); }
      })();
      return finished;
    },
  }};
}
