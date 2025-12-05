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
    generate: (count) => {
      stopCollisionDetection();
      generateParticles(count);
      setTimeout(startCollisionDetection, 1000);
    },
    startCollisions: startCollisionDetection,
    stopCollisions: stopCollisionDetection,
    config: PARTICLE_CONFIG
  };

  init();
  
  // ES6 Module Exports (for modern usage)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generateParticles, startCollisionDetection, stopCollisionDetection };
  }
  
  // Also expose as window function for backwards compatibility
  window.generateParticles = generateParticles;
})();
