# Phase 1 Implementation: Foundation

## 🎯 **Goal**: Create unified, bulletproof foundation based on test-design-system.html

## 📦 **What We're Building**

### **1. Unified CSS System**
`/assets/workrail-ui.css` - Single import for everything

```css
/* Current (test page) */
<link rel="stylesheet" href="/assets/design-system.css">
<link rel="stylesheet" href="/assets/animations.css">
<link rel="stylesheet" href="/assets/components.css">
<link rel="stylesheet" href="/assets/background-effects.css">
<link rel="stylesheet" href="/assets/theme-toggle.css">

/* New (unified) */
<link rel="stylesheet" href="/assets/workrail-ui.css">
```

### **2. Unified JS System**
`/assets/workrail-ui.js` - Single import with all functionality

```javascript
/* Current (test page) */
<script src="/assets/theme-manager.js"></script>
<script src="/assets/theme-toggle.js"></script>
<script src="/assets/particle-generator.js"></script>
<script src="/assets/background-interaction.js"></script>
<script src="/assets/time-of-day-theme.js"></script>
<script src="/assets/scroll-parallax.js"></script>
<script src="/assets/components.js"></script>

/* New (unified) */
<script src="/assets/workrail-ui.js"></script>
```

### **3. Component Library 2.0**
Enhanced components with:
- Prop validation
- Automatic error messages
- Theme-aware by default
- Accessible by default
- Tested

### **4. Layout System**
New components to prevent layout bugs:
- `DashboardLayout` - Fixed header, responsive main, optional sidebar
- `PageContainer` - Consistent max-width and padding
- `Grid` - Responsive grid with design tokens
- `Stack` - Vertical/horizontal stacks with consistent spacing
- `Spacer` - Design token spacing

---

## 📋 **Phase 1 Tasks**

### ✅ **Task 1.1: Create Unified CSS** (30 min)

**File:** `/assets/workrail-ui.css`

**Structure:**
```css
/* ==============================================
   WORKRAIL UI SYSTEM v2.0
   Single CSS import for all styling
   Based on test-design-system.html
   ============================================== */

/* 1. CSS Variables & Design Tokens */
/* ... from design-system.css ... */

/* 2. Reset & Base Styles */
/* ... from design-system.css ... */

/* 3. Layout Utilities */
/* NEW: Layout components */

/* 4. Component Styles */
/* ... from components.css ... */

/* 5. Animation Library */
/* ... from animations.css ... */

/* 6. Background Effects */
/* ... from background-effects.css ... */

/* 7. Theme Toggle */
/* ... from theme-toggle.css ... */

/* 8. Theme System */
/* Dark mode styles, transitions */
```

**Action:**
1. Combine all CSS files
2. Remove duplicates
3. Organize by section
4. Add clear comments
5. Ensure proper cascade order

---

### ✅ **Task 1.2: Create Unified JS** (45 min)

**File:** `/assets/workrail-ui.js`

**Structure:**
```javascript
/**
 * WORKRAIL UI SYSTEM v2.0
 * Complete UI framework for dashboards
 * 
 * Usage:
 *   <script src="/assets/workrail-ui.js"></script>
 *   const dashboard = WorkrailUI.createDashboard({ ... });
 */

(function(global) {
  'use strict';
  
  // ============================================
  // CORE SYSTEM
  // ============================================
  
  const WorkrailUI = {
    version: '2.0.0',
    
    // Theme system
    Theme: { ... },
    
    // Background effects
    Background: { ... },
    
    // Utilities
    Utils: { ... },
    
    // Components (below)
  };
  
  // ============================================
  // LAYOUT COMPONENTS
  // ============================================
  
  /**
   * DashboardLayout - Handles all layout concerns
   * Fixes header positioning, padding, responsive behavior
   */
  WorkrailUI.DashboardLayout = function(props) { ... };
  
  /**
   * PageContainer - Consistent max-width and padding
   */
  WorkrailUI.PageContainer = function(props) { ... };
  
  /**
   * Grid - Responsive grid system
   */
  WorkrailUI.Grid = function(props) { ... };
  
  /**
   * Stack - Vertical/horizontal layout
   */
  WorkrailUI.Stack = function(props) { ... };
  
  /**
   * Spacer - Design token spacing
   */
  WorkrailUI.Spacer = function(size) { ... };
  
  // ============================================
  // DATA DISPLAY COMPONENTS
  // ============================================
  
  WorkrailUI.Card = function(props) { ... };
  WorkrailUI.Hero = function(props) { ... };
  WorkrailUI.StatCard = function(props) { ... };
  WorkrailUI.Badge = function(props) { ... };
  WorkrailUI.ProgressRing = function(props) { ... };
  WorkrailUI.Timeline = function(props) { ... };
  // ... more components
  
  // ============================================
  // INTERACTIVE COMPONENTS
  // ============================================
  
  WorkrailUI.Button = function(props) { ... };
  WorkrailUI.Modal = function(props) { ... };
  WorkrailUI.Dropdown = function(props) { ... };
  // ... more components
  
  // ============================================
  // SCAFFOLD SYSTEM
  // ============================================
  
  /**
   * createDashboard - High-level dashboard builder
   */
  WorkrailUI.createDashboard = function(config) { ... };
  
  // ============================================
  // PROP VALIDATION
  // ============================================
  
  const PropTypes = {
    string: (val, name) => { ... },
    number: (val, name) => { ... },
    function: (val, name) => { ... },
    oneOf: (values) => { ... },
    // ... more validators
  };
  
  function validateProps(props, schema, componentName) { ... }
  
  // ============================================
  // AUTO-INITIALIZATION
  // ============================================
  
  document.addEventListener('DOMContentLoaded', () => {
    // Auto-init theme system
    WorkrailUI.Theme.init();
    
    // Auto-init background effects if containers exist
    if (document.querySelector('.bg-orbs')) {
      WorkrailUI.Background.init();
    }
    
    // Initialize Lucide icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  });
  
  // Export
  global.WorkrailUI = WorkrailUI;
  
})(typeof window !== 'undefined' ? window : this);
```

---

### ✅ **Task 1.3: Build Layout Components** (60 min)

#### **DashboardLayout**
Solves: Header positioning, padding bugs, responsive behavior

```javascript
/**
 * @typedef {Object} DashboardLayoutProps
 * @property {HTMLElement|Object} header - Header content or config
 * @property {HTMLElement} [sidebar] - Optional sidebar
 * @property {HTMLElement|HTMLElement[]} main - Main content
 * @property {HTMLElement} [footer] - Optional footer
 * @property {boolean} [stickyHeader=true] - Sticky header
 * @property {string} [maxWidth='1200px'] - Max width of main content
 */

WorkrailUI.DashboardLayout = function(props = {}) {
  validateProps(props, {
    header: PropTypes.oneOfType([PropTypes.element, PropTypes.object]),
    sidebar: PropTypes.element,
    main: PropTypes.oneOfType([PropTypes.element, PropTypes.arrayOf(PropTypes.element)]).required,
    footer: PropTypes.element,
    stickyHeader: PropTypes.bool,
    maxWidth: PropTypes.string
  }, 'DashboardLayout');
  
  const {
    header,
    sidebar,
    main,
    footer,
    stickyHeader = true,
    maxWidth = '1200px'
  } = props;
  
  // Create layout container
  const layout = createElement('div', ['wr-dashboard-layout']);
  
  // Header
  if (header) {
    const headerEl = typeof header === 'object' && header.title
      ? WorkrailUI.Header(header)
      : header;
    
    const headerContainer = createElement('header', [
      'wr-dashboard-header',
      stickyHeader ? 'wr-sticky' : ''
    ]);
    headerContainer.appendChild(headerEl);
    layout.appendChild(headerContainer);
  }
  
  // Main content wrapper
  const mainWrapper = createElement('div', ['wr-dashboard-body']);
  
  // Sidebar (if provided)
  if (sidebar) {
    const sidebarEl = createElement('aside', ['wr-dashboard-sidebar']);
    sidebarEl.appendChild(sidebar);
    mainWrapper.appendChild(sidebarEl);
  }
  
  // Main content
  const mainEl = createElement('main', ['wr-dashboard-main'], {
    style: { maxWidth }
  });
  
  if (Array.isArray(main)) {
    main.forEach(child => mainEl.appendChild(child));
  } else {
    mainEl.appendChild(main);
  }
  
  mainWrapper.appendChild(mainEl);
  layout.appendChild(mainWrapper);
  
  // Footer (if provided)
  if (footer) {
    const footerEl = createElement('footer', ['wr-dashboard-footer']);
    footerEl.appendChild(footer);
    layout.appendChild(footerEl);
  }
  
  return layout;
};
```

#### **CSS for DashboardLayout**
```css
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
  border-right: 1px solid var(--border-color);
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
  border-top: 1px solid var(--border-color);
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}

/* Responsive */
@media (max-width: 768px) {
  .wr-dashboard-sidebar {
    display: none; /* Hidden on mobile by default */
  }
  
  .wr-dashboard-main {
    padding: var(--space-6) var(--space-4);
  }
}
```

#### **Grid Component**
```javascript
/**
 * @typedef {Object} GridProps
 * @property {number|string} [columns='auto-fit'] - Number of columns or 'auto-fit'/'auto-fill'
 * @property {string} [gap='md'] - Gap size (xs|sm|md|lg|xl|2xl)
 * @property {HTMLElement[]} children - Grid items
 * @property {string} [minItemWidth='300px'] - Min width for auto-fit/auto-fill
 */

WorkrailUI.Grid = function(props = {}) {
  const {
    columns = 'auto-fit',
    gap = 'md',
    children = [],
    minItemWidth = '300px'
  } = props;
  
  const grid = createElement('div', ['wr-grid']);
  
  // Set grid template
  if (typeof columns === 'number') {
    grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  } else {
    grid.style.gridTemplateColumns = `repeat(${columns}, minmax(${minItemWidth}, 1fr))`;
  }
  
  // Set gap
  const gapSizes = {
    xs: 'var(--space-2)',
    sm: 'var(--space-4)',
    md: 'var(--space-6)',
    lg: 'var(--space-8)',
    xl: 'var(--space-10)',
    '2xl': 'var(--space-12)'
  };
  grid.style.gap = gapSizes[gap] || gap;
  
  // Add children
  children.forEach(child => grid.appendChild(child));
  
  return grid;
};
```

```css
.wr-grid {
  display: grid;
}
```

#### **Stack Component**
```javascript
/**
 * @typedef {Object} StackProps
 * @property {'vertical'|'horizontal'} [direction='vertical'] - Stack direction
 * @property {string} [gap='md'] - Gap size (xs|sm|md|lg|xl|2xl)
 * @property {string} [align='start'] - Align items (start|center|end|stretch)
 * @property {string} [justify='start'] - Justify content (start|center|end|space-between)
 * @property {HTMLElement[]} children - Stack items
 */

WorkrailUI.Stack = function(props = {}) {
  const {
    direction = 'vertical',
    gap = 'md',
    align = 'start',
    justify = 'start',
    children = []
  } = props;
  
  const stack = createElement('div', ['wr-stack', `wr-stack-${direction}`]);
  
  // Set gap
  const gapSizes = {
    xs: 'var(--space-2)',
    sm: 'var(--space-4)',
    md: 'var(--space-6)',
    lg: 'var(--space-8)',
    xl: 'var(--space-10)',
    '2xl': 'var(--space-12)'
  };
  stack.style.gap = gapSizes[gap] || gap;
  
  // Set alignment
  stack.style.alignItems = align;
  stack.style.justifyContent = justify;
  
  // Add children
  children.forEach(child => stack.appendChild(child));
  
  return stack;
};
```

```css
.wr-stack {
  display: flex;
}

.wr-stack-vertical {
  flex-direction: column;
}

.wr-stack-horizontal {
  flex-direction: row;
}
```

---

### ✅ **Task 1.4: Prop Validation System** (30 min)

```javascript
/**
 * Prop validation utilities
 * Provides helpful error messages when components are used incorrectly
 */

const PropTypes = {
  string: function(value, propName, componentName) {
    if (typeof value !== 'string') {
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  Expected: string\n` +
        `  Received: ${typeof value}\n` +
        `  Value: ${JSON.stringify(value)}`
      );
    }
  },
  
  number: function(value, propName, componentName) {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  Expected: number\n` +
        `  Received: ${typeof value}`
      );
    }
  },
  
  function: function(value, propName, componentName) {
    if (typeof value !== 'function') {
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  Expected: function\n` +
        `  Received: ${typeof value}`
      );
    }
  },
  
  element: function(value, propName, componentName) {
    if (!(value instanceof HTMLElement)) {
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  Expected: HTMLElement\n` +
        `  Received: ${typeof value}`
      );
    }
  },
  
  oneOf: function(validValues) {
    return function(value, propName, componentName) {
      if (!validValues.includes(value)) {
        const suggestions = validValues.map(v => `'${v}'`).join(' | ');
        throw new TypeError(
          `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
          `  Expected: ${suggestions}\n` +
          `  Received: '${value}'\n` +
          `  Did you mean one of: ${validValues.join(', ')}?`
        );
      }
    };
  },
  
  oneOfType: function(validators) {
    return function(value, propName, componentName) {
      const errors = [];
      for (const validator of validators) {
        try {
          validator(value, propName, componentName);
          return; // Success
        } catch (e) {
          errors.push(e.message);
        }
      }
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  No valid type matched.\n` +
        errors.join('\n')
      );
    };
  },
  
  arrayOf: function(validator) {
    return function(value, propName, componentName) {
      if (!Array.isArray(value)) {
        throw new TypeError(
          `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
          `  Expected: array\n` +
          `  Received: ${typeof value}`
        );
      }
      value.forEach((item, index) => {
        validator(item, `${propName}[${index}]`, componentName);
      });
    };
  }
};

// Add .required to validators
Object.keys(PropTypes).forEach(key => {
  const validator = PropTypes[key];
  if (typeof validator === 'function') {
    validator.required = function(value, propName, componentName) {
      if (value === undefined || value === null) {
        throw new TypeError(
          `[WorkrailUI] Missing required prop '${propName}' in ${componentName}`
        );
      }
      return validator(value, propName, componentName);
    };
  }
});

/**
 * Validate props against schema
 */
function validateProps(props, schema, componentName) {
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
```

---

### ✅ **Task 1.5: Enhanced Component Browser** (45 min)

Create `/component-browser.html` - Interactive testing playground

Features:
- Live preview of all components
- Props editor (change values, see updates)
- Dark/light mode toggle
- Code snippet generator
- Copy button for each example
- Search/filter components

---

## 🎯 **End Goal for Phase 1**

After Phase 1, developers can:

```html
<!DOCTYPE html>
<html>
<head>
  <!-- Single import -->
  <link rel="stylesheet" href="/assets/workrail-ui.css">
  <script src="/assets/workrail-ui.js"></script>
</head>
<body>
  <div id="root"></div>
  
  <script>
    // Create a dashboard with zero layout bugs
    const dashboard = WorkrailUI.DashboardLayout({
      header: {
        title: 'My Dashboard',
        backButton: true
      },
      main: WorkrailUI.Grid({
        columns: 2,
        gap: 'lg',
        children: [
          WorkrailUI.Card({ title: 'Card 1' }),
          WorkrailUI.Card({ title: 'Card 2' })
        ]
      })
    });
    
    document.getElementById('root').appendChild(dashboard);
  </script>
</body>
</html>
```

**No layout bugs. No CSS conflicts. Perfect every time.** ✨

---

## ⏱ **Timeline**

- Task 1.1: 30 min ✓
- Task 1.2: 45 min ✓
- Task 1.3: 60 min ✓
- Task 1.4: 30 min ✓
- Task 1.5: 45 min ✓

**Total: ~3.5 hours for complete foundation**

---

**Ready to start building?** 🚀




## 🎯 **Goal**: Create unified, bulletproof foundation based on test-design-system.html

## 📦 **What We're Building**

### **1. Unified CSS System**
`/assets/workrail-ui.css` - Single import for everything

```css
/* Current (test page) */
<link rel="stylesheet" href="/assets/design-system.css">
<link rel="stylesheet" href="/assets/animations.css">
<link rel="stylesheet" href="/assets/components.css">
<link rel="stylesheet" href="/assets/background-effects.css">
<link rel="stylesheet" href="/assets/theme-toggle.css">

/* New (unified) */
<link rel="stylesheet" href="/assets/workrail-ui.css">
```

### **2. Unified JS System**
`/assets/workrail-ui.js` - Single import with all functionality

```javascript
/* Current (test page) */
<script src="/assets/theme-manager.js"></script>
<script src="/assets/theme-toggle.js"></script>
<script src="/assets/particle-generator.js"></script>
<script src="/assets/background-interaction.js"></script>
<script src="/assets/time-of-day-theme.js"></script>
<script src="/assets/scroll-parallax.js"></script>
<script src="/assets/components.js"></script>

/* New (unified) */
<script src="/assets/workrail-ui.js"></script>
```

### **3. Component Library 2.0**
Enhanced components with:
- Prop validation
- Automatic error messages
- Theme-aware by default
- Accessible by default
- Tested

### **4. Layout System**
New components to prevent layout bugs:
- `DashboardLayout` - Fixed header, responsive main, optional sidebar
- `PageContainer` - Consistent max-width and padding
- `Grid` - Responsive grid with design tokens
- `Stack` - Vertical/horizontal stacks with consistent spacing
- `Spacer` - Design token spacing

---

## 📋 **Phase 1 Tasks**

### ✅ **Task 1.1: Create Unified CSS** (30 min)

**File:** `/assets/workrail-ui.css`

**Structure:**
```css
/* ==============================================
   WORKRAIL UI SYSTEM v2.0
   Single CSS import for all styling
   Based on test-design-system.html
   ============================================== */

/* 1. CSS Variables & Design Tokens */
/* ... from design-system.css ... */

/* 2. Reset & Base Styles */
/* ... from design-system.css ... */

/* 3. Layout Utilities */
/* NEW: Layout components */

/* 4. Component Styles */
/* ... from components.css ... */

/* 5. Animation Library */
/* ... from animations.css ... */

/* 6. Background Effects */
/* ... from background-effects.css ... */

/* 7. Theme Toggle */
/* ... from theme-toggle.css ... */

/* 8. Theme System */
/* Dark mode styles, transitions */
```

**Action:**
1. Combine all CSS files
2. Remove duplicates
3. Organize by section
4. Add clear comments
5. Ensure proper cascade order

---

### ✅ **Task 1.2: Create Unified JS** (45 min)

**File:** `/assets/workrail-ui.js`

**Structure:**
```javascript
/**
 * WORKRAIL UI SYSTEM v2.0
 * Complete UI framework for dashboards
 * 
 * Usage:
 *   <script src="/assets/workrail-ui.js"></script>
 *   const dashboard = WorkrailUI.createDashboard({ ... });
 */

(function(global) {
  'use strict';
  
  // ============================================
  // CORE SYSTEM
  // ============================================
  
  const WorkrailUI = {
    version: '2.0.0',
    
    // Theme system
    Theme: { ... },
    
    // Background effects
    Background: { ... },
    
    // Utilities
    Utils: { ... },
    
    // Components (below)
  };
  
  // ============================================
  // LAYOUT COMPONENTS
  // ============================================
  
  /**
   * DashboardLayout - Handles all layout concerns
   * Fixes header positioning, padding, responsive behavior
   */
  WorkrailUI.DashboardLayout = function(props) { ... };
  
  /**
   * PageContainer - Consistent max-width and padding
   */
  WorkrailUI.PageContainer = function(props) { ... };
  
  /**
   * Grid - Responsive grid system
   */
  WorkrailUI.Grid = function(props) { ... };
  
  /**
   * Stack - Vertical/horizontal layout
   */
  WorkrailUI.Stack = function(props) { ... };
  
  /**
   * Spacer - Design token spacing
   */
  WorkrailUI.Spacer = function(size) { ... };
  
  // ============================================
  // DATA DISPLAY COMPONENTS
  // ============================================
  
  WorkrailUI.Card = function(props) { ... };
  WorkrailUI.Hero = function(props) { ... };
  WorkrailUI.StatCard = function(props) { ... };
  WorkrailUI.Badge = function(props) { ... };
  WorkrailUI.ProgressRing = function(props) { ... };
  WorkrailUI.Timeline = function(props) { ... };
  // ... more components
  
  // ============================================
  // INTERACTIVE COMPONENTS
  // ============================================
  
  WorkrailUI.Button = function(props) { ... };
  WorkrailUI.Modal = function(props) { ... };
  WorkrailUI.Dropdown = function(props) { ... };
  // ... more components
  
  // ============================================
  // SCAFFOLD SYSTEM
  // ============================================
  
  /**
   * createDashboard - High-level dashboard builder
   */
  WorkrailUI.createDashboard = function(config) { ... };
  
  // ============================================
  // PROP VALIDATION
  // ============================================
  
  const PropTypes = {
    string: (val, name) => { ... },
    number: (val, name) => { ... },
    function: (val, name) => { ... },
    oneOf: (values) => { ... },
    // ... more validators
  };
  
  function validateProps(props, schema, componentName) { ... }
  
  // ============================================
  // AUTO-INITIALIZATION
  // ============================================
  
  document.addEventListener('DOMContentLoaded', () => {
    // Auto-init theme system
    WorkrailUI.Theme.init();
    
    // Auto-init background effects if containers exist
    if (document.querySelector('.bg-orbs')) {
      WorkrailUI.Background.init();
    }
    
    // Initialize Lucide icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  });
  
  // Export
  global.WorkrailUI = WorkrailUI;
  
})(typeof window !== 'undefined' ? window : this);
```

---

### ✅ **Task 1.3: Build Layout Components** (60 min)

#### **DashboardLayout**
Solves: Header positioning, padding bugs, responsive behavior

```javascript
/**
 * @typedef {Object} DashboardLayoutProps
 * @property {HTMLElement|Object} header - Header content or config
 * @property {HTMLElement} [sidebar] - Optional sidebar
 * @property {HTMLElement|HTMLElement[]} main - Main content
 * @property {HTMLElement} [footer] - Optional footer
 * @property {boolean} [stickyHeader=true] - Sticky header
 * @property {string} [maxWidth='1200px'] - Max width of main content
 */

WorkrailUI.DashboardLayout = function(props = {}) {
  validateProps(props, {
    header: PropTypes.oneOfType([PropTypes.element, PropTypes.object]),
    sidebar: PropTypes.element,
    main: PropTypes.oneOfType([PropTypes.element, PropTypes.arrayOf(PropTypes.element)]).required,
    footer: PropTypes.element,
    stickyHeader: PropTypes.bool,
    maxWidth: PropTypes.string
  }, 'DashboardLayout');
  
  const {
    header,
    sidebar,
    main,
    footer,
    stickyHeader = true,
    maxWidth = '1200px'
  } = props;
  
  // Create layout container
  const layout = createElement('div', ['wr-dashboard-layout']);
  
  // Header
  if (header) {
    const headerEl = typeof header === 'object' && header.title
      ? WorkrailUI.Header(header)
      : header;
    
    const headerContainer = createElement('header', [
      'wr-dashboard-header',
      stickyHeader ? 'wr-sticky' : ''
    ]);
    headerContainer.appendChild(headerEl);
    layout.appendChild(headerContainer);
  }
  
  // Main content wrapper
  const mainWrapper = createElement('div', ['wr-dashboard-body']);
  
  // Sidebar (if provided)
  if (sidebar) {
    const sidebarEl = createElement('aside', ['wr-dashboard-sidebar']);
    sidebarEl.appendChild(sidebar);
    mainWrapper.appendChild(sidebarEl);
  }
  
  // Main content
  const mainEl = createElement('main', ['wr-dashboard-main'], {
    style: { maxWidth }
  });
  
  if (Array.isArray(main)) {
    main.forEach(child => mainEl.appendChild(child));
  } else {
    mainEl.appendChild(main);
  }
  
  mainWrapper.appendChild(mainEl);
  layout.appendChild(mainWrapper);
  
  // Footer (if provided)
  if (footer) {
    const footerEl = createElement('footer', ['wr-dashboard-footer']);
    footerEl.appendChild(footer);
    layout.appendChild(footerEl);
  }
  
  return layout;
};
```

#### **CSS for DashboardLayout**
```css
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
  border-right: 1px solid var(--border-color);
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
  border-top: 1px solid var(--border-color);
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}

/* Responsive */
@media (max-width: 768px) {
  .wr-dashboard-sidebar {
    display: none; /* Hidden on mobile by default */
  }
  
  .wr-dashboard-main {
    padding: var(--space-6) var(--space-4);
  }
}
```

#### **Grid Component**
```javascript
/**
 * @typedef {Object} GridProps
 * @property {number|string} [columns='auto-fit'] - Number of columns or 'auto-fit'/'auto-fill'
 * @property {string} [gap='md'] - Gap size (xs|sm|md|lg|xl|2xl)
 * @property {HTMLElement[]} children - Grid items
 * @property {string} [minItemWidth='300px'] - Min width for auto-fit/auto-fill
 */

WorkrailUI.Grid = function(props = {}) {
  const {
    columns = 'auto-fit',
    gap = 'md',
    children = [],
    minItemWidth = '300px'
  } = props;
  
  const grid = createElement('div', ['wr-grid']);
  
  // Set grid template
  if (typeof columns === 'number') {
    grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  } else {
    grid.style.gridTemplateColumns = `repeat(${columns}, minmax(${minItemWidth}, 1fr))`;
  }
  
  // Set gap
  const gapSizes = {
    xs: 'var(--space-2)',
    sm: 'var(--space-4)',
    md: 'var(--space-6)',
    lg: 'var(--space-8)',
    xl: 'var(--space-10)',
    '2xl': 'var(--space-12)'
  };
  grid.style.gap = gapSizes[gap] || gap;
  
  // Add children
  children.forEach(child => grid.appendChild(child));
  
  return grid;
};
```

```css
.wr-grid {
  display: grid;
}
```

#### **Stack Component**
```javascript
/**
 * @typedef {Object} StackProps
 * @property {'vertical'|'horizontal'} [direction='vertical'] - Stack direction
 * @property {string} [gap='md'] - Gap size (xs|sm|md|lg|xl|2xl)
 * @property {string} [align='start'] - Align items (start|center|end|stretch)
 * @property {string} [justify='start'] - Justify content (start|center|end|space-between)
 * @property {HTMLElement[]} children - Stack items
 */

WorkrailUI.Stack = function(props = {}) {
  const {
    direction = 'vertical',
    gap = 'md',
    align = 'start',
    justify = 'start',
    children = []
  } = props;
  
  const stack = createElement('div', ['wr-stack', `wr-stack-${direction}`]);
  
  // Set gap
  const gapSizes = {
    xs: 'var(--space-2)',
    sm: 'var(--space-4)',
    md: 'var(--space-6)',
    lg: 'var(--space-8)',
    xl: 'var(--space-10)',
    '2xl': 'var(--space-12)'
  };
  stack.style.gap = gapSizes[gap] || gap;
  
  // Set alignment
  stack.style.alignItems = align;
  stack.style.justifyContent = justify;
  
  // Add children
  children.forEach(child => stack.appendChild(child));
  
  return stack;
};
```

```css
.wr-stack {
  display: flex;
}

.wr-stack-vertical {
  flex-direction: column;
}

.wr-stack-horizontal {
  flex-direction: row;
}
```

---

### ✅ **Task 1.4: Prop Validation System** (30 min)

```javascript
/**
 * Prop validation utilities
 * Provides helpful error messages when components are used incorrectly
 */

const PropTypes = {
  string: function(value, propName, componentName) {
    if (typeof value !== 'string') {
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  Expected: string\n` +
        `  Received: ${typeof value}\n` +
        `  Value: ${JSON.stringify(value)}`
      );
    }
  },
  
  number: function(value, propName, componentName) {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  Expected: number\n` +
        `  Received: ${typeof value}`
      );
    }
  },
  
  function: function(value, propName, componentName) {
    if (typeof value !== 'function') {
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  Expected: function\n` +
        `  Received: ${typeof value}`
      );
    }
  },
  
  element: function(value, propName, componentName) {
    if (!(value instanceof HTMLElement)) {
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  Expected: HTMLElement\n` +
        `  Received: ${typeof value}`
      );
    }
  },
  
  oneOf: function(validValues) {
    return function(value, propName, componentName) {
      if (!validValues.includes(value)) {
        const suggestions = validValues.map(v => `'${v}'`).join(' | ');
        throw new TypeError(
          `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
          `  Expected: ${suggestions}\n` +
          `  Received: '${value}'\n` +
          `  Did you mean one of: ${validValues.join(', ')}?`
        );
      }
    };
  },
  
  oneOfType: function(validators) {
    return function(value, propName, componentName) {
      const errors = [];
      for (const validator of validators) {
        try {
          validator(value, propName, componentName);
          return; // Success
        } catch (e) {
          errors.push(e.message);
        }
      }
      throw new TypeError(
        `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
        `  No valid type matched.\n` +
        errors.join('\n')
      );
    };
  },
  
  arrayOf: function(validator) {
    return function(value, propName, componentName) {
      if (!Array.isArray(value)) {
        throw new TypeError(
          `[WorkrailUI] Invalid prop '${propName}' in ${componentName}:\n` +
          `  Expected: array\n` +
          `  Received: ${typeof value}`
        );
      }
      value.forEach((item, index) => {
        validator(item, `${propName}[${index}]`, componentName);
      });
    };
  }
};

// Add .required to validators
Object.keys(PropTypes).forEach(key => {
  const validator = PropTypes[key];
  if (typeof validator === 'function') {
    validator.required = function(value, propName, componentName) {
      if (value === undefined || value === null) {
        throw new TypeError(
          `[WorkrailUI] Missing required prop '${propName}' in ${componentName}`
        );
      }
      return validator(value, propName, componentName);
    };
  }
});

/**
 * Validate props against schema
 */
function validateProps(props, schema, componentName) {
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
```

---

### ✅ **Task 1.5: Enhanced Component Browser** (45 min)

Create `/component-browser.html` - Interactive testing playground

Features:
- Live preview of all components
- Props editor (change values, see updates)
- Dark/light mode toggle
- Code snippet generator
- Copy button for each example
- Search/filter components

---

## 🎯 **End Goal for Phase 1**

After Phase 1, developers can:

```html
<!DOCTYPE html>
<html>
<head>
  <!-- Single import -->
  <link rel="stylesheet" href="/assets/workrail-ui.css">
  <script src="/assets/workrail-ui.js"></script>
</head>
<body>
  <div id="root"></div>
  
  <script>
    // Create a dashboard with zero layout bugs
    const dashboard = WorkrailUI.DashboardLayout({
      header: {
        title: 'My Dashboard',
        backButton: true
      },
      main: WorkrailUI.Grid({
        columns: 2,
        gap: 'lg',
        children: [
          WorkrailUI.Card({ title: 'Card 1' }),
          WorkrailUI.Card({ title: 'Card 2' })
        ]
      })
    });
    
    document.getElementById('root').appendChild(dashboard);
  </script>
</body>
</html>
```

**No layout bugs. No CSS conflicts. Perfect every time.** ✨

---

## ⏱ **Timeline**

- Task 1.1: 30 min ✓
- Task 1.2: 45 min ✓
- Task 1.3: 60 min ✓
- Task 1.4: 30 min ✓
- Task 1.5: 45 min ✓

**Total: ~3.5 hours for complete foundation**

---

**Ready to start building?** 🚀



