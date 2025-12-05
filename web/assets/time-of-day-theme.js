/**
 * Workrail Time-of-Day Theming
 * Adjusts background colors based on time of day
 */

(function() {
  'use strict';

  const TIME_THEMES = {
    morning: {
      name: 'morning',
      hours: [6, 7, 8, 9, 10, 11],
      description: 'Warmer tones - energetic start',
      colors: {
        orb1: 'radial-gradient(circle, rgba(249, 115, 22, 0.8), rgba(249, 115, 22, 0.4) 40%, transparent 70%)', // Orange
        orb2: 'radial-gradient(circle, rgba(234, 179, 8, 0.8), rgba(234, 179, 8, 0.4) 40%, transparent 70%)',   // Yellow
        orb3: 'radial-gradient(circle, rgba(236, 72, 153, 0.7), rgba(236, 72, 153, 0.35) 40%, transparent 70%)', // Pink
        orb4: 'radial-gradient(circle, rgba(249, 115, 22, 0.7), rgba(249, 115, 22, 0.35) 40%, transparent 70%)', // Orange
        orb5: 'radial-gradient(circle, rgba(234, 179, 8, 0.6), rgba(234, 179, 8, 0.3) 40%, transparent 70%)'    // Yellow
      }
    },
    afternoon: {
      name: 'afternoon',
      hours: [12, 13, 14, 15, 16, 17],
      description: 'Balanced palette - productive hours',
      colors: {
        orb1: 'radial-gradient(circle, rgba(6, 182, 212, 0.8), rgba(6, 182, 212, 0.4) 40%, transparent 70%)',  // Cyan (default)
        orb2: 'radial-gradient(circle, rgba(139, 92, 246, 0.8), rgba(139, 92, 246, 0.4) 40%, transparent 70%)', // Purple
        orb3: 'radial-gradient(circle, rgba(236, 72, 153, 0.8), rgba(236, 72, 153, 0.4) 40%, transparent 70%)', // Pink
        orb4: 'radial-gradient(circle, rgba(249, 115, 22, 0.8), rgba(249, 115, 22, 0.4) 40%, transparent 70%)', // Orange
        orb5: 'radial-gradient(circle, rgba(16, 185, 129, 0.7), rgba(16, 185, 129, 0.35) 40%, transparent 70%)' // Green
      }
    },
    evening: {
      name: 'evening',
      hours: [18, 19, 20, 21, 22, 23],
      description: 'Cooler tones - winding down',
      colors: {
        orb1: 'radial-gradient(circle, rgba(59, 130, 246, 0.8), rgba(59, 130, 246, 0.4) 40%, transparent 70%)',  // Blue
        orb2: 'radial-gradient(circle, rgba(139, 92, 246, 0.9), rgba(139, 92, 246, 0.45) 40%, transparent 70%)', // Purple
        orb3: 'radial-gradient(circle, rgba(6, 182, 212, 0.7), rgba(6, 182, 212, 0.35) 40%, transparent 70%)',   // Cyan
        orb4: 'radial-gradient(circle, rgba(99, 102, 241, 0.7), rgba(99, 102, 241, 0.35) 40%, transparent 70%)', // Indigo
        orb5: 'radial-gradient(circle, rgba(139, 92, 246, 0.6), rgba(139, 92, 246, 0.3) 40%, transparent 70%)'  // Purple
      }
    },
    night: {
      name: 'night',
      hours: [0, 1, 2, 3, 4, 5],
      description: 'Deep tones - focused work',
      colors: {
        orb1: 'radial-gradient(circle, rgba(99, 102, 241, 0.7), rgba(99, 102, 241, 0.35) 40%, transparent 70%)', // Indigo
        orb2: 'radial-gradient(circle, rgba(139, 92, 246, 0.8), rgba(139, 92, 246, 0.4) 40%, transparent 70%)',  // Purple
        orb3: 'radial-gradient(circle, rgba(59, 130, 246, 0.6), rgba(59, 130, 246, 0.3) 40%, transparent 70%)',  // Blue
        orb4: 'radial-gradient(circle, rgba(6, 182, 212, 0.6), rgba(6, 182, 212, 0.3) 40%, transparent 70%)',    // Cyan
        orb5: 'radial-gradient(circle, rgba(99, 102, 241, 0.5), rgba(99, 102, 241, 0.25) 40%, transparent 70%)' // Indigo
      }
    }
  };

  /**
   * Get current time theme
   */
  function getCurrentTheme() {
    const hour = new Date().getHours();
    
    for (const theme of Object.values(TIME_THEMES)) {
      if (theme.hours.includes(hour)) {
        return theme;
      }
    }
    
    return TIME_THEMES.afternoon; // Fallback
  }

  /**
   * Apply theme to orbs
   */
  function applyTheme(theme, options = {}) {
    const { transition = true, log = true } = options;
    
    // Set data attribute for CSS hooks
    document.documentElement.setAttribute('data-time-theme', theme.name);
    
    // Apply colors to orbs
    for (let i = 1; i <= 5; i++) {
      const orb = document.querySelector(`.bg-orb-${i}`);
      if (orb) {
        if (transition) {
          orb.style.transition = 'background 3s ease-in-out';
        }
        orb.style.background = theme.colors[`orb${i}`];
      }
    }
    
    if (log) {
      console.log(`🌅 [TimeTheme] Applied "${theme.name}" theme - ${theme.description}`);
    }
  }

  /**
   * Initialize and set up auto-refresh
   */
  function init() {
    const theme = getCurrentTheme();
    
    // Apply initial theme without transition
    applyTheme(theme, { transition: false });
    
    // Check every 10 minutes if theme should change
    setInterval(() => {
      const newTheme = getCurrentTheme();
      if (newTheme.name !== theme.name) {
        applyTheme(newTheme);
      }
    }, 10 * 60 * 1000); // 10 minutes
  }

  // Expose API
  window.WorkrailTimeTheme = {
    getCurrentTheme,
    applyTheme,
    themes: TIME_THEMES,
    forceTheme: (themeName) => {
      const theme = TIME_THEMES[themeName];
      if (theme) {
        applyTheme(theme);
      } else {
        console.warn(`[TimeTheme] Unknown theme: ${themeName}`);
      }
    }
  };

  // Auto-initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
