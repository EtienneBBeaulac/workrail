/**
 * Generic Dashboard Scaffold
 * 
 * Automatically generates a dashboard for any workflow by recognizing
 * data patterns in session data.
 * 
 * Usage:
 *   import { GenericDashboard } from '/assets/scaffolds/generic-dashboard.js';
 *   
 *   const dashboard = GenericDashboard({
 *     workflowId: 'my-workflow',
 *     sessionId: 'SESSION-123',
 *     dataSource: '/api/sessions/my-workflow/SESSION-123'
 *   });
 *   
 *   document.getElementById('root').appendChild(dashboard.element);
 */

import { GenericRenderer } from '../services/generic-renderer.js';
import { DataNormalizer } from '../services/data-normalizer.js';
import { dashboardInspector } from '../services/dashboard-inspector.js';
import { SmartDiff, perfMonitor, debounce } from '../utils/performance.js';
import { liveAnnouncer, focusManager, keyboardNav } from '../utils/accessibility.js';
import { searchEngine, SearchUI } from '../services/search-engine.js';

// Note: reconstructNestedObjects is now handled by DataNormalizer.normalize()

/**
 * Create a generic dashboard
 * @param {Object} config - Configuration
 * @param {string} config.workflowId - Workflow ID
 * @param {string} config.sessionId - Session ID
 * @param {boolean} config.autoStart - Auto-start real-time updates (default: true)
 * @returns {Object} { element, start, stop, destroy }
 */
export function GenericDashboard(config = {}) {
  const {
    workflowId,
    sessionId,
    autoStart = true
  } = config;
  
  // Create root element
  const element = document.createElement('div');
  element.className = 'generic-dashboard';
  
  // State
  let eventSource = null;
  let currentData = null;
  let renderer = new GenericRenderer();
  let normalizer = new DataNormalizer();
  let smartDiff = new SmartDiff();
  let previousData = null;
  let searchUI = null;
  
  // Initialize search
  if (config.enableSearch !== false) {
    searchUI = new SearchUI(searchEngine, {
      onSelect: (result) => {
        // Scroll to the field
        const pathParts = result.path.split('.');
        const sectionName = pathParts[0];
        const section = element.querySelector(`[data-section="${sectionName}"]`);
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Highlight briefly
          section.classList.add('highlight');
          setTimeout(() => section.classList.remove('highlight'), 2000);
        }
        liveAnnouncer.announcePolite(`Navigated to ${result.path}`);
      }
    });
    
    // Setup keyboard shortcut (/)
    keyboardNav.on('search', () => {
      if (searchUI) {
        searchUI.open();
      }
    });
  }
  
  // Create loading state
  element.innerHTML = '<div class="loading-state">Loading dashboard...</div>';
  
  /**
   * Connect to real-time updates via SSE
   * @private
   */
  function connectSSE() {
    try {
      // Validate required params
      if (!workflowId || !sessionId) {
        showError('Missing workflow or session ID');
        return;
      }
      
      // Close existing connection if any
      if (eventSource) {
        try {
          eventSource.close();
        } catch (e) {
          console.warn('Error closing previous SSE connection:', e);
        }
      }
      
      // Create SSE connection to stream endpoint
      const streamUrl = `/api/sessions/${encodeURIComponent(workflowId)}/${encodeURIComponent(sessionId)}/stream`;
      console.log(`Connecting to SSE: ${streamUrl}`);
      
      eventSource = new EventSource(streamUrl);
      
      eventSource.onopen = () => {
        console.log('✓ Connected to real-time updates');
        // Clear any error states
        if (element.querySelector('.connection-error')) {
          element.querySelector('.connection-error')?.remove();
        }
      };
      
      eventSource.onmessage = (event) => {
        try {
          // Validate event data
          if (!event || !event.data) {
            console.warn('SSE: Received empty event');
            return;
          }
          
          // Parse message
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (parseError) {
            console.error('SSE: Failed to parse message as JSON:', event.data);
            return;
          }
          
          // Validate message structure
          if (!message || typeof message !== 'object') {
            console.warn('SSE: Invalid message structure:', message);
            return;
          }
          
          // Handle update messages
          if (message.type === 'update' && message.session) {
            try {
              // Validate session data
              if (!message.session.data || typeof message.session.data !== 'object') {
                console.warn('SSE: Invalid session data structure');
                return;
              }
              
              // Normalize and reconstruct data
              // This includes: validation, cleaning, and nested reconstruction
              currentData = normalizer.normalize(message.session.data, {
                cleanValues: true,
                reconstructNested: true,
                normalizeKeys: false, // Keep original field names
                validate: true
              });
              
              // Update inspector with new data
              if (dashboardInspector.enabled) {
                dashboardInspector.setData(currentData);
              }
              
              // Index data for search
              if (searchEngine && config.enableSearch !== false) {
                searchEngine.indexData(currentData);
              }
              
              render();
            } catch (normalizeError) {
              console.error('SSE: Error normalizing data:', normalizeError);
              showError(`Data processing error: ${normalizeError.message}`);
            }
          } else if (message.type === 'connected') {
            console.log('✓ SSE connection confirmed');
          } else {
            console.log('SSE: Unknown message type:', message.type);
          }
        } catch (error) {
          console.error('SSE: Error handling message:', error);
          // Don't show error UI for individual message failures
        }
      };
      
      eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        
        // Close the connection
        try {
          eventSource.close();
        } catch (e) {
          console.warn('Error closing SSE after error:', e);
        }
        
        eventSource = null;
        
        // Show reconnection banner
        showReconnecting();
        
        // Attempt to reconnect after 3 seconds
        setTimeout(() => {
          console.log('Attempting to reconnect to SSE...');
          connectSSE();
        }, 3000);
      };
      
    } catch (error) {
      console.error('SSE: Critical error in connectSSE:', error);
      showError(`Connection failed: ${error.message}`);
    }
  }
  
  /**
   * Show reconnecting banner
   * @private
   */
  function showReconnecting() {
    // Don't show if already showing
    if (element.querySelector('.connection-error')) return;
    
    const banner = document.createElement('div');
    banner.className = 'connection-error';
    banner.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #f97316; color: white; padding: 12px 20px; border-radius: 8px; z-index: 9999; font-size: 14px;';
    banner.textContent = 'Reconnecting...';
    element.prepend(banner);
  }
  
  /**
   * Render dashboard
   * @private
   */
  function render() {
    try {
      // Validate data
      if (!currentData) {
        console.warn('render(): No data to render');
        return;
      }
      
      if (typeof currentData !== 'object' || Array.isArray(currentData)) {
        console.error('render(): Invalid data type:', typeof currentData);
        showError('Invalid data structure received');
        return;
      }
      
      // Preserve open state of details elements (phases)
      const openDetails = new Set();
      try {
        element.querySelectorAll('details[open]').forEach(detail => {
          const summary = detail.querySelector('.phase-summary');
          if (summary) {
            const phaseName = summary.querySelector('.phase-name');
            if (phaseName && phaseName.textContent) {
              openDetails.add(phaseName.textContent.trim());
            }
          }
        });
      } catch (preserveError) {
        console.warn('Error preserving UI state:', preserveError);
        // Continue rendering anyway
      }
      
      // Clear element
      element.innerHTML = '';
      
      // Render using pattern-based renderer
      try {
        // Performance monitoring
        if (config.enablePerformanceMonitoring) {
          perfMonitor.mark('render-start');
        }
        
        const dashboardContent = renderer.renderAll(currentData);
        
        if (!dashboardContent) {
          console.error('render(): renderer.renderAll returned null/undefined');
          showError('Failed to generate dashboard content');
          return;
        }
        
        element.appendChild(dashboardContent);
        
        if (config.enablePerformanceMonitoring) {
          perfMonitor.mark('render-end');
          const duration = perfMonitor.measure('Dashboard Render', 'render-start', 'render-end');
          if (duration > 100) {
            console.warn(`⚠️  Slow render: ${duration.toFixed(2)}ms`);
          }
        }
        
        // Apply stagger animations to sections
        try {
          const sections = element.querySelectorAll('.dashboard-section');
          sections.forEach((section, index) => {
            if (index < 6) {
              section.classList.add(`stagger-${index + 1}`);
            }
          });
        } catch (animError) {
          console.warn('Error applying animations:', animError);
        }
      } catch (renderError) {
        console.error('Error rendering dashboard content:', renderError);
        showError(`Rendering error: ${renderError.message}`);
        return;
      }
      
      // Restore open state
      try {
        element.querySelectorAll('details').forEach(detail => {
          const summary = detail.querySelector('.phase-summary');
          if (summary) {
            const phaseName = summary.querySelector('.phase-name');
            if (phaseName && phaseName.textContent && openDetails.has(phaseName.textContent.trim())) {
              detail.open = true;
            }
          }
        });
      } catch (restoreError) {
        console.warn('Error restoring UI state:', restoreError);
        // Non-critical, continue
      }
      
      // Announce to screen readers
      try {
        const title = currentData.dashboard?.title || 'Dashboard';
        liveAnnouncer.announcePolite(`${title} updated`);
      } catch (announceError) {
        console.warn('Error announcing update:', announceError);
      }
      
      // Initialize Lucide icons if available
      try {
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
          setTimeout(() => lucide.createIcons(), 50);
        }
      } catch (iconError) {
        console.warn('Error initializing Lucide icons:', iconError);
        // Non-critical, continue
      }
      
    } catch (error) {
      console.error('Critical rendering error:', error);
      showError(`Critical error: ${error.message}`);
    }
  }
  
  /**
   * Show error message
   * @private
   */
  function showError(message) {
    element.innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <div class="error-message">${escapeHtml(message)}</div>
        <button onclick="window.location.reload()" class="error-reload-btn">
          Reload Page
        </button>
      </div>
    `;
  }
  
  /**
   * Start real-time updates
   */
  function start() {
    if (eventSource) return; // Already started
    
    // Enable inspector if requested
    if (config.enableInspector) {
      dashboardInspector.enable();
    }
    
    // Announce to screen readers
    liveAnnouncer.announcePolite('Dashboard loading');
    
    connectSSE();
  }
  
  /**
   * Stop real-time updates
   */
  function stop() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }
  
  /**
   * Destroy dashboard and cleanup
   */
  function destroy() {
    stop();
    element.innerHTML = '';
  }
  
  // Auto-start if configured
  if (autoStart) {
    setTimeout(start, 0);
  }
  
  // Return public API
  return {
    element,
    start,
    stop,
    destroy,
    search: searchUI,
    export: () => exportData()
  };
  
  /**
   * Export dashboard data
   */
  function exportData(format = 'json') {
    if (!currentData) {
      console.warn('No data to export');
      return null;
    }
    
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${config.workflowId}-${config.sessionId}-${timestamp}`;
    
    if (format === 'json') {
      const json = JSON.stringify(currentData, null, 2);
      downloadFile(json, `${filename}.json`, 'application/json');
      liveAnnouncer.announcePolite('Dashboard exported as JSON');
    } else if (format === 'markdown') {
      const markdown = exportToMarkdown(currentData);
      downloadFile(markdown, `${filename}.md`, 'text/markdown');
      liveAnnouncer.announcePolite('Dashboard exported as Markdown');
    }
  }
  
  /**
   * Download file
   */
  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  /**
   * Export data to Markdown format
   */
  function exportToMarkdown(data) {
    let md = '';
    
    // Dashboard header
    if (data.dashboard) {
      md += `# ${data.dashboard.title || 'Dashboard'}\n\n`;
      if (data.dashboard.subtitle) {
        md += `${data.dashboard.subtitle}\n\n`;
      }
      if (data.dashboard.status) {
        md += `**Status:** ${data.dashboard.status}`;
        if (data.dashboard.progress) {
          md += ` (${data.dashboard.progress}%)`;
        }
        md += '\n\n';
      }
    }
    
    // Other sections
    for (const [key, value] of Object.entries(data)) {
      if (key === 'dashboard' || key === '_meta') continue;
      
      md += `## ${formatLabel(key)}\n\n`;
      md += formatValueToMarkdown(value, 0);
      md += '\n\n';
    }
    
    return md;
  }
  
  function formatValueToMarkdown(value, indent = 0) {
    const prefix = '  '.repeat(indent);
    
    if (Array.isArray(value)) {
      return value.map((item, i) => {
        if (typeof item === 'object' && item !== null) {
          let result = `${prefix}- **Item ${i + 1}:**\n`;
          for (const [k, v] of Object.entries(item)) {
            result += `${prefix}  - **${formatLabel(k)}:** ${formatPrimitive(v)}\n`;
          }
          return result;
        } else {
          return `${prefix}- ${formatPrimitive(item)}`;
        }
      }).join('\n');
    } else if (typeof value === 'object' && value !== null) {
      let result = '';
      for (const [k, v] of Object.entries(value)) {
        result += `${prefix}- **${formatLabel(k)}:** ${formatPrimitive(v)}\n`;
      }
      return result;
    } else {
      return `${prefix}${formatPrimitive(value)}`;
    }
  }
  
  function formatPrimitive(value) {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return String(value);
  }
  
  function formatLabel(key) {
    return key
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
      .trim();
  }
}

/**
 * Helper: Escape HTML
 * @private
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}



