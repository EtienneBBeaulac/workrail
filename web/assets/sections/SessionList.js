/**
 * SessionList Section
 * 
 * Reusable section component for displaying a list of sessions.
 * Uses formatters for display and session-data utilities for manipulation.
 * 
 * Pattern: Returns { element, update, destroy } for easy lifecycle management.
 */

import * as fmt from '../utils/formatters.js';
import * as sessionData from '../services/session-data.js';

/**
 * Create a SessionList section
 * 
 * @param {Object} config - Configuration options
 * @param {boolean} config.showAll - Show all sessions or only active (default: true)
 * @param {string} config.sortBy - Sort method: 'time', 'progress', 'confidence' (default: 'time')
 * @param {boolean} config.sortDesc - Sort descending (default: true)
 * @param {Function} config.onSessionClick - Callback when session is clicked
 * @param {Function} config.onSessionDelete - Callback when session is deleted
 * @param {string} config.emptyMessage - Custom empty state message
 * @returns {Object} { element, update, destroy }
 * 
 * @example
 * const sessionList = SessionList({
 *   showAll: false,  // Only active sessions
 *   sortBy: 'time',
 *   onSessionClick: (session) => console.log('Clicked:', session.id)
 * });
 * 
 * document.body.appendChild(sessionList.element);
 * sessionList.update(sessions);
 */
export function SessionList(config = {}) {
  const {
    showAll = true,
    sortBy = 'time',
    sortDesc = true,
    onSessionClick = null,
    onSessionDelete = null,
    emptyMessage = null
  } = config;
  
  // Create container element
  const element = document.createElement('div');
  element.className = 'session-list';
  
  // Store current sessions for reference
  let currentSessions = [];
  
  /**
   * Update the session list with new data
   * 
   * @param {Session[]} sessions - Array of session objects
   */
  function update(sessions) {
    currentSessions = sessions;
    render();
  }
  
  /**
   * Render the session list
   * @private
   */
  function render() {
    // Filter sessions if needed
    let filteredSessions = showAll 
      ? currentSessions 
      : sessionData.getActiveSessions(currentSessions);
    
    // Sort sessions
    switch (sortBy) {
      case 'progress':
        filteredSessions = sessionData.sortByProgress(filteredSessions, sortDesc);
        break;
      case 'confidence':
        filteredSessions = sessionData.sortByConfidence(filteredSessions, sortDesc);
        break;
      case 'time':
      default:
        filteredSessions = sessionData.sortByUpdatedAt(filteredSessions, sortDesc);
        break;
    }
    
    // Handle empty state
    if (filteredSessions.length === 0) {
      element.innerHTML = renderEmptyState();
      return;
    }
    
    // Render session cards
    element.innerHTML = filteredSessions
      .map(session => renderSessionCard(session))
      .join('');
    
    // Attach event listeners
    attachEventListeners();
  }
  
  /**
   * Render empty state
   * @private
   */
  function renderEmptyState() {
    const message = emptyMessage || (showAll 
      ? 'No sessions yet. Start a workflow to see sessions here.'
      : 'No active sessions. All sessions are complete or failed.');
    
    return `
      <div class="session-list-empty">
        <div class="empty-icon">📭</div>
        <div class="empty-message">${fmt.escapeHtml(message)}</div>
      </div>
    `;
  }
  
  /**
   * Render a single session card
   * @private
   */
  function renderSessionCard(session) {
    const dashboard = sessionData.extractDashboard(session);
    const meta = sessionData.extractSessionMetadata(session);
    
    return `
      <div class="session-card" 
           data-session-id="${fmt.escapeHtml(session.id)}"
           data-workflow-id="${fmt.escapeHtml(session.workflowId)}">
        
        <!-- Menu Button -->
        <button class="session-menu-btn"
                data-session-id="${fmt.escapeHtml(session.id)}"
                data-workflow-id="${fmt.escapeHtml(session.workflowId)}"
                title="Session options"
                aria-label="Session options">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="1"/>
            <circle cx="12" cy="5" r="1"/>
            <circle cx="12" cy="19" r="1"/>
          </svg>
        </button>
        
        <!-- Card Header -->
        <div class="session-header">
          <div class="session-id">${fmt.escapeHtml(session.id)}</div>
          <div class="session-status ${fmt.getStatusClass(dashboard.status)}">
            ${fmt.formatStatus(dashboard.status)}
          </div>
        </div>
        
        <!-- Card Title -->
        <div class="session-title">${fmt.escapeHtml(dashboard.title)}</div>
        
        <!-- Card Metadata -->
        <div class="session-meta">
          <div class="meta-item">
            <div class="meta-label">Progress</div>
            <div class="meta-value">${fmt.formatProgress(dashboard.progress)}</div>
          </div>
          
          <div class="meta-item">
            <div class="meta-label">Confidence</div>
            <div class="meta-value">${fmt.formatConfidence(dashboard.confidence)}</div>
            <div class="confidence-bar">
              <div class="confidence-fill" 
                   style="width: ${fmt.confidenceToPercent(dashboard.confidence)}%">
              </div>
            </div>
          </div>
          
          <div class="meta-item">
            <div class="meta-label">Current Phase</div>
            <div class="meta-value">${fmt.escapeHtml(dashboard.currentPhase)}</div>
          </div>
          
          <div class="meta-item">
            <div class="meta-label">Updated</div>
            <div class="meta-value" title="${fmt.formatDateTime(meta.updatedAt)}">
              ${fmt.formatTime(meta.updatedAt)}
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Attach event listeners to rendered elements
   * @private
   */
  function attachEventListeners() {
    // Card click handlers
    const cards = element.querySelectorAll('.session-card');
    cards.forEach(card => {
      card.addEventListener('click', handleCardClick);
    });
    
    // Menu button handlers
    const menuButtons = element.querySelectorAll('.session-menu-btn');
    menuButtons.forEach(button => {
      button.addEventListener('click', handleMenuClick);
    });
  }
  
  /**
   * Handle session card click
   * @private
   */
  function handleCardClick(event) {
    // Don't trigger if clicking menu button
    if (event.target.closest('.session-menu-btn')) {
      return;
    }
    
    const card = event.currentTarget;
    const sessionId = card.dataset.sessionId;
    const workflowId = card.dataset.workflowId;
    
    if (onSessionClick) {
      const session = currentSessions.find(s => s.id === sessionId);
      onSessionClick(session, workflowId, sessionId);
    } else {
      // Default behavior: navigate to dashboard
      navigateToSession(workflowId, sessionId);
    }
  }
  
  /**
   * Handle menu button click
   * @private
   */
  function handleMenuClick(event) {
    event.stopPropagation();
    
    const button = event.currentTarget;
    const sessionId = button.dataset.sessionId;
    const workflowId = button.dataset.workflowId;
    
    // TODO: Show menu dropdown
    // For now, just trigger delete callback if available
    if (onSessionDelete) {
      const session = currentSessions.find(s => s.id === sessionId);
      onSessionDelete(session, workflowId, sessionId);
    } else {
      console.log('Menu clicked for:', sessionId);
    }
  }
  
  /**
   * Navigate to session dashboard
   * @private
   */
  function navigateToSession(workflowId, sessionId) {
    // Handle known workflows
    if (workflowId === 'bug-investigation' || 
        workflowId === 'systematic-bug-investigation-with-loops') {
      window.location.href = `/workflows/bug-investigation/dashboard-v3.html?workflow=${encodeURIComponent(workflowId)}&id=${encodeURIComponent(sessionId)}`;
    } else {
      // Default: show alert for unimplemented dashboards
      alert(`Dashboard for workflow "${workflowId}" not yet implemented.\nSession: ${sessionId}`);
    }
  }
  
  /**
   * Cleanup function to remove event listeners
   */
  function destroy() {
    // Remove event listeners
    const cards = element.querySelectorAll('.session-card');
    cards.forEach(card => {
      card.removeEventListener('click', handleCardClick);
    });
    
    const menuButtons = element.querySelectorAll('.session-menu-btn');
    menuButtons.forEach(button => {
      button.removeEventListener('click', handleMenuClick);
    });
    
    // Clear content
    element.innerHTML = '';
  }
  
  // Initial render (empty)
  render();
  
  // Return public API
  return {
    element,
    update,
    destroy
  };
}

/**
 * Create a SessionGrid section with grid layout
 * Wrapper around SessionList with grid-specific styling
 * 
 * @param {Object} config - Same as SessionList config
 * @returns {Object} { element, update, destroy }
 * 
 * @example
 * const grid = SessionGrid({ showAll: true });
 * document.body.appendChild(grid.element);
 */
export function SessionGrid(config = {}) {
  const sessionList = SessionList(config);
  sessionList.element.classList.add('session-grid');
  return sessionList;
}

/**
 * Create a compact SessionList for sidebars
 * Shows minimal information per session
 * 
 * @param {Object} config - SessionList config
 * @returns {Object} { element, update, destroy }
 * 
 * @example
 * const compact = CompactSessionList({ showAll: false });
 */
export function CompactSessionList(config = {}) {
  const sessionList = SessionList(config);
  sessionList.element.classList.add('session-list-compact');
  return sessionList;
}

