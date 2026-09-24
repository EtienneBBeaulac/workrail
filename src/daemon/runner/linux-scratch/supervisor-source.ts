const workspaceIoSource=String.raw`
def file_at(value,write=False):
    parts=value.split('/')
    if any(p in ('','.','..','.git') for p in parts):raise ValueError('Unsupported path')
    directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            if write:
                try:
                    os.mkdir(part,dir_fd=directory)
                    os.chown(part,65534,65534,dir_fd=directory,follow_symlinks=False)
                except FileExistsError:pass
            nested=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory);directory=nested
        fd=os.open(parts[-1],(os.O_WRONLY|os.O_CREAT if write else os.O_RDONLY)|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=directory)
        if not stat.S_ISREG(os.fstat(fd).st_mode):os.close(fd);raise ValueError('Not a regular file')
        if write:
            os.ftruncate(fd,0);os.fchown(fd,65534,65534)
        return os.fdopen(fd,'wb' if write else 'rb')
    finally:os.close(directory)

def files():
    found=[];directories=0
    for directory,dirs,names in os.walk(root,followlinks=False):
        directories+=1
        if directories>256:raise ValueError('Directory budget exceeded')
        dirs[:]=sorted(d for d in dirs if not pathlib.Path(directory,d).is_symlink())
        for name in sorted(names):
            p=pathlib.Path(directory,name)
            if p.is_file() and not p.is_symlink():found.append(p)
            if len(found)>256:raise ValueError('File budget exceeded')
    return found
`;
/** Runs only inside the private Linux environment. No host paths or credentials.
 * stdout is a bounded protocol channel; command output never writes directly to it. */
export const supervisorSource=String.raw`
import os, sys, json, secrets, subprocess, tempfile, pathlib, fnmatch, stat
root=pathlib.Path('/workspace')
nonce=secrets.token_hex(32)
seq=0
MAX=1048576

def emit(value):
    sys.stdout.write(json.dumps(value,ensure_ascii=True,separators=(',',':'))+'\n');sys.stdout.flush()

def frame():
    line=sys.stdin.buffer.readline(MAX+1)
    if not line or len(line)>MAX or not line.endswith(b'\n'):sys.exit(2)
    return json.loads(line)

${workspaceIoSource}

if not os.path.isfile('/bin/bash') or not os.access('/bin/bash',os.X_OK):sys.exit(4)
emit({'kind':'hello','nonce':nonce})
init=frame()
if set(init)!={'kind','nonce','files'} or init['kind']!='init' or init['nonce']!=nonce:sys.exit(2)
for f in init['files']:
    with file_at(f['path'],True) as fobj:fobj.write(f['text'].encode('utf8'))
emit({'kind':'ready','nonce':nonce})
while True:
    value=frame()
    if set(value)!={'nonce','seq','command','timeoutMs'} or value['nonce']!=nonce or value['seq']!=seq+1:sys.exit(2)
    seq=value['seq'];command=value['command'];name=command['name'];args=command['input']
    try:
        error=False
        if name=='Read':
            with file_at(args['path']) as f:data=f.read(65537)
            if len(data)>65536:raise ValueError('Read byte budget exceeded')
            text=data.decode('utf8')
        elif name=='Write':
            with file_at(args['path'],True) as f:f.write(args['content'].encode('utf8'))
            text='Written in scratch workspace only.'
        elif name=='Edit':
            with file_at(args['path']) as f:data=f.read(65537)
            if len(data)>65536:raise ValueError('Edit byte budget exceeded')
            old=data.decode('utf8')
            if old.count(args['old_string'])!=1:raise ValueError('Edit requires exactly one match')
            with file_at(args['path'],True) as f:f.write(old.replace(args['old_string'],args['new_string'],1).encode('utf8'))
            text='Edited in scratch workspace only.'
        elif name=='Glob':text='\n'.join(str(p.relative_to(root)) for p in files() if fnmatch.fnmatchcase(str(p.relative_to(root)),args['pattern']))
        elif name=='Grep':
            hits=[]
            for p in files():
                with file_at(str(p.relative_to(root))) as f:data=f.read(65537)
                if len(data)>65536:raise ValueError('Search byte budget exceeded')
                for n,line in enumerate(data.decode('utf8',errors='replace').splitlines(),1):
                    if args['pattern'] in line:hits.append(str(p.relative_to(root))+':'+str(n)+':'+line)
            text='\n'.join(hits)
        elif name=='Bash':
            # File-backed output is bounded by the private tmpfs, not unbounded pipe RAM.
            with tempfile.TemporaryFile(dir=root) as out:
                def drop_identity():
                    os.setgroups([]);os.setgid(65534);os.setuid(65534)
                proc=subprocess.Popen(['/bin/bash','-c',args['command']],cwd=root,stdin=subprocess.DEVNULL,stdout=out,stderr=out,start_new_session=True,preexec_fn=drop_identity,env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/workspace','TMPDIR':'/workspace'})
                try:code=proc.wait(timeout=value['timeoutMs']/1000)
                except subprocess.TimeoutExpired:
                    emit({'kind':'unknown','nonce':nonce,'seq':seq});sys.exit(3)
                out.seek(0);data=out.read(65537)
                if len(data)>65536:raise ValueError('Command output budget exceeded')
                text='exit='+str(code)+'\n'+data.decode('utf8',errors='replace');error=code!=0
        else:raise ValueError('Unsupported command')
        if len(text.encode('utf8'))>65536:raise ValueError('Output budget exceeded')
        emit({'kind':'completed','nonce':nonce,'seq':seq,'text':text,'isError':error})
    except Exception as exc:
        # A write may already have happened. Failure is never safe retry feedback.
        emit({'kind':'unknown','nonce':nonce,'seq':seq});sys.exit(3)
`;

/** A fixed read-only observation program, not an agent command or recovered supervisor.
 * No paths or code are accepted from the caller. Never follows links or opens special files. */
export const inspectionSource=String.raw`
import os,sys,json,pathlib,stat,base64
root=pathlib.Path('/workspace')
${workspaceIoSource}
result=[];total=0
for p in files():
    name=str(p.relative_to(root))
    with file_at(name) as f:data=f.read(65537)
    total+=len(data)
    if len(data)>65536 or total>1048576:sys.exit(2)
    result.append({'path':name,'base64':base64.b64encode(data).decode('ascii')})
sys.stdout.write(json.dumps({'format':'workrail-scratch-observation-v1','files':result},separators=(',',':')))
`;
