/**
 * Tests for formatters utility functions
 */

import { describe, it, expect } from 'vitest';
import {
  formatTime,
  formatDateTime,
  formatProgress,
  formatConfidence,
  confidenceToPercent,
  formatStatus,
  getStatusClass,
  escapeHtml,
  truncate,
  formatDuration,
  pluralize
} from '../formatters.js';

describe('Time Formatters', () => {
  it('formats time correctly', () => {
    const date = new Date('2025-10-03T14:30:00');
    const result = formatTime(date.getTime());
    expect(result).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
  });

  it('formats datetime correctly', () => {
    const date = new Date('2025-10-03T14:30:00');
    const result = formatDateTime(date.getTime());
    expect(result).toContain('2025');
    expect(result).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
  });

  it('formats duration correctly', () => {
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3665)).toBe('1h 1m');
  });
});

describe('Progress Formatters', () => {
  it('formats progress as percentage', () => {
    expect(formatProgress(0)).toBe('0%');
    expect(formatProgress(50)).toBe('50%');
    expect(formatProgress(100)).toBe('100%');
  });

  it('handles decimal progress', () => {
    expect(formatProgress(33.33)).toBe('33%');
    expect(formatProgress(66.67)).toBe('67%');
  });

  it('formats confidence correctly', () => {
    expect(formatConfidence(0)).toBe('0.0/10');
    expect(formatConfidence(5.5)).toBe('5.5/10');
    expect(formatConfidence(10)).toBe('10.0/10');
  });

  it('converts confidence to percentage', () => {
    expect(confidenceToPercent(0)).toBe(0);
    expect(confidenceToPercent(5)).toBe(50);
    expect(confidenceToPercent(10)).toBe(100);
  });
});

describe('Status Formatters', () => {
  it('formats status with capitalization', () => {
    expect(formatStatus('in_progress')).toBe('In Progress');
    expect(formatStatus('complete')).toBe('Complete');
    expect(formatStatus('failed')).toBe('Failed');
  });

  it('returns correct status classes', () => {
    expect(getStatusClass('in_progress')).toBe('status-in_progress');
    expect(getStatusClass('complete')).toBe('status-complete');
    expect(getStatusClass('failed')).toBe('status-failed');
  });
});

describe('String Utilities', () => {
  it('escapes HTML correctly', () => {
    expect(escapeHtml('<script>alert("xss")</script>'))
      .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml('Safe text')).toBe('Safe text');
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('truncates text correctly', () => {
    expect(truncate('Short', 10)).toBe('Short');
    expect(truncate('This is a long text', 10)).toBe('This is...');
    expect(truncate('Exactly ten', 11)).toBe('Exactly ten');
  });

  it('pluralizes correctly', () => {
    expect(pluralize(0, 'item', 'items')).toBe('0 items');
    expect(pluralize(1, 'item', 'items')).toBe('1 item');
    expect(pluralize(5, 'item', 'items')).toBe('5 items');
  });
});

