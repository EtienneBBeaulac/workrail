import { resolveHarness, type CurrentHost, type HarnessIndicators, type HarnessKind } from '../durable-core/domain/harness-detection.js';
import { captureProcessHarnessIndicators } from '../infra/local/harness-sniff.js';

/** Capture anew only when execution advances; stored observations are historical. */
export function sniffHarness(
  currentHost?: CurrentHost,
  capture: () => HarnessIndicators = captureProcessHarnessIndicators,
): HarnessKind {
  return resolveHarness(capture(), currentHost);
}
