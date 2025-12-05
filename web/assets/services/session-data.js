/**
 * Workrail Session Data Utilities
 * 
 * Utilities for extracting, filtering, and manipulating session data.
 * Eliminates repeated dashboard extraction patterns from index.html.
 */

/**
 * Extract dashboard data from a session with safe defaults
 * 
 * @param {Session} session - Session object from API
 * @param {Object} defaults - Default values for missing fields
 * @returns {Dashboard} Dashboard object with all fields
 * 
 * @example
 * const dashboard = extractDashboard(session);
 * console.log(dashboard.progress);  // Always a number
 * 
 * @example
 * const dashboard = extractDashboard(session, { status: 'unknown' });
 */
export function extractDashboard(session, defaults = {}) {
  const dashboard = session?.data?.dashboard || {};
  
  return {
    status: dashboard.status || defaults.status || 'in_progress',
    progress: typeof dashboard.progress === 'number' ? dashboard.progress : (defaults.progress ?? 0),
    confidence: typeof dashboard.confidence === 'number' ? dashboard.confidence : (defaults.confidence ?? 0),
    title: dashboard.title || defaults.title || session?.id || 'Untitled Session',
    currentPhase: dashboard.currentPhase || defaults.currentPhase || '--'
  };
}

/**
 * Extract full session metadata including dashboard
 * 
 * @param {Session} session - Session object
 * @returns {Object} Extracted metadata
 * 
 * @example
 * const meta = extractSessionMetadata(session);
 * // { id, workflowId, createdAt, updatedAt, dashboard }
 */
export function extractSessionMetadata(session) {
  return {
    id: session.id,
    workflowId: session.workflowId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    url: session.url,
    dashboard: extractDashboard(session)
  };
}

/**
 * Filter sessions by status
 * 
 * @param {Session[]} sessions - Array of sessions
 * @param {string} status - Status to filter by ('in_progress', 'complete', 'failed')
 * @returns {Session[]} Filtered sessions
 * 
 * @example
 * const completed = filterByStatus(sessions, 'complete');
 * const active = filterByStatus(sessions, 'in_progress');
 */
export function filterByStatus(sessions, status) {
  return sessions.filter(session => {
    const dashboard = session?.data?.dashboard;
    return dashboard?.status === status;
  });
}

/**
 * Filter sessions by multiple statuses
 * 
 * @param {Session[]} sessions - Array of sessions
 * @param {string[]} statuses - Array of statuses to include
 * @returns {Session[]} Filtered sessions
 * 
 * @example
 * const activeOrComplete = filterByStatuses(sessions, ['in_progress', 'complete']);
 */
export function filterByStatuses(sessions, statuses) {
  const statusSet = new Set(statuses);
  return sessions.filter(session => {
    const dashboard = session?.data?.dashboard;
    return statusSet.has(dashboard?.status);
  });
}

/**
 * Count sessions by status
 * 
 * @param {Session[]} sessions - Array of sessions
 * @returns {Object} Count of sessions by status
 * 
 * @example
 * const counts = countByStatus(sessions);
 * // { in_progress: 3, complete: 5, failed: 1, total: 9 }
 */
export function countByStatus(sessions) {
  const counts = {
    in_progress: 0,
    complete: 0,
    failed: 0,
    other: 0,
    total: sessions.length
  };
  
  sessions.forEach(session => {
    const status = session?.data?.dashboard?.status;
    if (counts.hasOwnProperty(status)) {
      counts[status]++;
    } else {
      counts.other++;
    }
  });
  
  return counts;
}

/**
 * Group sessions by workflow ID
 * 
 * @param {Session[]} sessions - Array of sessions
 * @returns {Object} Sessions grouped by workflow ID
 * 
 * @example
 * const grouped = groupByWorkflow(sessions);
 * // {
 * //   'bug-investigation': [session1, session2],
 * //   'mr-review': [session3]
 * // }
 */
export function groupByWorkflow(sessions) {
  return sessions.reduce((groups, session) => {
    const workflowId = session.workflowId || 'unknown';
    if (!groups[workflowId]) {
      groups[workflowId] = [];
    }
    groups[workflowId].push(session);
    return groups;
  }, {});
}

/**
 * Sort sessions by updated timestamp
 * 
 * @param {Session[]} sessions - Array of sessions
 * @param {boolean|string} order - Sort order: true/'desc' for descending (newest first), false/'asc' for ascending
 * @returns {Session[]} Sorted sessions (new array)
 * 
 * @example
 * const newest = sortByUpdatedAt(sessions, true);   // Newest first
 * const newest2 = sortByUpdatedAt(sessions, 'desc'); // Newest first
 * const oldest = sortByUpdatedAt(sessions, false);  // Oldest first
 * const oldest2 = sortByUpdatedAt(sessions, 'asc'); // Oldest first
 */
export function sortByUpdatedAt(sessions, order = true) {
  const desc = order === true || order === 'desc';
  return [...sessions].sort((a, b) => {
    const dateA = new Date(a.updatedAt).getTime();
    const dateB = new Date(b.updatedAt).getTime();
    return desc ? dateB - dateA : dateA - dateB;
  });
}

/**
 * Sort sessions by progress
 * 
 * @param {Session[]} sessions - Array of sessions
 * @param {boolean} desc - Sort descending (highest progress first)
 * @returns {Session[]} Sorted sessions (new array)
 * 
 * @example
 * const mostProgress = sortByProgress(sessions, true);
 */
export function sortByProgress(sessions, desc = true) {
  return [...sessions].sort((a, b) => {
    const progressA = a?.data?.dashboard?.progress ?? 0;
    const progressB = b?.data?.dashboard?.progress ?? 0;
    return desc ? progressB - progressA : progressA - progressB;
  });
}

/**
 * Sort sessions by confidence
 * 
 * @param {Session[]} sessions - Array of sessions
 * @param {boolean} desc - Sort descending (highest confidence first)
 * @returns {Session[]} Sorted sessions (new array)
 * 
 * @example
 * const mostConfident = sortByConfidence(sessions, true);
 */
export function sortByConfidence(sessions, desc = true) {
  return [...sessions].sort((a, b) => {
    const confidenceA = a?.data?.dashboard?.confidence ?? 0;
    const confidenceB = b?.data?.dashboard?.confidence ?? 0;
    return desc ? confidenceB - confidenceA : confidenceA - confidenceB;
  });
}

/**
 * Get active (in_progress) sessions
 * 
 * @param {Session[]} sessions - Array of sessions
 * @returns {Session[]} Active sessions
 * 
 * @example
 * const active = getActiveSessions(sessions);
 */
export function getActiveSessions(sessions) {
  return filterByStatus(sessions, 'in_progress');
}

/**
 * Get completed sessions
 * 
 * @param {Session[]} sessions - Array of sessions
 * @returns {Session[]} Completed sessions
 * 
 * @example
 * const completed = getCompletedSessions(sessions);
 */
export function getCompletedSessions(sessions) {
  return filterByStatus(sessions, 'complete');
}

/**
 * Get failed sessions
 * 
 * @param {Session[]} sessions - Array of sessions
 * @returns {Session[]} Failed sessions
 * 
 * @example
 * const failed = getFailedSessions(sessions);
 */
export function getFailedSessions(sessions) {
  return filterByStatus(sessions, 'failed');
}

/**
 * Calculate aggregate statistics from sessions
 * 
 * @param {Session[]} sessions - Array of sessions
 * @returns {Object} Statistics object
 * 
 * @example
 * const stats = calculateStats(sessions);
 * // {
 * //   total: 10,
 * //   active: 3,
 * //   complete: 6,
 * //   failed: 1,
 * //   avgProgress: 65.5,
 * //   avgConfidence: 7.2
 * // }
 */
export function calculateStats(sessions) {
  const counts = countByStatus(sessions);
  
  let totalProgress = 0;
  let totalConfidence = 0;
  let progressCount = 0;
  let confidenceCount = 0;
  
  sessions.forEach(session => {
    const dashboard = session?.data?.dashboard;
    if (dashboard) {
      if (typeof dashboard.progress === 'number') {
        totalProgress += dashboard.progress;
        progressCount++;
      }
      if (typeof dashboard.confidence === 'number') {
        totalConfidence += dashboard.confidence;
        confidenceCount++;
      }
    }
  });
  
  return {
    total: sessions.length,
    active: counts.in_progress,
    complete: counts.complete,
    failed: counts.failed,
    other: counts.other,
    avgProgress: progressCount > 0 ? parseFloat((totalProgress / progressCount).toFixed(2)) : 0,
    avgConfidence: confidenceCount > 0 ? parseFloat((totalConfidence / confidenceCount).toFixed(2)) : 0
  };
}

/**
 * Find sessions matching a search query
 * Searches in: id, title, workflow ID
 * 
 * @param {Session[]} sessions - Array of sessions
 * @param {string} query - Search query (case-insensitive)
 * @returns {Session[]} Matching sessions
 * 
 * @example
 * const results = searchSessions(sessions, 'ticket-123');
 * const bugs = searchSessions(sessions, 'bug');
 */
export function searchSessions(sessions, query) {
  if (!query || query.trim() === '') return sessions;
  
  const lowerQuery = query.toLowerCase();
  
  return sessions.filter(session => {
    const id = (session.id || '').toLowerCase();
    const workflowId = (session.workflowId || '').toLowerCase();
    const title = (session.data?.dashboard?.title || '').toLowerCase();
    
    return id.includes(lowerQuery) || 
           workflowId.includes(lowerQuery) || 
           title.includes(lowerQuery);
  });
}

/**
 * Check if a session is stale (not updated recently)
 * 
 * @param {Session} session - Session object
 * @param {number} thresholdMs - Threshold in milliseconds (default: 1 hour)
 * @returns {boolean} True if session is stale
 * 
 * @example
 * const isStale = isSessionStale(session);  // Default 1 hour
 * const isOld = isSessionStale(session, 24 * 60 * 60 * 1000);  // 24 hours
 */
export function isSessionStale(session, thresholdMs = 60 * 60 * 1000) {
  if (!session.updatedAt) return false;
  
  const updatedAt = new Date(session.updatedAt).getTime();
  const now = Date.now();
  
  return (now - updatedAt) > thresholdMs;
}

/**
 * Get recent sessions (updated within timeframe)
 * 
 * @param {Session[]} sessions - Array of sessions
 * @param {number} timeframeMs - Timeframe in milliseconds (default: 1 hour)
 * @returns {Session[]} Recent sessions
 * 
 * @example
 * const recent = getRecentSessions(sessions);  // Last hour
 * const today = getRecentSessions(sessions, 24 * 60 * 60 * 1000);  // Last 24 hours
 */
export function getRecentSessions(sessions, timeframeMs = 60 * 60 * 1000) {
  return sessions.filter(session => !isSessionStale(session, timeframeMs));
}

