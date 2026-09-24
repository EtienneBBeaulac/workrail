"""Compile the historical notes prototype for explicit acceptance controls only."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
revision = 'fa8846112444ae38fcdf1beffe72074cd37ba083'
paths = ['src', 'spec', 'workflows', 'package.json', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.build.json']
archive = subprocess.check_output(['git', 'archive', revision, *paths], cwd=repo)
with tarfile.open(fileobj=io.BytesIO(archive)) as contents:
    contents.extractall(output, filter='data')
(output / 'node_modules').symlink_to((repo / 'node_modules').resolve(), target_is_directory=True)
with (output / 'build.log').open('w') as log:
    result = subprocess.run([str(repo / 'node_modules/.bin/tsc'), '-p', str(output / 'tsconfig.build.json')], cwd=output, stdout=log, stderr=subprocess.STDOUT)
(output / 'baseline-manifest.json').write_text(json.dumps({
    'kind': 'historical-unmerged-notes-prototype', 'revision': revision,
    'archiveSha256': hashlib.sha256(archive).hexdigest(), 'buildExit': result.returncode,
    'dependencies': str((repo / 'node_modules').resolve()),
}, indent=2) + '\n')
print(json.dumps({'baselineRoot': str(output), 'buildExit': result.returncode}))
raise SystemExit(result.returncode)
