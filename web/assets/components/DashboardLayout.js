/**
 * DashboardLayout Component
 * Handles all layout concerns - fixes header positioning, padding bugs
 * 
 * Usage:
 *   <wr-dashboard-layout>
 *     <div slot="header">Header content</div>
 *     <div slot="sidebar">Sidebar content</div>
 *     <div slot="main">Main content</div>
 *     <div slot="footer">Footer content</div>
 *   </wr-dashboard-layout>
 * 
 * Attributes:
 *   - sticky-header: Make header sticky (default: true)
 *   - max-width: Max width of main content (default: 1200px)
 *   - show-sidebar: Show sidebar (default: false)
 */

import { WorkrailComponent } from './base.js';

export class DashboardLayout extends WorkrailComponent {
  connectedCallback() {
    const stickyHeader = this.getAttr('sticky-header', 'true') === 'true';
    const maxWidth = this.getAttr('max-width', '1200px');
    const showSidebar = this.getBoolAttr('show-sidebar');
    
    this.shadowRoot.appendChild(this.loadTokens());
    this.shadowRoot.appendChild(this.createStyle(this.styles(maxWidth)));
    this.shadowRoot.appendChild(this.render(stickyHeader, showSidebar));
  }
  
  styles(maxWidth) {
    return `
      :host {
        display: block;
      }
      
      .layout {
        display: flex;
        flex-direction: column;
        min-height: 100vh;
      }
      
      .header {
        flex-shrink: 0;
        z-index: var(--z-50);
      }
      
      .header.sticky {
        position: sticky;
        top: 0;
        background: var(--bg-primary);
        box-shadow: var(--shadow-sm);
      }
      
      [data-theme="dark"] .header.sticky {
        border-bottom: 1px solid var(--border-light);
      }
      
      .body {
        flex: 1;
        display: flex;
        position: relative;
      }
      
      .sidebar {
        flex-shrink: 0;
        width: 280px;
        padding: var(--space-6);
        background: var(--bg-secondary);
        border-right: 1px solid var(--border-light);
        overflow-y: auto;
      }
      
      .main {
        flex: 1;
        width: 100%;
        max-width: ${maxWidth};
        margin: 0 auto;
        padding: var(--space-8) var(--space-6);
      }
      
      .footer {
        flex-shrink: 0;
        padding: var(--space-6);
        background: var(--bg-secondary);
        border-top: 1px solid var(--border-light);
        text-align: center;
        color: var(--text-tertiary);
        font-size: var(--text-sm);
      }
      
      /* Responsive */
      @media (max-width: 1024px) {
        .sidebar {
          width: 240px;
        }
      }
      
      @media (max-width: 768px) {
        .sidebar {
          display: none;
        }
        
        .main {
          padding: var(--space-6) var(--space-4);
        }
      }
      
      @media (max-width: 480px) {
        .main {
          padding: var(--space-4) var(--space-3);
        }
      }
    `;
  }
  
  render(stickyHeader, showSidebar) {
    const layout = document.createElement('div');
    layout.className = 'layout';
    
    // Header
    const header = document.createElement('div');
    header.className = `header${stickyHeader ? ' sticky' : ''}`;
    header.appendChild(document.createElement('slot'));
    header.querySelector('slot').setAttribute('name', 'header');
    layout.appendChild(header);
    
    // Body (main + optional sidebar)
    const body = document.createElement('div');
    body.className = 'body';
    
    // Sidebar (if enabled)
    if (showSidebar) {
      const sidebar = document.createElement('aside');
      sidebar.className = 'sidebar';
      const sidebarSlot = document.createElement('slot');
      sidebarSlot.setAttribute('name', 'sidebar');
      sidebar.appendChild(sidebarSlot);
      body.appendChild(sidebar);
    }
    
    // Main content
    const main = document.createElement('main');
    main.className = 'main';
    const mainSlot = document.createElement('slot');
    mainSlot.setAttribute('name', 'main');
    main.appendChild(mainSlot);
    body.appendChild(main);
    
    layout.appendChild(body);
    
    // Footer (optional)
    const footer = document.createElement('div');
    footer.className = 'footer';
    const footerSlot = document.createElement('slot');
    footerSlot.setAttribute('name', 'footer');
    footer.appendChild(footerSlot);
    layout.appendChild(footer);
    
    return layout;
  }
}

customElements.define('wr-dashboard-layout', DashboardLayout);
