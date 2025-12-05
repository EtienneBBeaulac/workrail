/**
 * Stack Component
 * Vertical or horizontal stack layout
 * 
 * Usage:
 *   <wr-stack direction="vertical" gap="md" align="center">
 *     <wr-card>Item 1</wr-card>
 *     <wr-card>Item 2</wr-card>
 *   </wr-stack>
 * 
 * Attributes:
 *   - direction: vertical|horizontal (default: vertical)
 *   - gap: xs|sm|md|lg|xl (default: md)
 *   - align: start|center|end|stretch (default: stretch)
 *   - justify: start|center|end|space-between (default: start)
 */

import { WorkrailComponent } from './base.js';

export class Stack extends WorkrailComponent {
  connectedCallback() {
    const direction = this.getAttr('direction', 'vertical');
    const gap = this.getAttr('gap', 'md');
    const align = this.getAttr('align', 'stretch');
    const justify = this.getAttr('justify', 'start');
    
    this.shadowRoot.appendChild(this.loadTokens());
    this.shadowRoot.appendChild(this.createStyle(this.styles(direction, gap, align, justify)));
    this.shadowRoot.appendChild(this.render());
  }
  
  styles(direction, gap, align, justify) {
    const gapSizes = {
      xs: 'var(--space-2)',
      sm: 'var(--space-4)',
      md: 'var(--space-6)',
      lg: 'var(--space-8)',
      xl: 'var(--space-12)'
    };
    
    const gapValue = gapSizes[gap] || gap;
    const flexDirection = direction === 'horizontal' ? 'row' : 'column';
    
    return `
      :host {
        display: block;
      }
      
      .stack {
        display: flex;
        flex-direction: ${flexDirection};
        gap: ${gapValue};
        align-items: ${align};
        justify-content: ${justify};
      }
    `;
  }
  
  render() {
    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.appendChild(document.createElement('slot'));
    return stack;
  }
}

customElements.define('wr-stack', Stack);
