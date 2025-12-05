/**
 * Card Component
 * Flexible container with variants
 * 
 * Usage:
 *   <wr-card title="My Card" variant="glass">
 *     Content here
 *   </wr-card>
 * 
 * Attributes:
 *   - title: Card title (optional)
 *   - variant: default | glass | elevated | bordered
 *   - border-color: Left border accent color
 *   - expandable: Make card expandable/collapsible
 */

import { WorkrailComponent } from './base.js';

export class Card extends WorkrailComponent {
  constructor() {
    super();
    this.expanded = true;
  }
  
  connectedCallback() {
    const title = this.getAttr('title');
    const icon = this.getAttr('icon');
    const variant = this.getAttr('variant', 'default');
    const borderColor = this.getAttr('border-color');
    const expandable = this.getBoolAttr('expandable');
    
    this.shadowRoot.appendChild(this.loadTokens());
    this.shadowRoot.appendChild(this.createStyle(this.styles()));
    this.shadowRoot.appendChild(this.render(title, icon, variant, borderColor, expandable));
    
    if (expandable) {
      this.setupExpandable();
    }
    
    // Initialize Lucide icons in shadow DOM
    if (icon && typeof lucide !== 'undefined') {
      setTimeout(() => {
        const iconElement = this.shadowRoot.querySelector('[data-lucide]');
        if (iconElement) {
          const iconName = iconElement.getAttribute('data-lucide');
          if (lucide.icons && lucide.icons[iconName]) {
            const svgElement = lucide.createElement(lucide.icons[iconName]);
            svgElement.setAttribute('style', 'width: 1.25em; height: 1.25em;');
            iconElement.parentNode.replaceChild(svgElement, iconElement);
          }
        }
      }, 0);
    }
  }
  
  styles() {
    return `
      :host {
        display: block;
      }
      
      .card {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        padding: var(--space-6);
        border: 1px solid var(--border-light);
        transition: transform var(--duration-base) var(--ease-out),
                    box-shadow var(--duration-base) var(--ease-out);
      }
      
      .card-glass {
        background: var(--glass-bg);
        backdrop-filter: var(--glass-blur);
        -webkit-backdrop-filter: var(--glass-blur);
        border: 1px solid var(--glass-border);
      }
      
      .card-elevated {
        box-shadow: var(--shadow-lg);
        border: none;
      }
      
      .card-bordered {
        border: 2px solid var(--border-medium);
      }
      
      .card:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-xl);
      }
      
      .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--space-4);
        padding-bottom: var(--space-3);
        border-bottom: 1px solid var(--border-light);
      }
      
      .card-header.expandable {
        cursor: pointer;
        user-select: none;
      }
      
      .card-header h3 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      
      .card-expand-icon {
        transition: transform var(--duration-base) var(--ease-out);
      }
      
      .card-expand-icon.expanded {
        transform: rotate(180deg);
      }
      
      .card-content {
        color: var(--text-secondary);
        line-height: var(--leading-relaxed);
      }
      
      .card-content.collapsed {
        display: none;
      }
      
      .border-accent {
        border-left: 4px solid var(--accent-color, var(--primary-500));
      }
    `;
  }
  
  render(title, icon, variant, borderColor, expandable) {
    const container = document.createElement('div');
    container.className = `card card-${variant}${borderColor ? ' border-accent' : ''}`;
    
    if (borderColor) {
      container.style.setProperty('--accent-color', borderColor);
    }
    
    if (title) {
      const header = document.createElement('div');
      header.className = `card-header${expandable ? ' expandable' : ''}`;
      header.id = 'header';
      
      const titleContainer = document.createElement('div');
      titleContainer.style.cssText = 'display: flex; align-items: center; gap: var(--space-2);';
      
      if (icon) {
        const iconElement = document.createElement('i');
        iconElement.setAttribute('data-lucide', icon);
        iconElement.style.cssText = 'width: 1.25em; height: 1.25em;';
        titleContainer.appendChild(iconElement);
      }
      
      const h3 = document.createElement('h3');
      h3.style.margin = '0';
      h3.textContent = title;
      titleContainer.appendChild(h3);
      
      header.appendChild(titleContainer);
      
      if (expandable) {
        const expandIcon = document.createElement('span');
        expandIcon.className = 'card-expand-icon expanded';
        expandIcon.innerHTML = '▼';
        expandIcon.id = 'expand-icon';
        header.appendChild(expandIcon);
      }
      
      container.appendChild(header);
    }
    
    const content = document.createElement('div');
    content.className = 'card-content';
    content.id = 'content';
    content.appendChild(document.createElement('slot'));
    container.appendChild(content);
    
    return container;
  }
  
  setupExpandable() {
    const header = this.shadowRoot.getElementById('header');
    const content = this.shadowRoot.getElementById('content');
    const icon = this.shadowRoot.getElementById('expand-icon');
    
    header.addEventListener('click', () => {
      this.expanded = !this.expanded;
      
      if (this.expanded) {
        content.classList.remove('collapsed');
        icon.classList.add('expanded');
      } else {
        content.classList.add('collapsed');
        icon.classList.remove('expanded');
      }
      
      this.emit('toggle', { expanded: this.expanded });
    });
  }
}

customElements.define('wr-card', Card);
