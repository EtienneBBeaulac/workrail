/**
 * Tests for session-data utility functions
 */

import { describe, it, expect } from 'vitest';
import {
  extractDashboard,
  filterByStatus,
  countByStatus,
  getActiveSessions,
  getCompletedSessions,
  sortByUpdatedAt,
  calculateStats
} from '../session-data.js';

describe('Session Data Extraction', () => {
  const mockSession = {
    id: 'TEST-001',
    workflowId: 'test-workflow',
    data: {
      dashboard: {
        status: 'in_progress',
        progress: 50,
        confidence: 7.5,
        title: 'Test Session',
        currentPhase: 'Phase 1'
      }
    },
    updatedAt: '2025-10-03T14:30:00Z'
  };

  it('extracts dashboard data correctly', () => {
    const dashboard = extractDashboard(mockSession);
    expect(dashboard.status).toBe('in_progress');
    expect(dashboard.progress).toBe(50);
    expect(dashboard.confidence).toBe(7.5);
  });

  it('returns default values for missing dashboard', () => {
    const dashboard = extractDashboard({ id: 'TEST' });
    expect(dashboard.status).toBe('in_progress');
    expect(dashboard.progress).toBe(0);
    expect(dashboard.confidence).toBe(0);
  });
});

describe('Session Filtering', () => {
  const sessions = [
    {
      id: 'S1',
      data: { dashboard: { status: 'in_progress' } }
    },
    {
      id: 'S2',
      data: { dashboard: { status: 'complete' } }
    },
    {
      id: 'S3',
      data: { dashboard: { status: 'in_progress' } }
    }
  ];

  it('filters by status', () => {
    const inProgress = filterByStatus(sessions, 'in_progress');
    expect(inProgress).toHaveLength(2);
    expect(inProgress[0].id).toBe('S1');
  });

  it('counts by status', () => {
    const counts = countByStatus(sessions);
    expect(counts.in_progress).toBe(2);
    expect(counts.complete).toBe(1);
  });

  it('gets active sessions', () => {
    const active = getActiveSessions(sessions);
    expect(active).toHaveLength(2);
  });

  it('gets completed sessions', () => {
    const completed = getCompletedSessions(sessions);
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe('S2');
  });
});

describe('Session Sorting', () => {
  const sessions = [
    {
      id: 'S1',
      updatedAt: '2025-10-03T10:00:00Z',
      data: { dashboard: { progress: 25 } }
    },
    {
      id: 'S2',
      updatedAt: '2025-10-03T12:00:00Z',
      data: { dashboard: { progress: 75 } }
    },
    {
      id: 'S3',
      updatedAt: '2025-10-03T11:00:00Z',
      data: { dashboard: { progress: 50 } }
    }
  ];

  it('sorts by updated time descending', () => {
    const sorted = sortByUpdatedAt(sessions, 'desc');
    expect(sorted[0].id).toBe('S2');
    expect(sorted[2].id).toBe('S1');
  });

  it('sorts by updated time ascending', () => {
    const sorted = sortByUpdatedAt(sessions, 'asc');
    expect(sorted[0].id).toBe('S1');
    expect(sorted[2].id).toBe('S2');
  });
});

describe('Session Statistics', () => {
  const sessions = [
    {
      id: 'S1',
      data: {
        dashboard: {
          status: 'in_progress',
          progress: 30,
          confidence: 6.0
        }
      }
    },
    {
      id: 'S2',
      data: {
        dashboard: {
          status: 'complete',
          progress: 100,
          confidence: 9.5
        }
      }
    },
    {
      id: 'S3',
      data: {
        dashboard: {
          status: 'in_progress',
          progress: 60,
          confidence: 7.5
        }
      }
    }
  ];

  it('calculates statistics correctly', () => {
    const stats = calculateStats(sessions);
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(2);
    expect(stats.complete).toBe(1);
    expect(stats.avgProgress).toBeCloseTo(63.33, 1);
    expect(stats.avgConfidence).toBeCloseTo(7.67, 1);
  });

  it('handles empty sessions', () => {
    const stats = calculateStats([]);
    expect(stats.total).toBe(0);
    expect(stats.avgProgress).toBe(0);
  });
});

