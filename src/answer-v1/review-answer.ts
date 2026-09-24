import { z } from 'zod';
import { AnswerJsonSchema } from './answer-json.js';
import { toCanonicalBytes } from '../v2/durable-core/canonical/jcs.js';
import type { JsonValue } from '../v2/durable-core/canonical/json-types.js';
import { ReviewVerdictFindingSchema } from '../v2/durable-core/schemas/artifacts/review-verdict.js';
import type { ValidatedFinding, QuestionIssue } from './contracts/answer-contract.js';

/** Routing has a closed domain shape; original JSON remains evidence, never authority.
 * Keeping both avoids losing enrichment (including properties a parser may strip). */
export type ReviewFinding = Readonly<{ routing: ValidatedFinding; original: JsonValue }>;
export type ReviewFields = Readonly<{
  notes: string;
  verdict: 'clean' | 'minor' | 'blocking';
  confidence: 'high' | 'medium' | 'low';
  findings: readonly ReviewFinding[];
  summary: string;
}>;
export type ReviewField = keyof ReviewFields;
type AtLeastOne<T> = { [K in keyof T]: Readonly<Required<Pick<T, K>> & Partial<Omit<T, K>>> }[keyof T];
export type ReviewFragment = AtLeastOne<ReviewFields>;
export type ReviewState = Readonly<{
  accepted: Partial<ReviewFields>;
  correction: ReviewFragment | null;
}>;
export const emptyReview: ReviewState = Object.freeze({ accepted: Object.freeze({}), correction: null });
const keys = ['notes', 'verdict', 'confidence', 'findings', 'summary'] as const;
const fragmentSchema = z.object({
  notes: z.string().min(1).optional(),
  verdict: z.enum(['clean', 'minor', 'blocking']).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  findings: z.array(ReviewVerdictFindingSchema).optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type ReviewParse =
  | Readonly<{ kind: 'valid'; fragment: ReviewFragment }>
  | Readonly<{ kind: 'invalid'; issues: readonly QuestionIssue[] }>;

/** Only the pinned obligation chooses this decoder. Payload shape never selects a profile. */
export function parseReviewFragment(input: unknown): ReviewParse {
  const json = AnswerJsonSchema.safeParse(input);
  const parsed = fragmentSchema.safeParse(input);
  if (!json.success || !parsed.success) return { kind: 'invalid', issues: parsed.success
    ? [{ kind: 'field', field: 'findings', reason: 'Provide JSON review fields.' }]
    : parsed.error.issues.map(issue => ({ kind: 'field',
      field: keys.find(key => key === issue.path[0]) ?? 'notes', reason: issue.message })) };
  const value = parsed.data;
  if (!keys.some(key => value[key] !== undefined)) return { kind: 'invalid', issues: [
    { kind: 'field', field: 'notes', reason: 'Provide at least one review field.' },
  ] };
  // Validation above proves the source is the strict field object with a findings array.
  const canonical = toCanonicalBytes(json.data);
  if (canonical.isErr()) return { kind: 'invalid', issues: [{ kind: 'field', field: 'findings', reason: 'Provide canonical JSON evidence.' }] };
  const original = JSON.parse(Buffer.from(canonical.value).toString('utf8')) as { readonly findings?: readonly JsonValue[] };
  const fields = {
    ...value,
    ...(value.findings === undefined ? {} : { findings: value.findings.map((finding, index) => ({
      routing: { severity: finding.severity, summary: finding.summary,
        ...(finding.findingCategory === undefined ? {} : { findingCategory: finding.findingCategory }),
      } as ValidatedFinding,
      original: original.findings![index]!,
    })) }),
  };
  return { kind: 'valid', fragment: fields as ReviewFragment };
}

function equal(left: JsonValue, right: JsonValue): boolean {
  const a = toCanonicalBytes(left), b = toCanonicalBytes(right);
  return a.isOk() && b.isOk() && Buffer.from(a.value).equals(Buffer.from(b.value));
}
function fieldEqual(field: ReviewField, left: ReviewFields[ReviewField], right: ReviewFields[ReviewField]): boolean {
  if (field !== 'findings') return left === right;
  // Compare exact evidence, including optional absence and nested enrichment.
  return equal((left as ReviewFields['findings']).map(f => f.original),
    (right as ReviewFields['findings']).map(f => f.original));
}
export function missingReviewFields(fields: Partial<ReviewFields>): readonly QuestionIssue[] {
  return keys.filter(key => fields[key] === undefined).map(field => ({ kind: 'field', field, reason: `Provide ${field}.` }));
}
function complete(fields: Partial<ReviewFields>): fields is ReviewFields {
  return keys.every(key => fields[key] !== undefined);
}
export type ReviewTransition =
  | Readonly<{ kind: 'correction_required'; state: ReviewState; issues: readonly QuestionIssue[] }>
  | Readonly<{ kind: 'partial'; state: ReviewState; issues: readonly QuestionIssue[] }>
  | Readonly<{ kind: 'complete'; state: ReviewState; fields: ReviewFields }>;

/** A conflicting submission proposes a correction without changing accepted fields.
 * The immediately following valid submission must repeat every proposed replacement.
 * An unrelated submission clears the proposal, so old rejections cannot confer authority. */
export function contributeReview(state: ReviewState, fragment: ReviewFragment): ReviewTransition {
  const conflicts = keys.filter(key => state.accepted[key] !== undefined && fragment[key] !== undefined
    && !fieldEqual(key, state.accepted[key]!, fragment[key]!));
  const proposed = state.correction;
  const proposedConflicts = proposed === null ? [] : keys.filter(key => state.accepted[key] !== undefined
    && proposed[key] !== undefined && !fieldEqual(key, state.accepted[key]!, proposed[key]!));
  const confirms = proposed !== null && proposedConflicts.length > 0
    && proposedConflicts.every(key => fragment[key] !== undefined && fieldEqual(key, proposed[key]!, fragment[key]!))
    && conflicts.every(key => proposedConflicts.includes(key));
  if (conflicts.length && !confirms) return {
    kind: 'correction_required', state: { accepted: state.accepted, correction: fragment },
    issues: conflicts.map(field => ({ kind: 'field', field,
      reason: `This changes retained ${field}. Repeat the proposed value on the next reply to confirm replacement, or supply a different answer.` })),
  };
  const accepted = { ...state.accepted, ...fragment };
  const next: ReviewState = { accepted, correction: null };
  return complete(accepted) ? { kind: 'complete', state: next, fields: accepted }
    : { kind: 'partial', state: next, issues: missingReviewFields(accepted) };
}

/** Artifact identity is engine-owned; submitted constants are rejected by the decoder. */
export function materializeReview(fields: ReviewFields): Readonly<{
  notesMarkdown: string;
  artifacts: readonly [Readonly<{ kind: 'wr.review_verdict'; verdict: ReviewFields['verdict'];
    confidence: ReviewFields['confidence']; findings: readonly JsonValue[]; summary: string }>];
}> {
  return { notesMarkdown: fields.notes, artifacts: [{ kind: 'wr.review_verdict', verdict: fields.verdict,
    confidence: fields.confidence, findings: fields.findings.map(f => f.original), summary: fields.summary }] };
}

export function reviewQuestions(state: ReviewState): readonly QuestionIssue[] {
  if (state.correction === null) return missingReviewFields(state.accepted);
  const proposal = contributeReview({ accepted: state.accepted, correction: null }, state.correction);
  return proposal.kind === 'correction_required' ? [...proposal.issues, ...missingReviewFields(state.accepted)] : missingReviewFields(state.accepted);
}
