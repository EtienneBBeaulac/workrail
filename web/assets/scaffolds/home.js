/**
 * Home Page Scaffold
 * 
 * Composes sections into the complete home page experience.
 * Handles data fetching, polling, and page lifecycle.
 */

import { SessionGrid } from '../sections/index.js';
import * as api from '../services/api.js';
import * as polling from '../services/polling.js';
import * as fmt from '../utils/formatters.js';

/**
 * Create the home page scaffold
 * 
 * @param {Object} config - Configuration options
 * @param {number} config.pollInterval - Polling interval in ms (default: 5000)
 * @param {boolean} config.autoStart - Auto-start polling (default: true)
 * @returns {Object} { element, start, stop, destroy }
 */
export function HomePage(config = {}) {
  const {
    pollInterval = 5000,
    autoStart = true
  } = config;
  
  // Create root element
  const element = document.createElement('div');
  element.className = 'home-container';
  
  // State
  let pollingId = null;
  let currentSessions = [];
  let projectInfo = null;
  
  // Create sections
  const sessionList = SessionGrid({
    showAll: true,
    sortBy: 'time',
    sortDesc: true,
    onSessionClick: handleSessionClick,
    onSessionDelete: handleSessionDelete,
    emptyMessage: null // We'll show custom onboarding instead
  });
  
  // Build page structure
  function buildPageStructure() {
    element.innerHTML = `
      <!-- Background Effects -->
      <svg class="bg-orbs" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        <defs>
          <filter id="orb-blur-home" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3"/>
          </filter>
        </defs>
        
        <!-- Orbs - Light Mode -->
        <g class="orbs-light">
          <circle cx="15" cy="15" r="8" fill="rgba(6, 182, 212, 0.4)" filter="url(#orb-blur-home)">
            <animate attributeName="cx" values="15;18;12;15" dur="20s" repeatCount="indefinite"/>
            <animate attributeName="cy" values="15;18;12;15" dur="20s" repeatCount="indefinite"/>
          </circle>
          <circle cx="85" cy="10" r="10" fill="rgba(139, 92, 246, 0.4)" filter="url(#orb-blur-home)">
            <animate attributeName="cx" values="85;82;88;85" dur="25s" repeatCount="indefinite"/>
            <animate attributeName="cy" values="10;13;7;10" dur="25s" repeatCount="indefinite"/>
          </circle>
          <circle cx="20" cy="85" r="9" fill="rgba(236, 72, 153, 0.4)" filter="url(#orb-blur-home)">
            <animate attributeName="cx" values="20;17;23;20" dur="22s" repeatCount="indefinite"/>
            <animate attributeName="cy" values="85;82;88;85" dur="22s" repeatCount="indefinite"/>
          </circle>
          <circle cx="85" cy="80" r="7" fill="rgba(249, 115, 22, 0.4)" filter="url(#orb-blur-home)">
            <animate attributeName="cx" values="85;88;82;85" dur="18s" repeatCount="indefinite"/>
            <animate attributeName="cy" values="80;83;77;80" dur="18s" repeatCount="indefinite"/>
          </circle>
        </g>
        
        <!-- Orbs - Dark Mode -->
        <g class="orbs-dark" style="display: none;">
          <circle cx="15" cy="15" r="8" fill="rgba(6, 182, 212, 0.3)" filter="url(#orb-blur-home)">
            <animate attributeName="cx" values="15;18;12;15" dur="20s" repeatCount="indefinite"/>
            <animate attributeName="cy" values="15;18;12;15" dur="20s" repeatCount="indefinite"/>
          </circle>
          <circle cx="85" cy="10" r="10" fill="rgba(139, 92, 246, 0.35)" filter="url(#orb-blur-home)">
            <animate attributeName="cx" values="85;82;88;85" dur="25s" repeatCount="indefinite"/>
            <animate attributeName="cy" values="10;13;7;10" dur="25s" repeatCount="indefinite"/>
          </circle>
          <circle cx="20" cy="85" r="9" fill="rgba(236, 72, 153, 0.3)" filter="url(#orb-blur-home)">
            <animate attributeName="cx" values="20;17;23;20" dur="22s" repeatCount="indefinite"/>
            <animate attributeName="cy" values="85;82;88;85" dur="22s" repeatCount="indefinite"/>
          </circle>
          <circle cx="85" cy="80" r="7" fill="rgba(249, 115, 22, 0.3)" filter="url(#orb-blur-home)">
            <animate attributeName="cx" values="85;88;82;85" dur="18s" repeatCount="indefinite"/>
            <animate attributeName="cy" values="80;83;77;80" dur="18s" repeatCount="indefinite"/>
          </circle>
        </g>
      </svg>
      
      <!-- Workflow Rails & Nodes -->
      <div class="bg-rails">
        <div class="rail-path rail-h1">
          <svg viewBox="0 0 1400 100" preserveAspectRatio="none">
            <path d="M0,50 Q350,20 700,50 T1400,50" stroke="rgba(139, 92, 246, 0.3)" stroke-width="2" fill="none"/>
          </svg>
        </div>
        <div class="rail-path rail-h2">
          <svg viewBox="0 0 1400 100" preserveAspectRatio="none">
            <path d="M0,50 Q350,80 700,50 T1400,50" stroke="rgba(6, 182, 212, 0.3)" stroke-width="2" fill="none"/>
          </svg>
        </div>
        <div class="rail-path rail-d1"></div>
        <div class="rail-path rail-d2"></div>
      </div>
      
      <!-- Workflow Nodes -->
      <div class="workflow-node node-1"></div>
      <div class="workflow-node node-2"></div>
      <div class="workflow-node node-3"></div>
      <div class="workflow-node node-4"></div>
      <div class="workflow-node node-5"></div>
      
      <!-- Hero Section -->
      <div class="hero">
        <h1>
          <i data-lucide="rocket" style="width: 42px; height: 42px; display: inline-block; vertical-align: middle; margin-right: 12px;"></i>
          Workrail Dashboard
        </h1>
        <p>Real-time workflow execution tracking and visualization</p>
      </div>
      
      <!-- Project Info Section -->
      <div id="projectInfo" class="project-info">
        <h2>Current Project</h2>
        <div class="project-details">
          <div class="detail-item">
            <div class="detail-label">Project ID</div>
            <div class="detail-value" id="projectId">Loading...</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Project Path</div>
            <div class="detail-value" id="projectPath">Loading...</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Active Sessions</div>
            <div class="detail-value" id="sessionCount">Loading...</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Last Updated</div>
            <div class="detail-value" id="projectUpdated">Loading...</div>
          </div>
        </div>
      </div>
      
      <!-- Sessions Header -->
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px;">
        <h2 style="margin: 0; font-size: 24px; color: #2c3e50;">Active Sessions</h2>
        <button id="clearCompletedBtn" 
                class="clear-completed-btn" 
                style="display: none;">
          Clear <span id="completedCount">0</span> completed
        </button>
      </div>
      
      <!-- Sessions Container -->
      <div id="sessionsContainer" class="sessions-grid"></div>
    `;
    
    // Append session list to container
    const container = element.querySelector('#sessionsContainer');
    container.appendChild(sessionList.element);
    
    // Attach clear button handler
    const clearBtn = element.querySelector('#clearCompletedBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', handleClearCompleted);
    }
  }
  
  /**
   * Load project info
   * @private
   */
  async function loadProjectInfo() {
    try {
      projectInfo = await api.getCurrentProject();
      updateProjectInfo();
    } catch (error) {
      console.error('Failed to load project info:', error);
      // Set default values on error
      element.querySelector('#projectId').textContent = 'Unknown';
      element.querySelector('#projectPath').textContent = 'Unknown';
    }
  }
  
  /**
   * Update project info display
   * @private
   */
  function updateProjectInfo() {
    if (!projectInfo) return;
    
    element.querySelector('#projectId').textContent = projectInfo.id || 'Unknown';
    element.querySelector('#projectPath').textContent = projectInfo.path || 'Unknown';
    element.querySelector('#sessionCount').textContent = currentSessions.length;
    element.querySelector('#projectUpdated').textContent = fmt.formatTime(Date.now());
  }
  
  /**
   * Load sessions
   * @private
   */
  async function loadSessions() {
    try {
      currentSessions = await api.getSessions();
      
      // Always update display, even if empty (will show onboarding)
      updateSessionsDisplay();
      updateClearButton();
      updateProjectInfo();
      
      // Reinitialize Lucide icons if available
      if (typeof lucide !== 'undefined') {
        setTimeout(() => lucide.createIcons(), 50);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
      console.error('API Error details:', error.message);
      
      // If no sessions found, show empty state instead of error
      // Only show error if it's a real API failure
      if (error.message && error.message.includes('404')) {
        // Endpoint not found - probably wrong API
        showError('API endpoint not found. Is the MCP server running?');
      } else {
        // Network error or other failure
        showError(`Failed to connect to API. Check console for details.`);
      }
    }
  }
  
  /**
   * Update sessions display
   * @private
   */
  function updateSessionsDisplay() {
    if (currentSessions.length === 0) {
      showOnboarding();
    } else {
      sessionList.update(currentSessions);
      // Ensure session list is visible
      sessionList.element.style.display = 'grid';
    }
  }
  
  /**
   * Show onboarding when no sessions
   * @private
   */
  function showOnboarding() {
    // Hide session list
    sessionList.element.style.display = 'none';
    
    // Show onboarding in container
    const container = element.querySelector('#sessionsContainer');
    const onboarding = document.createElement('div');
    onboarding.className = 'onboarding-container';
    onboarding.innerHTML = `
      <div class="onboarding-hero">
        <div class="onboarding-icon">
          <i data-lucide="rocket" style="width: 64px; height: 64px;"></i>
        </div>
        <h2>Welcome to Workrail Dashboard</h2>
        <p class="onboarding-subtitle">Real-time workflow execution tracking and visualization</p>
      </div>
      
      <div class="onboarding-content">
        <div class="onboarding-section">
          <h3><i data-lucide="bar-chart" style="width: 20px; height: 20px; display: inline-block; vertical-align: middle; margin-right: 8px;"></i>What is this?</h3>
          <p>This dashboard provides real-time monitoring of your workflow executions. Watch as AI agents work through complex tasks like bug investigations, code reviews, and documentation creation.</p>
        </div>
        
        <div class="onboarding-section">
          <h3><i data-lucide="target" style="width: 20px; height: 20px; display: inline-block; vertical-align: middle; margin-right: 8px;"></i>Getting Started</h3>
          <p>To see the dashboard in action, have an AI agent execute a workflow. For example, try the bug investigation workflow:</p>
          <div class="code-block">
            <code>workrail_create_session("bug-investigation", "YOUR-TICKET-ID", {...})</code>
          </div>
          <p class="hint">💡 The agent will automatically call this when starting an investigation</p>
        </div>
        
        <div class="onboarding-section">
          <h3><i data-lucide="sparkles" style="width: 20px; height: 20px; display: inline-block; vertical-align: middle; margin-right: 8px;"></i>What you'll see:</h3>
          <div class="features-grid">
            <div class="feature-item">
              <span class="feature-icon">
                <i data-lucide="trending-up" style="width: 24px; height: 24px;"></i>
              </span>
              <div class="feature-text">
                <strong>Progress Tracking</strong>
                <p>Watch progress from 0% to 100%</p>
              </div>
            </div>
            <div class="feature-item">
              <span class="feature-icon">
                <i data-lucide="lightbulb" style="width: 24px; height: 24px;"></i>
              </span>
              <div class="feature-text">
                <strong>Hypothesis Evolution</strong>
                <p>See theories develop and get validated</p>
              </div>
            </div>
            <div class="feature-item">
              <span class="feature-icon">
                <i data-lucide="clock" style="width: 24px; height: 24px;"></i>
              </span>
              <div class="feature-text">
                <strong>Live Timeline</strong>
                <p>Track events as they happen</p>
              </div>
            </div>
            <div class="feature-item">
              <span class="feature-icon">
                <i data-lucide="bar-chart-2" style="width: 24px; height: 24px;"></i>
              </span>
              <div class="feature-text">
                <strong>Confidence Journey</strong>
                <p>See confidence grow with evidence</p>
              </div>
            </div>
          </div>
        </div>
        
        <div class="onboarding-section onboarding-cta">
          <h3>🧪 Ready to start?</h3>
          <p>Just tell your AI agent to investigate a bug or execute any Workrail workflow - the dashboard will automatically populate!</p>
          <div class="auto-refresh-notice">
            <span class="pulse-dot"></span>
            Dashboard auto-refreshes every ${pollInterval / 1000} seconds
          </div>
        </div>
      </div>
    `;
    
    // Replace session list with onboarding
    container.insertBefore(onboarding, sessionList.element);
    
    // Initialize icons
    if (typeof lucide !== 'undefined') {
      setTimeout(() => lucide.createIcons(), 50);
    }
  }
  
  /**
   * Update clear completed button
   * @private
   */
  function updateClearButton() {
    const completedCount = currentSessions.filter(s => 
      s.data?.dashboard?.status === 'complete'
    ).length;
    
    const clearBtn = element.querySelector('#clearCompletedBtn');
    const countSpan = element.querySelector('#completedCount');
    
    if (clearBtn && countSpan) {
      if (completedCount > 0) {
        clearBtn.style.display = 'block';
        countSpan.textContent = completedCount;
      } else {
        clearBtn.style.display = 'none';
      }
    }
  }
  
  /**
   * Handle session click
   * @private
   */
  function handleSessionClick(session, workflowId, sessionId) {
    // Navigate to universal generic dashboard
    window.location.href = `/dashboard.html?workflow=${encodeURIComponent(workflowId)}&id=${encodeURIComponent(sessionId)}`;
  }
  
  /**
   * Handle session delete
   * @private
   */
  async function handleSessionDelete(session, workflowId, sessionId) {
    if (!confirm(`Delete session "${sessionId}"?\n\nThis action cannot be undone.`)) {
      return;
    }
    
    try {
      await api.deleteSession(workflowId, sessionId);
      await loadSessions();
    } catch (error) {
      console.error('Failed to delete session:', error);
      alert('Failed to delete session');
    }
  }
  
  /**
   * Handle clear completed sessions
   * @private
   */
  async function handleClearCompleted() {
    const completed = currentSessions.filter(s => 
      s.data?.dashboard?.status === 'complete'
    );
    
    if (completed.length === 0) return;
    
    if (!confirm(`Delete ${completed.length} completed session(s)?\n\nThis action cannot be undone.`)) {
      return;
    }
    
    try {
      await api.bulkDeleteSessions(completed);
      await loadSessions();
    } catch (error) {
      console.error('Failed to clear completed sessions:', error);
      alert('Failed to clear completed sessions');
    }
  }
  
  /**
   * Show error message
   * @private
   */
  function showError(message) {
    const container = element.querySelector('#sessionsContainer');
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #e74c3c;">
        <p style="font-size: 18px; margin-bottom: 8px;">⚠️ ${fmt.escapeHtml(message)}</p>
        <button onclick="window.location.reload()" 
                style="padding: 8px 16px; margin-top: 16px; cursor: pointer;">
          Reload Page
        </button>
      </div>
    `;
  }
  
  /**
   * Start polling for updates
   */
  function start() {
    if (pollingId) return; // Already started
    
    // Initial load
    loadProjectInfo();
    loadSessions();
    
    // Start polling (use relative URL for proxy compatibility)
    pollingId = polling.startPolling(
      'sessions',
      async () => {
        try {
          currentSessions = await api.getSessions();
          updateSessionsDisplay();
          updateClearButton();
          updateProjectInfo();
          
          // Reinitialize icons
          if (typeof lucide !== 'undefined') {
            setTimeout(() => lucide.createIcons(), 50);
          }
        } catch (error) {
          console.error('Polling error:', error);
          // Don't show error UI on polling failures, just log
        }
      },
      pollInterval
    );
  }
  
  /**
   * Stop polling
   */
  function stop() {
    if (pollingId) {
      polling.stopPolling(pollingId);
      pollingId = null;
    }
  }
  
  /**
   * Destroy the page and cleanup
   */
  function destroy() {
    stop();
    sessionList.destroy();
    element.innerHTML = '';
  }
  
  // Build initial structure
  buildPageStructure();
  
  // Auto-start if configured
  if (autoStart) {
    // Small delay to allow DOM to be ready
    setTimeout(start, 0);
  }
  
  // Return public API
  return {
    element,
    start,
    stop,
    destroy
  };
}

