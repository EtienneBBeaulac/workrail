import { describe, it, expect } from 'vitest';
import { buildTagSummary, buildVirtualSourceTags } from '../../../src/mcp/handlers/v2-workflow.js';

const SAMPLE_TAGS_FILE = {
  tags: [
    { id: 'coding', displayName: 'Coding', when: ['implementing a feature'], examples: ['coding-task'] },
    { id: 'review_audit', displayName: 'Review & Audit', when: ['reviewing an MR'], examples: ['mr-review'] },
    { id: 'tickets', displayName: 'Tickets', when: ['creating a ticket'], examples: ['ticket-creation'] },
  ],
  workflows: {
    'coding-task': { tags: ['coding'] },
    'mr-review': { tags: ['review_audit'] },
    'ticket-creation': { tags: ['tickets'] },
    'test-gen': { tags: ['tickets', 'coding'] }, // multi-tag
    'hidden-test': { tags: ['coding'], hidden: true },
  },
} as const;

describe('buildTagSummary', () => {
  it('counts workflows per tag', () => {
    const summary = buildTagSummary(SAMPLE_TAGS_FILE, ['coding-task', 'mr-review', 'ticket-creation', 'test-gen', 'hidden-test']);
    const coding = summary.find((t) => t.id === 'coding')!;
    const tickets = summary.find((t) => t.id === 'tickets')!;

    // coding-task + test-gen = 2 (hidden-test excluded)
    expect(coding.count).toBe(2);
    // ticket-creation + test-gen = 2
    expect(tickets.count).toBe(2);
  });

  it('excludes hidden workflows from count', () => {
    const summary = buildTagSummary(SAMPLE_TAGS_FILE, ['hidden-test']);
    const coding = summary.find((t) => t.id === 'coding')!;
    expect(coding.count).toBe(0);
  });

  it('only counts workflows present in compiledWorkflowIds', () => {
    const summary = buildTagSummary(SAMPLE_TAGS_FILE, ['coding-task']); // mr-review not in list
    const review = summary.find((t) => t.id === 'review_audit')!;
    expect(review.count).toBe(0);
  });

  it('returns when and examples from tag definitions', () => {
    const summary = buildTagSummary(SAMPLE_TAGS_FILE, []);
    const coding = summary.find((t) => t.id === 'coding')!;
    expect(coding.when).toEqual(['implementing a feature']);
    expect(coding.examples).toEqual(['coding-task']);
  });

  it('appends virtual source tags for unregistered namespaced workflow IDs', () => {
    const ids = ['coding-task', 'mercury-android.clickstream-impl', 'mercury-android.telemetry-impl', 'mercury-ios.clickstream-impl'];
    const summary = buildTagSummary(SAMPLE_TAGS_FILE, ids);
    const androidTag = summary.find((t) => t.id === 'mercury-android');
    const iosTag = summary.find((t) => t.id === 'mercury-ios');
    expect(androidTag).toBeDefined();
    expect(androidTag!.count).toBe(2);
    expect(androidTag!.displayName).toBe('Mercury Android');
    expect(androidTag!.examples).toEqual(['mercury-android.clickstream-impl', 'mercury-android.telemetry-impl']);
    expect(iosTag).toBeDefined();
    expect(iosTag!.count).toBe(1);
    expect(iosTag!.displayName).toBe('Mercury iOS');
  });

  it('does not create virtual tags for already-registered namespaced IDs', () => {
    // wr.discovery is registered in SAMPLE_TAGS_FILE if we add it, but here we verify
    // that an ID present in tagsFile.workflows is not double-counted as a virtual tag.
    const tagsFileWithNs = {
      ...SAMPLE_TAGS_FILE,
      workflows: { ...SAMPLE_TAGS_FILE.workflows, 'acme.my-workflow': { tags: ['coding'] as const } },
    };
    const summary = buildTagSummary(tagsFileWithNs, ['acme.my-workflow']);
    expect(summary.find((t) => t.id === 'acme')).toBeUndefined();
  });

  it('virtual source tags come after bundled functional tags', () => {
    const ids = ['coding-task', 'acme.workflow-one'];
    const summary = buildTagSummary(SAMPLE_TAGS_FILE, ids);
    const bundledIdx = summary.findIndex((t) => t.id === 'coding');
    const virtualIdx = summary.findIndex((t) => t.id === 'acme');
    expect(bundledIdx).toBeGreaterThanOrEqual(0);
    expect(virtualIdx).toBeGreaterThan(bundledIdx);
  });
});

describe('buildVirtualSourceTags', () => {
  it('groups unregistered namespaced IDs by namespace prefix', () => {
    const ids = ['mercury-android.workflow-a', 'mercury-android.workflow-b', 'mercury-ios.workflow-c', 'non-namespaced'];
    const tags = buildVirtualSourceTags(SAMPLE_TAGS_FILE, ids);
    expect(tags).toHaveLength(2);
    const android = tags.find((t) => t.id === 'mercury-android')!;
    expect(android.count).toBe(2);
    expect(android.examples).toEqual(['mercury-android.workflow-a', 'mercury-android.workflow-b']);
  });

  it('caps examples at 3', () => {
    const ids = ['acme.a', 'acme.b', 'acme.c', 'acme.d'];
    const tags = buildVirtualSourceTags(SAMPLE_TAGS_FILE, ids);
    expect(tags[0]!.examples).toHaveLength(3);
  });

  it('skips IDs without a dot', () => {
    const tags = buildVirtualSourceTags(SAMPLE_TAGS_FILE, ['no-dot-here']);
    expect(tags).toHaveLength(0);
  });

  it('applies acronym-aware title casing', () => {
    const tags = buildVirtualSourceTags(SAMPLE_TAGS_FILE, ['mercury-ios.some-workflow']);
    expect(tags[0]!.displayName).toBe('Mercury iOS');
  });
});
