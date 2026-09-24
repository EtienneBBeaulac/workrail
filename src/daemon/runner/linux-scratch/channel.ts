import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';

const Frame=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('hello'),nonce:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({kind:z.literal('ready'),nonce:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({kind:z.literal('completed'),nonce:z.string(),seq:z.number().int().positive(),text:z.string().max(65536),isError:z.boolean()}).strict(),
  z.object({kind:z.literal('unknown'),nonce:z.string(),seq:z.number().int().positive()}).strict(),
]);
export type SupervisorFrame=z.infer<typeof Frame>;
/** One live stream only. No reconnect method, no deserialization constructor. */
export class ScratchChannel {
  private state:'open'|'closed'='open';
  private buffer=Buffer.alloc(0);
  private queued:SupervisorFrame|undefined;
  private waiting:((frame:SupervisorFrame|undefined)=>void)|undefined;
  constructor(private readonly child:ChildProcessWithoutNullStreams){
    let stderrBytes=0;
    child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>65536)this.close();});
    child.on('error',()=>this.close());child.on('close',()=>this.close());child.stdin.on('error',()=>this.close());
    child.stdout.on('data',(chunk:Buffer)=>{
      this.buffer=Buffer.concat([this.buffer,chunk]);
      if(this.buffer.length>1048576){this.close();return;}
      const newline=this.buffer.indexOf(10);
      if(newline<0)return;
      const bytes=this.buffer.subarray(0,newline);this.buffer=this.buffer.subarray(newline+1);
      // Exactly one outstanding response. Unsolicited/concatenated frames fail closed.
      if(this.buffer.length!==0){this.close();return;}
      try {
        const parsed=Frame.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
        if(!parsed.success || this.state==='closed'){this.close();return;}
        if(this.waiting){const deliver=this.waiting;this.waiting=undefined;deliver(parsed.data);}
        else if(this.queued){this.close();}else this.queued=parsed.data;
      }catch {this.close();}
    });
  }
  close():void {
    if(this.state==='closed')return;this.state='closed';this.queued=undefined;
    this.child.kill('SIGKILL');this.child.stdin.destroy();this.child.stdout.destroy();this.child.stderr.destroy();
    this.waiting?.(undefined);this.waiting=undefined;
  }
  receive(signal:AbortSignal,timeoutMs:number):Promise<SupervisorFrame|undefined>{
    if(this.state==='closed'||signal.aborted||this.waiting){this.close();return Promise.resolve(undefined);}
    if(this.queued){const frame=this.queued;this.queued=undefined;return Promise.resolve(frame);}
    return new Promise(resolve=>{
      const abort=()=>this.close();const timer=setTimeout(abort,timeoutMs);
      this.waiting=frame=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve(frame);};
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  send(value:unknown):boolean {
    if(this.state==='closed')return false;
    try {const text=JSON.stringify(value)+'\n';if(Buffer.byteLength(text)>1048576){this.close();return false;}
      this.child.stdin.write(text);return true;
    }catch {this.close();return false;}
  }
}
