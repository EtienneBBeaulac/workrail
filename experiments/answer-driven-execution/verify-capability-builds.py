"""Compile isolated full/notes-only candidate builds and exercise retained recovery.

The notes build is a constrained current-source candidate, not a historical release.
No installed runtime or source checkout is modified. Evidence remains in --output.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
manifest = {'builds': {}, 'kind': 'current-source-capability-variants'}
for name in ['full', 'notes']:
    target = output / name
    target.mkdir()
    for directory in ['src', 'spec', 'workflows']:
        shutil.copytree(repo / directory, target / directory)
    for filename in ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.build.json']:
        shutil.copy2(repo / filename, target / filename)
    (target / 'node_modules').symlink_to((repo / 'node_modules').resolve(), target_is_directory=True)
    if name == 'notes':
        host = target / 'src/answer-v1/host.ts'
        source = host.read_text()
        declaration = "supportedOutputs: Object.freeze(['notes' as const, 'wr.contracts.review_verdict' as const])"
        if source.count(declaration) != 1:
            raise SystemExit('Expected exactly one immutable build capability declaration')
        host.write_text(source.replace(declaration, "supportedOutputs: Object.freeze(['notes' as const])"))
    source_hashes = {str(path.relative_to(target)): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in sorted(target.rglob('*')) if path.is_file() and 'node_modules' not in path.parts}
    with (output / (name + '-build.log')).open('w') as log:
        result = subprocess.run([str(repo / 'node_modules/.bin/tsc'), '-p', str(target / 'tsconfig.build.json')], cwd=target, stdout=log, stderr=subprocess.STDOUT)
    manifest['builds'][name] = {'sourceHashes': source_hashes, 'buildExit': result.returncode}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if result.returncode:
        raise SystemExit(result.returncode)
env = dict(os.environ,
           WORKRAIL_CAPABILITY_WRITER_MODULE=str(output / 'full/dist/answer-v1/host.js'),
           WORKRAIL_CAPABILITY_READER_MODULE=str(output / 'notes/dist/answer-v1/host.js'))
with (output / 'probe.log').open('w') as log:
    result = subprocess.run([str(repo / 'node_modules/.bin/vitest'), 'run', '--config',
        'experiments/answer-driven-execution/vitest.config.js',
        'experiments/answer-driven-execution/host-capability-mismatch.probe.ts', '--retry=0'],
        cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
manifest['probeExit'] = result.returncode
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'evidence': str(output), 'probeExit': result.returncode}))
raise SystemExit(result.returncode)
