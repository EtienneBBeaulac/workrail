// Transport fault only: the real server commits and emits its response, but the
// client never receives that response. No journal or application state is edited.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
const [server, evidence] = process.argv.slice(2);
const child = spawn(process.execPath, [server], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
let dropped = false;
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.on('error', error => { process.stderr.write(String(error)); process.exitCode = 1; });
createInterface({ input: child.stdout }).on('line', line => {
  let answer;
  try { answer = JSON.parse(JSON.parse(line).result.content[0].text); } catch {}
  if (!dropped && answer?.kind === 'recorded' && answer.disposition === 'accepted') {
    dropped = true;
    writeFileSync(evidence, JSON.stringify({ dropped: true, receipt: answer.receipt }));
    child.kill('SIGKILL');
  } else if (!dropped) process.stdout.write(line + '\n');
});
child.on('close', () => { process.stdin.unpipe(child.stdin); process.stdin.destroy(); process.exit(dropped ? 0 : 1); });
