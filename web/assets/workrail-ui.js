/**
 * ========================================
 * WORKRAIL UI SYSTEM v2.0
 * ========================================
 * 
 * Complete UI framework for dashboards
 * Based on test-design-system.html (battle-tested)
 * 
 * Usage:
 *   <script src="/assets/workrail-ui.js"></script>
 *   const dashboard = WorkrailUI.createDashboard({ ... });
 * 
 * Generated: 2025-10-02T17:22:15.378Z
 */

(function(global) {
  'use strict';
  
  console.log('%c🚀 Workrail UI System v2.0', 'color: #8b5cf6; font-weight: bold; font-size: 14px;');
  
  // ============================================
  // EXISTING FUNCTIONALITY
  // ============================================
  

  // ============================================
  // THEME-MANAGER
  // ============================================

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


  // ============================================
  // THEME-TOGGLE
  // ============================================

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


  // ============================================
  // PARTICLE-GENERATOR
  // ============================================

/**
 * Workrail Background - Particle Generator
 * Dynamically creates particles with random properties
 */

(function() {
  'use strict';

  const PARTICLE_CONFIG = {
    count: 12,
    colors: [
      { bg: 'rgba(139, 92, 246, 0.6)', glow: 'rgba(139, 92, 246, 0.4)' },  // Purple
      { bg: 'rgba(236, 72, 153, 0.6)', glow: 'rgba(236, 72, 153, 0.4)' },  // Pink
      { bg: 'rgba(59, 130, 246, 0.6)', glow: 'rgba(59, 130, 246, 0.4)' },  // Blue
      { bg: 'rgba(16, 185, 129, 0.6)', glow: 'rgba(16, 185, 129, 0.4)' },  // Green
      { bg: 'rgba(249, 115, 22, 0.6)', glow: 'rgba(249, 115, 22, 0.4)' },  // Orange
      { bg: 'rgba(234, 179, 8, 0.6)', glow: 'rgba(234, 179, 8, 0.4)' }     // Yellow
    ],
    size: { min: 2, max: 4 },
    duration: { min: 15, max: 30 },
    delay: { min: 0, max: 3 }, // Reduced from 10 to 3 seconds for faster start
    collision: {
      enabled: true,
      checkInterval: 100, // ms
      detectionRadius: 15, // pixels
      explosionParticles: { min: 4, max: 7 },
      explosionSpeed: { min: 50, max: 150 }, // pixels
      explosionDuration: 800 // ms
    }
  };

  /**
   * Random number between min and max
   */
  function random(min, max) {
    return Math.random() * (max - min) + min;
  }

  /**
   * Random integer between min and max (inclusive)
   */
  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Pick random item from array
   */
  function randomPick(array) {
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * Generate a random particle path
   * Returns: { startX, startY, endX, endY, controlPoints }
   */
  function generatePath() {
    const directions = [
      'left-to-right',
      'right-to-left',
      'top-to-bottom',
      'bottom-to-top',
      'diagonal-tl-br',
      'diagonal-tr-bl'
    ];
    
    const direction = randomPick(directions);
    let path = {};
    
    switch (direction) {
      case 'left-to-right':
        path = {
          startX: -5,
          startY: random(10, 90),
          endX: 105,
          endY: random(10, 90),
          midY: random(10, 90)
        };
        break;
      
      case 'right-to-left':
        path = {
          startX: 105,
          startY: random(10, 90),
          endX: -5,
          endY: random(10, 90),
          midY: random(10, 90)
        };
        break;
      
      case 'top-to-bottom':
        path = {
          startX: random(10, 90),
          startY: -5,
          endX: random(10, 90),
          endY: 105,
          midX: random(10, 90)
        };
        break;
      
      case 'bottom-to-top':
        path = {
          startX: random(10, 90),
          startY: 105,
          endX: random(10, 90),
          endY: -5,
          midX: random(10, 90)
        };
        break;
      
      case 'diagonal-tl-br':
        path = {
          startX: -5,
          startY: -5,
          endX: 105,
          endY: 105,
          midX: random(30, 70),
          midY: random(30, 70)
        };
        break;
      
      case 'diagonal-tr-bl':
        path = {
          startX: 105,
          startY: -5,
          endX: -5,
          endY: 105,
          midX: random(30, 70),
          midY: random(30, 70)
        };
        break;
    }
    
    return path;
  }

  /**
   * Create CSS keyframes for a particle path
   */
  function createKeyframes(id, path) {
    const keyframeName = `particleFlow${id}`;
    
    // Build keyframe animation with subtle variations
    const keyframesCSS = `
      @keyframes ${keyframeName} {
        0% {
          left: ${path.startX}%;
          top: ${path.startY}%;
          opacity: 0;
        }
        10% {
          opacity: 0.8;
          ${path.midX ? `left: ${path.startX + (path.midX - path.startX) * 0.1}%;` : ''}
          ${path.midY ? `top: ${path.startY + (path.midY - path.startY) * 0.1}%;` : ''}
        }
        50% {
          opacity: 1;
          ${path.midX ? `left: ${path.midX}%;` : ''}
          ${path.midY ? `top: ${path.midY}%;` : ''}
        }
        90% {
          opacity: 0.8;
          ${path.midX ? `left: ${path.endX - (path.endX - path.midX) * 0.1}%;` : ''}
          ${path.midY ? `top: ${path.endY - (path.endY - path.midY) * 0.1}%;` : ''}
        }
        100% {
          left: ${path.endX}%;
          top: ${path.endY}%;
          opacity: 0;
        }
      }
    `;
    
    return { name: keyframeName, css: keyframesCSS };
  }

  /**
   * Generate and inject all particles
   */
  function generateParticles() {
    const container = document.querySelector('.bg-particles');
    if (!container) {
      console.warn('[ParticleGenerator] .bg-particles container not found');
      return;
    }

    // Clear existing particles
    container.innerHTML = '';
    
    // Create style element for keyframes
    let styleEl = document.getElementById('particle-keyframes');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'particle-keyframes';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = '';

    // Generate particles
    for (let i = 1; i <= PARTICLE_CONFIG.count; i++) {
      const color = randomPick(PARTICLE_CONFIG.colors);
      const size = random(PARTICLE_CONFIG.size.min, PARTICLE_CONFIG.size.max);
      const duration = random(PARTICLE_CONFIG.duration.min, PARTICLE_CONFIG.duration.max);
      const delay = random(PARTICLE_CONFIG.delay.min, PARTICLE_CONFIG.delay.max);
      const path = generatePath();
      const keyframes = createKeyframes(i, path);
      
      // Create particle element
      const particle = document.createElement('div');
      particle.className = `particle particle-${i}`;
      particle.style.setProperty('--particle-color', color.bg);
      particle.style.setProperty('--particle-glow', color.glow);
      particle.style.setProperty('--particle-size', `${size}px`);
      particle.style.animation = `${keyframes.name} ${duration}s linear ${delay}s infinite`;
      
      // Set initial position
      particle.style.left = `${path.startX}%`;
      particle.style.top = `${path.startY}%`;
      
      container.appendChild(particle);
      
      // Inject keyframes
      styleEl.textContent += keyframes.css;
    }

    console.log(`✨ [ParticleGenerator] Generated ${PARTICLE_CONFIG.count} random particles`);
    
    // Notify interaction system that particles are ready
    if (window.WorkrailBackground && window.WorkrailBackground.refreshElements) {
      setTimeout(() => {
        window.WorkrailBackground.refreshElements();
        console.log('✨ [ParticleGenerator] Notified interaction system');
      }, 100);
    }
  }

  /**
   * Get current position of a particle element
   * Uses computed style to get the actual animated position
   */
  function getParticlePosition(particle) {
    const computed = window.getComputedStyle(particle);
    const transform = computed.transform;
    
    // Try to get position from transform matrix if available
    if (transform && transform !== 'none') {
      const matrix = new DOMMatrix(transform);
      const rect = particle.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    }
    
    // Fallback to left/top properties
    const left = parseFloat(computed.left) || 0;
    const top = parseFloat(computed.top) || 0;
    const width = parseFloat(computed.width) || 3;
    const height = parseFloat(computed.height) || 3;
    
    return {
      x: left + width / 2,
      y: top + height / 2
    };
  }

  /**
   * Calculate distance between two points
   */
  function getDistance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  }

  /**
   * Create an explosion particle
   */
  function createExplosionParticle(x, y, angle, speed, color) {
    const container = document.querySelector('.bg-particles');
    if (!container) {
      console.warn('[ParticleGenerator] No container for explosion particle');
      return;
    }

    const particle = document.createElement('div');
    particle.className = 'particle explosion-particle';
    
    // Set CSS variables
    particle.style.setProperty('--particle-color', color.bg);
    particle.style.setProperty('--particle-glow', color.glow);
    particle.style.setProperty('--particle-size', '4px'); // Larger for visibility
    
    // Position and style
    particle.style.position = 'fixed';
    particle.style.left = x + 'px';
    particle.style.top = y + 'px';
    particle.style.opacity = '1';
    particle.style.pointerEvents = 'none';
    particle.style.zIndex = '10000';
    particle.style.background = color.bg;
    particle.style.boxShadow = `0 0 10px ${color.glow}`;
    particle.style.borderRadius = '50%';
    particle.style.width = '4px';
    particle.style.height = '4px';
    
    const endX = x + Math.cos(angle) * speed;
    const endY = y + Math.sin(angle) * speed;
    
    particle.style.transition = `
      left ${PARTICLE_CONFIG.collision.explosionDuration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94),
      top ${PARTICLE_CONFIG.collision.explosionDuration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94),
      opacity ${PARTICLE_CONFIG.collision.explosionDuration}ms ease-out,
      transform ${PARTICLE_CONFIG.collision.explosionDuration}ms ease-out
    `;
    
    container.appendChild(particle);
    
    // Trigger animation on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        particle.style.left = endX + 'px';
        particle.style.top = endY + 'px';
        particle.style.opacity = '0';
        particle.style.transform = 'scale(0.3)';
      });
    });
    
    // Remove after animation
    setTimeout(() => {
      particle.remove();
    }, PARTICLE_CONFIG.collision.explosionDuration + 100);
  }

  /**
   * Create explosion at collision point
   */
  function createExplosion(x, y, color1, color2) {
    const count = randomInt(
      PARTICLE_CONFIG.collision.explosionParticles.min,
      PARTICLE_CONFIG.collision.explosionParticles.max
    );
    
    console.log(`💥 [ParticleGenerator] Explosion at (${Math.round(x)}, ${Math.round(y)}) - spawning ${count} particles`);
    
    // Create particles in a burst pattern
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + random(-0.3, 0.3);
      const speed = random(
        PARTICLE_CONFIG.collision.explosionSpeed.min,
        PARTICLE_CONFIG.collision.explosionSpeed.max
      );
      
      // Alternate between the two colliding colors
      const color = i % 2 === 0 ? color1 : color2;
      
      // Slight delay for staggered effect
      setTimeout(() => {
        createExplosionParticle(x, y, angle, speed, color);
      }, i * 20);
    }
  }

  /**
   * Check for particle collisions
   */
  let collisionCheckInterval;
  let recentCollisions = new Set(); // Track recent collisions to prevent duplicates
  
  function checkCollisions() {
    if (!PARTICLE_CONFIG.collision.enabled) return;
    
    const particles = Array.from(document.querySelectorAll('.particle:not(.explosion-particle)'));
    const radius = PARTICLE_CONFIG.collision.detectionRadius;
    
    // Debug: Log particle count on first run
    if (particles.length === 0) {
      console.warn('[ParticleGenerator] No particles found for collision detection');
      return;
    }
    
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const p1 = particles[i];
        const p2 = particles[j];
        
        // Create unique collision ID using class names for stability
        const id1 = p1.className.split(' ').find(c => c.startsWith('particle-')) || `p${i}`;
        const id2 = p2.className.split(' ').find(c => c.startsWith('particle-')) || `p${j}`;
        const collisionId = `${id1}-${id2}`;
        
        // Skip if this collision happened recently (within 5 seconds)
        if (recentCollisions.has(collisionId)) continue;
        
        const pos1 = getParticlePosition(p1);
        const pos2 = getParticlePosition(p2);
        
        // Skip if positions are invalid (offscreen or at 0,0)
        if (pos1.x <= 0 || pos1.y <= 0 || pos2.x <= 0 || pos2.y <= 0) continue;
        
        const distance = getDistance(pos1.x, pos1.y, pos2.x, pos2.y);
        
        if (distance < radius && distance > 0) {
          // Collision detected!
          const midX = (pos1.x + pos2.x) / 2;
          const midY = (pos1.y + pos2.y) / 2;
          
          // Get colors from particles
          const color1 = {
            bg: p1.style.getPropertyValue('--particle-color') || 'rgba(139, 92, 246, 0.6)',
            glow: p1.style.getPropertyValue('--particle-glow') || 'rgba(139, 92, 246, 0.4)'
          };
          const color2 = {
            bg: p2.style.getPropertyValue('--particle-color') || 'rgba(236, 72, 153, 0.6)',
            glow: p2.style.getPropertyValue('--particle-glow') || 'rgba(236, 72, 153, 0.4)'
          };
          
          console.log(`💥 Collision between ${id1} and ${id2} at distance ${distance.toFixed(1)}px`);
          console.log(`   Positions: (${pos1.x.toFixed(0)}, ${pos1.y.toFixed(0)}) and (${pos2.x.toFixed(0)}, ${pos2.y.toFixed(0)})`);
          
          createExplosion(midX, midY, color1, color2);
          
          // Mark collision as recent
          recentCollisions.add(collisionId);
          
          // Remove from recent collisions after 5 seconds
          setTimeout(() => {
            recentCollisions.delete(collisionId);
          }, 5000);
        }
      }
    }
  }

  /**
   * Start collision detection
   */
  function startCollisionDetection() {
    if (!PARTICLE_CONFIG.collision.enabled) return;
    
    // Clear any existing interval
    if (collisionCheckInterval) {
      clearInterval(collisionCheckInterval);
    }
    
    // Start checking for collisions
    collisionCheckInterval = setInterval(
      checkCollisions,
      PARTICLE_CONFIG.collision.checkInterval
    );
    
    console.log('💥 [ParticleGenerator] Collision detection started');
  }

  /**
   * Stop collision detection
   */
  function stopCollisionDetection() {
    if (collisionCheckInterval) {
      clearInterval(collisionCheckInterval);
      collisionCheckInterval = null;
    }
  }

  /**
   * Initialize
   */
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        generateParticles();
        setTimeout(startCollisionDetection, 1000);
      });
    } else {
      generateParticles();
      setTimeout(startCollisionDetection, 1000);
    }
  }

  // Expose global function for re-generation
  window.WorkrailParticles = {
    generate: () => {
      stopCollisionDetection();
      generateParticles();
      setTimeout(startCollisionDetection, 1000);
    },
    startCollisions: startCollisionDetection,
    stopCollisions: stopCollisionDetection,
    config: PARTICLE_CONFIG
  };

  init();


  // ============================================
  // BACKGROUND-INTERACTION
  // ============================================

/**
 * Workrail Background Interaction v1.0
 * Mouse-driven disturbance effects for workflow-themed backgrounds
 * 
 * Usage:
 * <script src="/assets/background-interaction.js"></script>
 * <script>
 *   document.addEventListener('DOMContentLoaded', () => {
 *     WorkrailBackground.enableInteraction();
 *   });
 * </script>
 */

const WorkrailBackground = (function() {
  let isEnabled = false;
  let rafId = null;
  let mouseX = 0;
  let mouseY = 0;
  
  // Configuration
  const config = {
    disturbanceRadius: 50, // pixels - very close! cursor must be near
    railDisturbanceRadius: 25, // pixels - VERY close for rails (was too far)
    checkInterval: 16, // ~60fps
  };
  
  // Get all interactive elements
  const elements = {
    rails: [],
    nodes: [],
    particles: []
  };
  
  /**
   * Cache/refresh all interactive elements
   */
  function cacheElements() {
    elements.rails = Array.from(document.querySelectorAll('.rail-path'));
    elements.nodes = Array.from(document.querySelectorAll('.workflow-node'));
    elements.particles = Array.from(document.querySelectorAll('.particle:not(.explosion-particle)'));
    
    const total = elements.rails.length + elements.nodes.length + elements.particles.length;
    console.log(`[WorkrailBackground] Cached ${total} elements (${elements.particles.length} particles)`);
    
    return total;
  }
  
  /**
   * Calculate distance between cursor and element
   */
  function getDistance(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  /**
   * Get element's center position
   */
  function getElementCenter(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }
  
  /**
   * Check if cursor is near a rail path
   * Calculate actual visual position from CSS properties, ignoring transform distortions
   */
    function checkRailProximity(rail) {
      const radius = config.railDisturbanceRadius;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      
      // Define rail geometry: center position + rotation
      let railConfig;
      
      if (rail.classList.contains('rail-h1')) {
        // CSS: top: 25%, height: 80px, rotate: 3deg
        railConfig = {
          name: 'rail-h1',
          centerY: vh * 0.25 + 40, // top + half height
          rotation: 3 * Math.PI / 180, // degrees to radians
          isHorizontal: true
        };
      } else if (rail.classList.contains('rail-h2')) {
        // CSS: bottom: 30%, height: 80px, rotate: -2deg
        // bottom: 30% means bottom edge is at 70% from top
        // With height 80px, center is 40px above that
        railConfig = {
          name: 'rail-h2',
          centerY: vh * 0.70 - 40, // bottom position - half height
          rotation: -2 * Math.PI / 180,
          isHorizontal: true
        };
      } else if (rail.classList.contains('rail-d1')) {
        // CSS: top: 5%, height: 2px, rotate: 23deg, origin: top left
        railConfig = {
          name: 'rail-d1',
          x1: 0,
          y1: vh * 0.05,
          x2: vw,
          y2: vh * 0.05 + vw * Math.tan(23 * Math.PI / 180),
          isHorizontal: false
        };
      } else if (rail.classList.contains('rail-d2')) {
        // CSS: top: 15%, rotate: -27deg, origin: top right
        railConfig = {
          name: 'rail-d2',
          x1: vw,
          y1: vh * 0.15,
          x2: 0,
          y2: vh * 0.15 + vw * Math.tan(27 * Math.PI / 180),
          isHorizontal: false
        };
      } else {
        return false;
      }
      
      let distance;
      
      if (railConfig.isHorizontal) {
        // For nearly-horizontal rails: simple Y-distance check
        // The rotation is so small (2-3 degrees) we can approximate
        distance = Math.abs(mouseY - railConfig.centerY);
      } else {
        // For diagonal rails: perpendicular distance to line
        // Distance from point (mouseX, mouseY) to line through (x1,y1) and (x2,y2)
        const { x1, y1, x2, y2 } = railConfig;
        const A = y2 - y1;
        const B = x1 - x2;
        const C = x2 * y1 - x1 * y2;
        distance = Math.abs(A * mouseX + B * mouseY + C) / Math.sqrt(A * A + B * B);
      }
      
      const isNear = distance < radius;
      
      // DEBUG: Log when triggered
      if (isNear) {
        console.log(`🎯 ${railConfig.name} triggered at (${mouseX}, ${mouseY}) | distance: ${distance.toFixed(1)}px`);
      }
      
      return isNear;
    }
  
  /**
   * Update disturbance effects based on cursor position
   */
  function updateDisturbance() {
    let disturbedCount = 0;
    
    // Check rails (DISABLED - proximity detection skipped)
    // elements.rails.forEach(rail => {
    //   const isNear = checkRailProximity(rail);
    //   
    //   if (isNear && !rail.classList.contains('disturbed')) {
    //     rail.classList.add('disturbed');
    //     disturbedCount++;
    //   } else if (!isNear && rail.classList.contains('disturbed')) {
    //     rail.classList.remove('disturbed');
    //   }
    // });
    
    // Check nodes (DISABLED - proximity detection skipped)
    // elements.nodes.forEach(node => {
    //   const center = getElementCenter(node);
    //   const distance = getDistance(mouseX, mouseY, center.x, center.y);
    //   const isNear = distance < config.disturbanceRadius;
    //   
    //   if (isNear && !node.classList.contains('disturbed')) {
    //     node.classList.add('disturbed');
    //     disturbedCount++;
    //   } else if (!isNear && node.classList.contains('disturbed')) {
    //     node.classList.remove('disturbed');
    //   }
    // });
    
    // Check particles
    elements.particles.forEach(particle => {
      const center = getElementCenter(particle);
      const distance = getDistance(mouseX, mouseY, center.x, center.y);
      const isNear = distance < config.disturbanceRadius * 0.8; // Slightly smaller radius for particles
      
      if (isNear && !particle.classList.contains('disturbed')) {
        particle.classList.add('disturbed');
        disturbedCount++;
      } else if (!isNear && particle.classList.contains('disturbed')) {
        particle.classList.remove('disturbed');
      }
    });
    
    // Debug logging (disabled)
    // if (disturbedCount > 0) {
    //   console.log(`[WorkrailBackground] ${disturbedCount} elements disturbed at (${mouseX}, ${mouseY})`);
    // }
  }
  
  /**
   * Animation loop
   */
  function animate() {
    updateDisturbance();
    rafId = requestAnimationFrame(animate);
  }
  
  /**
   * Mouse move handler
   */
  function handleMouseMove(event) {
    mouseX = event.clientX;
    mouseY = event.clientY;
  }
  
  /**
   * Initialize and enable interaction
   */
  function enableInteraction() {
    if (isEnabled) {
      console.warn('[WorkrailBackground] Interaction already enabled');
      return;
    }
    
    // Gather all elements
    cacheElements();
    
    const totalElements = elements.rails.length + elements.nodes.length + elements.particles.length;
    
    if (totalElements === 0) {
      console.warn('[WorkrailBackground] No interactive background elements found');
      return;
    }
    
    // Add event listener
    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    
    // Start animation loop
    animate();
    
    isEnabled = true;
    console.log(`[WorkrailBackground] Interaction enabled for ${totalElements} elements`);
  }
  
  /**
   * Disable interaction and cleanup
   */
  function disableInteraction() {
    if (!isEnabled) {
      return;
    }
    
    // Remove event listener
    document.removeEventListener('mousemove', handleMouseMove);
    
    // Cancel animation frame
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    
    // Remove all disturbed classes
    [...elements.rails, ...elements.nodes, ...elements.particles].forEach(el => {
      el.classList.remove('disturbed');
    });
    
    isEnabled = false;
    console.log('[WorkrailBackground] Interaction disabled');
  }
  
  /**
   * Update configuration
   */
  function setConfig(newConfig) {
    Object.assign(config, newConfig);
    console.log('[WorkrailBackground] Config updated:', config);
  }
  
  // Public API
  return {
    enableInteraction,
    disableInteraction,
    setConfig,
    refreshElements: cacheElements,
    isEnabled: () => isEnabled
  };
})();

// Auto-enable if data attribute is present
if (document.documentElement.hasAttribute('data-workrail-interactive')) {
  document.addEventListener('DOMContentLoaded', () => {
    WorkrailBackground.enableInteraction();
  });
}


  // ============================================
  // TIME-OF-DAY-THEME
  // ============================================

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


  // ============================================
  // SCROLL-PARALLAX
  // ============================================

/**
 * Workrail Scroll Parallax
 * Adds subtle depth to background elements on scroll
 */

(function() {
  'use strict';

  const PARALLAX_CONFIG = {
    enabled: true,
    smoothness: 0.1, // Lower = smoother but more lag
    layers: {
      orbs: { speed: 0.15 },      // Slowest - furthest back
      rails: { speed: 0.25 },      // Medium
      nodes: { speed: 0.35 },      // Medium-fast
      particles: { speed: 0.5 }    // Fastest - closest
    }
  };

  let scrollY = 0;
  let targetScrollY = 0;
  let rafId = null;
  let isEnabled = false;

  const elements = {
    orbs: [],
    rails: [],
    nodes: [],
    particles: []
  };

  /**
   * Cache all parallax elements
   */
  function cacheElements() {
    elements.orbs = Array.from(document.querySelectorAll('.bg-orb'));
    elements.rails = Array.from(document.querySelectorAll('.rail-path'));
    elements.nodes = Array.from(document.querySelectorAll('.workflow-node'));
    elements.particles = Array.from(document.querySelectorAll('.particle:not(.explosion-particle)'));
    
    const total = elements.orbs.length + elements.rails.length + 
                  elements.nodes.length + elements.particles.length;
    
    console.log(`[ScrollParallax] Cached ${total} elements for parallax effect`);
    
    return total;
  }

  /**
   * Handle scroll event
   */
  function handleScroll() {
    targetScrollY = window.scrollY || window.pageYOffset;
  }

  /**
   * Apply parallax transforms
   * Uses filter to create depth without affecting animations
   */
  function updateParallax() {
    if (!isEnabled) {
      console.warn('[ScrollParallax] updateParallax called but isEnabled=false');
      return;
    }

    // Smooth scrolling interpolation
    scrollY += (targetScrollY - scrollY) * PARALLAX_CONFIG.smoothness;
    
    // Debug: Log on first few frames
    if (!updateParallax.frameCount) updateParallax.frameCount = 0;
    updateParallax.frameCount++;
    
    if (updateParallax.frameCount < 5) {
      console.log(`[ScrollParallax] Frame ${updateParallax.frameCount}: scrollY=${scrollY}, targetScrollY=${targetScrollY}, orbs=${elements.orbs.length}`);
    }

    // Apply to each layer by adjusting top position
    // Store original top values on first run
    elements.orbs.forEach((orb, index) => {
      if (!orb.dataset.originalTop) {
        const computed = window.getComputedStyle(orb);
        orb.dataset.originalTop = computed.top;
      }
      const offset = Math.round(scrollY * PARALLAX_CONFIG.layers.orbs.speed);
      const original = parseFloat(orb.dataset.originalTop) || 0;
      orb.style.top = `calc(${orb.dataset.originalTop} + ${offset}px)`;
    });

    elements.rails.forEach((rail, index) => {
      if (!rail.dataset.originalTop) {
        const computed = window.getComputedStyle(rail);
        rail.dataset.originalTop = computed.top;
      }
      const offset = Math.round(scrollY * PARALLAX_CONFIG.layers.rails.speed);
      rail.style.top = `calc(${rail.dataset.originalTop} + ${offset}px)`;
    });

    elements.nodes.forEach((node, index) => {
      if (!node.dataset.originalTop) {
        const computed = window.getComputedStyle(node);
        node.dataset.originalTop = computed.top;
      }
      const offset = Math.round(scrollY * PARALLAX_CONFIG.layers.nodes.speed);
      node.style.top = `calc(${node.dataset.originalTop} + ${offset}px)`;
    });

    // Log first frame for debugging (once scroll starts)
    if (!updateParallax.logged && Math.abs(scrollY) > 1) {
      console.log(`[ScrollParallax] 🎬 Active! scrollY=${scrollY.toFixed(0)}, orb offset=${(scrollY * PARALLAX_CONFIG.layers.orbs.speed).toFixed(1)}px`);
      updateParallax.logged = true;
    }

    rafId = requestAnimationFrame(updateParallax);
  }

  /**
   * Enable parallax effect
   */
  function enable() {
    if (isEnabled) {
      console.warn('[ScrollParallax] Already enabled');
      return;
    }

    const total = cacheElements();
    
    if (total === 0) {
      console.warn('[ScrollParallax] No elements found');
      return;
    }

    // Add smooth scroll listener
    window.addEventListener('scroll', handleScroll, { passive: true });
    
    // CRITICAL: Set isEnabled BEFORE starting the loop!
    isEnabled = true;
    console.log(`[ScrollParallax] ✓ Enabled! Tracking ${elements.orbs.length} orbs, ${elements.rails.length} rails`);
    console.log('[ScrollParallax] Scroll the page to see parallax effect');
    
    // Start animation loop
    updateParallax();
    
    // Set initial values
    setTimeout(() => {
      if (elements.orbs.length > 0) {
        const orb = elements.orbs[0];
        console.log(`[ScrollParallax] Initial check - Orb 1 original top: ${orb.dataset.originalTop || '(calculating...)'}`);
        console.log(`[ScrollParallax] Orb 1 current top: ${orb.style.top || '(not set yet)'}`);
      }
    }, 100);
  }

  /**
   * Disable parallax effect
   */
  function disable() {
    if (!isEnabled) return;

    window.removeEventListener('scroll', handleScroll);
    
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    // Reset transforms
    [...elements.orbs, ...elements.rails, ...elements.nodes].forEach(el => {
      el.style.transform = '';
    });

    isEnabled = false;
    console.log('[ScrollParallax] Disabled');
  }

  /**
   * Update configuration
   */
  function setConfig(newConfig) {
    Object.assign(PARALLAX_CONFIG, newConfig);
    console.log('[ScrollParallax] Config updated');
  }

  /**
   * Initialize
   */
  function init() {
    // Auto-enable on load
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(enable, 500); // Wait for other scripts
      });
    } else {
      setTimeout(enable, 500);
    }
  }

  // Expose API
  window.WorkrailParallax = {
    enable,
    disable,
    setConfig,
    refresh: cacheElements,
    isEnabled: () => isEnabled,
    config: PARALLAX_CONFIG
  };

  init();


  // ============================================
  // COMPONENTS
  // ============================================

/**
 * Workrail Component Library
 * Reusable UI components following the design system
 * Similar to Jetpack Compose - define once, use everywhere
 * 
 * Usage:
 *   const card = WorkrailComponents.Card({
 *     title: "My Card",
 *     content: "Card content",
 *     variant: "glass"
 *   });
 *   document.getElementById('container').appendChild(card);
 */

(function(global) {
  'use strict';
  
  const WorkrailComponents = {};
  
  // ============================================
  // UTILITY FUNCTIONS
  // ============================================
  
  /**
   * Create element with classes and attributes
   */
  function createElement(tag, classes = [], attrs = {}, children = []) {
    const el = document.createElement(tag);
    
    if (classes.length > 0) {
      el.className = classes.join(' ');
    }
    
    Object.keys(attrs).forEach(key => {
      if (key.startsWith('data-')) {
        el.setAttribute(key, attrs[key]);
      } else if (key === 'style' && typeof attrs[key] === 'object') {
        Object.assign(el.style, attrs[key]);
      } else {
        el[key] = attrs[key];
      }
    });
    
    children.forEach(child => {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else if (child) {
        el.appendChild(child);
      }
    });
    
    return el;
  }
  
  /**
   * Parse icon string to Lucide icon element
   */
  function createIcon(iconName, size = 20) {
    const i = createElement('i', [], {
      'data-lucide': iconName,
      style: {
        width: `${size}px`,
        height: `${size}px`,
        display: 'inline-block',
        verticalAlign: 'middle'
      }
    });
    
    // Reinitialize Lucide icons if available
    if (global.lucide && global.lucide.createIcons) {
      setTimeout(() => global.lucide.createIcons(), 0);
    }
    
    return i;
  }
  
  // ============================================
  // BUTTON COMPONENT
  // ============================================
  
  /**
   * Button Component
   * @param {Object} config
   * @param {string} config.text - Button text
   * @param {string} config.icon - Lucide icon name
   * @param {string} config.variant - primary|secondary|ghost|danger|glass
   * @param {string} config.size - sm|md|lg
   * @param {Function} config.onClick - Click handler
   * @param {boolean} config.disabled
   * @param {boolean} config.spring - Add spring animation
   */
  WorkrailComponents.Button = function(config) {
    const {
      text = '',
      icon = null,
      variant = 'primary',
      size = 'md',
      onClick = null,
      disabled = false,
      spring = false
    } = config;
    
    const classes = ['btn', `btn-${variant}`];
    if (spring) classes.push('btn-spring');
    if (size !== 'md') classes.push(`btn-${size}`);
    
    const children = [];
    if (icon) {
      children.push(createIcon(icon, size === 'sm' ? 16 : size === 'lg' ? 24 : 20));
    }
    if (text) {
      children.push(text);
    }
    
    const button = createElement('button', classes, { disabled }, children);
    
    if (onClick && !disabled) {
      button.addEventListener('click', onClick);
    }
    
    return button;
  };
  
  // ============================================
  // CARD COMPONENT
  // ============================================
  
  /**
   * Card Component
   * @param {Object} config
   * @param {string|HTMLElement} config.title - Card title
   * @param {string|HTMLElement} config.content - Card content
   * @param {string|HTMLElement} config.footer - Card footer
   * @param {string} config.variant - default|glass|float|workflow
   * @param {string} config.borderColor - Left border accent color (CSS var)
   * @param {Function} config.onClick - Click handler
   * @param {boolean} config.animate - Add entrance animation
   */
  WorkrailComponents.Card = function(config) {
    const {
      title = null,
      content = null,
      footer = null,
      variant = 'default',
      borderColor = null,
      onClick = null,
      animate = false
    } = config;
    
    const classes = ['card'];
    if (variant === 'glass') classes.push('card-glass');
    if (variant === 'float') classes.push('card-float');
    if (variant === 'workflow') classes.push('card-workflow');
    if (animate) classes.push('animate-fade-in');
    
    const children = [];
    
    if (title) {
      const titleEl = typeof title === 'string' 
        ? createElement('h3', ['card-title'], {}, [title])
        : title;
      children.push(titleEl);
    }
    
    if (content) {
      const contentEl = typeof content === 'string'
        ? createElement('div', ['card-content'], {}, [content])
        : content;
      children.push(contentEl);
    }
    
    if (footer) {
      const footerEl = typeof footer === 'string'
        ? createElement('div', ['card-footer'], {}, [footer])
        : footer;
      children.push(footerEl);
    }
    
    const attrs = {};
    if (borderColor) {
      attrs.style = { borderLeftColor: borderColor };
    }
    if (onClick) {
      attrs.style = { ...attrs.style, cursor: 'pointer' };
    }
    
    const card = createElement('div', classes, attrs, children);
    
    if (onClick) {
      card.addEventListener('click', onClick);
    }
    
    return card;
  };
  
  // ============================================
  // SESSION CARD COMPONENT
  // ============================================
  
  /**
   * Session Card Component (specialized card for sessions)
   * @param {Object} config
   * @param {string} config.sessionId - Session ID
   * @param {string} config.title - Session title
   * @param {string} config.status - in_progress|complete
   * @param {number} config.progress - 0-100
   * @param {number} config.confidence - 0-10
   * @param {string} config.phase - Current phase
   * @param {string} config.updated - Last updated timestamp
   * @param {Function} config.onClick - Click handler
   * @param {Function} config.onDelete - Delete handler
   * @param {string} config.borderColor - Accent color
   */
  WorkrailComponents.SessionCard = function(config) {
    const {
      sessionId,
      title,
      status,
      progress,
      confidence,
      phase,
      updated,
      onClick,
      onDelete,
      borderColor = 'var(--primary-500)'
    } = config;
    
    // Header
    const header = createElement('div', ['session-header'], {}, [
      createElement('div', ['session-id'], {}, [sessionId]),
      createElement('span', ['session-status', `status-${status}`], {}, [
        status.replace('_', ' ').toUpperCase()
      ])
    ]);
    
    // Title
    const titleEl = createElement('div', ['session-title'], {}, [title || `${sessionId}: Session data not updating in real-time`]);
    
    // Meta grid
    const metaItems = [
      { label: 'Progress', value: `${progress}%` },
      { label: 'Confidence', value: confidence ? `${confidence}/10` : 'N/A' },
      { label: 'Current Phase', value: phase || 'Phase 0' },
      { label: 'Updated', value: updated || 'Just now' }
    ];
    
    const metaGrid = createElement('div', ['session-meta'], {}, 
      metaItems.map(item => 
        createElement('div', ['meta-item'], {}, [
          createElement('div', ['meta-label'], {}, [item.label]),
          createElement('div', ['meta-value'], {}, [item.value])
        ])
      )
    );
    
    // Progress bar
    if (progress !== undefined) {
      const progressBar = createElement('div', ['confidence-bar'], {}, [
        createElement('div', ['confidence-fill'], {
          style: { width: `${progress}%` }
        })
      ]);
      metaGrid.appendChild(progressBar);
    }
    
    // Menu button
    const menuBtn = createElement('button', ['session-menu-btn'], {
      'aria-label': 'Session menu'
    }, [
      createIcon('more-vertical', 20)
    ]);
    
    if (onDelete) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete session ${sessionId}?`)) {
          onDelete(sessionId);
        }
      });
    }
    
    // Build card
    const card = WorkrailComponents.Card({
      variant: 'glass',
      borderColor,
      onClick,
      animate: true
    });
    
    card.classList.add('session-card');
    card.style.borderLeftColor = borderColor;
    card.appendChild(menuBtn);
    card.appendChild(header);
    card.appendChild(titleEl);
    card.appendChild(metaGrid);
    
    return card;
  };
  
  // ============================================
  // STATUS BADGE COMPONENT
  // ============================================
  
  /**
   * Status Badge Component
   * @param {Object} config
   * @param {string} config.status - success|active|pending|error|info
   * @param {string} config.text - Badge text
   * @param {boolean} config.glow - Add glow effect
   */
  WorkrailComponents.StatusBadge = function(config) {
    const {
      status = 'info',
      text,
      glow = false
    } = config;
    
    const classes = ['session-status', `status-${status}`];
    if (glow) classes.push('badge-glow');
    
    return createElement('span', classes, {}, [text || status.toUpperCase()]);
  };
  
  // ============================================
  // HERO SECTION COMPONENT
  // ============================================
  
  /**
   * Hero Section Component
   * @param {Object} config
   * @param {string} config.title - Hero title
   * @param {string} config.subtitle - Hero subtitle
   * @param {string} config.icon - Lucide icon name
   * @param {string} config.gradient - CSS gradient string
   */
  WorkrailComponents.Hero = function(config) {
    const {
      title,
      subtitle,
      icon = 'rocket',
      gradient = null
    } = config;
    
    const attrs = {};
    if (gradient) {
      attrs.style = { background: gradient };
    }
    
    const titleContent = [];
    if (icon) {
      titleContent.push(createIcon(icon, 42));
    }
    titleContent.push(title);
    
    const hero = createElement('div', ['hero'], attrs, [
      createElement('h1', [], { style: { position: 'relative', zIndex: 2 } }, titleContent),
      createElement('p', [], { style: { position: 'relative', zIndex: 2 } }, [subtitle])
    ]);
    
    return hero;
  };
  
  // ============================================
  // STAT CARD COMPONENT
  // ============================================
  
  /**
   * Stat Card Component
   * @param {Object} config
   * @param {string|number} config.value - Stat value
   * @param {string} config.label - Stat label
   * @param {string} config.icon - Lucide icon name
   * @param {string} config.color - Icon color (CSS value)
   * @param {boolean} config.gradient - Use gradient background
   * @param {boolean} config.float - Add float animation
   */
  WorkrailComponents.StatCard = function(config) {
    const {
      value,
      label,
      icon,
      color = 'var(--primary-500)',
      gradient = false,
      float = false
    } = config;
    
    const classes = ['stat-card'];
    if (gradient) classes.push('stat-card-gradient');
    if (float) classes.push('card-float');
    
    const iconEl = icon ? createElement('div', ['stat-icon'], {}, [
      createIcon(icon, 48)
    ]) : null;
    
    if (iconEl && color) {
      iconEl.style.color = color;
    }
    
    const children = [];
    if (iconEl) children.push(iconEl);
    children.push(createElement('div', ['stat-value'], {}, [String(value)]));
    children.push(createElement('div', ['stat-label'], {}, [label]));
    
    return createElement('div', classes, {}, children);
  };
  
  // ============================================
  // PROGRESS RING COMPONENT
  // ============================================
  
  /**
   * Progress Ring Component
   * @param {Object} config
   * @param {number} config.progress - 0-100
   * @param {number} config.size - Circle diameter in pixels
   * @param {number} config.strokeWidth - Stroke width
   * @param {string} config.color - Progress color
   * @param {boolean} config.showPercentage - Show percentage text
   */
  WorkrailComponents.ProgressRing = function(config) {
    const {
      progress = 0,
      size = 120,
      strokeWidth = 8,
      color = 'var(--primary-500)',
      showPercentage = true
    } = config;
    
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - (progress / 100) * circumference;
    
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.classList.add('progress-ring');
    
    // Background circle
    const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bgCircle.setAttribute('cx', size / 2);
    bgCircle.setAttribute('cy', size / 2);
    bgCircle.setAttribute('r', radius);
    bgCircle.setAttribute('fill', 'none');
    bgCircle.setAttribute('stroke', 'var(--bg-tertiary)');
    bgCircle.setAttribute('stroke-width', strokeWidth);
    
    // Progress circle
    const progressCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    progressCircle.setAttribute('cx', size / 2);
    progressCircle.setAttribute('cy', size / 2);
    progressCircle.setAttribute('r', radius);
    progressCircle.setAttribute('fill', 'none');
    progressCircle.setAttribute('stroke', color);
    progressCircle.setAttribute('stroke-width', strokeWidth);
    progressCircle.setAttribute('stroke-dasharray', circumference);
    progressCircle.setAttribute('stroke-dashoffset', offset);
    progressCircle.setAttribute('stroke-linecap', 'round');
    progressCircle.style.transform = 'rotate(-90deg)';
    progressCircle.style.transformOrigin = '50% 50%';
    progressCircle.style.transition = 'stroke-dashoffset 0.5s cubic-bezier(0.4, 0.0, 0.2, 1)';
    
    svg.appendChild(bgCircle);
    svg.appendChild(progressCircle);
    
    if (showPercentage) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', '50%');
      text.setAttribute('y', '50%');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('font-size', size / 4);
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('fill', 'var(--text-primary)');
      text.textContent = `${Math.round(progress)}%`;
      svg.appendChild(text);
    }
    
    return svg;
  };
  
  // ============================================
  // MODAL COMPONENT
  // ============================================
  
  /**
   * Modal Component
   * @param {Object} config
   * @param {string} config.title - Modal title
   * @param {string|HTMLElement} config.content - Modal content
   * @param {Array} config.actions - Array of {text, onClick, variant}
   * @param {Function} config.onClose - Close handler
   */
  WorkrailComponents.Modal = function(config) {
    const {
      title,
      content,
      actions = [],
      onClose
    } = config;
    
    const actionsContainer = createElement('div', ['modal-actions'], {},
      actions.map(action => WorkrailComponents.Button({
        text: action.text,
        variant: action.variant || 'primary',
        onClick: action.onClick
      }))
    );
    
    const contentEl = typeof content === 'string'
      ? createElement('div', ['modal-message'], {}, [content])
      : content;
    
    const dialog = createElement('div', ['modal-dialog'], {}, [
      createElement('h2', ['modal-title'], {}, [title]),
      contentEl,
      actionsContainer
    ]);
    
    const overlay = createElement('div', ['modal-overlay'], {}, [dialog]);
    
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && onClose) {
        onClose();
      }
    });
    
    // Helper method to show modal
    overlay.show = function() {
      overlay.classList.add('show');
      document.body.appendChild(overlay);
    };
    
    // Helper method to hide modal
    overlay.hide = function() {
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 300);
    };
    
    return overlay;
  };
  
  // Export to global scope
  global.WorkrailComponents = WorkrailComponents;
  
  console.log('[Workrail Components] Library loaded');


  // ============================================
  // WORKRAIL UI NAMESPACE
  // ============================================
  
  const WorkrailUI = {
    version: '2.0.0',
    
    // Theme system (from theme-manager.js)
    Theme: typeof window.WorkrailTheme !== 'undefined' ? window.WorkrailTheme : {},
    
    // Background system (from particle-generator.js, background-interaction.js)
    Background: typeof window.WorkrailBackground !== 'undefined' ? window.WorkrailBackground : {},
    
    // Components (from components.js)
    ...(typeof window.WorkrailComponents !== 'undefined' ? window.WorkrailComponents : {}),
    
    // Utilities
    Utils: {
      formatTime: function(timestamp) {
        return new Date(timestamp).toLocaleTimeString();
      },
      formatDate: function(timestamp) {
        return new Date(timestamp).toLocaleDateString();
      }
    }
  };
  
  // Export to global
  global.WorkrailUI = WorkrailUI;
  
  // Also keep individual exports for backwards compatibility
  if (typeof window.WorkrailTheme !== 'undefined') {
    global.WorkrailTheme = window.WorkrailTheme;
  }
  if (typeof window.WorkrailComponents !== 'undefined') {
    global.WorkrailComponents = window.WorkrailComponents;
  }
  if (typeof window.WorkrailBackground !== 'undefined') {
    global.WorkrailBackground = window.WorkrailBackground;
  }
  
  console.log('✅ Workrail UI initialized');
  
})(typeof window !== 'undefined' ? window : this);
