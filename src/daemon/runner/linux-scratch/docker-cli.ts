import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type DockerReply=Readonly<{kind:'completed';bytes:Buffer}>|Readonly<{kind:'unknown'}>;
/** Fixed local daemon and API, no shell, context lookup, inherited credentials or implicit pull.
 * A killed CLI is NOT evidence that a daemon-side operation stopped. */
export class DockerCli {
  private constructor(private readonly binary:string,private readonly socket:string){}
  static local(binary:string,socket:string):DockerCli|undefined {
    return isAbsolute(binary)&&isAbsolute(socket)&&!socket.includes('\0') ? new DockerCli(binary,socket):undefined;
  }
  stream(args:readonly string[]):ChildProcessWithoutNullStreams {
    return spawn(this.binary,['--host',`unix://${this.socket}`,...args],{
      env:{PATH:'/usr/bin:/bin:/usr/local/bin',DOCKER_API_VERSION:'1.54'},stdio:['pipe','pipe','pipe'],
    });
  }
  run(args:readonly string[],signal:AbortSignal,maxBytes=1048576,timeoutMs=10000):Promise<DockerReply> {
    if(signal.aborted)return Promise.resolve({kind:'unknown'});
    return new Promise(resolve=>{
      let child:ChildProcessWithoutNullStreams;
      try {child=this.stream(args);}catch {resolve({kind:'unknown'});return;}
      let done=false,size=0;const chunks:Buffer[]=[];
      const finish=(value:DockerReply)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);resolve(value);};
      const abort=()=>{child.kill('SIGKILL');finish({kind:'unknown'});};
      const timer=setTimeout(abort,timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){abort();return;}chunks.push(chunk);});
      // Bound and drain stderr, but never parse it as success or a completion receipt.
      let errors=0;child.stderr.on('data',(chunk:Buffer)=>{errors+=chunk.length;if(errors>65536)abort();});
      child.on('error',abort);child.on('close',code=>finish(code===0?{kind:'completed',bytes:Buffer.concat(chunks)}:{kind:'unknown'}));
      child.stdin.on('error',abort);child.stdin.end();
      if(signal.aborted)abort();
    });
  }
}
