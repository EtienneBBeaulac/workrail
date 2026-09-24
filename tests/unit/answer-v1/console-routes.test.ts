import { it, expect } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountAnswerConsoleRoutes } from '../../../src/answer-v1/console-routes.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';
import type { ReadRef } from '../../../src/answer-v1/contracts/answer-contract.js';

it('HTTP selectors cannot broaden a scoped reader and malformed cursors never reach it', async () => {
  const app = express();
  let reads = 0;
  mountAnswerConsoleRoutes(app, {
    scope: 'host_bound', boundSessionId: asSessionId('sess_right'),
    async getAnswer() {
      reads++;
      return { kind: 'loaded', sessionId: asSessionId('sess_right'), view: {
        kind: 'finished', read: 'read' as ReadRef, retained: [], taskOutcome: 'unknown', execution: { kind: 'completed' },
      } };
    },
    async getReceipt(receipt) { reads++; return { kind: 'refused', sessionId: asSessionId('sess_right'), receipt, reason: 'invalid_scope' }; },
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const suffix of ['answer', 'answer/receipts/receipt']) {
      const r = await fetch(`${url}/api/v2/sessions/sess_foreign/${suffix}`);
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ success: false, outcome: { reason: 'invalid_scope' } });
    }
    expect(reads).toBe(0);
    const malformed = await fetch(`${url}/api/v2/sessions/sess_right/answer/receipts/receipt?cursor=a&cursor=b`);
    expect(malformed.status).toBe(400);
    expect(reads).toBe(0);
    const valid = await fetch(`${url}/api/v2/sessions/sess_right/answer`);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ success: true, data: { view: { kind: 'finished' } } });
    expect(reads).toBe(1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('client disconnect revokes its read and causes no late response write', async () => {
  const app = express();
  let writes = 0;
  app.use((_req, res, next) => { const json = res.json.bind(res); res.json = body => { writes++; return json(body); }; next(); });
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  mountAnswerConsoleRoutes(app, {
    scope: 'host_bound', boundSessionId: asSessionId('sess_right'),
    async getAnswer(signal) {
      enter();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      done();
      return { kind: 'unavailable', sessionId: asSessionId('sess_right'), reason: 'storage_unavailable' };
    },
    async getReceipt(receipt) { return { kind: 'refused', sessionId: asSessionId('sess_right'), receipt, reason: 'invalid_scope' }; },
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const abort = new AbortController();
  try {
    const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/sessions/sess_right/answer`, { signal: abort.signal }).catch(() => undefined);
    await entered;
    abort.abort();
    await request;
    await completed;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(writes).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
