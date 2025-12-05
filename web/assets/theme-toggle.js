/**
 * Theme Toggle Component
 * Renders and manages the theme toggle UI
 */

(function() {
  'use strict';
  
  /**
   * Create and inject theme toggle HTML
   */
  function createToggle() {
    const container = document.createElement('div');
    container.className = 'theme-toggle';
    container.id = 'theme-toggle';
    
    container.innerHTML = `
      <button 
        class="theme-toggle-btn" 
        id="theme-toggle-btn"
        aria-label="Toggle theme"
        title="Toggle light/dark mode"
      >
        <svg class="theme-icon theme-icon-sun" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4"/>
          <path d="M12 2v2"/>
          <path d="M12 20v2"/>
          <path d="m4.93 4.93 1.41 1.41"/>
          <path d="m17.66 17.66 1.41 1.41"/>
          <path d="M2 12h2"/>
          <path d="M20 12h2"/>
          <path d="m6.34 17.66-1.41 1.41"/>
          <path d="m19.07 4.93-1.41 1.41"/>
        </svg>
        <svg class="theme-icon theme-icon-moon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
        </svg>
        <span class="theme-toggle-auto-badge"></span>
      </button>
      <div class="theme-toggle-tooltip" id="theme-toggle-tooltip"></div>
    `;
    
    document.body.appendChild(container);
    
    // Setup event listeners
    const btn = document.getElementById('theme-toggle-btn');
    btn.addEventListener('click', handleToggle);
    
    // Update tooltip on theme change
    if (window.WorkrailTheme) {
      window.WorkrailTheme.onChange(updateTooltip);
      updateTooltip(window.WorkrailTheme.getTheme());
    }
    
    console.log('[ThemeToggle] Component initialized');
  }
  
  /**
   * Handle toggle button click
   */
  function handleToggle(e) {
    if (!window.WorkrailTheme) {
      console.error('[ThemeToggle] WorkrailTheme not available');
      return;
    }
    
    // Cycle through: light → dark → light
    window.WorkrailTheme.toggle();
    
    // Add a little bounce animation
    const btn = document.getElementById('theme-toggle-btn');
    btn.style.animation = 'none';
    setTimeout(() => {
      btn.style.animation = '';
    }, 10);
    
    // Remove focus to prevent persistent border after click
    btn.blur();
  }
  
  /**
   * Update tooltip text
   */
  function updateTooltip(theme) {
    const tooltip = document.getElementById('theme-toggle-tooltip');
    const container = document.getElementById('theme-toggle');
    
    if (!tooltip || !container) return;
    
    if (window.WorkrailTheme && window.WorkrailTheme.isAuto()) {
      tooltip.textContent = `Auto (${theme})`;
      container.classList.add('is-auto');
    } else {
      tooltip.textContent = theme === 'dark' ? 'Dark mode' : 'Light mode';
      container.classList.remove('is-auto');
    }
  }
  
  /**
   * Initialize
   */
  function init() {
    // Wait for both DOM and ThemeManager
    const checkReady = () => {
      if (document.body && window.WorkrailTheme) {
        createToggle();
      } else {
        setTimeout(checkReady, 50);
      }
    };
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkReady);
    } else {
      checkReady();
    }
  }
  
  init();
})();
