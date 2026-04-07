import { MAX_RESUME_PREVIEW_BYTES, RECOVERY_BUDGET_BYTES, TRUNCATION_MARKER } from '../constants.js';

export type RetrievalPackSurface = 'rehydrate';
export type ResumePreviewSurface = 'resume_preview';

export type RetrievalPackTier = 'structural_context' | 'durable_recap' | 'reference_material';
export type ResumePreviewTier = 'identity_context' | 'durable_recap';

export interface RetrievalPackTierDefinition {
  readonly tier: RetrievalPackTier;
  readonly purpose: string;
  readonly priority: number;
  readonly retention: 'core' | 'tail';
}

export interface ResumePreviewTierDefinition {
  readonly tier: ResumePreviewTier;
  readonly purpose: string;
  readonly priority: number;
  readonly maxBytes: number;
}

export interface RetrievalPackTruncationPolicy {
  readonly mode: 'drop_lower_tiers_then_global_utf8_trim';
  readonly budgetScope: 'shared_recovery_prompt';
  readonly antiReconstructionRule: 'select_order_and_compress_explicit_facts_only';
}

export interface RetrievalPackContract {
  readonly surface: RetrievalPackSurface;
  readonly tiers: readonly RetrievalPackTierDefinition[];
  readonly truncation: RetrievalPackTruncationPolicy;
}

export interface ResumePreviewContract {
  readonly surface: ResumePreviewSurface;
  readonly tiers: readonly ResumePreviewTierDefinition[];
  readonly budgetBytes: number;
}

export interface BranchSummarySegment {
  readonly kind: 'branch_summary';
  readonly tier: 'structural_context';
  readonly source: 'deterministic_structure';
  readonly title: 'Branch Summary';
  readonly body: string;
}

export interface DownstreamRecapSegment {
  readonly kind: 'downstream_recap';
  readonly tier: 'structural_context';
  readonly source: 'explicit_durable_fact';
  readonly title: 'Downstream Recap (Preferred Branch)';
  readonly body: string;
}

export interface AncestryRecapSegment {
  readonly kind: 'ancestry_recap';
  readonly tier: 'durable_recap';
  readonly source: 'explicit_durable_fact';
  readonly title: 'Ancestry Recap';
  readonly body: string;
}

export interface FunctionDefinitionsSegment {
  readonly kind: 'function_definitions';
  readonly tier: 'reference_material';
  readonly source: 'workflow_definition';
  readonly title: 'Function Definitions';
  readonly body: string;
}

export type RetrievalPackSegment =
  | BranchSummarySegment
  | DownstreamRecapSegment
  | AncestryRecapSegment
  | FunctionDefinitionsSegment;

export interface RetrievalPackRenderResult {
  readonly text: string;
  readonly includedTiers: readonly RetrievalPackTier[];
  readonly omittedTierCount: number;
  readonly truncatedWithinTier: boolean;
}

export interface SessionTitlePreviewSegment {
  readonly kind: 'session_title_preview';
  readonly tier: 'identity_context';
  readonly source: 'persisted_context';
  readonly body: string;
}

export interface RecapPreviewSegment {
  readonly kind: 'recap_preview';
  readonly tier: 'durable_recap';
  readonly source: 'explicit_durable_fact';
  readonly body: string;
}

export type ResumePreviewSegment = SessionTitlePreviewSegment | RecapPreviewSegment;

export type ResumePreviewText = string & { readonly __brand: 'ResumePreviewText' };

export interface ResumePreviewRenderResult {
  readonly text: ResumePreviewText;
  readonly includedTiers: readonly ResumePreviewTier[];
}

const REHYDRATE_TIER_DEFINITIONS = [
  {
    tier: 'structural_context',
    purpose: 'Orient the agent to branch shape and preferred continuation path.',
    priority: 0,
    retention: 'core',
  },
  {
    tier: 'durable_recap',
    purpose: 'Surface durable notes captured from explicit recap outputs.',
    priority: 1,
    retention: 'core',
  },
  {
    tier: 'reference_material',
    purpose: 'Surface authored workflow definitions referenced by the current step.',
    priority: 2,
    retention: 'tail',
  },
] as const satisfies readonly RetrievalPackTierDefinition[];

export const REHYDRATE_RETRIEVAL_CONTRACT: RetrievalPackContract = {
  surface: 'rehydrate',
  tiers: REHYDRATE_TIER_DEFINITIONS,
  truncation: {
    mode: 'drop_lower_tiers_then_global_utf8_trim',
    budgetScope: 'shared_recovery_prompt',
    antiReconstructionRule: 'select_order_and_compress_explicit_facts_only',
  },
};

const RESUME_PREVIEW_TIER_DEFINITIONS = [
  {
    tier: 'identity_context',
    purpose: 'Surface the best concise identity hint for the session.',
    priority: 0,
    maxBytes: 320,
  },
  {
    tier: 'durable_recap',
    purpose: 'Surface durable recap text, focused around the user query when possible.',
    priority: 1,
    maxBytes: 1600,
  },
] as const satisfies readonly ResumePreviewTierDefinition[];

export const RESUME_PREVIEW_CONTRACT: ResumePreviewContract = {
  surface: 'resume_preview',
  tiers: RESUME_PREVIEW_TIER_DEFINITIONS,
  budgetBytes: MAX_RESUME_PREVIEW_BYTES,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

// Pre-computed Record lookups replace Array.find over constant 2-3 element arrays.
// Each call to getTierPriority etc. happens inside sort comparators that run on
// every segment pair -- O(1) Record access is meaningfully cheaper than O(N) find.
const TIER_PRIORITY: Record<RetrievalPackTier, number> = Object.fromEntries(
  REHYDRATE_RETRIEVAL_CONTRACT.tiers.map((t) => [t.tier, t.priority]),
) as Record<RetrievalPackTier, number>;

const TIER_RETENTION: Record<RetrievalPackTier, 'core' | 'tail'> = Object.fromEntries(
  REHYDRATE_RETRIEVAL_CONTRACT.tiers.map((t) => [t.tier, t.retention]),
) as Record<RetrievalPackTier, 'core' | 'tail'>;

const RESUME_PREVIEW_TIER_PRIORITY: Record<ResumePreviewTier, number> = Object.fromEntries(
  RESUME_PREVIEW_CONTRACT.tiers.map((t) => [t.tier, t.priority]),
) as Record<ResumePreviewTier, number>;

const RESUME_PREVIEW_TIER_MAX_BYTES: Record<ResumePreviewTier, number> = Object.fromEntries(
  RESUME_PREVIEW_CONTRACT.tiers.map((t) => [t.tier, t.maxBytes]),
) as Record<ResumePreviewTier, number>;

function getTierPriority(tier: RetrievalPackTier): number {
  return TIER_PRIORITY[tier] ?? Number.MAX_SAFE_INTEGER;
}

function getTierRetention(tier: RetrievalPackTier): 'core' | 'tail' {
  return TIER_RETENTION[tier] ?? 'tail';
}

function getResumePreviewTierPriority(tier: ResumePreviewTier): number {
  return RESUME_PREVIEW_TIER_PRIORITY[tier] ?? Number.MAX_SAFE_INTEGER;
}

function getResumePreviewTierMaxBytes(tier: ResumePreviewTier): number {
  return RESUME_PREVIEW_TIER_MAX_BYTES[tier] ?? RESUME_PREVIEW_CONTRACT.budgetBytes;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function trimToUtf8Boundary(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  if (n === 0) return bytes;

  let cont = 0;
  for (let i = n - 1; i >= 0 && i >= n - 4; i--) {
    const b = bytes[i]!;
    if ((b & 0b1100_0000) === 0b1000_0000) {
      cont++;
    } else {
      break;
    }
  }

  if (cont === 0) return bytes;

  const leadByteIndex = n - cont - 1;
  if (leadByteIndex < 0) {
    return new Uint8Array(0);
  }

  const leadByte = bytes[leadByteIndex]!;
  const expectedLen =
    (leadByte & 0b1000_0000) === 0 ? 1 :
    (leadByte & 0b1110_0000) === 0b1100_0000 ? 2 :
    (leadByte & 0b1111_0000) === 0b1110_0000 ? 3 :
    (leadByte & 0b1111_1000) === 0b1111_0000 ? 4 :
    0;

  const actualLen = cont + 1;
  if (expectedLen === 0 || expectedLen !== actualLen) {
    return bytes.subarray(0, leadByteIndex);
  }

  return bytes;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  return decoder.decode(trimToUtf8Boundary(bytes.subarray(0, Math.max(0, maxBytes))));
}

function buildOmissionSuffix(omittedTierCount: number): string {
  const omissionLine = omittedTierCount > 0
    ? `\nOmitted ${omittedTierCount} lower-priority tier${omittedTierCount === 1 ? '' : 's'} due to budget constraints.`
    : '\nOmitted recovery content due to budget constraints.';
  return `${TRUNCATION_MARKER}${omissionLine}`;
}

function trimFinalRecoveryText(text: string, omittedTierCount: number): string {
  const suffix = buildOmissionSuffix(omittedTierCount);
  const maxContentBytes = RECOVERY_BUDGET_BYTES - encoder.encode(suffix).length;
  const truncated = truncateUtf8(text, maxContentBytes);
  return truncated + suffix;
}

function normalizePreviewFocusTerms(focusTerms: readonly string[]): readonly string[] {
  return [...new Set(focusTerms.map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 3))];
}

function findFocusIndex(text: string, focusTerms: readonly string[]): number {
  if (focusTerms.length === 0) return -1;
  const lower = text.toLowerCase();
  return focusTerms.reduce((bestIndex, term) => {
    const idx = lower.indexOf(term);
    if (idx === -1) return bestIndex;
    if (bestIndex === -1) return idx;
    return Math.min(bestIndex, idx);
  }, -1);
}

function excerptAroundFocus(text: string, maxBytes: number, focusTerms: readonly string[]): string {
  const focusIndex = findFocusIndex(text, focusTerms);
  if (focusIndex === -1) {
    const truncated = truncateUtf8(text, maxBytes);
    return truncated.length < text.length ? `${truncated}...` : truncated;
  }

  const contextChars = Math.max(80, Math.floor(maxBytes / 4));
  const start = Math.max(0, focusIndex - contextChars);
  const end = Math.min(text.length, focusIndex + contextChars * 2);
  const slice = text.slice(start, end).trim();
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  const excerpt = `${prefix}${slice}${suffix}`;
  return truncateUtf8(excerpt, maxBytes);
}

export function createBranchSummarySegment(body: string): BranchSummarySegment | null {
  const trimmed = body.trim();
  return trimmed.length === 0
    ? null
    : {
        kind: 'branch_summary',
        tier: 'structural_context',
        source: 'deterministic_structure',
        title: 'Branch Summary',
        body: trimmed,
      };
}

export function createDownstreamRecapSegment(body: string): DownstreamRecapSegment | null {
  const trimmed = body.trim();
  return trimmed.length === 0
    ? null
    : {
        kind: 'downstream_recap',
        tier: 'structural_context',
        source: 'explicit_durable_fact',
        title: 'Downstream Recap (Preferred Branch)',
        body: trimmed,
      };
}

export function createAncestryRecapSegment(body: string): AncestryRecapSegment | null {
  const trimmed = body.trim();
  return trimmed.length === 0
    ? null
    : {
        kind: 'ancestry_recap',
        tier: 'durable_recap',
        source: 'explicit_durable_fact',
        title: 'Ancestry Recap',
        body: trimmed,
      };
}

export function createFunctionDefinitionsSegment(body: string): FunctionDefinitionsSegment | null {
  const trimmed = body.trim();
  return trimmed.length === 0
    ? null
    : {
        kind: 'function_definitions',
        tier: 'reference_material',
        source: 'workflow_definition',
        title: 'Function Definitions',
        body: trimmed,
      };
}

export function createSessionTitlePreviewSegment(body: string): SessionTitlePreviewSegment | null {
  const trimmed = body.trim();
  return trimmed.length === 0
    ? null
    : {
        kind: 'session_title_preview',
        tier: 'identity_context',
        source: 'persisted_context',
        body: trimmed,
      };
}

export function createRecapPreviewSegment(body: string): RecapPreviewSegment | null {
  const trimmed = body.trim();
  return trimmed.length === 0
    ? null
    : {
        kind: 'recap_preview',
        tier: 'durable_recap',
        source: 'explicit_durable_fact',
        body: trimmed,
      };
}

export function compareRetrievalPackSegments(a: RetrievalPackSegment, b: RetrievalPackSegment): number {
  const tierDiff = getTierPriority(a.tier) - getTierPriority(b.tier);
  if (tierDiff !== 0) return tierDiff;

  const titleDiff = compareAscii(a.title, b.title);
  if (titleDiff !== 0) return titleDiff;

  return compareAscii(a.body, b.body);
}

export function orderRetrievalPackSegments(
  segments: readonly RetrievalPackSegment[],
): readonly RetrievalPackSegment[] {
  return [...segments].sort(compareRetrievalPackSegments);
}

export function renderRetrievalPackSections(
  segments: readonly RetrievalPackSegment[],
): readonly string[] {
  return orderRetrievalPackSegments(segments).map((segment) => `### ${segment.title}\n${segment.body}`);
}

function compareResumePreviewSegments(a: ResumePreviewSegment, b: ResumePreviewSegment): number {
  const tierDiff = getResumePreviewTierPriority(a.tier) - getResumePreviewTierPriority(b.tier);
  if (tierDiff !== 0) return tierDiff;
  return compareAscii(a.body, b.body);
}

export function renderBudgetedResumePreview(args: {
  readonly segments: readonly ResumePreviewSegment[];
  readonly focusTerms?: readonly string[];
}): ResumePreviewRenderResult {
  const ordered = [...args.segments].sort(compareResumePreviewSegments);
  if (ordered.length === 0) {
    return { text: '' as ResumePreviewText, includedTiers: [] };
  }

  const focusTerms = normalizePreviewFocusTerms(args.focusTerms ?? []);
  const tierTexts = ordered.map((segment) => {
    const maxBytes = getResumePreviewTierMaxBytes(segment.tier);
    return {
      tier: segment.tier,
      text: excerptAroundFocus(segment.body, maxBytes, focusTerms),
    };
  });

  const joined = tierTexts.map((entry) => entry.text).filter((text) => text.length > 0).join('\n\n');
  const finalText = truncateUtf8(joined, RESUME_PREVIEW_CONTRACT.budgetBytes) as ResumePreviewText;
  const includedTiers = [...new Set(tierTexts.filter((entry) => entry.text.length > 0).map((entry) => entry.tier))];
  return { text: finalText, includedTiers };
}

export function renderBudgetedRehydrateRecovery(args: {
  readonly header: string;
  readonly segments: readonly RetrievalPackSegment[];
}): RetrievalPackRenderResult {
  const ordered = orderRetrievalPackSegments(args.segments);
  if (ordered.length === 0) {
    return { text: '', includedTiers: [], omittedTierCount: 0, truncatedWithinTier: false };
  }

  const tiersInOrder = REHYDRATE_RETRIEVAL_CONTRACT.tiers.map((tier) => tier.tier);
  const sectionsByTier = new Map<RetrievalPackTier, readonly string[]>(
    tiersInOrder.map((tier) => [tier, ordered.filter((segment) => segment.tier === tier).map((segment) => `### ${segment.title}\n${segment.body}`)]),
  );

  const renderFromTiers = (tiers: readonly RetrievalPackTier[]): string => {
    const sections = tiers.flatMap((tier) => sectionsByTier.get(tier) ?? []);
    return sections.length === 0 ? '' : `${args.header}\n\n${sections.join('\n\n')}`;
  };

  const initiallyIncludedTiers = tiersInOrder.filter((tier) => (sectionsByTier.get(tier) ?? []).length > 0);
  let includedTiers = initiallyIncludedTiers;
  let recoveryText = renderFromTiers(includedTiers);
  // Eliminated 2 redundant `encoder.encode()` calls per loop iteration (was 3
  // total: condition + needsSuffix check + return value). Now encodes once per
  // iteration for the condition check. Recompute only after renderFromTiers.
  let recoveryBytes = encoder.encode(recoveryText).length;

  while (recoveryBytes > RECOVERY_BUDGET_BYTES) {
    const droppableTierIndex = [...includedTiers]
      .reverse()
      .findIndex((tier) => getTierRetention(tier) === 'tail');

    if (droppableTierIndex === -1) {
      break;
    }

    const actualIndex = includedTiers.length - 1 - droppableTierIndex;
    includedTiers = includedTiers.filter((_, index) => index !== actualIndex);
    recoveryText = renderFromTiers(includedTiers);
    recoveryBytes = encoder.encode(recoveryText).length;
  }

  const omittedTierCount = initiallyIncludedTiers.length - includedTiers.length;
  const needsSuffix = omittedTierCount > 0 || recoveryBytes > RECOVERY_BUDGET_BYTES || includedTiers.length === 0;
  const finalText = recoveryText.length === 0
    ? trimFinalRecoveryText(args.header, initiallyIncludedTiers.length)
    : !needsSuffix
      ? recoveryText
      : trimFinalRecoveryText(recoveryText, omittedTierCount);

  return {
    text: finalText,
    includedTiers,
    omittedTierCount,
    truncatedWithinTier: recoveryBytes > RECOVERY_BUDGET_BYTES || includedTiers.length === 0,
  };
}
