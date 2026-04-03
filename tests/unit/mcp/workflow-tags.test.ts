import { describe, it, expect } from 'vitest';
import { buildTagSummary } from '../../../src/mcp/handlers/v2-workflow.js';

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
});
