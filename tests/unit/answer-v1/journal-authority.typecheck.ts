import { SessionJournal } from '../../../src/answer-v1/journal.js';
import type { AnswerEngine } from '../../../src/answer-v1/engine-composition.js';
import type { HostEnrollment } from '../../../src/answer-v1/contracts/invocation-contract.js';

declare const engine: AnswerEngine;
declare const enrollment: HostEnrollment;
// Persistence requires no dummy inference implementation or credential-bearing factory.
const journal = new SessionJournal(engine, enrollment, {}, signal => !signal.aborted);
// @ts-expect-error Persistence does not grant model invocation authority.
void journal.config.model;
// @ts-expect-error Persistence does not grant per-delivery model construction authority.
void journal.config.modelFactory;
