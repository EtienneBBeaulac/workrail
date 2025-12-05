/**
 * Badge Component
 * Status and category indicators
 * 
 * Usage:
 *   <wr-badge variant="success">Complete</wr-badge>
 *   <wr-badge variant="warning" pulse>In Progress</wr-badge>
 * 
 * Attributes:
 *   - variant: success|warning|error|info|neutral (default: neutral)
 *   - size: sm|md|lg (default: md)
 *   - pulse: Animated pulse effect (boolean)
 *   - icon: Lucide icon name (optional)
 */

import { WorkrailComponent } from './base.js';

export class Badge extends WorkrailComponent {
  connectedCallback() {
    const variant = this.getAttr('variant', 'neutral');
    const size = this.getAttr('size', 'md');
    const pulse = this.getBoolAttr('pulse');
    const icon = this.getAttr('icon');
    
    this.shadowRoot.appendChild(this.loadTokens());
    this.shadowRoot.appendChild(this.createStyle(this.styles()));
    this.shadowRoot.appendChild(this.render(variant, size, pulse, icon));
    
    // Initialize Lucide icons
    if (icon && typeof lucide !== 'undefined') {
      setTimeout(() => lucide.createIcons({ nameAttr: 'data-lucide' }), 0);
    }
  }
  
  styles() {
    return `
      :host {
        display: inline-block;
      }
      
      .badge {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-md);
        font-weight: var(--font-medium);
        font-size: var(--text-sm);
        line-height: 1;
        border: 1px solid transparent;
        position: relative;
        overflow: hidden;
        transition: transform var(--duration-fast) var(--ease-out);
      }
      
      .badge:hover {
        transform: scale(1.05);
      }
      
      /* Sizes */
      .badge-sm {
        padding: var(--space-1) var(--space-2);
        font-size: var(--text-xs);
      }
      
      .badge-lg {
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-base);
      }
      
      /* Variants */
      .badge-success {
        background: rgba(16, 185, 129, 0.1);
        color: var(--status-success);
        border-color: rgba(16, 185, 129, 0.3);
      }
      
      [data-theme="dark"] .badge-success {
        background: rgba(16, 185, 129, 0.15);
      }
      
      .badge-warning {
        background: rgba(245, 158, 11, 0.1);
        color: var(--status-pending);
        border-color: rgba(245, 158, 11, 0.3);
      }
      
      [data-theme="dark"] .badge-warning {
        background: rgba(245, 158, 11, 0.15);
      }
      
      .badge-error {
        background: rgba(239, 68, 68, 0.1);
        color: var(--status-error);
        border-color: rgba(239, 68, 68, 0.3);
      }
      
      [data-theme="dark"] .badge-error {
        background: rgba(239, 68, 68, 0.15);
      }
      
      .badge-info {
        background: rgba(99, 102, 241, 0.1);
        color: var(--status-info);
        border-color: rgba(99, 102, 241, 0.3);
      }
      
      [data-theme="dark"] .badge-info {
        background: rgba(99, 102, 241, 0.15);
      }
      
      .badge-neutral {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        border-color: var(--border-light);
      }
      
      /* Pulse animation */
      .badge-pulse::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: currentColor;
        opacity: 0;
        border-radius: inherit;
        animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      }
      
      @keyframes pulse {
        0%, 100% {
          opacity: 0;
          transform: scale(1);
        }
        50% {
          opacity: 0.1;
          transform: scale(1.1);
        }
      }
      
      .icon {
        width: 14px;
        height: 14px;
      }
      
      .badge-lg .icon {
        width: 16px;
        height: 16px;
      }
    `;
  }
  
  render(variant, size, pulse, icon) {
    const badge = document.createElement('span');
    badge.className = `badge badge-${variant} badge-${size}${pulse ? ' badge-pulse' : ''}`;
    
    if (icon) {
      const iconEl = document.createElement('i');
      iconEl.setAttribute('data-lucide', icon);
      iconEl.className = 'icon';
      badge.appendChild(iconEl);
    }
    
    badge.appendChild(document.createElement('slot'));
    
    return badge;
  }
}

customElements.define('wr-badge', Badge);
