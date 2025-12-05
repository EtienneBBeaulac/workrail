/**
 * Performance Optimization Utilities
 * 
 * Tools for optimizing dashboard rendering performance with large datasets.
 */

/**
 * Memoization cache for expensive computations
 */
class MemoizationCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }
  
  get(key) {
    const stringKey = JSON.stringify(key);
    return this.cache.get(stringKey);
  }
  
  set(key, value) {
    const stringKey = JSON.stringify(key);
    
    // Enforce max size (LRU)
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(stringKey, value);
  }
  
  has(key) {
    const stringKey = JSON.stringify(key);
    return this.cache.has(stringKey);
  }
  
  clear() {
    this.cache.clear();
  }
}

/**
 * Memoize a function
 */
export function memoize(fn, options = {}) {
  const { maxSize = 100, keyFn = null } = options;
  const cache = new MemoizationCache(maxSize);
  
  return function memoized(...args) {
    const key = keyFn ? keyFn(...args) : args;
    
    if (cache.has(key)) {
      return cache.get(key);
    }
    
    const result = fn.apply(this, args);
    cache.set(key, result);
    return result;
  };
}

/**
 * Debounce function calls
 */
export function debounce(fn, delay = 250) {
  let timeoutId = null;
  
  return function debounced(...args) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    
    timeoutId = setTimeout(() => {
      fn.apply(this, args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Throttle function calls
 */
export function throttle(fn, limit = 250) {
  let inThrottle = false;
  
  return function throttled(...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * Request idle callback with fallback
 */
export function requestIdleCallback(callback, options = {}) {
  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(callback, options);
  }
  
  // Fallback
  return setTimeout(() => {
    const start = Date.now();
    callback({
      didTimeout: false,
      timeRemaining: () => Math.max(0, 50 - (Date.now() - start))
    });
  }, 1);
}

/**
 * Cancel idle callback
 */
export function cancelIdleCallback(id) {
  if ('cancelIdleCallback' in window) {
    window.cancelIdleCallback(id);
  } else {
    clearTimeout(id);
  }
}

/**
 * Batch DOM updates
 */
export class BatchScheduler {
  constructor() {
    this.pending = [];
    this.scheduled = false;
  }
  
  schedule(fn) {
    this.pending.push(fn);
    
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => {
        const tasks = this.pending;
        this.pending = [];
        this.scheduled = false;
        
        for (const task of tasks) {
          task();
        }
      });
    }
  }
}

export const batchScheduler = new BatchScheduler();

/**
 * Virtual Scroll Manager
 * Renders only visible items for large lists
 */
export class VirtualScroll {
  constructor(container, options = {}) {
    this.container = container;
    this.itemHeight = options.itemHeight || 50;
    this.buffer = options.buffer || 5;
    this.items = [];
    this.visibleItems = new Map();
    this.scrollTop = 0;
    this.containerHeight = 0;
    
    this.setupContainer();
    this.attachListeners();
  }
  
  setupContainer() {
    // Ensure container is scrollable
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }
    
    // Create viewport
    this.viewport = document.createElement('div');
    this.viewport.style.position = 'relative';
    this.container.appendChild(this.viewport);
  }
  
  attachListeners() {
    this.handleScroll = throttle(() => {
      this.scrollTop = this.container.scrollTop;
      this.render();
    }, 16); // ~60fps
    
    this.container.addEventListener('scroll', this.handleScroll);
    
    // Handle resize
    this.resizeObserver = new ResizeObserver(() => {
      this.containerHeight = this.container.clientHeight;
      this.render();
    });
    this.resizeObserver.observe(this.container);
  }
  
  setItems(items) {
    this.items = items;
    
    // Set viewport height
    const totalHeight = this.items.length * this.itemHeight;
    this.viewport.style.height = `${totalHeight}px`;
    
    this.render();
  }
  
  render() {
    if (this.items.length === 0) return;
    
    const startIndex = Math.max(0, Math.floor(this.scrollTop / this.itemHeight) - this.buffer);
    const endIndex = Math.min(
      this.items.length,
      Math.ceil((this.scrollTop + this.containerHeight) / this.itemHeight) + this.buffer
    );
    
    // Remove items outside visible range
    for (const [index, element] of this.visibleItems.entries()) {
      if (index < startIndex || index >= endIndex) {
        element.remove();
        this.visibleItems.delete(index);
      }
    }
    
    // Add visible items
    for (let i = startIndex; i < endIndex; i++) {
      if (!this.visibleItems.has(i)) {
        const item = this.items[i];
        const element = this.renderItem(item, i);
        
        element.style.position = 'absolute';
        element.style.top = `${i * this.itemHeight}px`;
        element.style.left = '0';
        element.style.right = '0';
        
        this.viewport.appendChild(element);
        this.visibleItems.set(i, element);
      }
    }
  }
  
  renderItem(item, index) {
    // Override this method to customize rendering
    const div = document.createElement('div');
    div.textContent = JSON.stringify(item);
    div.dataset.index = index;
    return div;
  }
  
  destroy() {
    this.container.removeEventListener('scroll', this.handleScroll);
    this.resizeObserver.disconnect();
    this.viewport.remove();
  }
}

/**
 * Incremental Renderer
 * Breaks large rendering tasks into chunks
 */
export class IncrementalRenderer {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize || 10;
    this.chunkDelay = options.chunkDelay || 16; // ~60fps
    this.onProgress = options.onProgress || null;
    this.onComplete = options.onComplete || null;
  }
  
  async render(items, renderFn, container) {
    const total = items.length;
    let processed = 0;
    
    for (let i = 0; i < items.length; i += this.chunkSize) {
      // Process chunk
      const chunk = items.slice(i, i + this.chunkSize);
      
      for (const item of chunk) {
        const element = renderFn(item);
        if (element) {
          container.appendChild(element);
        }
        processed++;
      }
      
      // Report progress
      if (this.onProgress) {
        this.onProgress(processed, total);
      }
      
      // Yield to browser
      if (i + this.chunkSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, this.chunkDelay));
      }
    }
    
    // Complete
    if (this.onComplete) {
      this.onComplete();
    }
  }
}

/**
 * Smart Diff - Efficiently compute differences between data objects
 */
export class SmartDiff {
  constructor() {
    this.cache = new Map();
  }
  
  /**
   * Compute diff between old and new data
   * Returns only changed paths
   */
  diff(oldData, newData) {
    const changes = {
      added: [],
      removed: [],
      modified: []
    };
    
    // Cache data as JSON for comparison
    const oldJson = JSON.stringify(oldData);
    const newJson = JSON.stringify(newData);
    
    // Quick check - no changes
    if (oldJson === newJson) {
      return changes;
    }
    
    // Deep diff
    this._deepDiff(oldData, newData, '', changes);
    
    return changes;
  }
  
  _deepDiff(oldVal, newVal, path, changes) {
    // Type change
    const oldType = Array.isArray(oldVal) ? 'array' : typeof oldVal;
    const newType = Array.isArray(newVal) ? 'array' : typeof newVal;
    
    if (oldType !== newType) {
      changes.modified.push({ path, oldValue: oldVal, newValue: newVal });
      return;
    }
    
    // Primitive comparison
    if (oldType !== 'object' || oldVal === null || newVal === null) {
      if (oldVal !== newVal) {
        changes.modified.push({ path, oldValue: oldVal, newValue: newVal });
      }
      return;
    }
    
    // Array comparison
    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      const maxLen = Math.max(oldVal.length, newVal.length);
      
      for (let i = 0; i < maxLen; i++) {
        const itemPath = path ? `${path}[${i}]` : `[${i}]`;
        
        if (i >= oldVal.length) {
          changes.added.push({ path: itemPath, value: newVal[i] });
        } else if (i >= newVal.length) {
          changes.removed.push({ path: itemPath, value: oldVal[i] });
        } else {
          this._deepDiff(oldVal[i], newVal[i], itemPath, changes);
        }
      }
      return;
    }
    
    // Object comparison
    const oldKeys = new Set(Object.keys(oldVal));
    const newKeys = new Set(Object.keys(newVal));
    
    // Added keys
    for (const key of newKeys) {
      const keyPath = path ? `${path}.${key}` : key;
      
      if (!oldKeys.has(key)) {
        changes.added.push({ path: keyPath, value: newVal[key] });
      } else {
        this._deepDiff(oldVal[key], newVal[key], keyPath, changes);
      }
    }
    
    // Removed keys
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        const keyPath = path ? `${path}.${key}` : key;
        changes.removed.push({ path: keyPath, value: oldVal[key] });
      }
    }
  }
  
  /**
   * Apply diff to DOM efficiently
   * Only updates changed elements
   */
  applyDiff(changes, container, renderer) {
    // Batch all DOM updates
    batchScheduler.schedule(() => {
      // Handle removals
      for (const { path } of changes.removed) {
        const element = container.querySelector(`[data-path="${path}"]`);
        if (element) {
          element.remove();
        }
      }
      
      // Handle additions
      for (const { path, value } of changes.added) {
        const element = renderer(path, value);
        if (element) {
          element.dataset.path = path;
          container.appendChild(element);
        }
      }
      
      // Handle modifications
      for (const { path, newValue } of changes.modified) {
        const element = container.querySelector(`[data-path="${path}"]`);
        if (element) {
          const newElement = renderer(path, newValue);
          if (newElement) {
            newElement.dataset.path = path;
            element.replaceWith(newElement);
          }
        }
      }
    });
  }
}

/**
 * Performance monitor
 */
export class PerformanceMonitor {
  constructor() {
    this.marks = new Map();
    this.measures = [];
  }
  
  mark(name) {
    this.marks.set(name, performance.now());
  }
  
  measure(name, startMark, endMark = null) {
    const startTime = this.marks.get(startMark);
    const endTime = endMark ? this.marks.get(endMark) : performance.now();
    
    if (startTime === undefined) {
      console.warn(`Start mark not found: ${startMark}`);
      return null;
    }
    
    const duration = endTime - startTime;
    this.measures.push({ name, duration, timestamp: Date.now() });
    
    return duration;
  }
  
  report() {
    console.group('⚡ Performance Report');
    
    for (const { name, duration } of this.measures) {
      const color = duration < 16 ? 'green' : duration < 100 ? 'orange' : 'red';
      console.log(
        `%c${name}: ${duration.toFixed(2)}ms`,
        `color: ${color}; font-weight: bold;`
      );
    }
    
    console.groupEnd();
  }
  
  clear() {
    this.marks.clear();
    this.measures = [];
  }
}

export const perfMonitor = new PerformanceMonitor();






