/**
 * Button Component
 * Accessible button with variants
 * 
 * Usage:
 *   <wr-button variant="primary" icon="rocket">
 *     Click Me
 *   </wr-button>
 * 
 * Attributes:
 *   - variant: primary | secondary | ghost | danger | success
 *   - size: sm | md | lg
 *   - icon: Lucide icon name (optional)
 *   - disabled: Boolean
 *   - loading: Boolean
 */

import { WorkrailComponent } from './base.js';

export class Button extends WorkrailComponent {
  connectedCallback() {
    const variant = this.getAttr('variant', 'primary');
    const size = this.getAttr('size', 'md');
    const icon = this.getAttr('icon');
    const disabled = this.getBoolAttr('disabled');
    const loading = this.getBoolAttr('loading');
    
    this.shadowRoot.appendChild(this.loadTokens());
    this.shadowRoot.appendChild(this.createStyle(this.styles()));
    this.shadowRoot.appendChild(this.render(variant, size, icon, disabled, loading));
  }
  
  styles() {
    return `
      :host {
        display: inline-block;
      }
      
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-6);
        border-radius: var(--radius-lg);
        font-family: var(--font-sans);
        font-weight: var(--font-medium);
        font-size: var(--text-base);
        cursor: pointer;
        border: none;
        transition: all var(--duration-base) var(--ease-out);
        outline: none;
      }
      
      button:focus-visible {
        outline: 2px solid var(--primary-500);
        outline-offset: 2px;
      }
      
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      /* Sizes */
      .btn-sm {
        padding: var(--space-2) var(--space-4);
        font-size: var(--text-sm);
      }
      
      .btn-lg {
        padding: var(--space-4) var(--space-8);
        font-size: var(--text-lg);
      }
      
      /* Variants */
      .btn-primary {
        background: var(--primary-500);
        color: white;
      }
      
      .btn-primary:hover:not(:disabled) {
        background: var(--primary-600);
        transform: translateY(-2px);
        box-shadow: var(--shadow-lg);
      }
      
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border-medium);
      }
      
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
        border-color: var(--border-heavy);
      }
      
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
      }
      
      .btn-ghost:hover:not(:disabled) {
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      
      .btn-danger {
        background: var(--status-error);
        color: white;
      }
      
      .btn-danger:hover:not(:disabled) {
        background: #dc2626;
        transform: translateY(-2px);
        box-shadow: var(--shadow-lg);
      }
      
      .btn-success {
        background: var(--status-success);
        color: white;
      }
      
      .btn-success:hover:not(:disabled) {
        background: #059669;
        transform: translateY(-2px);
        box-shadow: var(--shadow-lg);
      }
      
      /* Icon */
      .icon {
        width: 18px;
        height: 18px;
      }
      
      /* Loading spinner */
      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid currentColor;
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;
  }
  
  render(variant, size, icon, disabled, loading) {
    const button = document.createElement('button');
    button.className = `btn-${variant} btn-${size}`;
    button.disabled = disabled || loading;
    
    if (loading) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      button.appendChild(spinner);
    } else if (icon) {
      const iconEl = document.createElement('i');
      iconEl.setAttribute('data-lucide', icon);
      iconEl.className = 'icon';
      button.appendChild(iconEl);
      
      // Initialize Lucide icon if available
      if (typeof lucide !== 'undefined') {
        setTimeout(() => lucide.createIcons(), 0);
      }
    }
    
    button.appendChild(document.createElement('slot'));
    
    return button;
  }
}

customElements.define('wr-button', Button);
