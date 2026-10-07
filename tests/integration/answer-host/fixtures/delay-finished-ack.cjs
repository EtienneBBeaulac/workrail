// Delay an actual retained final answer, without editing journal/application state.
// The forge mode is a negative control for receipt-backed verification.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
const [server, evidence, mode = 'delay'] = process.argv.slice(2);
if (!['delay', 'forge_receipts', 'wrong_error'].includes(mode)) throw new Error('Unsupported transport control');
const child = spawn(process.execPath, [server], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
let pending = 0, closed = false, exit = 0;
const finish = () => {
  if (closed && pending === 0) { process.stdin.destroy(); process.exit(exit); }
};
process.on('SIGTERM', () => child.kill('SIGKILL'));
process.on('SIGINT', () => child.kill('SIGKILL'));
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.on('error', error => { process.stderr.write(String(error)); exit = 1; });
createInterface({ input: child.stdout }).on('line', line => {
  let response, answer;
  try { response = JSON.parse(line); answer = JSON.parse(response.result.content[0].text); } catch {}
  const delayed = answer?.kind === 'recorded' && answer.disposition === 'accepted' && answer.view?.kind === 'finished';
  if (delayed) writeFileSync(evidence, JSON.stringify({ delayed: true, receipt: answer.receipt, delayMs: 6000 }));
  const finalAnswer = delayed || (answer?.kind === 'replay' && answer.original?.kind === 'finished');
  if (mode === 'wrong_error' && delayed) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: response.id, error: { code: -32602, message: 'control_wrong_error' } }) + '\n');
    return;
  }
  if (mode === 'forge_receipts' && finalAnswer) {
    answer.receipt = 'forged_receipt';
    response.result.content[0].text = JSON.stringify(answer);
    line = JSON.stringify(response);
  }
  if (delayed) {
    pending++;
    setTimeout(() => { process.stdout.write(line + '\n'); pending--; finish(); }, 6000);
  } else process.stdout.write(line + '\n');
});
child.on('close', code => { process.stdin.unpipe(child.stdin); closed = true; exit = code ?? 1; finish(); });
