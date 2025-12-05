/**
 * Grid Component
 * Responsive grid layout with design tokens
 * 
 * Usage:
 *   <wr-grid columns="3" gap="lg">
 *     <wr-card>Item 1</wr-card>
 *     <wr-card>Item 2</wr-card>
 *     <wr-card>Item 3</wr-card>
 *   </wr-grid>
 * 
 * Attributes:
 *   - columns: Number of columns or 'auto-fit' (default: auto-fit)
 *   - min-width: Min width for auto-fit (default: 300px)
 *   - gap: xs|sm|md|lg|xl (default: md)
 */

import { WorkrailComponent } from './base.js';

export class Grid extends WorkrailComponent {
  connectedCallback() {
    const columns = this.getAttr('columns', 'auto-fit');
    const minWidth = this.getAttr('min-width', '300px');
    const gap = this.getAttr('gap', 'md');
    
    this.shadowRoot.appendChild(this.loadTokens());
    this.shadowRoot.appendChild(this.createStyle(this.styles(columns, minWidth, gap)));
    this.shadowRoot.appendChild(this.render());
  }
  
  styles(columns, minWidth, gap) {
    const gapSizes = {
      xs: 'var(--space-2)',
      sm: 'var(--space-4)',
      md: 'var(--space-6)',
      lg: 'var(--space-8)',
      xl: 'var(--space-12)'
    };
    
    const gapValue = gapSizes[gap] || gap;
    
    let gridTemplate;
    if (columns === 'auto-fit') {
      gridTemplate = `repeat(auto-fit, minmax(${minWidth}, 1fr))`;
    } else if (columns === 'auto-fill') {
      gridTemplate = `repeat(auto-fill, minmax(${minWidth}, 1fr))`;
    } else {
      gridTemplate = `repeat(${columns}, 1fr)`;
    }
    
    return `
      :host {
        display: block;
      }
      
      .grid {
        display: grid;
        grid-template-columns: ${gridTemplate};
        gap: ${gapValue};
      }
    `;
  }
  
  render() {
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.appendChild(document.createElement('slot'));
    return grid;
  }
}

customElements.define('wr-grid', Grid);
