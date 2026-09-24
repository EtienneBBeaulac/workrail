import type { CapturePolicy, ResponsePayload } from '../../../src/answer-v1/response-capture.js';

// @ts-expect-error Boundary validation is required before using a capture policy.
const uncheckedPolicy: CapturePolicy = { maxBytes: 0 };
// @ts-expect-error A raw provider response is not a validated immutable payload.
const uncheckedPayload: ResponsePayload = { responseText: '', calls: [] };
void uncheckedPolicy;
void uncheckedPayload;
