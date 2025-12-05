/**
 * Generic Renderer
 * 
 * Renders data based on patterns recognized by PatternRecognizer.
 * Creates DOM elements with appropriate components for each data type.
 */

import { PatternRecognizer } from './pattern-recognizer.js';
import * as fmt from '../utils/formatters.js';
import { chartBuilder } from './chart-builder.js';

export class GenericRenderer {
  constructor() {
    this.recognizer = new PatternRecognizer();
    this.chartBuilder = chartBuilder;
  }
  
  // ==================== Web Component Helpers ====================
  
  /**
   * Create a Web Component element
   * @param {string} tagName - Component tag name (e.g., 'wr-card')
   * @param {Object} attributes - Attributes to set
   * @param {HTMLElement|string} children - Child elements or text content
   * @returns {HTMLElement}
   */
  createComponent(tagName, attributes = {}, children = null) {
    const element = document.createElement(tagName);
    
    // Set attributes
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== null && value !== undefined && value !== false) {
        if (typeof value === 'boolean') {
          element.setAttribute(key, '');
        } else {
          element.setAttribute(key, String(value));
        }
      }
    }
    
    // Add children
    if (children) {
      if (typeof children === 'string') {
        element.textContent = children;
      } else if (children instanceof HTMLElement) {
        element.appendChild(children);
      } else if (Array.isArray(children)) {
        children.forEach(child => {
          if (child instanceof HTMLElement) {
            element.appendChild(child);
          } else if (typeof child === 'string') {
            element.appendChild(document.createTextNode(child));
          }
        });
      }
    }
    
    return element;
  }
  
  /**
   * Create a Badge component
   */
  createBadge(text, variant = 'neutral', options = {}) {
    return this.createComponent('wr-badge', {
      variant,
      size: options.size || 'md',
      icon: options.icon,
      pulse: options.pulse
    }, text);
  }
  
  /**
   * Create a Card component
   */
  createCard(title, children, options = {}) {
    const card = this.createComponent('wr-card', {
      title,
      variant: options.variant || 'default',
      'border-color': options.borderColor,
      expandable: options.expandable,
      icon: options.icon
    });
    
    if (children) {
      if (Array.isArray(children)) {
        children.forEach(child => {
          if (child instanceof HTMLElement) {
            card.appendChild(child);
          }
        });
      } else if (children instanceof HTMLElement) {
        card.appendChild(children);
      }
    }
    
    return card;
  }
  
  /**
   * Create a StatCard component
   */
  createStatCard(label, value, options = {}) {
    return this.createComponent('wr-stat-card', {
      label,
      value,
      icon: options.icon,
      trend: options.trend,
      variant: options.variant || 'default'
    });
  }
  
  /**
   * Create a ProgressRing component
   */
  createProgressRing(value, options = {}) {
    return this.createComponent('wr-progress-ring', {
      value,
      size: options.size || 'md',
      'show-value': options.showValue,
      variant: options.variant || 'primary'
    });
  }
  
  /**
   * Map status values to badge variants
   */
  getStatusVariant(status) {
    const statusMap = {
      'complete': 'success',
      'completed': 'success',
      'success': 'success',
      'active': 'info',
      'in_progress': 'info',
      'pending': 'warning',
      'partial': 'warning',
      'cancelled': 'neutral',
      'rejected': 'neutral',
      'error': 'error',
      'failed': 'error'
    };
    
    return statusMap[status?.toLowerCase()] || 'neutral';
  }
  
  /**
   * Render a field (key-value pair) to DOM element
   * @param {string} key - Field name
   * @param {any} value - Field value
   * @param {boolean} wrapInSection - Whether to wrap in section (default: true for top-level)
   * @returns {HTMLElement}
   */
  render(key, value, wrapInSection = true) {
    try {
      // Validate inputs
      if (key == null) {
        console.warn('GenericRenderer: null/undefined key provided');
        return this.renderError('Invalid Field', new Error('No key provided'));
      }
      
      const spec = this.recognizer.recognize(key, value);
      
      if (!spec || !spec.component) {
        console.warn(`GenericRenderer: Invalid spec returned for ${key}`);
        return this.renderFallback(key, value);
      }
      
      // Map component name to renderer method
      const rendererMethod = `render${spec.component}`;
      
      if (typeof this[rendererMethod] === 'function') {
        try {
          const content = this[rendererMethod](spec.props);
          
          if (!content) {
            console.warn(`GenericRenderer: ${rendererMethod} returned null/undefined`);
            return this.renderFallback(key, value);
          }
          
          // Only wrap in section if requested (top-level fields only)
          // Skip wrapping for components that have their own titles/headers
          const noWrapComponents = ['Hero', 'Card', 'HighlightCard', 'ErrorCard'];
          if (wrapInSection && !noWrapComponents.includes(spec.component)) {
            return this.renderSection(this.recognizer.formatLabel(key), this.getIcon(spec.component), content);
          }
          
          return content;
        } catch (renderError) {
          console.error(`GenericRenderer: Error in ${rendererMethod}:`, renderError);
          return this.renderError(key, renderError);
        }
      }
      
      // Fallback
      console.warn(`No renderer for component: ${spec.component}`);
      return this.renderFallback(key, value);
      
    } catch (error) {
      console.error(`GenericRenderer: Critical error rendering ${key}:`, error);
      return this.renderError(key, error);
    }
  }
  
  /**
   * Get icon for component type
   * @private
   */
  getIcon(componentType) {
    const iconMap = {
      'Timeline': 'clock',
      'Checklist': 'check-square',
      'GroupedList': 'list',
      'SeverityList': 'alert-circle',
      'StatGrid': 'bar-chart',
      'CodeBlock': 'code',
      'HighlightCard': 'star',
      'GenericList': 'list',
      'PhasesList': 'layers'
    };
    return iconMap[componentType] || null;
  }
  
  /**
   * Render entire session data
   * @param {Object} data - Session data object
   * @returns {HTMLElement}
   */
  renderAll(data) {
    const container = document.createElement('div');
    container.className = 'generic-dashboard-container';
    
    // Extract configuration from dashboard._meta
    const meta = this.extractMeta(data);
    
    // Get field order based on meta configuration
    const orderedFields = this.getOrderedFields(data, meta);
    
    // Render each field
    for (const key of orderedFields) {
      const value = data[key];
      if (value === null || value === undefined) continue;
      
      // Skip if field is hidden via meta
      if (meta.hidden && meta.hidden.includes(key)) {
        console.log(`Skipping hidden field: ${key}`);
        continue;
      }
      
      try {
        const element = this.render(key, value);
        if (element) {
          // Apply meta configuration to section
          this.applyMetaToElement(element, key, meta);
          container.appendChild(element);
        }
      } catch (error) {
        console.error(`Error rendering field ${key}:`, error);
        container.appendChild(this.renderError(key, error));
      }
    }
    
    return container;
  }
  
  /**
   * Extract meta configuration from dashboard._meta
   * @private
   */
  extractMeta(data) {
    const meta = {
      order: null,      // Array of field names in desired order
      hidden: [],       // Array of field names to hide
      icons: {},        // Map of field name to icon name
      collapsible: {}   // Map of field name to boolean
    };
    
    // Check for dashboard._meta
    if (data.dashboard && typeof data.dashboard === 'object' && data.dashboard._meta) {
      const userMeta = data.dashboard._meta;
      
      if (Array.isArray(userMeta.order)) {
        meta.order = userMeta.order;
      }
      
      if (Array.isArray(userMeta.hidden)) {
        meta.hidden = userMeta.hidden;
      }
      
      if (typeof userMeta.icons === 'object') {
        meta.icons = userMeta.icons;
      }
      
      if (typeof userMeta.collapsible === 'object') {
        meta.collapsible = userMeta.collapsible;
      }
    }
    
    return meta;
  }
  
  /**
   * Get ordered list of fields based on meta configuration
   * @private
   */
  getOrderedFields(data, meta) {
    const fields = Object.keys(data);
    
    // If explicit order is provided, use it
    if (meta.order && Array.isArray(meta.order)) {
      const orderedSet = new Set();
      const result = [];
      
      // Add fields in specified order
      for (const key of meta.order) {
        if (fields.includes(key)) {
          result.push(key);
          orderedSet.add(key);
        }
      }
      
      // Add remaining fields (dashboard first, then alphabetically)
      const remaining = fields.filter(k => !orderedSet.has(k));
      const dashboardFields = remaining.filter(k => k === 'dashboard');
      const otherFields = remaining.filter(k => k !== 'dashboard').sort();
      
      return [...result, ...dashboardFields, ...otherFields];
    }
    
    // Default ordering: dashboard first, then alphabetically
    return [
      ...fields.filter(k => k === 'dashboard'),
      ...fields.filter(k => k !== 'dashboard').sort()
    ];
  }
  
  /**
   * Apply meta configuration to rendered element
   * @private
   */
  applyMetaToElement(element, key, meta) {
    // Apply custom icon if specified
    if (meta.icons && meta.icons[key]) {
      const iconElement = element.querySelector('.section-icon');
      if (iconElement) {
        iconElement.setAttribute('data-lucide', meta.icons[key]);
        // Re-initialize Lucide for this icon
        if (typeof lucide !== 'undefined') {
          setTimeout(() => lucide.createIcons(), 0);
        }
      }
    }
    
    // Apply collapsible configuration
    if (meta.collapsible && typeof meta.collapsible[key] === 'boolean') {
      const section = element.querySelector('.dashboard-section');
      if (section && meta.collapsible[key]) {
        this.makeCollapsible(section, key);
      }
    }
  }
  
  /**
   * Make a section collapsible
   * @private
   */
  makeCollapsible(section, key) {
    const header = section.querySelector('.section-header');
    const content = section.querySelector('.section-content');
    
    if (!header || !content) return;
    
    // Add collapsible class and toggle icon
    header.classList.add('collapsible-header');
    header.style.cursor = 'pointer';
    
    const toggleIcon = document.createElement('span');
    toggleIcon.className = 'section-toggle-icon';
    toggleIcon.innerHTML = '▼';
    toggleIcon.style.cssText = 'margin-left: auto; transition: transform 0.3s ease; font-size: 0.8em;';
    header.appendChild(toggleIcon);
    
    // Add click handler
    let isCollapsed = false;
    header.addEventListener('click', () => {
      isCollapsed = !isCollapsed;
      
      if (isCollapsed) {
        content.style.display = 'none';
        toggleIcon.style.transform = 'rotate(-90deg)';
      } else {
        content.style.display = 'block';
        toggleIcon.style.transform = 'rotate(0deg)';
      }
      
      // Store state in localStorage
      try {
        localStorage.setItem(`dashboard-section-${key}-collapsed`, String(isCollapsed));
      } catch (e) {
        console.warn('Could not save section state:', e);
      }
    });
    
    // Restore state from localStorage
    try {
      const savedState = localStorage.getItem(`dashboard-section-${key}-collapsed`);
      if (savedState === 'true') {
        header.click();
      }
    } catch (e) {
      console.warn('Could not restore section state:', e);
    }
  }
  
  // ==================== Component Renderers ====================
  
  /**
   * Render Hero section (from dashboard object)
   */
  renderHero(props) {
    try {
      if (!props || typeof props !== 'object') {
        console.warn('renderHero: Invalid props');
        props = {};
      }
      
      const hero = document.createElement('div');
      hero.className = 'hero-section';
      hero.innerHTML = `
        <div class="hero-content">
          <h1 class="hero-title">${fmt.escapeHtml(props.title || 'Dashboard')}</h1>
          ${props.subtitle ? `<p class="hero-subtitle">${fmt.escapeHtml(props.subtitle)}</p>` : ''}
          <div class="hero-meta">
            ${this.renderHeroMeta(props)}
          </div>
        </div>
      `;
      return hero;
    } catch (error) {
      console.error('Error rendering Hero:', error);
      return this.renderError('Dashboard', error);
    }
  }
  
  renderHeroMeta(props) {
    try {
      if (!props) return '';
      
      const container = document.createElement('div');
      container.className = 'hero-meta-container';
      
      if (props.status) {
        const statusVariant = this.getStatusVariant(props.status);
        const badge = this.createBadge(fmt.formatStatus(props.status), statusVariant, {
          size: 'md',
          pulse: props.status === 'in_progress'
        });
        container.appendChild(badge);
      }
      
      if (typeof props.progress === 'number' && Number.isFinite(props.progress)) {
        const clampedProgress = Math.max(0, Math.min(100, props.progress));
        const progressContainer = document.createElement('div');
        progressContainer.className = 'hero-progress';
        
        const label = document.createElement('span');
        label.className = 'hero-progress-label';
        label.textContent = 'Progress:';
        
        const ring = this.createProgressRing(clampedProgress, {
          size: 'sm',
          showValue: true,
          variant: clampedProgress >= 75 ? 'success' : clampedProgress >= 50 ? 'primary' : 'warning'
        });
        
        progressContainer.appendChild(label);
        progressContainer.appendChild(ring);
        container.appendChild(progressContainer);
      }
      
      if (typeof props.confidence === 'number' && Number.isFinite(props.confidence)) {
        const confSpan = document.createElement('span');
        confSpan.className = 'hero-confidence';
        confSpan.textContent = `Confidence: ${fmt.formatConfidence(props.confidence)}`;
        container.appendChild(confSpan);
      }
      
      if (props.currentPhase) {
        const phaseSpan = document.createElement('span');
        phaseSpan.className = 'hero-phase';
        phaseSpan.textContent = `Phase: ${String(props.currentPhase)}`;
        container.appendChild(phaseSpan);
      }
      
      return container.innerHTML;
    } catch (error) {
      console.error('Error rendering hero meta:', error);
      return '';
    }
  }
  
  /**
   * Render Section wrapper
   */
  renderSection(title, icon, children) {
    const section = document.createElement('section');
    section.className = 'dashboard-section';
    
    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `
      ${icon ? `<i data-lucide="${icon}" class="section-icon"></i>` : ''}
      <h2 class="section-title">${fmt.escapeHtml(title)}</h2>
    `;
    section.appendChild(header);
    
    const content = document.createElement('div');
    content.className = 'section-content';
    if (children) {
      content.appendChild(children);
    }
    section.appendChild(content);
    
    return section;
  }
  
  /**
   * Render Card
   */
  renderCard(props) {
    try {
      if (!props || typeof props !== 'object') {
        console.warn('renderCard: Invalid props');
        return this.renderFallback('Card', props);
      }
      
      const card = document.createElement('div');
      card.className = 'card';
      
      if (props.title) {
        const header = document.createElement('div');
        header.className = 'card-header';
        header.innerHTML = `<h3>${fmt.escapeHtml(String(props.title))}</h3>`;
        card.appendChild(header);
      }
      
      const content = document.createElement('div');
      content.className = 'card-content';
      
      // Render nested fields (without section wrappers)
      if (props.data && typeof props.data === 'object' && !Array.isArray(props.data)) {
        for (const [key, value] of Object.entries(props.data)) {
          if (value === null || value === undefined) continue;
          
          try {
            const field = this.render(key, value, false);  // Don't wrap nested fields in sections
            if (field) {
              // Only add label for arrays and objects (complex types)
              // Primitives and text fields handle their own labels
              if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
                const fieldContainer = document.createElement('div');
                fieldContainer.className = 'card-field';
                
                const label = document.createElement('div');
                label.className = 'field-label';
                label.textContent = this.recognizer.formatLabel(key);
                fieldContainer.appendChild(label);
                
                const fieldContent = document.createElement('div');
                fieldContent.className = 'field-content';
                fieldContent.appendChild(field);
                fieldContainer.appendChild(fieldContent);
                
                content.appendChild(fieldContainer);
              } else {
                // Primitive types - just add the field directly (it has its own label)
                content.appendChild(field);
              }
            }
          } catch (fieldError) {
            console.error(`Error rendering field ${key} in card:`, fieldError);
            // Continue rendering other fields
          }
        }
      }
      
      card.appendChild(content);
      return card;  // Don't wrap in section here, done at top level
    } catch (error) {
      console.error('Error rendering Card:', error);
      return this.renderError('Card', error);
    }
  }
  
  /**
   * Render HighlightCard (for high-confidence results)
   */
  renderHighlightCard(props) {
    const card = document.createElement('div');
    card.className = 'card card-highlight';
    
    const header = document.createElement('div');
    header.className = 'card-header';
    
    const title = document.createElement('h3');
    title.textContent = props.title;
    header.appendChild(title);
    
    const confBadge = this.createBadge(
      `Confidence: ${fmt.formatConfidence(props.confidence)}`,
      props.confidence >= 8 ? 'success' : props.confidence >= 6 ? 'info' : 'warning',
      { size: 'sm' }
    );
    header.appendChild(confBadge);
    
    card.appendChild(header);
    
    const content = document.createElement('div');
    content.className = 'card-content';
    
    // Render nested fields (excluding confidence)
    if (props.data && typeof props.data === 'object') {
      for (const [key, value] of Object.entries(props.data)) {
        if (key === 'confidence') continue;
        if (value === null || value === undefined) continue;
        
        const field = this.render(key, value, false);  // Don't wrap nested fields in sections
        if (field) {
          content.appendChild(field);
        }
      }
    }
    
    card.appendChild(content);
    return card;  // Don't wrap in section here, done at top level
  }
  
  /**
   * Render PhasesList (compact, collapsible workflow phases)
   */
  renderPhasesList(props) {
    const { title, phases } = props;

    const container = document.createElement('div');
    container.className = 'phases-list';

    // Sort phases by key (phase-0, phase-0a, etc.)
    const sortedEntries = Object.entries(phases).sort(([a], [b]) => {
      // Extract numbers and letters for proper sorting
      const parsePhase = (key) => {
        const match = key.match(/phase-(\d+)([a-z]?)/);
        return match ? [parseInt(match[1]), match[2] || ''] : [999, key];
      };
      const [aNum, aLetter] = parsePhase(a);
      const [bNum, bLetter] = parsePhase(b);
      return aNum === bNum ? aLetter.localeCompare(bLetter) : aNum - bNum;
    });

    for (const [phaseKey, phaseData] of sortedEntries) {
      const status = phaseData.complete ? '✓' : '○';
      const phaseName = this.recognizer.formatLabel(phaseKey);
      const phaseText = phaseData.summary || phaseData.description || 'No summary';

      // Check if there's any content beyond summary/complete
      const hasDetails = Object.entries(phaseData).some(([key, value]) => {
        return key !== 'complete' && key !== 'summary' && value !== null && value !== undefined;
      });

      if (hasDetails) {
        // Render as expandable details element
        const phaseItem = document.createElement('details');
        phaseItem.className = 'phase-item';

        if (phaseData.complete) {
          phaseItem.classList.add('phase-complete');
        }

        const summary = document.createElement('summary');
        summary.className = 'phase-summary';
        summary.innerHTML = `
          <span class="phase-status">${status}</span>
          <span class="phase-name">${fmt.escapeHtml(phaseName)}</span>
          <span class="phase-text">${fmt.escapeHtml(phaseText)}</span>
        `;

        phaseItem.appendChild(summary);

        // Create details content
        const details = document.createElement('div');
        details.className = 'phase-details';

        for (const [key, value] of Object.entries(phaseData)) {
          if (key === 'complete' || key === 'summary') continue;
          if (value === null || value === undefined) continue;

          const field = this.render(key, value, false);
          if (field) {
            details.appendChild(field);
          }
        }

        phaseItem.appendChild(details);
        container.appendChild(phaseItem);
      } else {
        // Render as simple list item (no dropdown)
        const phaseItem = document.createElement('div');
        phaseItem.className = 'phase-item phase-item-simple';

        if (phaseData.complete) {
          phaseItem.classList.add('phase-complete');
        }

        phaseItem.innerHTML = `
          <span class="phase-status">${status}</span>
          <span class="phase-name">${fmt.escapeHtml(phaseName)}</span>
          <span class="phase-text">${fmt.escapeHtml(phaseText)}</span>
        `;

        container.appendChild(phaseItem);
      }
    }

    return container;
  }
  
  /**
   * Render ObjectCollection (object whose values are all objects)
   * Example: metadata = { "item-1": {...}, "item-2": {...} }
   */
  renderObjectCollection(props) {
    const { title, items } = props;
    
    const container = document.createElement('div');
    container.className = 'object-collection';
    
    // Render each object as a card
    for (const [key, value] of Object.entries(items)) {
      const itemCard = document.createElement('div');
      itemCard.className = 'collection-item';
      
      // Add item title
      const itemTitle = document.createElement('h4');
      itemTitle.className = 'collection-item-title';
      itemTitle.textContent = this.recognizer.formatLabel(key);
      itemCard.appendChild(itemTitle);
      
      // Render nested fields (without section wrappers)
      if (value && typeof value === 'object') {
        for (const [fieldKey, fieldValue] of Object.entries(value)) {
          if (fieldValue === null || fieldValue === undefined) continue;
          
          const field = this.render(fieldKey, fieldValue, false);
          itemCard.appendChild(field);
        }
      }
      
      container.appendChild(itemCard);
    }
    
    return container;
  }
  
  /**
   * Render GroupedList (arrays grouped by field)
   */
  renderGroupedList(props) {
    const { title, items, groupBy, groupOrder } = props;
    
    // Group items
    const groups = {};
    for (const item of items) {
      const groupKey = item[groupBy] || 'other';
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(item);
    }
    
    // Determine order - use groupOrder first, then add any remaining groups
    let order = groupOrder || [];
    const remainingGroups = Object.keys(groups).filter(key => !order.includes(key));
    order = [...order, ...remainingGroups.sort()];
    
    // Create list
    const list = document.createElement('div');
    list.className = 'grouped-list';
    
    for (const groupKey of order) {
      if (!groups[groupKey]) continue;
      
      const groupItems = groups[groupKey];
      
      const group = document.createElement('div');
      group.className = 'list-group';
      group.innerHTML = `
        <div class="group-header">
          <h4 class="group-title">${fmt.escapeHtml(fmt.formatStatus(groupKey))}</h4>
          <span class="group-count">${groupItems.length}</span>
        </div>
        <div class="group-items">
          ${groupItems.map(item => this.renderListItem(item, groupBy)).join('')}
        </div>
      `;
      
      list.appendChild(group);
    }
    
    return list;  // Don't wrap in section here, done at top level
  }
  
  /**
   * Render SeverityList (color-coded by severity)
   */
  renderSeverityList(props) {
    const { title, items, severityField = 'severity' } = props;
    
    // Group by severity
    const severityOrder = ['critical', 'high', 'error', 'warning', 'medium', 'low', 'info'];
    const groups = {};
    
    for (const item of items) {
      const severity = item[severityField] || 'info';
      if (!groups[severity]) {
        groups[severity] = [];
      }
      groups[severity].push(item);
    }
    
    // Create list
    const list = document.createElement('div');
    list.className = 'severity-list';
    
    for (const severity of severityOrder) {
      if (!groups[severity]) continue;
      
      const groupItems = groups[severity];
      
      const group = document.createElement('div');
      group.className = `severity-group severity-${severity}`;
      group.innerHTML = `
        <div class="group-header">
          <span class="severity-icon">${this.getSeverityIcon(severity)}</span>
          <h4 class="group-title">${fmt.escapeHtml(severity.toUpperCase())}</h4>
          <span class="group-count">${groupItems.length}</span>
        </div>
        <div class="group-items">
          ${groupItems.map(item => this.renderListItem(item, severityField)).join('')}
        </div>
      `;
      
      list.appendChild(group);
    }
    
    return list;  // Don't wrap in section here, done at top level
  }
  
  getSeverityIcon(severity) {
    const icons = {
      critical: '🔴',
      high: '🔴',
      error: '🔴',
      warning: '🟠',
      medium: '🟡',
      low: '🔵',
      info: '🔵'
    };
    return icons[severity] || '⚪';
  }
  
  /**
   * Render PriorityList (sorted by priority)
   */
  renderPriorityList(props) {
    const { title, items, priorityField = 'priority' } = props;
    
    // Sort by priority (highest first)
    const sorted = [...items].sort((a, b) => (b[priorityField] || 0) - (a[priorityField] || 0));
    
    // Create list
    const list = document.createElement('div');
    list.className = 'priority-list';
    
    for (const item of sorted) {
      const priority = item[priorityField] || 0;
      const priorityClass = priority >= 8 ? 'priority-high' : priority >= 5 ? 'priority-medium' : 'priority-low';
      
      const listItem = document.createElement('div');
      listItem.className = `priority-item ${priorityClass}`;
      
      // Build item structure
      const header = document.createElement('div');
      header.className = 'priority-item-header';
      
      const priorityBadge = this.createBadge(
        String(priority),
        priority >= 8 ? 'error' : priority >= 5 ? 'warning' : 'info',
        { size: 'sm' }
      );
      header.appendChild(priorityBadge);
      
      const description = document.createElement('strong');
      description.className = 'item-description';
      description.textContent = item.description || 'No description';
      header.appendChild(description);
      
      listItem.appendChild(header);
      
      if (item.reasoning) {
        const reasoning = document.createElement('p');
        reasoning.className = 'item-reasoning';
        reasoning.textContent = item.reasoning;
        listItem.appendChild(reasoning);
      }
      
      // Metadata tags
      const metadata = [];
      if (item.effort) metadata.push({ label: 'Effort', value: item.effort });
      if (item.status) metadata.push({ label: 'Status', value: item.status });
      
      if (metadata.length > 0) {
        const metaContainer = document.createElement('div');
        metaContainer.className = 'item-metadata';
        metaContainer.innerHTML = metadata.map(m => 
          `<span class="metadata-tag">${fmt.escapeHtml(m.label)}: <strong>${fmt.escapeHtml(m.value)}</strong></span>`
        ).join('');
        listItem.appendChild(metaContainer);
      }
      
      list.appendChild(listItem);
    }
    
    return list;  // Don't wrap in section here, done at top level
  }
  
  /**
   * Render Timeline
   */
  renderTimeline(props) {
    const { title, events } = props;
    
    // Sort by timestamp (newest first)
    const sorted = [...events].sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    
    const timeline = document.createElement('div');
    timeline.className = 'timeline';
    
    for (const event of sorted) {
      const item = document.createElement('div');
      item.className = 'timeline-item';
      item.innerHTML = `
        <div class="timeline-marker"></div>
        <div class="timeline-content">
          <div class="timeline-time">${fmt.formatTime(event.timestamp)}</div>
          <div class="timeline-event">${fmt.escapeHtml(this.extractEventText(event))}</div>
        </div>
      `;
      timeline.appendChild(item);
    }
    
    return timeline;  // Don't wrap in section here, done at top level
  }
  
  /**
   * Render Chart visualization
   */
  renderChart(props) {
    try {
      const { type, data, title } = props;
      
      if (!data || !Array.isArray(data) || data.length === 0) {
        return this.renderError('Chart', new Error('No data provided'));
      }
      
      // Render chart based on type
      switch (type) {
        case 'bar':
          return this.chartBuilder.createBarChart(data, { title });
        case 'line':
          return this.chartBuilder.createLineChart(data, { title, fill: true });
        case 'pie':
          return this.chartBuilder.createPieChart(data, { title, donut: true });
        case 'gauge':
          // For gauge, expect single value
          const value = data[0]?.value || 0;
          return this.chartBuilder.createGaugeChart(value, { title });
        default:
          return this.chartBuilder.createBarChart(data, { title });
      }
    } catch (error) {
      console.error('Error rendering chart:', error);
      return this.renderError('Chart', error);
    }
  }
  
  /**
   * Render Checklist (array of strings)
   */
  renderChecklist(props) {
    const { title, items } = props;
    
    const list = document.createElement('div');
    list.className = 'checklist';
    
    for (const item of items) {
      const checkItem = document.createElement('div');
      checkItem.className = 'checklist-item';
      checkItem.innerHTML = `
        <input type="checkbox" disabled class="checklist-checkbox">
        <span class="checklist-label">${fmt.escapeHtml(item)}</span>
      `;
      list.appendChild(checkItem);
    }
    
    return list;  // Don't wrap in section here, done at top level
  }
  
  /**
   * Render StatGrid (object with all numbers)
   */
  renderStatGrid(props) {
    const { title, metrics, columns = 3 } = props;
    
    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    grid.style.gridTemplateColumns = `repeat(${Math.min(columns, 4)}, 1fr)`;
    
    for (const [key, value] of Object.entries(metrics)) {
      const stat = document.createElement('div');
      stat.className = 'stat-card';
      stat.innerHTML = `
        <div class="stat-label">${fmt.escapeHtml(this.recognizer.formatLabel(key))}</div>
        <div class="stat-value">${fmt.formatNumber(value)}</div>
      `;
      grid.appendChild(stat);
    }
    
    return grid;  // Don't wrap in section here, done at top level
  }
  
  /**
   * Render TextField (simple text)
   */
  renderTextField(props) {
    const field = document.createElement('div');
    field.className = 'text-field';
    field.innerHTML = `
      <div class="field-label">${fmt.escapeHtml(props.label)}</div>
      <div class="field-value">${fmt.escapeHtml(props.text)}</div>
    `;
    return field;
  }
  
  /**
   * Render TextArea (long text)
   */
  renderTextArea(props) {
    const field = document.createElement('div');
    field.className = 'text-area';
    field.innerHTML = `
      <div class="field-label">${fmt.escapeHtml(props.label)}</div>
      <div class="field-value field-value-long">${fmt.escapeHtml(props.text)}</div>
    `;
    return field;
  }
  
  /**
   * Render StatCard (single stat)
   */
  renderStatCard(props) {
    return this.createStatCard(
      props.label,
      fmt.formatNumber(props.value),
      {
        icon: props.icon,
        variant: props.variant || 'default'
      }
    );
  }
  
  /**
   * Render ScoreDisplay (0-10 score)
   */
  renderScoreDisplay(props) {
    const { label, score, maxScore = 10 } = props;
    const percentage = (score / maxScore) * 100;
    
    const display = document.createElement('div');
    display.className = 'score-display';
    display.innerHTML = `
      <div class="field-label">${fmt.escapeHtml(label)}</div>
      <div class="score-value">
        <span class="score-number">${score.toFixed(1)}</span>
        <span class="score-max">/${maxScore}</span>
      </div>
      <div class="score-bar">
        <div class="score-fill" style="width: ${percentage}%"></div>
      </div>
    `;
    return display;
  }
  
  /**
   * Render ProgressBar
   */
  renderProgressBar(props) {
    const { label, value, max = 100 } = props;
    const percentage = (value / max) * 100;
    
    const container = document.createElement('div');
    container.className = 'progress-display';
    
    const labelEl = document.createElement('div');
    labelEl.className = 'field-label';
    labelEl.textContent = label;
    
    const ring = this.createProgressRing(percentage, {
      size: 'md',
      showValue: true,
      variant: percentage >= 75 ? 'success' : percentage >= 50 ? 'primary' : 'warning'
    });
    
    container.appendChild(labelEl);
    container.appendChild(ring);
    return container;
  }
  
  /**
   * Render TimeDisplay
   */
  renderTimeDisplay(props) {
    const field = document.createElement('div');
    field.className = 'text-field';
    field.innerHTML = `
      <div class="field-label">${fmt.escapeHtml(props.label)}</div>
      <div class="field-value">${fmt.formatTime(props.timestamp)}</div>
    `;
    return field;
  }
  
  /**
   * Render LinkText
   */
  renderLinkText(props) {
    const field = document.createElement('div');
    field.className = 'text-field';
    field.innerHTML = `
      <div class="field-label">${fmt.escapeHtml(props.label)}</div>
      <div class="field-value">
        <a href="${fmt.escapeHtml(props.url)}" target="_blank" rel="noopener noreferrer">
          ${fmt.escapeHtml(props.url)}
        </a>
      </div>
    `;
    return field;
  }
  
  /**
   * Render PathText
   */
  renderPathText(props) {
    const field = document.createElement('div');
    field.className = 'text-field';
    field.innerHTML = `
      <div class="field-label">${fmt.escapeHtml(props.label)}</div>
      <div class="field-value field-value-path">${fmt.escapeHtml(props.path)}</div>
    `;
    return field;
  }
  
  /**
   * Render CodeBlock
   */
  renderCodeBlock(props) {
    const { title, code, language = 'text' } = props;
    
    const block = document.createElement('div');
    block.className = 'code-block';
    block.innerHTML = `
      <pre><code class="language-${language}">${fmt.escapeHtml(code)}      </code></pre>
    `;
    
    return block;  // Don't wrap in section here, done at top level
  }
  
  /**
   * Render Checkbox
   */
  renderCheckbox(props) {
    const field = document.createElement('div');
    field.className = 'checkbox-field';
    field.innerHTML = `
      <input type="checkbox" ${props.checked ? 'checked' : ''} ${props.disabled ? 'disabled' : ''} class="checkbox-input">
      <label class="checkbox-label">${fmt.escapeHtml(props.label)}</label>
    `;
    return field;
  }
  
  /**
   * Render EmptyCard
   */
  renderEmptyCard(props) {
    const card = document.createElement('div');
    card.className = 'empty-card';
    card.innerHTML = `
      <div class="empty-icon">${props.icon ? `<i data-lucide="${props.icon}"></i>` : '📭'}</div>
      <div class="empty-message">${fmt.escapeHtml(props.message)}</div>
    `;
    return card;
  }
  
  /**
   * Render ErrorCard
   */
  renderErrorCard(props) {
    const card = document.createElement('div');
    card.className = 'card card-error';
    card.innerHTML = `
      <div class="card-header">
        <h3>${fmt.escapeHtml(props.title || 'Error')}</h3>
      </div>
      <div class="card-content">
        <div class="error-message">${fmt.escapeHtml(props.error)}</div>
        ${props.code ? `<div class="error-code">Code: ${fmt.escapeHtml(props.code)}</div>` : ''}
        ${props.details ? `<div class="error-details">${fmt.escapeHtml(props.details)}</div>` : ''}
      </div>
    `;
    return card;
  }
  
  /**
   * Render Empty (for null/undefined)
   */
  renderEmpty(props) {
    return document.createTextNode('');
  }
  
  /**
   * Render generic List
   */
  renderList(props) {
    const { title, items } = props;
    
    const list = document.createElement('div');
    list.className = 'generic-list';
    
    for (const item of items) {
      const itemEl = document.createElement('div');
      itemEl.className = 'list-item';
      itemEl.innerHTML = this.renderListItem(item);
      list.appendChild(itemEl);
    }
    
    return list;  // Don't wrap in section here, done at top level
  }
  
  /**
   * Extract event text from timeline item
   * @private
   */
  extractEventText(item) {
    // Try common field names in order of preference
    const fields = ['event', 'message', 'description', 'reasoning', 'title', 'text', 'content', 'summary'];
    
    for (const field of fields) {
      if (item[field] && typeof item[field] === 'string') {
        return item[field];
      }
    }
    
    // Fallback: find the first string field that isn't timestamp or a known metadata field
    const { timestamp, phase, confidence, severity, status, priority, ...rest } = item;
    const stringFields = Object.entries(rest).filter(([_, value]) => typeof value === 'string' && value.trim().length > 0);
    
    if (stringFields.length > 0) {
      return stringFields[0][1];  // Return first string value
    }
    
    // If only metadata fields exist, compose a message from them
    const parts = [];
    if (item.phase) parts.push(`Phase: ${item.phase}`);
    if (item.confidence !== undefined) parts.push(`Confidence: ${item.confidence}`);
    if (item.status) parts.push(`Status: ${item.status}`);
    if (item.severity) parts.push(`Severity: ${item.severity}`);
    if (item.priority) parts.push(`Priority: ${item.priority}`);
    
    if (parts.length > 0) {
      return parts.join(' • ');
    }
    
    // Last resort: stringify remaining fields (but avoid empty objects)
    const keys = Object.keys(rest);
    if (keys.length === 0) {
      return 'Event';  // Better than showing {}
    }
    if (keys.length === 1) {
      return String(rest[keys[0]]);
    }
    return JSON.stringify(rest);
  }
  
  /**
   * Helper: Render list item
   * @private
   */
  renderListItem(item, excludeKey = null) {
    if (typeof item === 'string') {
      return fmt.escapeHtml(item);
    }
    
    if (typeof item === 'object') {
      const parts = [];
      for (const [key, value] of Object.entries(item)) {
        if (key === excludeKey) continue;
        if (key === 'id') continue; // Skip IDs in list display
        
        const label = this.recognizer.formatLabel(key);
        const formatted = this.formatValue(value);
        parts.push(`<div class="item-field"><strong>${fmt.escapeHtml(label)}:</strong> ${formatted}</div>`);
      }
      return parts.join('');
    }
    
    return fmt.escapeHtml(String(item));
  }
  
  /**
   * Helper: Format value for inline display
   * @private
   */
  formatValue(value) {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? '✓' : '✗';
    if (typeof value === 'number') return fmt.formatNumber(value);
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (typeof value === 'object') return '[Object]';
    
    const str = String(value);
    if (str.length > 100) {
      return fmt.escapeHtml(str.substring(0, 100)) + '...';
    }
    return fmt.escapeHtml(str);
  }
  
  /**
   * Fallback renderer
   * @private
   */
  renderFallback(key, value) {
    const el = document.createElement('div');
    el.className = 'fallback-field';
    el.innerHTML = `
      <div class="field-label">${fmt.escapeHtml(this.recognizer.formatLabel(key))}</div>
      <div class="field-value">${fmt.escapeHtml(JSON.stringify(value, null, 2))}</div>
    `;
    return el;
  }
  
  /**
   * Error renderer
   * @private
   */
  renderError(key, error) {
    const el = document.createElement('div');
    el.className = 'render-error';
    el.innerHTML = `
      <strong>Error rendering "${fmt.escapeHtml(key)}":</strong> ${fmt.escapeHtml(error.message)}
    `;
    return el;
  }
}



