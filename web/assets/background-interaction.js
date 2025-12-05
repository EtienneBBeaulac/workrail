/**
 * Workrail Background Interaction v1.0
 * Mouse-driven disturbance effects for workflow-themed backgrounds
 * 
 * Usage:
 * [HTML example removed for Vite compatibility]
 * [HTML example removed for Vite compatibility]
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

