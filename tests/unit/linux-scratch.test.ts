import { describe,it,expect } from 'vitest';
import { spawn } from 'node:child_process';
import { decodeLinuxScratchProfile,CommandSchema } from '../../src/daemon/runner/linux-scratch/contract.js';
import { ScratchChannel } from '../../src/daemon/runner/linux-scratch/channel.js';

const profile=()=>({kind:'linux_scratch',image:'python@sha256:'+'a'.repeat(64),platform:'linux/arm64',
  snapshot:{kind:'explicit_files',description:'Declared fixture only',files:[{path:'a.txt',text:'original'}]}});
describe('Linux scratch admission',()=>{
  it('copies and freezes the supplied snapshot before digesting',()=>{
    const raw=profile(),decoded=decodeLinuxScratchProfile(raw);
    expect(decoded.kind).toBe('validated');if(decoded.kind!=='validated')return;
    raw.snapshot.files[0]!.text='changed';
    expect(decoded.profile.snapshot.files[0]!.text).toBe('original');
    expect(Object.isFrozen(decoded.profile.snapshot.files[0])).toBe(true);
    expect(decodeLinuxScratchProfile(profile())).toEqual(decoded);
  });
  it.each(['../escape','/absolute','a/../b','a\\b','.git/config','a//b'])('rejects unsafe snapshot paths %s',path=>{
    const raw=profile();raw.snapshot.files[0]!.path=path;
    expect(decodeLinuxScratchProfile(raw).kind).toBe('refused');
    expect(CommandSchema.safeParse({name:'Read',input:{path}}).success).toBe(false);
  });
  it('refuses path conflicts and UTF-8 byte overruns',()=>{
    const raw=profile();raw.snapshot.files.push({path:'a.txt/b',text:'bad'});
    expect(decodeLinuxScratchProfile(raw).kind).toBe('refused');
    raw.snapshot.files=Array.from({length:4},(_,i)=>({path:String(i),text:'🔥'.repeat(32768)}));
    expect(decodeLinuxScratchProfile(raw).kind).toBe('refused');
  });
  it('refuses implicit image pulls, extra fields and unsupported commands',()=>{
    expect(decodeLinuxScratchProfile({...profile(),image:'python:latest'}).kind).toBe('refused');
    expect(decodeLinuxScratchProfile({...profile(),mounts:['/Users']}).kind).toBe('refused');
    expect(CommandSchema.safeParse({name:'Bash',input:{command:'true',cwd:'/host'}}).success).toBe(false);
    expect(CommandSchema.safeParse({name:'spawn_agent',input:{}}).success).toBe(false);
  });
});

it.each(['unterminated','extra','malformed','oversize','cancelled','valid'] as const)(
  'channel refuses invalid transport or cancellation: %s',async mode=>{
    const hello=JSON.stringify({kind:'hello',nonce:'a'.repeat(64)});
    const bytes=mode==='unterminated'?hello:mode==='extra'?hello+'\n'+hello+'\n':mode==='malformed'?'{}\n':mode==='oversize'?'x'.repeat(1048577):hello+'\n';
    // A disposable executable fake exercises real pipe boundaries, not mocked callbacks.
    const child=spawn(process.execPath,['-e',`process.stdout.write(${mode==='oversize'?"'x'.repeat(1048577)":JSON.stringify(bytes)});${mode==='unterminated'?'':'setInterval(()=>{},1000);'}`],{stdio:['pipe','pipe','pipe']});
    const channel=new ScratchChannel(child),abort=new AbortController();
    if(mode==='cancelled')abort.abort();
    try {
      const result=await channel.receive(abort.signal,2000);
      expect(result).toEqual(mode==='valid'?{kind:'hello',nonce:'a'.repeat(64)}:undefined);
      channel.close();
      expect(await channel.receive(new AbortController().signal,100)).toBeUndefined();
      expect(channel.send({kind:'anything'})).toBe(false);
    }finally{channel.close();}
  });
