import type { AnswerReadEngine } from '../../../src/answer-v1/engine-composition.js';
import type { ConsoleReadConfig } from '../../../src/answer-v1/contracts/console-composition.js';
import type { AnswerHostConfig } from '../../../src/answer-v1/contracts/host-composition.js';
declare const reader: AnswerReadEngine;
declare const host: AnswerHostConfig;
// @ts-expect-error Read composition does not grant append authority.
reader.sessionStore.append;
// @ts-expect-error Read composition does not grant ownership transactions.
reader.gate;
// @ts-expect-error Read composition does not grant identity allocation.
reader.idFactory;
// @ts-expect-error An execution configuration cannot become read-only via structural assignment.
const config: ConsoleReadConfig = host;
void config;
