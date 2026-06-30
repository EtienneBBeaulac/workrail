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

const ONBOARDING_PROTOCOL = [
  'Rules of Engagement (Local LLM Protocol):',
  '1. NO PREEMPTIVE WORK: Do not attempt to solve the overarching task right now. You must wait for explicit workflow steps. Do not jump ahead.',
  '2. ADHERE TO THE DAG: You will be fed prompts one step at a time. Complete only the step requested. The engine handles all branching, routing, and loops—you just provide the facts.',
  '3. OUTPUT CONTRACTS: Use the `continue_workflow` tool to submit your work when a step is done. Do not just print your final answer in chat; it must be submitted through the tool.',
  '4. DURABLE OUTPUTS: Your findings must be recorded in `output.notesMarkdown` (for human-readable summaries) or `output.artifacts` (for structured data/arrays).',
  '5. CONFIDENCE & DISCLOSURE: Do not invent facts to bypass steps. If you lack context or tools, degrade your confidence and explicitly disclose what is missing. The workflow is designed to handle missing information safely.',
  '6. TOKEN PROTOCOL: Always pass the exact `continueToken` provided in the current prompt when calling `continue_workflow`.',
].join('\n');

export type SupplementKind = 'authority_context' | 'notes_guidance' | 'subagent_guidance' | 'onboarding_protocol';

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
    kind: 'onboarding_protocol',
    order: 15,
    lifecycles: ['start', 'rehydrate'],
    delivery: { mode: 'per_lifecycle' },
    renderText: () => ONBOARDING_PROTOCOL,
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
