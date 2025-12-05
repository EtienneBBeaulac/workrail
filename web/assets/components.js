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
  
})(window);



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
  
})(window);



