"""Build distinct full and notes-only policy fixtures from the target checkout."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HELPER = Path(__file__).with_name('current-cross-version.py')
SPEC = importlib.util.spec_from_file_location('compatibility_process', HELPER)
if SPEC is None or SPEC.loader is None:
    raise SystemExit('Current compatibility helpers unavailable')
process = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(process)
HOST = 'src/answer-v1/host.ts'
POLICY = "Object.freeze(['notes' as const, 'wr.contracts.review_verdict' as const])"
NOTES_POLICY = "Object.freeze(['notes' as const])"
PROBE = 'experiments/answer-driven-execution/host-capability-mismatch.probe.ts'
CONFIG = 'experiments/answer-driven-execution/vitest.config.js'

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
    before = process.inventory(checkout, names)
    report = {'checkout': str(checkout), 'head': head, 'sourceInventory': before,
              'currentSource': 'tracked working bytes, including guard controls',
              'readerRole': 'controlled notes-only public policy build; not a released historical reader or removed compiled review implementation',
              'readerDelta': {'file': HOST, 'find': POLICY, 'replace': NOTES_POLICY},
              'phases': [], 'builds': {}, 'dependencyCache': str(dependency_cache)}
    root = Path(tempfile.mkdtemp(prefix='capability-build-proof-'))
    code = 1
    try:
        home = root / 'home'
        home.mkdir()
        env = {k: os.environ[k] for k in ('PATH', 'LANG', 'TMPDIR') if k in os.environ}
        env.update({'HOME': str(home), 'npm_config_cache': str(dependency_cache),
                    'WORKRAIL_KEYS_DIR': str(root / 'keys'),
                    'WORKRAIL_DATA_DIR': str(root / 'data'),
                    'ANTHROPIC_API_KEY': 'local-fixture-no-model-call'})
        trees = {}
        for role in ('writer', 'reader'):
            tree = root / role
            tree.mkdir()
            trees[role] = tree
            for name in names:
                target = tree / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(checkout / name, target)
            if role == 'reader':
                host = tree / HOST
                source = host.read_text()
                if source.count(POLICY) != 1:
                    raise ValueError('Current public capability policy is ambiguous')
                host.write_text(source.replace(POLICY, NOTES_POLICY))
            report['builds'][role] = {'source': process.inventory(tree, names),
                                      'lockSha256': process.digest(tree / 'package-lock.json')}
            code = process.execute(['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
                                   tree, env, output, role + '-dependencies', report['phases'])
            if code:
                break
            if (tree / 'node_modules').is_symlink():
                raise ValueError('Dependencies must belong to this source copy')
            code = process.execute(['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
                                   tree, env, output, role + '-build', report['phases'])
            if code:
                break
            compiled = tree / 'dist'
            compiled_names = sorted(str(p.relative_to(compiled)) for p in compiled.rglob('*') if p.is_file())
            if not compiled_names or not (compiled / 'answer-v1/host.js').is_file():
                raise ValueError('Compiled factory or transitive build unavailable')
            report['builds'][role]['compiledFiles'] = process.inventory(compiled, compiled_names)
        if code == 0:
            writer, reader = trees['writer'], trees['reader']
            if writer.resolve() == reader.resolve():
                raise ValueError('Build identities must be distinct')
            env.update({'WORKRAIL_CAPABILITY_WRITER_MODULE': str(writer / 'dist/answer-v1/host.js'),
                        'WORKRAIL_CAPABILITY_READER_MODULE': str(reader / 'dist/answer-v1/host.js')})
            code = process.execute(['node', 'node_modules/vitest/vitest.mjs', 'run', '--config',
                                    CONFIG, PROBE, '--retry=0'], writer, env, output,
                                   'capability-probe', report['phases'])
    finally:
        report['inputSourceUnchanged'] = (process.inventory(checkout, names) == before
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
