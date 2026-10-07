"""Exercise the real recovery CLI with isolated subprocess transport fakes.

These controls verify harness outcomes and retained diagnostics, not engine recovery.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SOURCE = Path(__file__).with_name('host-recovery.py')
FAKE = '''#!{python}
import json,os,time
from pathlib import Path
mode={mode!r}
root=Path(os.environ['WORKRAIL_RESTART_ROOT'])
phase=os.environ['WORKRAIL_RESTART_PHASE']
nonce=os.environ['WORKRAIL_RESTART_NONCE']
case=os.environ['WORKRAIL_RESTART_CASE']
if phase=='write':
 if mode=='writer_exit':raise SystemExit(7)
 if mode=='writer_timeout':
  print('WRITER_DEADLINE_DIAGNOSTIC',flush=True)
  while True:time.sleep(1)
 barrier=dict(ready=True,caseType=case,phase='write',runNonce=nonce,writerPid=os.getpid(),recordedAt=int(time.time()*1000))
 (root/'barrier.json').write_text(json.dumps(barrier))
 while True:time.sleep(1)
else:
 if mode=='reader_timeout':
  print('READER_DEADLINE_DIAGNOSTIC',flush=True)
  while True:time.sleep(1)
 if mode=='reader_failure':
  print('READER_FAILURE_DIAGNOSTIC\\nG1: PASSED',flush=True)
  raise SystemExit(1)
 writer=json.loads((root/'barrier.json').read_text())['writerPid']
 observed=dict(caseType=case,phase='read',runNonce=nonce,readerPid=os.getpid(),writerPid=writer,success=True,storageBytesMatched=True,barrierObserved=True,storageIntact=True)
 (root/'reader-observation.json').write_text(json.dumps(observed))
'''

class CliCases(unittest.TestCase):
    def invoke(self, mode):
        with tempfile.TemporaryDirectory(prefix='recovery-outcome-control-') as directory:
            root=Path(directory);repo=root/'repo';repo.mkdir()
            paths={'experiments/answer-driven-execution/host-recovery.py':SOURCE.read_text(),
                   'experiments/answer-driven-execution/host-recovery.fixture.ts':'fixture transport is substituted',
                   'experiments/answer-driven-execution/host-recovery.config.js':'configuration transport is substituted',
                   'src/answer-v1/host.ts':'present candidate marker','workflows/marker':'fixture',
                   'package.json':'{}','package-lock.json':'{}'}
            helper=SOURCE.with_name('host_recovery_outcomes.py')
            if helper.exists():paths['experiments/answer-driven-execution/host_recovery_outcomes.py']=helper.read_text()
            for name,value in paths.items():
                path=repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(value)
            subprocess.run(['git','init','-qb','fixture',str(repo)],check=True,capture_output=True)
            subprocess.run(['git','-C',str(repo),'config','core.hooksPath','/dev/null'],check=True)
            subprocess.run(['git','-C',str(repo),'add',*paths],check=True)
            subprocess.run(['git','-C',str(repo),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','test(engine): create isolated transport fixture'],check=True,capture_output=True)
            binary=repo/'node_modules/.bin/vitest';binary.parent.mkdir(parents=True)
            binary.write_text(FAKE.format(python=sys.executable,mode=mode));binary.chmod(0o755)
            output=root/'report'
            result=subprocess.run([sys.executable,str(repo/'experiments/answer-driven-execution/host-recovery.py'),'--case','harness_control','--output-dir',str(output)],cwd=repo,capture_output=True,text=True,timeout=45)
            report=json.loads((output/'result.json').read_text())
            return result,report['cases'][0]

    def test_valid_transport_control(self):
        result,case=self.invoke('valid')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(case['status'],'passed')
        self.assertTrue(case['success'])
        self.assertTrue(case['phases'][0]['killedWithSigkill'])

    def test_reader_timeout_is_unavailable(self):
        result,case=self.invoke('reader_timeout')
        self.assertEqual(result.returncode,124,result.stdout+result.stderr)
        self.assertEqual(case['status'],'harness_timeout')
        self.assertIn('READER_DEADLINE_DIAGNOSTIC',result.stdout)

    def test_live_writer_deadline_is_not_premature_exit(self):
        result,case=self.invoke('writer_timeout')
        self.assertEqual(result.returncode,124,result.stdout+result.stderr)
        self.assertEqual(case['status'],'harness_timeout')
        self.assertIsNone(case['phases'][0]['writerExitCode'])
        self.assertNotIn('prematurely',case['phases'][0]['error'])
        self.assertIn('WRITER_DEADLINE_DIAGNOSTIC',result.stdout)

    def test_failed_reader_diagnostic_survives_output_cleanup(self):
        result,case=self.invoke('reader_failure')
        self.assertEqual(result.returncode,1,result.stdout+result.stderr)
        self.assertEqual(case['status'],'test_failed')
        self.assertIn('    | READER_FAILURE_DIAGNOSTIC',result.stdout)
        self.assertNotIn('\nG1: PASSED',result.stdout)
        self.assertIn('    | G1: PASSED',result.stdout)

    def test_early_writer_exit_is_unavailable(self):
        result,case=self.invoke('writer_exit')
        self.assertEqual(result.returncode,126,result.stdout+result.stderr)
        self.assertEqual(case['status'],'harness_error')
        self.assertEqual(case['phases'][0]['writerExitCode'],7)

class OutcomeCases(unittest.TestCase):
    def test_terminal_outcomes_require_complete_available_cases(self):
        from host_recovery_outcomes import CaseStatus as Status, ExitCode, terminal_exit
        examples = [
            ((), ExitCode.UNAVAILABLE),
            ((Status.PASSED,), ExitCode.PASSED),
            ((Status.PASSED, Status.PENDING), ExitCode.UNAVAILABLE),
            ((Status.PASSED, Status.TEST_FAILED), ExitCode.CHECK_FAILED),
            ((Status.TEST_FAILED, Status.HARNESS_TIMEOUT), ExitCode.TIMED_OUT),
            ((Status.PASSED, Status.RUNTIME_UNAVAILABLE), ExitCode.UNAVAILABLE),
            ((Status.TEST_FAILED, Status.RUNTIME_ERROR), ExitCode.UNAVAILABLE),
        ]
        for statuses, expected in examples:
            with self.subTest(statuses=statuses):self.assertEqual(terminal_exit(statuses),expected)

    def test_diagnostics_are_bounded_and_keep_the_tail(self):
        from host_recovery_outcomes import diagnostic_tail
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'phase.log'
            path.write_text(('x'*1000+'\n')*100+'FINAL_DIAGNOSTIC')
            lines=diagnostic_tail(path)
            self.assertLessEqual(len(lines),13)
            self.assertLessEqual(max(map(len,lines)),512)
            self.assertEqual(lines[-1],'FINAL_DIAGNOSTIC')
            self.assertEqual(diagnostic_tail(path.with_name('absent')),('phase log unavailable',))

if __name__=='__main__':unittest.main()
