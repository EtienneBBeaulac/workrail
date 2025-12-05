/**
 * Workrail Polling Service
 * 
 * Abstracts HTTP polling with support for:
 * - Simple interval-based polling
 * - ETag-based conditional requests (future)
 * - Adaptive polling rates
 * - Easy start/stop control
 */

// Active polling instances
const activePollers = new Map();

/**
 * Start polling a URL at a fixed interval
 * 
 * @param {string} id - Unique identifier for this poller
 * @param {Function} callback - Async function to call on each poll
 * @param {number} interval - Polling interval in milliseconds
 * @returns {Function} Stop function
 * 
 * @example
 * const stop = startPolling('sessions', async () => {
 *   const sessions = await getSessions();
 *   renderSessions(sessions);
 * }, 5000);
 * 
 * // Later: stop()
 */
export function startPolling(id, callback, interval = 5000) {
  // Stop existing poller with same ID
  stopPolling(id);
  
  let timeoutId = null;
  let isRunning = true;
  
  async function poll() {
    if (!isRunning) return;
    
    try {
      await callback();
    } catch (error) {
      console.error(`Polling error [${id}]:`, error);
      // Continue polling even on error
    }
    
    if (isRunning) {
      timeoutId = setTimeout(poll, interval);
    }
  }
  
  // Start immediately
  poll();
  
  // Create stop function
  const stopFn = () => {
    isRunning = false;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    activePollers.delete(id);
  };
  
  // Store poller
  activePollers.set(id, {
    id,
    interval,
    stop: stopFn,
    startedAt: Date.now()
  });
  
  return stopFn;
}

/**
 * Stop a specific poller by ID
 * 
 * @param {string} id - Poller identifier
 * 
 * @example
 * stopPolling('sessions');
 */
export function stopPolling(id) {
  const poller = activePollers.get(id);
  if (poller) {
    poller.stop();
  }
}

/**
 * Stop all active pollers
 * Useful for cleanup on page unload
 * 
 * @example
 * stopAllPolling();
 */
export function stopAllPolling() {
  activePollers.forEach(poller => poller.stop());
  activePollers.clear();
}

/**
 * Check if a poller is currently active
 * 
 * @param {string} id - Poller identifier
 * @returns {boolean} True if poller is active
 * 
 * @example
 * if (isPolling('sessions')) {
 *   console.log('Already polling sessions');
 * }
 */
export function isPolling(id) {
  return activePollers.has(id);
}

/**
 * Get information about active pollers
 * 
 * @returns {Object[]} Array of poller info
 * 
 * @example
 * const pollers = getActivePollers();
 * console.log(`${pollers.length} pollers active`);
 */
export function getActivePollers() {
  return Array.from(activePollers.values()).map(({ id, interval, startedAt }) => ({
    id,
    interval,
    startedAt,
    runningFor: Date.now() - startedAt
  }));
}

/**
 * Start adaptive polling that adjusts rate based on activity
 * 
 * Faster polling when:
 * - Document is visible
 * - Recent activity detected
 * 
 * Slower polling when:
 * - Document is hidden
 * - No recent activity
 * 
 * @param {string} id - Unique identifier
 * @param {Function} callback - Async function to call
 * @param {Object} config - Configuration options
 * @param {number} config.fastInterval - Fast polling interval (default: 2000ms)
 * @param {number} config.slowInterval - Slow polling interval (default: 10000ms)
 * @param {number} config.activityWindow - Activity detection window (default: 60000ms)
 * @returns {Function} Stop function
 * 
 * @example
 * const stop = startAdaptivePolling('sessions', fetchSessions, {
 *   fastInterval: 2000,  // 2 seconds when active
 *   slowInterval: 10000  // 10 seconds when idle
 * });
 */
export function startAdaptivePolling(id, callback, config = {}) {
  const {
    fastInterval = 2000,
    slowInterval = 10000,
    activityWindow = 60000
  } = config;
  
  let lastActivityTime = Date.now();
  let lastDataChangeTime = Date.now();
  let previousData = null;
  let currentInterval = fastInterval;
  let timeoutId = null;
  let isRunning = true;
  
  // Track user activity
  function onActivity() {
    lastActivityTime = Date.now();
  }
  
  // Add activity listeners
  ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
    document.addEventListener(event, onActivity, { passive: true });
  });
  
  // Track visibility changes
  function onVisibilityChange() {
    if (document.hidden) {
      currentInterval = slowInterval;
    } else {
      currentInterval = fastInterval;
      lastActivityTime = Date.now();
    }
  }
  
  document.addEventListener('visibilitychange', onVisibilityChange);
  
  async function poll() {
    if (!isRunning) return;
    
    try {
      const data = await callback();
      
      // Check if data changed
      const dataStr = JSON.stringify(data);
      if (dataStr !== previousData) {
        lastDataChangeTime = Date.now();
        previousData = dataStr;
      }
      
      // Adjust interval based on activity
      const timeSinceActivity = Date.now() - lastActivityTime;
      const timeSinceDataChange = Date.now() - lastDataChangeTime;
      
      if (document.hidden) {
        currentInterval = slowInterval;
      } else if (timeSinceActivity < activityWindow || timeSinceDataChange < activityWindow) {
        currentInterval = fastInterval;
      } else {
        currentInterval = slowInterval;
      }
      
    } catch (error) {
      console.error(`Adaptive polling error [${id}]:`, error);
    }
    
    if (isRunning) {
      timeoutId = setTimeout(poll, currentInterval);
    }
  }
  
  // Start immediately
  poll();
  
  // Create stop function
  const stopFn = () => {
    isRunning = false;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    
    // Remove event listeners
    ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
      document.removeEventListener(event, onActivity);
    });
    document.removeEventListener('visibilitychange', onVisibilityChange);
    
    activePollers.delete(id);
  };
  
  // Store poller
  activePollers.set(id, {
    id,
    interval: `${fastInterval}-${slowInterval}ms (adaptive)`,
    stop: stopFn,
    startedAt: Date.now(),
    adaptive: true
  });
  
  return stopFn;
}

/**
 * Poll with exponential backoff on errors
 * Useful for resilient polling when API might be temporarily unavailable
 * 
 * @param {string} id - Unique identifier
 * @param {Function} callback - Async function to call
 * @param {Object} config - Configuration
 * @param {number} config.initialInterval - Starting interval (default: 5000ms)
 * @param {number} config.maxInterval - Maximum interval (default: 60000ms)
 * @param {number} config.backoffMultiplier - Backoff multiplier (default: 2)
 * @returns {Function} Stop function
 * 
 * @example
 * const stop = startPollingWithBackoff('sessions', fetchSessions);
 */
export function startPollingWithBackoff(id, callback, config = {}) {
  const {
    initialInterval = 5000,
    maxInterval = 60000,
    backoffMultiplier = 2
  } = config;
  
  let currentInterval = initialInterval;
  let consecutiveErrors = 0;
  let timeoutId = null;
  let isRunning = true;
  
  async function poll() {
    if (!isRunning) return;
    
    try {
      await callback();
      
      // Success - reset backoff
      consecutiveErrors = 0;
      currentInterval = initialInterval;
      
    } catch (error) {
      console.error(`Polling with backoff error [${id}]:`, error);
      
      // Increase backoff
      consecutiveErrors++;
      currentInterval = Math.min(
        currentInterval * backoffMultiplier,
        maxInterval
      );
      
      console.log(`Backing off to ${currentInterval}ms after ${consecutiveErrors} errors`);
    }
    
    if (isRunning) {
      timeoutId = setTimeout(poll, currentInterval);
    }
  }
  
  // Start immediately
  poll();
  
  // Create stop function
  const stopFn = () => {
    isRunning = false;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    activePollers.delete(id);
  };
  
  // Store poller
  activePollers.set(id, {
    id,
    interval: `${currentInterval}ms (with backoff)`,
    stop: stopFn,
    startedAt: Date.now(),
    backoff: true
  });
  
  return stopFn;
}

// Cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', stopAllPolling);
}

