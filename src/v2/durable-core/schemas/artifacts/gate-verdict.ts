import { z } from 'zod';

/**
 * Gate Verdict Artifact Schema (v1)
 *
 * Typed artifact produced by an independent gate evaluator session and
 * consumed by the coordinator to decide whether to approve, reject, or
 * escalate a gate checkpoint. The evaluator session reads only the typed
 * handoff artifact from the gated session -- not the session's conversation
 * history -- ensuring structural isolation between producer and evaluator.
 *
 * Related: docs/design/worktrain-pause-resume-discovery.md (Selected direction)
 * Related: docs/design/gate-coordinator-pr2-implementation-plan.md (Slice 1-2)
 */

/**
 * Contract reference for gate verdict artifacts.
 * Used in evaluator workflow step definitions to declare the output contract.
 */
export const GATE_VERDICT_CONTRACT_REF = 'wr.contracts.gate_verdict' as const;

/**
 * Gate Verdict Artifact V1 Schema
 *
 * Produced by gate evaluator workflow sessions. Read by GateEvaluatorDispatcher
 * in the coordinator to decide whether to resume the parked session with
 * an 'approved' verdict or escalate to operator outbox.
 */
export const GateVerdictArtifactV1Schema = z
  .object({
    /** Artifact kind discriminator */
    kind: z.literal('wr.gate_verdict'),
    version: z.literal(1),

    /**
     * The evaluator's decision.
     * - 'approved': coordinator resumes the parked session with verdict context
     * - 'rejected': coordinator escalates to operator outbox with findings
     * - 'uncertain': evaluator could not reach a confident conclusion;
     *   coordinator escalates to operator outbox
     */
    verdict: z.enum(['approved', 'rejected', 'uncertain']),

    /**
     * The evaluator's confidence in the verdict.
     * Affects whether the coordinator auto-approves or routes to additional review.
     */
    confidence: z.enum(['high', 'medium', 'low']),

    /**
     * The evaluator's rationale for the verdict.
     * Injected into the resumed session's first step prompt so the agent
     * understands why the gate was approved or rejected.
     * Min 20 chars to ensure substantive reasoning is required.
     */
    rationale: z.string().min(20),
  })
  .strict();

export type GateVerdictArtifactV1 = z.infer<typeof GateVerdictArtifactV1Schema>;

/**
 * Type guard to check if an unknown artifact is a gate verdict artifact.
 *
 * Checks the kind discriminant only -- does not validate the full schema.
 * Use parseGateVerdictArtifact() for full validation.
 */
export function isGateVerdictArtifact(
  artifact: unknown,
): artifact is { readonly kind: 'wr.gate_verdict' } {
  return (
    typeof artifact === 'object' &&
    artifact !== null &&
    (artifact as Record<string, unknown>).kind === 'wr.gate_verdict'
  );
}

/**
 * Parse and validate an unknown artifact as a gate verdict artifact.
 *
 * Returns the parsed artifact on success, null on validation failure.
 */
export function parseGateVerdictArtifact(
  artifact: unknown,
): GateVerdictArtifactV1 | null {
  const result = GateVerdictArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}

/** Actionable blocked message for wr.gate_verdict contract. */
export function getBlockedMessage(): readonly string[] {
  return [
    `Artifact contract: ${GATE_VERDICT_CONTRACT_REF}`,
    `Provide a wr.gate_verdict artifact in complete_step's artifacts[] parameter.`,
    `Required fields: verdict ("approved"|"rejected"|"uncertain"), rationale (string), confidence ("high"|"medium"|"low"), stepId (string).`,
    `Canonical format:`,
    `\`\`\`json`,
    `{ "artifacts": [{ "kind": "wr.gate_verdict", "verdict": "approved", "rationale": "Output meets criteria", "confidence": "high", "stepId": "phase-6-final-handoff" }] }`,
    `\`\`\``,
  ];
}
