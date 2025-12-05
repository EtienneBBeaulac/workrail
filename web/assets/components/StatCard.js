/**
 * StatCard Component
 * Display metrics and statistics
 * 
 * Usage:
 *   <wr-stat-card 
 *     label="Progress" 
 *     value="75%" 
 *     icon="trending-up"
 *     trend="+15%"
 *     variant="success">
 *   </wr-stat-card>
 * 
 * Attributes:
 *   - label: Stat label (required)
 *   - value: Stat value (required)
 *   - icon: Lucide icon name (optional)
 *   - trend: Trend indicator (optional)
 *   - variant: default|success|warning|error (default: default)
 */

import { WorkrailComponent } from './base.js';

export class StatCard extends WorkrailComponent {
  connectedCallback() {
    const label = this.getAttr('label');
    const value = this.getAttr('value');
    const icon = this.getAttr('icon');
    const trend = this.getAttr('trend');
    const variant = this.getAttr('variant', 'default');
    
    this.shadowRoot.appendChild(this.loadTokens());
    this.shadowRoot.appendChild(this.createStyle(this.styles()));
    this.shadowRoot.appendChild(this.render(label, value, icon, trend, variant));
    
    // Initialize Lucide icons
    if (icon && typeof lucide !== 'undefined') {
      setTimeout(() => lucide.createIcons({ nameAttr: 'data-lucide' }), 0);
    }
  }
  
  styles() {
    return `
      :host {
        display: block;
      }
      
      .stat-card {
        position: relative;
        background: var(--glass-bg);
        backdrop-filter: var(--glass-blur);
        -webkit-backdrop-filter: var(--glass-blur);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-xl);
        padding: var(--space-6);
        overflow: hidden;
        transition: transform var(--duration-base) var(--ease-out),
                    box-shadow var(--duration-base) var(--ease-out);
      }
      
      .stat-card::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 4px;
        background: var(--accent-gradient);
        opacity: 0;
        transition: opacity var(--duration-base) var(--ease-out);
      }
      
      .stat-card:hover {
        transform: translateY(-4px) scale(1.02);
        box-shadow: var(--shadow-xl);
      }
      
      .stat-card:hover::before {
        opacity: 1;
      }
      
      .stat-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--space-3);
      }
      
      .stat-label {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      
      .stat-icon {
        width: 20px;
        height: 20px;
        color: var(--text-tertiary);
      }
      
      .stat-value {
        font-size: var(--text-3xl);
        font-weight: var(--font-bold);
        color: var(--text-primary);
        line-height: 1.2;
        margin-bottom: var(--space-2);
      }
      
      .stat-trend {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm);
      }
      
      /* Variants */
      .variant-success {
        --accent-gradient: var(--gradient-forest);
      }
      
      .variant-success .stat-value {
        color: var(--status-success);
      }
      
      .variant-success .stat-trend {
        background: rgba(16, 185, 129, 0.1);
        color: var(--status-success);
      }
      
      .variant-warning {
        --accent-gradient: var(--gradient-dawn);
      }
      
      .variant-warning .stat-value {
        color: var(--status-pending);
      }
      
      .variant-warning .stat-trend {
        background: rgba(245, 158, 11, 0.1);
        color: var(--status-pending);
      }
      
      .variant-error {
        --accent-gradient: var(--gradient-sunset);
      }
      
      .variant-error .stat-value {
        color: var(--status-error);
      }
      
      .variant-error .stat-trend {
        background: rgba(239, 68, 68, 0.1);
        color: var(--status-error);
      }
      
      .variant-default {
        --accent-gradient: var(--gradient-primary);
      }
    `;
  }
  
  render(label, value, icon, trend, variant) {
    const card = document.createElement('div');
    card.className = `stat-card variant-${variant}`;
    
    // Header (label + icon)
    const header = document.createElement('div');
    header.className = 'stat-header';
    
    const labelEl = document.createElement('div');
    labelEl.className = 'stat-label';
    labelEl.textContent = label;
    header.appendChild(labelEl);
    
    if (icon) {
      const iconEl = document.createElement('i');
      iconEl.setAttribute('data-lucide', icon);
      iconEl.className = 'stat-icon';
      header.appendChild(iconEl);
    }
    
    card.appendChild(header);
    
    // Value
    const valueEl = document.createElement('div');
    valueEl.className = 'stat-value';
    valueEl.textContent = value;
    card.appendChild(valueEl);
    
    // Trend (if provided)
    if (trend) {
      const trendEl = document.createElement('div');
      trendEl.className = 'stat-trend';
      trendEl.textContent = trend;
      card.appendChild(trendEl);
    }
    
    // Slot for additional content
    card.appendChild(document.createElement('slot'));
    
    return card;
  }
}

customElements.define('wr-stat-card', StatCard);
