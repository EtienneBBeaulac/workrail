"""Candidate current-checkout compatibility proof; no installed runtime changes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time

BASELINE = '396cdfa4e665afa993b50fcf0ec59ca53a2167db'
ARCHIVE = 'experiments/answer-driven-execution/fixtures/legacy-writer-396cdfa4.tar.gz'
ARCHIVE_SHA256 = '6ac4f5344f355db5e3adc57867b235c38266d7a959f8b5ef2069e81367374b9e'
FIXTURE = 'experiments/answer-driven-execution/cross-version.fixture.ts'
CONFIG = 'experiments/answer-driven-execution/cross-version.config.js'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def inventory(checkout, names):
    result = {}
    for name in names:
        path = checkout / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Tracked source must be a regular file: {name}')
        result[name] = digest(path)
    return result

def live_group(group):
    rows = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True, timeout=5)
    return any(int(fields[0]) == group and not fields[1].startswith('Z')
               for row in rows.splitlines() if len(fields := row.split()) == 2)

def close_group(child):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            break
        end = time.monotonic() + 5
        while live_group(child.pid) and time.monotonic() < end:
            time.sleep(0.05)
    child.wait(timeout=5)
    if live_group(child.pid):
        raise ValueError('Child process group remained live')

def execute(argv, tree, env, output, label, phases):
    start = time.monotonic()
    with (output / (label + '.log')).open('w') as log:
        child = subprocess.Popen(argv, cwd=tree, env=env, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait(timeout=120)
        except subprocess.TimeoutExpired:
            code = 124
        finally:
            close_group(child)
    phases.append({'label': label, 'argv': argv, 'exitCode': code,
                   'seconds': time.monotonic() - start, 'liveProcessGroupGone': True})
    return code

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkout', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--dependency-cache', type=Path, help='Explicit npm offline cache; build runtimes remain independent')
    args = parser.parse_args()
    checkout = Path(args.checkout).resolve()
    dependency_cache = (args.dependency_cache or Path.home() / '.npm').resolve()
    if not dependency_cache.is_dir():
        raise ValueError('Dependency cache unavailable: supply --dependency-cache explicitly')
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('Evidence directory must be empty')
    def git(*argv):
        return subprocess.check_output(['git', *argv], cwd=checkout)
    head = git('rev-parse', 'HEAD').decode().strip()
    names = git('ls-files', '-z').decode().rstrip('\0').split('\0')
    before = inventory(checkout, names)
    report = {'checkout': str(checkout), 'head': head, 'baseline': BASELINE,
              'currentSource': 'tracked working-tree bytes, including controls',
              'sourceInventory': before, 'phases': [], 'dependencyCache': str(dependency_cache)}
    code = 1
    root = Path(tempfile.mkdtemp(prefix='workrail-portable-compat-'))
    try:
        writer = root / 'writer'
        reader = root / 'reader'
        writer.mkdir()
        reader.mkdir()
        archive = checkout / ARCHIVE
        if digest(archive) != ARCHIVE_SHA256:
            raise ValueError('Historical writer archive identity mismatch')
        report['writerArchiveSha256'] = ARCHIVE_SHA256
        with tarfile.open(archive) as source:
            source.extractall(writer, filter='data')
        # Never archive HEAD for the reader: doing so would discard sabotage.
        for name in names:
            target = reader / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(checkout / name, target)
        for name in (FIXTURE, CONFIG):
            target = writer / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(checkout / name, target)
        private_home = root / 'home'
        private_home.mkdir()
        env = {k: os.environ[k] for k in ('PATH', 'LANG', 'TMPDIR') if k in os.environ}
        env.update({'HOME': str(private_home), 'npm_config_cache': str(dependency_cache),
                    'WORKRAIL_COMPAT_ROOT': str(root / 'fixture-state'),
                    'WORKRAIL_COMPAT_REQUIRE_BLOCKED': '1',
                    'WORKRAIL_DATA_DIR': str(root / 'fixture-state/state'),
                    'WORKRAIL_KEYS_DIR': str(root / 'keys'),
                    'ANTHROPIC_API_KEY': 'local-fixture-no-model-call'})
        report['locks'] = {'writer': digest(writer / 'package-lock.json'),
                           'reader': digest(reader / 'package-lock.json')}
        for phase, tree in [('write', writer), ('read', reader)]:
            code = execute(['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
                           tree, env, output, phase + '-dependencies', report['phases'])
            if code:
                break
            if (tree / 'node_modules').is_symlink():
                raise ValueError('Dependencies must belong to this revision')
            env['WORKRAIL_COMPAT_PHASE'] = phase
            code = execute(['node', 'node_modules/vitest/vitest.mjs', 'run', '--config',
                            CONFIG, FIXTURE, '--retry=0'], tree, env, output, phase,
                           report['phases'])
            if code:
                break
    finally:
        report['inputSourceUnchanged'] = (inventory(checkout, names) == before
            and git('rev-parse', 'HEAD').decode().strip() == head
            and git('ls-files', '-z').decode().rstrip('\0').split('\0') == names)
        shutil.rmtree(root)
        report['temporaryRootRemoved'] = not root.exists()
        report['exitCode'] = code
        (output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        if not report['inputSourceUnchanged']:
            raise ValueError('Input source drifted during the proof')
    raise SystemExit(code)

if __name__ == '__main__':
    main()
