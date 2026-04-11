import { describe, expect, it } from 'vitest';
import { MAX_RESUME_PREVIEW_BYTES } from '../../../src/v2/durable-core/constants.js';
import {
  REHYDRATE_RETRIEVAL_CONTRACT,
  RESUME_PREVIEW_CONTRACT,
  compareRetrievalPackSegments,
  createAncestryRecapSegment,
  createBranchSummarySegment,
  createDownstreamRecapSegment,
  createFunctionDefinitionsSegment,
  createRecapPreviewSegment,
  createSessionTitlePreviewSegment,
  orderRetrievalPackSegments,
  renderBudgetedRehydrateRecovery,
  renderBudgetedResumePreview,
  renderRetrievalPackSections,
  type RetrievalPackSegment,
} from '../../../src/v2/durable-core/domain/retrieval-contract.js';

describe('retrieval-contract', () => {
  it('defines an explicit rehydrate retrieval contract', () => {
    expect(REHYDRATE_RETRIEVAL_CONTRACT.surface).toBe('rehydrate');
    expect(REHYDRATE_RETRIEVAL_CONTRACT.tiers.map((tier) => tier.tier)).toEqual([
      'structural_context',
      'durable_recap',
      'reference_material',
    ]);
    expect(REHYDRATE_RETRIEVAL_CONTRACT.truncation).toEqual({
      mode: 'drop_lower_tiers_then_global_utf8_trim',
      budgetScope: 'shared_recovery_prompt',
      antiReconstructionRule: 'select_order_and_compress_explicit_facts_only',
    });
  });

  it('uses the contract as the runtime tier ordering source', () => {
    expect(REHYDRATE_RETRIEVAL_CONTRACT.tiers.map((tier) => [tier.tier, tier.priority])).toEqual([
      ['structural_context', 0],
      ['durable_recap', 1],
      ['reference_material', 2],
    ]);
    expect(REHYDRATE_RETRIEVAL_CONTRACT.tiers.map((tier) => [tier.tier, tier.retention])).toEqual([
      ['structural_context', 'core'],
      ['durable_recap', 'core'],
      ['reference_material', 'tail'],
    ]);
    expect(RESUME_PREVIEW_CONTRACT.budgetBytes).toBe(MAX_RESUME_PREVIEW_BYTES);
  });

  it('drops empty segments instead of manufacturing placeholder content', () => {
    expect(createAncestryRecapSegment('   ')).toBeNull();
  });

  it('creates typed segments with explicit titles and allowed sources', () => {
    expect(createFunctionDefinitionsSegment('```ts\nconst fn = 1;\n```')).toEqual({
      kind: 'function_definitions',
      tier: 'reference_material',
      source: 'workflow_definition',
      title: 'Function Definitions',
      body: '```ts\nconst fn = 1;\n```',
    });
  });

  it('orders segments deterministically by tier and segment kind priority', () => {
    const segments: readonly RetrievalPackSegment[] = [
      createFunctionDefinitionsSegment('```txt\nfn\n```')!,
      createAncestryRecapSegment('Prior notes')!,
      createDownstreamRecapSegment('Preferred branch notes')!,
      createBranchSummarySegment('This node has 2 children.')!,
    ];

    expect(orderRetrievalPackSegments(segments).map((segment) => segment.kind)).toEqual([
      'branch_summary',
      'downstream_recap',
      'ancestry_recap',
      'function_definitions',
    ]);
  });

  it('uses lexical fallback for otherwise identical segments', () => {
    const a = createAncestryRecapSegment('A')!;
    const b = createAncestryRecapSegment('B')!;

    expect(compareRetrievalPackSegments(a, b)).toBeLessThan(0);
    expect(compareRetrievalPackSegments(b, a)).toBeGreaterThan(0);
  });

  it('renders ordered markdown sections without changing the segment bodies', () => {
    const rendered = renderRetrievalPackSections([
      createFunctionDefinitionsSegment('```txt\nfn\n```')!,
      createBranchSummarySegment('This node has 1 child.')!,
    ]);

    expect(rendered).toEqual([
      '### Branch Summary\nThis node has 1 child.',
      '### Function Definitions\n```txt\nfn\n```',
    ]);
  });

  it('drops lower-priority tail tiers before trimming within core recovery tiers', () => {
    const result = renderBudgetedRehydrateRecovery({
      header: '## Recovery Context',
      segments: [
        createBranchSummarySegment('Stable orientation context')!,
        createAncestryRecapSegment('A'.repeat(26000))!,
        createFunctionDefinitionsSegment('```txt\n' + 'B'.repeat(16000) + '\n```')!,
      ],
    });

    expect(result.includedTiers).toEqual(['structural_context', 'durable_recap']);
    expect(result.omittedTierCount).toBe(1);
    expect(result.text).toContain('### Branch Summary');
    expect(result.text).toContain('### Ancestry Recap');
    expect(result.text).not.toContain('### Function Definitions');
    expect(result.text).toContain('[TRUNCATED]');
    expect(result.truncatedWithinTier).toBe(true);
  });

  it('keeps all rehydrate tiers when the larger budget can accommodate them', () => {
    const result = renderBudgetedRehydrateRecovery({
      header: '## Recovery Context',
      segments: [
        createBranchSummarySegment('Stable orientation context')!,
        createAncestryRecapSegment('A'.repeat(6000))!,
        createFunctionDefinitionsSegment('```txt\n' + 'B'.repeat(2500) + '\n```')!,
      ],
    });

    expect(result.includedTiers).toEqual(['structural_context', 'durable_recap', 'reference_material']);
    expect(result.omittedTierCount).toBe(0);
    expect(result.text).toContain('### Function Definitions');
  });

  it('compareRetrievalPackSegments returns correct ordering for all tier pairs (Record lookup)', () => {
    // Verifies the Record<tier, priority> lookup returns the same values as the
    // previous Array.find implementation for all possible tier pairs.
    const structural = createBranchSummarySegment('x')!;
    const durable = createAncestryRecapSegment('x')!;
    const reference = createFunctionDefinitionsSegment('x')!;

    // structural (0) < durable (1): negative diff
    expect(compareRetrievalPackSegments(structural, durable)).toBeLessThan(0);
    // durable (1) < reference (2): negative diff
    expect(compareRetrievalPackSegments(durable, reference)).toBeLessThan(0);
    // structural (0) < reference (2): negative diff
    expect(compareRetrievalPackSegments(structural, reference)).toBeLessThan(0);
    // same tier, same body: 0 (after title sort)
    expect(compareRetrievalPackSegments(structural, createBranchSummarySegment('x')!)).toBe(0);
  });

  it('renderBudgetedRehydrateRecovery correctly drops tail tiers under repeated budget checks (encoder caching)', () => {
    // This exercises the encoder.encode caching path: the while loop in
    // renderBudgetedRehydrateRecovery must re-check bytes after each tier drop.
    // If caching is incorrect (stale bytes), the wrong tiers may be included.
    // We verify correctness, not timing.
    const largeBody = 'X'.repeat(15000);
    const result = renderBudgetedRehydrateRecovery({
      header: '## Recovery',
      segments: [
        createBranchSummarySegment('Orientation')!,
        createAncestryRecapSegment(largeBody)!,
        createFunctionDefinitionsSegment(largeBody)!,
      ],
    });
    // reference_material (tail) should be dropped first to fit budget
    expect(result.omittedTierCount).toBeGreaterThanOrEqual(1);
    expect(result.includedTiers).not.toContain('reference_material');
    expect(result.includedTiers).toContain('structural_context');
  });

  it('keeps both identity context and recap in larger resume previews', () => {
    const result = renderBudgetedResumePreview({
      segments: [
        createSessionTitlePreviewSegment('Task dev for MR ownership and budget redesign')!,
        createRecapPreviewSegment('ownership-aware resume previews ' + 'A'.repeat(1700))!,
      ],
    });

    const bytes = new TextEncoder().encode(result.text);
    expect(result.includedTiers).toEqual(['identity_context', 'durable_recap']);
    expect(bytes.length).toBeLessThanOrEqual(MAX_RESUME_PREVIEW_BYTES);
    expect(result.text).toContain('Task dev for MR ownership');
    expect(result.text.toLowerCase()).toContain('ownership-aware');
  });
});
