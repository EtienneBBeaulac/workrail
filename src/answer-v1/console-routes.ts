import type { Application, Request, Response } from 'express';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import type { ReceiptRef, EvidenceCursor } from './contracts/answer-contract.js';
import type { ConsoleReaderBinding, ConsoleAnswerUnavailableReason } from './contracts/console-contract.js';

const unavailableStatus: Readonly<Record<ConsoleAnswerUnavailableReason, 404 | 422 | 503>> = {
  missing: 404,
  corrupt: 422,
  unsupported_version: 422,
  storage_unavailable: 503,
  profile_disabled: 503,
};

/** No binding means no answer authority. An URL selector can only narrow the injected
 * reader's scope; it cannot select a host session the reader was not bound to. */
export function mountAnswerConsoleRoutes(app: Application, reader?: ConsoleReaderBinding): void {
  const route = (receiptRoute: boolean) => async (req: Request, res: Response) => {
    const sessionId = asSessionId(String(req.params.sessionId));
    const receipt = String(req.params.receipt ?? '') as ReceiptRef;
    const identity = receiptRoute ? { sessionId, receipt } : { sessionId };
    const request = new AbortController();
    const abort = () => request.abort();
    res.once('close', abort);
    try {
      if (!reader || (reader.scope === 'host_bound' && reader.boundSessionId !== sessionId)) {
        res.status(403).json({ success: false, error: 'Answer scope required', outcome: {
          kind: 'refused', ...identity, reason: reader ? 'invalid_scope' : 'bound_session_required',
        } });
        return;
      }
      if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') {
        res.status(400).json({ success: false, error: 'Invalid evidence cursor' });
        return;
      }
      const cursor = req.query.cursor as EvidenceCursor | undefined;
      const outcome = receiptRoute
        ? reader.scope === 'host_bound' ? await reader.getReceipt(receipt, cursor, request.signal)
          : await reader.getReceipt(sessionId, receipt, cursor, request.signal)
        : reader.scope === 'host_bound' ? await reader.getAnswer(request.signal)
          : await reader.getAnswer(sessionId, request.signal);
      if (request.signal.aborted || res.destroyed || res.writableEnded) return;
      switch (outcome.kind) {
        case 'loaded': {
          const { kind: _kind, ...data } = outcome;
          res.json({ success: true, data });
          return;
        }
        case 'refused': res.status(403).json({ success: false, error: 'Answer scope refused', outcome }); return;
        case 'not_enrolled': res.status(409).json({ success: false, error: 'Session not enrolled', outcome }); return;
        case 'unavailable': res.status(unavailableStatus[outcome.reason]).json({ success: false, error: 'Answer unavailable', outcome }); return;
      }
    } catch {
      if (request.signal.aborted || res.destroyed || res.writableEnded || res.headersSent) return;
      res.status(503).json({ success: false, error: 'Answer unavailable', outcome: {
        kind: 'unavailable', ...identity, reason: 'storage_unavailable',
      } });
    } finally { res.removeListener('close', abort); }
  };
  app.get('/api/v2/sessions/:sessionId/answer', route(false));
  app.get('/api/v2/sessions/:sessionId/answer/receipts/:receipt', route(true));
}
