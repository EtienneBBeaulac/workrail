/**
 * Workrail Theme Manager
 * 
 * Handles theme detection, switching, and persistence.
 * Supports:
 * - Auto-detection via prefers-color-scheme
 * - Manual override with localStorage persistence
 * - Smooth transitions between themes
 * - Event-based updates for UI components
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'workrail-theme';
  const THEME_ATTRIBUTE = 'data-theme';
  
  /**
   * Theme state
   */
  let currentTheme = 'light'; // 'light' or 'dark'
  let userPreference = null;  // null (auto), 'light', or 'dark'
  let listeners = [];
  
  /**
   * Get system theme preference
   */
  function getSystemTheme() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }
  
  /**
   * Get stored user preference
   */
  function getStoredPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      console.warn('[ThemeManager] localStorage not available');
      return null;
    }
  }
  
  /**
   * Store user preference
   */
  function storePreference(theme) {
    try {
      if (theme === null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, theme);
      }
    } catch (e) {
      console.warn('[ThemeManager] Failed to store preference');
    }
  }
  
  /**
   * Determine which theme to use
   */
  function resolveTheme() {
    // Priority: user preference > system preference
    if (userPreference !== null) {
      return userPreference;
    }
    return getSystemTheme();
  }
  
  /**
   * Apply theme to DOM (with smooth color transition)
   */
  function applyTheme(theme) {
    const html = document.documentElement;
    
    // Update data attribute - colors will animate smoothly via CSS
    if (theme === 'dark') {
      html.setAttribute(THEME_ATTRIBUTE, 'dark');
    } else {
      html.removeAttribute(THEME_ATTRIBUTE);
    }
    
    currentTheme = theme;
    
    // Notify listeners
    listeners.forEach(callback => {
      try {
        callback(theme);
      } catch (e) {
        console.error('[ThemeManager] Listener error:', e);
      }
    });
    
    console.log(`[ThemeManager] Theme applied: ${theme} (user preference: ${userPreference || 'auto'})`);
  }
  
  /**
   * Set theme (public API)
   * @param {string|null} theme - 'light', 'dark', or null for auto
   */
  function setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark' && theme !== null) {
      console.error('[ThemeManager] Invalid theme:', theme);
      return;
    }
    
    userPreference = theme;
    storePreference(theme);
    
    const resolvedTheme = resolveTheme();
    applyTheme(resolvedTheme);
  }
  
  /**
   * Toggle between light and dark
   */
  function toggle() {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
  }
  
  /**
   * Get current theme
   */
  function getTheme() {
    return currentTheme;
  }
  
  /**
   * Get user preference (null if auto)
   */
  function getPreference() {
    return userPreference;
  }
  
  /**
   * Check if using auto mode
   */
  function isAuto() {
    return userPreference === null;
  }
  
  /**
   * Add theme change listener
   * @param {Function} callback - Called with theme ('light' or 'dark')
   * @returns {Function} - Unsubscribe function
   */
  function onChange(callback) {
    listeners.push(callback);
    
    // Return unsubscribe function
    return () => {
      listeners = listeners.filter(cb => cb !== callback);
    };
  }
  
  /**
   * Initialize theme system
   */
  function init() {
    // Load stored preference
    const stored = getStoredPreference();
    if (stored === 'light' || stored === 'dark') {
      userPreference = stored;
    }
    
    // Apply initial theme
    const theme = resolveTheme();
    applyTheme(theme);
    
    // Listen for system theme changes (when in auto mode)
    if (window.matchMedia) {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      
      // Modern API
      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', (e) => {
          if (userPreference === null) {
            // Only update if in auto mode
            const newTheme = e.matches ? 'dark' : 'light';
            applyTheme(newTheme);
          }
        });
      }
      // Legacy API
      else if (mediaQuery.addListener) {
        mediaQuery.addListener((e) => {
          if (userPreference === null) {
            const newTheme = e.matches ? 'dark' : 'light';
            applyTheme(newTheme);
          }
        });
      }
    }
    
    console.log('[ThemeManager] Initialized');
    console.log(`  - Current theme: ${currentTheme}`);
    console.log(`  - User preference: ${userPreference || 'auto (following system)'}`);
    console.log(`  - System preference: ${getSystemTheme()}`);
  }
  
  // Public API
  window.WorkrailTheme = {
    setTheme,
    toggle,
    getTheme,
    getPreference,
    isAuto,
    onChange,
    
    // Convenience methods
    setLight: () => setTheme('light'),
    setDark: () => setTheme('dark'),
    setAuto: () => setTheme(null),
  };
  
  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
