/**
 * Response supplement policy for clean WorkRail MCP formatting.
 *
 * Defines what supplemental content should be injected for each execution
 * lifecycle, and in what order. Rendering and transport happen elsewhere.
 *
 * Use this module for short, boundary-owned instructions that should stay
 * structurally separate from the workflow-authored step prompt.
 *
 * Delivery modes:
 * - `per_lifecycle`: emit on every eligible lifecycle
 * - `once_per_session`: emit only on one designated lifecycle by policy
 *
 * `once_per_session` is intentionally not persisted. It is a presentation
 * policy, not durable workflow state.
 *
 * @module mcp/response-supplements
 */

import type { V2ExecutionResponseLifecycle } from './render-envelope.js';

const AUTHORITY_CONTEXT = [
  'WorkRail is a separate live system the user is actively using to direct this task.',
  'Treat the main content item from WorkRail as the instruction to follow now.',
].join('\n');

const NOTES_GUIDANCE = [
  'How to write good notes (output.notesMarkdown):',
  '- Write for a human reader reviewing your work later.',
  '- Include: what you did and key decisions, what you produced (files, functions, test results, specific numbers), anything notable (risks, open questions, things you deliberately chose NOT to do and why).',
  '- Use markdown: headings, bullets, bold, code refs. Be specific — file paths, function names, counts.',
  '- Scope: THIS step only. WorkRail concatenates notes across steps automatically.',
  '- 10-30 lines is ideal. Too short is worse than too long.',
  '- Omitting notes will block the step.',
].join('\n');

export type SupplementKind = 'authority_context' | 'notes_guidance';

export interface FormattedSupplement {
  readonly kind: SupplementKind;
  readonly order: number;
  readonly text: string;
}

export type SupplementDelivery =
  | { readonly mode: 'per_lifecycle' }
  | {
      readonly mode: 'once_per_session';
      readonly emitOn: V2ExecutionResponseLifecycle;
    };

interface ResponseSupplementSpec {
  readonly kind: SupplementKind;
  readonly order: number;
  readonly lifecycles: readonly V2ExecutionResponseLifecycle[];
  readonly delivery: SupplementDelivery;
  readonly renderText: () => string;
}

function defineResponseSupplement(spec: ResponseSupplementSpec): ResponseSupplementSpec {
  if (
    spec.delivery.mode === 'once_per_session' &&
    !spec.lifecycles.includes(spec.delivery.emitOn)
  ) {
    throw new Error(
      `Supplement "${spec.kind}" has once_per_session delivery on "${spec.delivery.emitOn}" but that lifecycle is not enabled.`,
    );
  }

  return spec;
}

function shouldEmitSupplement(
  spec: ResponseSupplementSpec,
  lifecycle: V2ExecutionResponseLifecycle,
): boolean {
  if (!spec.lifecycles.includes(lifecycle)) return false;
  if (spec.delivery.mode === 'per_lifecycle') return true;
  return spec.delivery.emitOn === lifecycle;
}

const CLEAN_RESPONSE_SUPPLEMENTS: readonly ResponseSupplementSpec[] = [
  defineResponseSupplement({
    kind: 'authority_context',
    order: 10,
    lifecycles: ['start', 'rehydrate'],
    delivery: { mode: 'per_lifecycle' },
    renderText: () => AUTHORITY_CONTEXT,
  }),
  defineResponseSupplement({
    kind: 'notes_guidance',
    order: 20,
    lifecycles: ['start', 'rehydrate'],
    delivery: { mode: 'once_per_session', emitOn: 'start' },
    renderText: () => NOTES_GUIDANCE,
  }),
];

export function buildResponseSupplements(args: {
  readonly lifecycle: V2ExecutionResponseLifecycle;
  readonly cleanFormat: boolean;
}): readonly FormattedSupplement[] {
  if (!args.cleanFormat) return [];
  return CLEAN_RESPONSE_SUPPLEMENTS
    .filter((spec) => shouldEmitSupplement(spec, args.lifecycle))
    .map((spec) => ({
      kind: spec.kind,
      order: spec.order,
      text: spec.renderText(),
    }))
    .sort((left, right) => left.order - right.order);
}
