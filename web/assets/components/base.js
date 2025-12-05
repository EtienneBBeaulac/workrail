/**
 * Base Web Component Utilities
 * Shared functionality for all Workrail components
 */

/**
 * Base class for Workrail Web Components
 * Provides common functionality and conventions
 */
export class WorkrailComponent extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }
  
  /**
   * Load design tokens into shadow DOM
   */
  loadTokens() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/assets/styles/tokens.css';
    return link;
  }
  
  /**
   * Create a style element with component-specific styles
   */
  createStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    return style;
  }
  
  /**
   * Get attribute with default value
   */
  getAttr(name, defaultValue = '') {
    return this.getAttribute(name) || defaultValue;
  }
  
  /**
   * Get boolean attribute
   */
  getBoolAttr(name) {
    return this.hasAttribute(name);
  }
  
  /**
   * Dispatch custom event
   */
  emit(eventName, detail = {}) {
    this.dispatchEvent(new CustomEvent(eventName, {
      detail,
      bubbles: true,
      composed: true
    }));
  }
}

/**
 * Prop validation utilities
 * Throws helpful errors when components are used incorrectly
 */
export const PropTypes = {
  string(value, propName, componentName) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new TypeError(
        `[${componentName}] Invalid prop '${propName}':\n` +
        `  Expected: string\n` +
        `  Received: ${typeof value}\n` +
        `  Value: ${JSON.stringify(value)}`
      );
    }
  },
  
  number(value, propName, componentName) {
    if (value !== undefined && value !== null && (typeof value !== 'number' || isNaN(value))) {
      throw new TypeError(
        `[${componentName}] Invalid prop '${propName}':\n` +
        `  Expected: number\n` +
        `  Received: ${typeof value}`
      );
    }
  },
  
  oneOf(validValues) {
    return function(value, propName, componentName) {
      if (value && !validValues.includes(value)) {
        const suggestions = validValues.map(v => `'${v}'`).join(' | ');
        throw new TypeError(
          `[${componentName}] Invalid prop '${propName}':\n` +
          `  Expected: ${suggestions}\n` +
          `  Received: '${value}'\n\n` +
          `  Valid values: ${validValues.join(', ')}`
        );
      }
    };
  },
  
  required(validator) {
    return function(value, propName, componentName) {
      if (value === undefined || value === null || value === '') {
        throw new TypeError(
          `[${componentName}] Missing required prop '${propName}'`
        );
      }
      return validator(value, propName, componentName);
    };
  }
};

/**
 * Validate props against schema
 */
export function validateProps(props, schema, componentName) {
  Object.keys(schema).forEach(propName => {
    const validator = schema[propName];
    const value = props[propName];
    
    try {
      validator(value, propName, componentName);
    } catch (error) {
      console.error(error.message);
      throw error;
    }
  });
}

/**
 * Helper to create elements
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  
  // Set attributes
  Object.keys(attrs).forEach(key => {
    if (key === 'className') {
      el.className = attrs[key];
    } else if (key === 'style' && typeof attrs[key] === 'object') {
      Object.assign(el.style, attrs[key]);
    } else if (key.startsWith('on') && typeof attrs[key] === 'function') {
      const event = key.substring(2).toLowerCase();
      el.addEventListener(event, attrs[key]);
    } else {
      el.setAttribute(key, attrs[key]);
    }
  });
  
  // Add children
  children.forEach(child => {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child) {
      el.appendChild(child);
    }
  });
  
  return el;
}
