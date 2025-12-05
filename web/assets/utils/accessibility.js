/**
 * Accessibility Utilities
 * 
 * Tools for improving keyboard navigation, screen reader support, and WCAG compliance.
 */

/**
 * Focus Management
 */
export class FocusManager {
  constructor() {
    this.focusHistory = [];
    this.trapStack = [];
  }
  
  /**
   * Save current focus to restore later
   */
  saveFocus() {
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body) {
      this.focusHistory.push(activeElement);
    }
  }
  
  /**
   * Restore previously saved focus
   */
  restoreFocus() {
    const element = this.focusHistory.pop();
    if (element && typeof element.focus === 'function') {
      try {
        element.focus();
      } catch (e) {
        console.warn('Failed to restore focus:', e);
      }
    }
  }
  
  /**
   * Trap focus within an element (for modals/dialogs)
   */
  trapFocus(element) {
    const focusableSelectors = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    
    const focusableElements = element.querySelectorAll(focusableSelectors);
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];
    
    const handleKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      
      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable.focus();
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable.focus();
        }
      }
    };
    
    element.addEventListener('keydown', handleKeyDown);
    
    // Save to stack for cleanup
    this.trapStack.push({ element, handler: handleKeyDown });
    
    // Focus first element
    if (firstFocusable) {
      firstFocusable.focus();
    }
    
    return () => {
      element.removeEventListener('keydown', handleKeyDown);
      this.trapStack.pop();
    };
  }
  
  /**
   * Get all focusable elements within container
   */
  getFocusableElements(container = document) {
    const selectors = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    
    return Array.from(container.querySelectorAll(selectors));
  }
}

/**
 * Announce to screen readers
 */
export class LiveAnnouncer {
  constructor() {
    this.regions = {
      polite: null,
      assertive: null
    };
    this.init();
  }
  
  init() {
    // Create polite region
    this.regions.polite = document.createElement('div');
    this.regions.polite.setAttribute('aria-live', 'polite');
    this.regions.polite.setAttribute('aria-atomic', 'true');
    this.regions.polite.className = 'sr-only';
    document.body.appendChild(this.regions.polite);
    
    // Create assertive region
    this.regions.assertive = document.createElement('div');
    this.regions.assertive.setAttribute('aria-live', 'assertive');
    this.regions.assertive.setAttribute('aria-atomic', 'true');
    this.regions.assertive.className = 'sr-only';
    document.body.appendChild(this.regions.assertive);
  }
  
  /**
   * Announce message to screen readers
   * @param {string} message - Message to announce
   * @param {string} priority - 'polite' or 'assertive'
   */
  announce(message, priority = 'polite') {
    const region = this.regions[priority];
    if (!region) {
      console.warn(`Invalid priority: ${priority}`);
      return;
    }
    
    // Clear and set new message
    region.textContent = '';
    setTimeout(() => {
      region.textContent = message;
    }, 100);
  }
  
  /**
   * Announce politely (non-interrupting)
   */
  announcePolite(message) {
    this.announce(message, 'polite');
  }
  
  /**
   * Announce assertively (interrupting)
   */
  announceAssertive(message) {
    this.announce(message, 'assertive');
  }
}

/**
 * Keyboard Navigation Handler
 */
export class KeyboardNav {
  constructor() {
    this.handlers = new Map();
    this.init();
  }
  
  init() {
    document.addEventListener('keydown', (e) => {
      this.handleKeyDown(e);
    });
  }
  
  handleKeyDown(e) {
    // Escape key - global handler
    if (e.key === 'Escape') {
      this.trigger('escape', e);
    }
    
    // Slash key for search (when not in input)
    if (e.key === '/' && !this.isInputFocused()) {
      e.preventDefault();
      this.trigger('search', e);
    }
    
    // Cmd/Ctrl + K for command palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      this.trigger('command', e);
    }
    
    // Arrow keys for navigation
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      this.trigger('arrow', { direction: e.key.replace('Arrow', '').toLowerCase(), event: e });
    }
  }
  
  isInputFocused() {
    const active = document.activeElement;
    return active && (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.isContentEditable
    );
  }
  
  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(handler);
  }
  
  off(event, handler) {
    if (!this.handlers.has(event)) return;
    const handlers = this.handlers.get(event);
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }
  
  trigger(event, data) {
    if (!this.handlers.has(event)) return;
    for (const handler of this.handlers.get(event)) {
      handler(data);
    }
  }
}

/**
 * Skip Links Manager
 */
export class SkipLinks {
  constructor() {
    this.links = [];
  }
  
  add(label, targetId) {
    this.links.push({ label, targetId });
  }
  
  render() {
    const nav = document.createElement('nav');
    nav.className = 'skip-links';
    nav.setAttribute('aria-label', 'Skip links');
    
    for (const { label, targetId } of this.links) {
      const link = document.createElement('a');
      link.href = `#${targetId}`;
      link.className = 'skip-link';
      link.textContent = label;
      
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById(targetId);
        if (target) {
          target.focus();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      
      nav.appendChild(link);
    }
    
    return nav;
  }
}

/**
 * ARIA Helper
 */
export const aria = {
  /**
   * Set ARIA label
   */
  label(element, label) {
    element.setAttribute('aria-label', label);
  },
  
  /**
   * Set ARIA described by
   */
  describedBy(element, id) {
    element.setAttribute('aria-describedby', id);
  },
  
  /**
   * Set ARIA expanded
   */
  expanded(element, isExpanded) {
    element.setAttribute('aria-expanded', String(isExpanded));
  },
  
  /**
   * Set ARIA pressed
   */
  pressed(element, isPressed) {
    element.setAttribute('aria-pressed', String(isPressed));
  },
  
  /**
   * Set ARIA hidden
   */
  hidden(element, isHidden) {
    element.setAttribute('aria-hidden', String(isHidden));
  },
  
  /**
   * Set ARIA live region
   */
  live(element, level = 'polite') {
    element.setAttribute('aria-live', level);
    element.setAttribute('aria-atomic', 'true');
  },
  
  /**
   * Set ARIA busy
   */
  busy(element, isBusy) {
    element.setAttribute('aria-busy', String(isBusy));
  },
  
  /**
   * Set ARIA current
   */
  current(element, value = 'page') {
    element.setAttribute('aria-current', value);
  },
  
  /**
   * Create description element
   */
  createDescription(id, text) {
    const desc = document.createElement('div');
    desc.id = id;
    desc.className = 'sr-only';
    desc.textContent = text;
    return desc;
  }
};

/**
 * Color Contrast Checker (WCAG AA/AAA)
 */
export class ContrastChecker {
  /**
   * Calculate relative luminance
   */
  getLuminance(r, g, b) {
    const [rs, gs, bs] = [r, g, b].map(c => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }
  
  /**
   * Calculate contrast ratio
   */
  getContrastRatio(color1, color2) {
    const lum1 = this.getLuminance(...color1);
    const lum2 = this.getLuminance(...color2);
    const lighter = Math.max(lum1, lum2);
    const darker = Math.min(lum1, lum2);
    return (lighter + 0.05) / (darker + 0.05);
  }
  
  /**
   * Check if contrast meets WCAG standards
   */
  meetsWCAG(ratio, level = 'AA', size = 'normal') {
    if (level === 'AA') {
      return size === 'large' ? ratio >= 3 : ratio >= 4.5;
    } else if (level === 'AAA') {
      return size === 'large' ? ratio >= 4.5 : ratio >= 7;
    }
    return false;
  }
  
  /**
   * Parse hex color to RGB
   */
  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [
      parseInt(result[1], 16),
      parseInt(result[2], 16),
      parseInt(result[3], 16)
    ] : null;
  }
}

/**
 * Reduced Motion Support
 */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * High Contrast Mode Detection
 */
export function prefersHighContrast() {
  return window.matchMedia('(prefers-contrast: high)').matches;
}

/**
 * Screen Reader Detection (approximate)
 */
export function isScreenReaderActive() {
  // This is approximate - true detection is not reliably possible
  return !!(navigator.userAgent.match(/screen reader|JAWS|NVDA|VoiceOver/i));
}

// Export singleton instances
export const focusManager = new FocusManager();
export const liveAnnouncer = new LiveAnnouncer();
export const keyboardNav = new KeyboardNav();
export const contrastChecker = new ContrastChecker();






