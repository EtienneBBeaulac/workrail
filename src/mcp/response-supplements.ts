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
  '## WorkRail Protocol -- Read Before You Start',
  '',
  'You are executing a step-by-step WorkRail workflow. Every response you receive',
  'has two sections:',
  '',
  "- **USER** -- the step's instructions. Do what they say.",
  '- **SYSTEM** -- a JSON block containing your next `continueToken`.',
  '',
  '### The loop',
  '',
  "After completing each step's work:",
  '',
  '1. Call `continue_workflow` with:',
  '   - `continueToken`: the `ct_...` token from the SYSTEM section JSON block',
  '   - `notes`: a plain string summarizing what you did',
  '',
  '2. Read the response. The SYSTEM section contains a NEW token:',
  '',
  '   ```',
  '   **Tokens for step `<stepId>` — use these for your next `continue_workflow` call',
  '   (not tokens from earlier steps):**',
  '   {"continueToken": "ct_NEW_TOKEN_HERE"}',
  '   ```',
  '',
  '3. Copy `ct_NEW_TOKEN_HERE`. Use it in your NEXT call. Throw away the old token.',
  '',
  '4. Repeat until the response says the workflow is complete.',
  '',
  '**The token changes on every call. Never reuse a token from a previous step.**',
  '',
  '---',
  '',
  '### Passing notes',
  '',
  'Pass `notes` as a plain string at the top level. Do NOT nest it inside an',
  '`output` object.',
  '',
  'Correct:',
  '```',
  'continue_workflow(',
  '  continueToken="ct_abc123",',
  '  notes="## What I did\\nSurveyed the repo. Found X. Decided Y."',
  ')',
  '```',
  '',
  'Wrong (Ollama serializes nested objects as strings, WorkRail rejects them):',
  '```',
  'continue_workflow(',
  '  continueToken="ct_abc123",',
  '  output={"notesMarkdown": "..."}   ← DO NOT DO THIS',
  ')',
  '```',
  '',
  '---',
  '',
  '### Passing assessment artifacts',
  '',
  'If a step requires assessment artifacts, pass them as a JSON string in the',
  'top-level `artifacts` parameter -- not as a nested `output.artifacts` array.',
  '',
  'Correct:',
  '```',
  'continue_workflow(',
  '  continueToken="ct_abc123",',
  '  notes="## Assessment\\nDesign is sound.",',
  '  artifacts=\'[{"kind":"wr.assessment","assessmentId":"design-soundness-gate","dimensions":{"design_soundness":"high"}}]\'',
  ')',
  '```',
  '',
  'Wrong (same Ollama nesting bug):',
  '```',
  'continue_workflow(',
  '  continueToken="ct_abc123",',
  '  output={"artifacts": [...]}   ← DO NOT DO THIS',
  ')',
  '```',
  '',
  '---',
  '',
  '### Delegation steps',
  '',
  'If a step instructs you to spawn sub-agents or delegate to a sub-routine',
  '(e.g. `wr.routine-design-review`):',
  '',
  '- If your environment has a `delegate` tool and the source is found, use it.',
  '- If the source is not found or no `delegate` tool exists, call `continue_workflow`',
  '  with notes explaining that delegation is not available, and advance. Example:',
  '',
  '```',
  'continue_workflow(',
  '  continueToken="ct_abc123",',
  '  notes="## Delegation skipped\\nNo delegate tool available in this environment.\\nPerformed the design review inline instead.\\n\\n[inline findings here]"',
  ')',
  '```',
  '',
  'Do not loop or retry delegation. Advance once with the skip note.',
].join('\\n');

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
