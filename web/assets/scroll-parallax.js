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
})();


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
})();

