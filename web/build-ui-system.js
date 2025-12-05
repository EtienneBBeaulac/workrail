#!/usr/bin/env node

/**
 * Build Script for Workrail UI System
 * Consolidates all CSS and JS files into unified imports
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, 'assets');
const OUTPUT_CSS = path.join(ASSETS_DIR, 'workrail-ui.css');
const OUTPUT_JS = path.join(ASSETS_DIR, 'workrail-ui.js');

// CSS Files to combine (in order)
const CSS_FILES = [
  'design-system.css',
  'animations.css',
  'components.css',
  'background-effects.css',
  'theme-toggle.css'
];

// JS Files to combine (in order)
const JS_FILES = [
  'theme-manager.js',
  'theme-toggle.js',
  'particle-generator.js',
  'background-interaction.js',
  'time-of-day-theme.js',
  'scroll-parallax.js',
  'components.js'
];

console.log('🏗️  Building Workrail UI System...\n');

// ============================================
// BUILD CSS
// ============================================

console.log('📦 Combining CSS files...');

let cssContent = `/**
 * ========================================
 * WORKRAIL UI SYSTEM v2.0
 * ========================================
 * 
 * Single CSS import for all styling
 * Based on test-design-system.html (battle-tested)
 * 
 * Usage:
 *   <link rel="stylesheet" href="/assets/workrail-ui.css">
 * 
 * Contents:
 *   1. Design Tokens (colors, spacing, typography)
 *   2. Base Styles & Resets
 *   3. Layout Components (Grid, Stack, DashboardLayout)
 *   4. UI Components (Card, Button, etc.)
 *   5. Animation Library
 *   6. Background Effects
 *   7. Theme System
 * 
 * Generated: ${new Date().toISOString()}
 */

`;

CSS_FILES.forEach((file, index) => {
  const filePath = path.join(ASSETS_DIR, file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  Warning: ${file} not found, skipping...`);
    return;
  }
  
  console.log(`   ✓ ${file}`);
  
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Add section header
  cssContent += `\n/* ============================================
   ${index + 1}. ${file.toUpperCase().replace('.CSS', '')}
   ============================================ */\n\n`;
  
  cssContent += content;
  cssContent += '\n\n';
});

// Add new layout component styles
cssContent += `\n/* ============================================
   8. LAYOUT COMPONENTS (NEW)
   ============================================ */

/* Dashboard Layout - Handles all layout concerns */
.wr-dashboard-layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.wr-dashboard-header {
  flex-shrink: 0;
  z-index: 100;
}

.wr-dashboard-header.wr-sticky {
  position: sticky;
  top: 0;
  background: var(--bg-primary);
  box-shadow: var(--shadow-sm);
}

[data-theme="dark"] .wr-dashboard-header.wr-sticky {
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-light);
}

.wr-dashboard-body {
  flex: 1;
  display: flex;
  position: relative;
}

.wr-dashboard-sidebar {
  flex-shrink: 0;
  width: 280px;
  padding: var(--space-6);
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-light);
}

.wr-dashboard-main {
  flex: 1;
  width: 100%;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
}

.wr-dashboard-footer {
  flex-shrink: 0;
  padding: var(--space-6);
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-light);
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}

/* Page Container - Consistent max-width and padding */
.wr-page-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
}

/* Grid - Responsive grid system */
.wr-grid {
  display: grid;
}

/* Stack - Vertical/horizontal layout */
.wr-stack {
  display: flex;
}

.wr-stack-vertical {
  flex-direction: column;
}

.wr-stack-horizontal {
  flex-direction: row;
}

/* Spacer - Design token spacing */
.wr-spacer {
  flex-shrink: 0;
}

/* Responsive behavior */
@media (max-width: 1024px) {
  .wr-dashboard-sidebar {
    width: 240px;
  }
}

@media (max-width: 768px) {
  .wr-dashboard-sidebar {
    display: none; /* Hidden on mobile by default */
  }
  
  .wr-dashboard-main,
  .wr-page-container {
    padding: var(--space-6) var(--space-4);
  }
}

@media (max-width: 480px) {
  .wr-dashboard-main,
  .wr-page-container {
    padding: var(--space-4) var(--space-3);
  }
}

/* ============================================
   END OF WORKRAIL UI SYSTEM CSS
   ============================================ */
`;

fs.writeFileSync(OUTPUT_CSS, cssContent);
console.log(`\n✅ Created: ${OUTPUT_CSS}`);
console.log(`   Size: ${(cssContent.length / 1024).toFixed(2)} KB`);

// ============================================
// BUILD JS
// ============================================

console.log('\n📦 Combining JS files...\n');

let jsContent = `/**
 * ========================================
 * WORKRAIL UI SYSTEM v2.0
 * ========================================
 * 
 * Complete UI framework for dashboards
 * Based on test-design-system.html (battle-tested)
 * 
 * Usage:
 *   <script src="/assets/workrail-ui.js"></script>
 *   const dashboard = WorkrailUI.createDashboard({ ... });
 * 
 * Generated: ${new Date().toISOString()}
 */

(function(global) {
  'use strict';
  
  console.log('%c🚀 Workrail UI System v2.0', 'color: #8b5cf6; font-weight: bold; font-size: 14px;');
  
  // ============================================
  // EXISTING FUNCTIONALITY
  // ============================================
  
`;

JS_FILES.forEach((file, index) => {
  const filePath = path.join(ASSETS_DIR, file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  Warning: ${file} not found, skipping...`);
    return;
  }
  
  console.log(`   ✓ ${file}`);
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Remove IIFE wrappers if present
  content = content.replace(/^\(function\s*\([^)]*\)\s*\{/, '');
  content = content.replace(/\}\)\([^)]*\);?\s*$/, '');
  
  // Add section header
  jsContent += `\n  // ============================================
  // ${file.toUpperCase().replace('.JS', '')}
  // ============================================\n\n`;
  
  jsContent += content.trim();
  jsContent += '\n\n';
});

// Add WorkrailUI namespace wrapper
jsContent += `
  // ============================================
  // WORKRAIL UI NAMESPACE
  // ============================================
  
  const WorkrailUI = {
    version: '2.0.0',
    
    // Theme system (from theme-manager.js)
    Theme: typeof window.WorkrailTheme !== 'undefined' ? window.WorkrailTheme : {},
    
    // Background system (from particle-generator.js, background-interaction.js)
    Background: typeof window.WorkrailBackground !== 'undefined' ? window.WorkrailBackground : {},
    
    // Components (from components.js)
    ...(typeof window.WorkrailComponents !== 'undefined' ? window.WorkrailComponents : {}),
    
    // Utilities
    Utils: {
      formatTime: function(timestamp) {
        return new Date(timestamp).toLocaleTimeString();
      },
      formatDate: function(timestamp) {
        return new Date(timestamp).toLocaleDateString();
      }
    }
  };
  
  // Export to global
  global.WorkrailUI = WorkrailUI;
  
  // Also keep individual exports for backwards compatibility
  if (typeof window.WorkrailTheme !== 'undefined') {
    global.WorkrailTheme = window.WorkrailTheme;
  }
  if (typeof window.WorkrailComponents !== 'undefined') {
    global.WorkrailComponents = window.WorkrailComponents;
  }
  if (typeof window.WorkrailBackground !== 'undefined') {
    global.WorkrailBackground = window.WorkrailBackground;
  }
  
  console.log('✅ Workrail UI initialized');
  
})(typeof window !== 'undefined' ? window : this);
`;

fs.writeFileSync(OUTPUT_JS, jsContent);
console.log(`\n✅ Created: ${OUTPUT_JS}`);
console.log(`   Size: ${(jsContent.length / 1024).toFixed(2)} KB`);

console.log('\n🎉 Build complete!\n');
console.log('📄 Usage:');
console.log('   <link rel="stylesheet" href="/assets/workrail-ui.css">');
console.log('   <script src="/assets/workrail-ui.js"></script>\n');




/**
 * Build Script for Workrail UI System
 * Consolidates all CSS and JS files into unified imports
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, 'assets');
const OUTPUT_CSS = path.join(ASSETS_DIR, 'workrail-ui.css');
const OUTPUT_JS = path.join(ASSETS_DIR, 'workrail-ui.js');

// CSS Files to combine (in order)
const CSS_FILES = [
  'design-system.css',
  'animations.css',
  'components.css',
  'background-effects.css',
  'theme-toggle.css'
];

// JS Files to combine (in order)
const JS_FILES = [
  'theme-manager.js',
  'theme-toggle.js',
  'particle-generator.js',
  'background-interaction.js',
  'time-of-day-theme.js',
  'scroll-parallax.js',
  'components.js'
];

console.log('🏗️  Building Workrail UI System...\n');

// ============================================
// BUILD CSS
// ============================================

console.log('📦 Combining CSS files...');

let cssContent = `/**
 * ========================================
 * WORKRAIL UI SYSTEM v2.0
 * ========================================
 * 
 * Single CSS import for all styling
 * Based on test-design-system.html (battle-tested)
 * 
 * Usage:
 *   <link rel="stylesheet" href="/assets/workrail-ui.css">
 * 
 * Contents:
 *   1. Design Tokens (colors, spacing, typography)
 *   2. Base Styles & Resets
 *   3. Layout Components (Grid, Stack, DashboardLayout)
 *   4. UI Components (Card, Button, etc.)
 *   5. Animation Library
 *   6. Background Effects
 *   7. Theme System
 * 
 * Generated: ${new Date().toISOString()}
 */

`;

CSS_FILES.forEach((file, index) => {
  const filePath = path.join(ASSETS_DIR, file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  Warning: ${file} not found, skipping...`);
    return;
  }
  
  console.log(`   ✓ ${file}`);
  
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Add section header
  cssContent += `\n/* ============================================
   ${index + 1}. ${file.toUpperCase().replace('.CSS', '')}
   ============================================ */\n\n`;
  
  cssContent += content;
  cssContent += '\n\n';
});

// Add new layout component styles
cssContent += `\n/* ============================================
   8. LAYOUT COMPONENTS (NEW)
   ============================================ */

/* Dashboard Layout - Handles all layout concerns */
.wr-dashboard-layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.wr-dashboard-header {
  flex-shrink: 0;
  z-index: 100;
}

.wr-dashboard-header.wr-sticky {
  position: sticky;
  top: 0;
  background: var(--bg-primary);
  box-shadow: var(--shadow-sm);
}

[data-theme="dark"] .wr-dashboard-header.wr-sticky {
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-light);
}

.wr-dashboard-body {
  flex: 1;
  display: flex;
  position: relative;
}

.wr-dashboard-sidebar {
  flex-shrink: 0;
  width: 280px;
  padding: var(--space-6);
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-light);
}

.wr-dashboard-main {
  flex: 1;
  width: 100%;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
}

.wr-dashboard-footer {
  flex-shrink: 0;
  padding: var(--space-6);
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-light);
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}

/* Page Container - Consistent max-width and padding */
.wr-page-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-6);
}

/* Grid - Responsive grid system */
.wr-grid {
  display: grid;
}

/* Stack - Vertical/horizontal layout */
.wr-stack {
  display: flex;
}

.wr-stack-vertical {
  flex-direction: column;
}

.wr-stack-horizontal {
  flex-direction: row;
}

/* Spacer - Design token spacing */
.wr-spacer {
  flex-shrink: 0;
}

/* Responsive behavior */
@media (max-width: 1024px) {
  .wr-dashboard-sidebar {
    width: 240px;
  }
}

@media (max-width: 768px) {
  .wr-dashboard-sidebar {
    display: none; /* Hidden on mobile by default */
  }
  
  .wr-dashboard-main,
  .wr-page-container {
    padding: var(--space-6) var(--space-4);
  }
}

@media (max-width: 480px) {
  .wr-dashboard-main,
  .wr-page-container {
    padding: var(--space-4) var(--space-3);
  }
}

/* ============================================
   END OF WORKRAIL UI SYSTEM CSS
   ============================================ */
`;

fs.writeFileSync(OUTPUT_CSS, cssContent);
console.log(`\n✅ Created: ${OUTPUT_CSS}`);
console.log(`   Size: ${(cssContent.length / 1024).toFixed(2)} KB`);

// ============================================
// BUILD JS
// ============================================

console.log('\n📦 Combining JS files...\n');

let jsContent = `/**
 * ========================================
 * WORKRAIL UI SYSTEM v2.0
 * ========================================
 * 
 * Complete UI framework for dashboards
 * Based on test-design-system.html (battle-tested)
 * 
 * Usage:
 *   <script src="/assets/workrail-ui.js"></script>
 *   const dashboard = WorkrailUI.createDashboard({ ... });
 * 
 * Generated: ${new Date().toISOString()}
 */

(function(global) {
  'use strict';
  
  console.log('%c🚀 Workrail UI System v2.0', 'color: #8b5cf6; font-weight: bold; font-size: 14px;');
  
  // ============================================
  // EXISTING FUNCTIONALITY
  // ============================================
  
`;

JS_FILES.forEach((file, index) => {
  const filePath = path.join(ASSETS_DIR, file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  Warning: ${file} not found, skipping...`);
    return;
  }
  
  console.log(`   ✓ ${file}`);
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Remove IIFE wrappers if present
  content = content.replace(/^\(function\s*\([^)]*\)\s*\{/, '');
  content = content.replace(/\}\)\([^)]*\);?\s*$/, '');
  
  // Add section header
  jsContent += `\n  // ============================================
  // ${file.toUpperCase().replace('.JS', '')}
  // ============================================\n\n`;
  
  jsContent += content.trim();
  jsContent += '\n\n';
});

// Add WorkrailUI namespace wrapper
jsContent += `
  // ============================================
  // WORKRAIL UI NAMESPACE
  // ============================================
  
  const WorkrailUI = {
    version: '2.0.0',
    
    // Theme system (from theme-manager.js)
    Theme: typeof window.WorkrailTheme !== 'undefined' ? window.WorkrailTheme : {},
    
    // Background system (from particle-generator.js, background-interaction.js)
    Background: typeof window.WorkrailBackground !== 'undefined' ? window.WorkrailBackground : {},
    
    // Components (from components.js)
    ...(typeof window.WorkrailComponents !== 'undefined' ? window.WorkrailComponents : {}),
    
    // Utilities
    Utils: {
      formatTime: function(timestamp) {
        return new Date(timestamp).toLocaleTimeString();
      },
      formatDate: function(timestamp) {
        return new Date(timestamp).toLocaleDateString();
      }
    }
  };
  
  // Export to global
  global.WorkrailUI = WorkrailUI;
  
  // Also keep individual exports for backwards compatibility
  if (typeof window.WorkrailTheme !== 'undefined') {
    global.WorkrailTheme = window.WorkrailTheme;
  }
  if (typeof window.WorkrailComponents !== 'undefined') {
    global.WorkrailComponents = window.WorkrailComponents;
  }
  if (typeof window.WorkrailBackground !== 'undefined') {
    global.WorkrailBackground = window.WorkrailBackground;
  }
  
  console.log('✅ Workrail UI initialized');
  
})(typeof window !== 'undefined' ? window : this);
`;

fs.writeFileSync(OUTPUT_JS, jsContent);
console.log(`\n✅ Created: ${OUTPUT_JS}`);
console.log(`   Size: ${(jsContent.length / 1024).toFixed(2)} KB`);

console.log('\n🎉 Build complete!\n');
console.log('📄 Usage:');
console.log('   <link rel="stylesheet" href="/assets/workrail-ui.css">');
console.log('   <script src="/assets/workrail-ui.js"></script>\n');



