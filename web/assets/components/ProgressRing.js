/**
 * ProgressRing Component
 * Circular progress indicator
 * 
 * Usage:
 *   <wr-progress-ring value="75" size="lg" show-value></wr-progress-ring>
 * 
 * Attributes:
 *   - value: Progress value 0-100 (required)
 *   - size: sm|md|lg (default: md)
 *   - show-value: Display value in center (boolean)
 *   - color: Custom color (optional, uses variant colors by default)
 *   - variant: success|warning|error|primary (default: primary)
 */

import { WorkrailComponent } from './base.js';

export class ProgressRing extends WorkrailComponent {
  connectedCallback() {
    const value = parseFloat(this.getAttr('value', '0'));
    const size = this.getAttr('size', 'md');
    const showValue = this.getBoolAttr('show-value');
    const color = this.getAttr('color');
    const variant = this.getAttr('variant', 'primary');
    
    this.shadowRoot.appendChild(this.loadTokens());
    this.shadowRoot.appendChild(this.createStyle(this.styles(size)));
    this.shadowRoot.appendChild(this.render(value, size, showValue, color, variant));
  }
  
  styles(size) {
    const sizes = {
      sm: { ring: 60, stroke: 4 },
      md: { ring: 100, stroke: 6 },
      lg: { ring: 140, stroke: 8 }
    };
    
    const { ring, stroke } = sizes[size] || sizes.md;
    
    return `
      :host {
        display: inline-block;
      }
      
      .progress-ring {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: ${ring}px;
        height: ${ring}px;
      }
      
      .progress-ring svg {
        transform: rotate(-90deg);
      }
      
      .progress-ring-circle {
        fill: none;
        stroke-width: ${stroke};
        transition: stroke-dashoffset var(--duration-slow) var(--ease-out);
      }
      
      .progress-ring-track {
        stroke: var(--border-light);
      }
      
      .progress-ring-fill {
        stroke-linecap: round;
      }
      
      /* Variant colors */
      .variant-primary .progress-ring-fill {
        stroke: var(--primary-500);
      }
      
      .variant-success .progress-ring-fill {
        stroke: var(--status-success);
      }
      
      .variant-warning .progress-ring-fill {
        stroke: var(--status-pending);
      }
      
      .variant-error .progress-ring-fill {
        stroke: var(--status-error);
      }
      
      .progress-value {
        position: absolute;
        font-size: var(--text-xl);
        font-weight: var(--font-bold);
        color: var(--text-primary);
      }
      
      .size-sm .progress-value {
        font-size: var(--text-sm);
      }
      
      .size-lg .progress-value {
        font-size: var(--text-3xl);
      }
    `;
  }
  
  render(value, size, showValue, customColor, variant) {
    const sizes = {
      sm: { ring: 60, stroke: 4 },
      md: { ring: 100, stroke: 6 },
      lg: { ring: 140, stroke: 8 }
    };
    
    const { ring, stroke } = sizes[size] || sizes.md;
    const radius = (ring - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (value / 100) * circumference;
    
    const container = document.createElement('div');
    container.className = `progress-ring size-${size} variant-${variant}`;
    
    // SVG
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', ring);
    svg.setAttribute('height', ring);
    
    // Track (background circle)
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.classList.add('progress-ring-circle', 'progress-ring-track');
    track.setAttribute('cx', ring / 2);
    track.setAttribute('cy', ring / 2);
    track.setAttribute('r', radius);
    svg.appendChild(track);
    
    // Fill (progress circle)
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fill.classList.add('progress-ring-circle', 'progress-ring-fill');
    fill.setAttribute('cx', ring / 2);
    fill.setAttribute('cy', ring / 2);
    fill.setAttribute('r', radius);
    fill.setAttribute('stroke-dasharray', `${circumference} ${circumference}`);
    fill.setAttribute('stroke-dashoffset', offset);
    
    if (customColor) {
      fill.setAttribute('stroke', customColor);
    }
    
    svg.appendChild(fill);
    container.appendChild(svg);
    
    // Value display
    if (showValue) {
      const valueEl = document.createElement('div');
      valueEl.className = 'progress-value';
      valueEl.textContent = `${Math.round(value)}%`;
      container.appendChild(valueEl);
    }
    
    return container;
  }
}

customElements.define('wr-progress-ring', ProgressRing);
