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

const SUBAGENT_GUIDANCE = [
  'Interactive Session Advancement & Subagent Guidance:',
  '- **Advancement**: When you have completed all work for this step, call `continue_workflow` with the provided `continueToken`. You can pass `notes` and `artifacts` directly at the top level or nested inside `output` — both formats are fully supported.',
  '- **Spawning Routines / Executors**: If a step instructs you to "spawn a WorkRail Executor" or execute a parallel routine (e.g. `wr.routine-philosophy-alignment`), you should delegate it to a subagent using your native client capabilities (e.g. `invoke_subagent` to start a child agent running the routine with `start_workflow`) or execute it inline if client-side subagent tools are unavailable.',
].join('\n');

export type SupplementKind = 'authority_context' | 'notes_guidance' | 'subagent_guidance' | 'executor_directive';

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

const EXECUTOR_DIRECTIVE_TEXT = [
  'WorkRail Executor Behavioral Rules:',
  '- Token types: ct_ = continueToken (advance); st_/cp_ = resumeToken (rehydrate only). Never mix.',
  '- Advance only when the step\'s work is fully complete. Call continue_workflow with intent "advance".',
  '- Rehydrate is read-only: if resuming with intent "rehydrate", do NOT re-do the step\'s work.',
  '- Autonomous confirmation gates: make the best default decision from available context, record it in notesMarkdown as "AUTONOMOUS GATE DECISION: [gate] -- selected [option] because [reason]", then advance immediately.',
  '- If any mcp__workrail__* tool fails with a connection or tool-not-found error: stop immediately, do not improvise, retry the failed call until it succeeds, and hold any tokens you have.',
].join('\n');

const CLEAN_RESPONSE_SUPPLEMENTS: readonly ResponseSupplementSpec[] = [
  defineResponseSupplement({
    kind: 'executor_directive',
    order: 4,
    lifecycles: ['start', 'rehydrate'],
    delivery: { mode: 'per_lifecycle' },
    renderText: () => EXECUTOR_DIRECTIVE_TEXT,
  }),
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
  defineResponseSupplement({
    kind: 'subagent_guidance',
    order: 30,
    lifecycles: ['start', 'rehydrate'],
    delivery: { mode: 'per_lifecycle' },
    renderText: () => SUBAGENT_GUIDANCE,
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
