# Component System Overhaul: Zero-Bug UI Framework

## 🎯 **Goal**: Make it impossible to create buggy dashboards

### **Core Principle**
> "If you can write it wrong, the system is broken."

## 📊 **Current State Analysis**

### ❌ **Problems Identified**

1. **Inconsistent Usage**
   - Some dashboards use components
   - Some use raw HTML/CSS
   - No enforcement mechanism

2. **Incomplete Component Library**
   - Missing critical components (layouts, grids, etc.)
   - No composition patterns
   - No validation/testing

3. **CSS Chaos**
   - Styles scattered across 5+ files
   - Duplicate definitions
   - Conflicting rules
   - No single source of truth

4. **Manual Layout Management**
   - Padding/margin bugs
   - Fixed header positioning issues
   - Responsive breakpoints inconsistent

5. **No Testing**
   - Components have no tests
   - Visual regression not caught
   - Breaking changes go unnoticed

## ✅ **Proposed Solution: The Bulletproof System**

### **1. Complete Component Library** (50+ components)

#### **Layout Components** (The Foundation)
```javascript
// DashboardLayout - Handles all layout concerns
WorkrailUI.DashboardLayout({
  header: headerContent,      // Automatically fixed/sticky
  sidebar: sidebarContent,     // Optional, auto-responsive
  main: mainContent,           // Auto-padding, max-width
  footer: footerContent        // Optional
})

// PageContainer - Consistent spacing
WorkrailUI.PageContainer({
  maxWidth: '1200px',          // Default
  padding: 'responsive',       // Auto-adjusts for mobile
  children: [...]
})

// Grid - Responsive grid system
WorkrailUI.Grid({
  columns: 'auto-fit',         // Or: 1, 2, 3, 4, 'auto-fill'
  gap: 'md',                   // Uses design tokens
  children: [card1, card2, card3]
})

// Stack - Vertical/horizontal layout
WorkrailUI.Stack({
  direction: 'vertical',       // or 'horizontal'
  gap: 'md',
  align: 'start',              // start|center|end|stretch
  children: [...]
})

// Spacer - Consistent spacing
WorkrailUI.Spacer('md')        // Uses design system tokens
```

#### **Data Display Components**
```javascript
// Hero - Page headers
WorkrailUI.Hero({
  title: 'Bug Investigation',
  subtitle: 'Real-time progress',
  status: 'in_progress',
  badge: { text: 'DASH-001', variant: 'primary' },
  actions: [button1, button2]
})

// Card - All card variants
WorkrailUI.Card({
  variant: 'default',          // default|glass|elevated|bordered
  title: 'Root Cause',
  icon: 'target',
  status: 'success',
  expandable: true,
  children: [content]
})

// SessionCard - Specialized
WorkrailUI.SessionCard({
  sessionId: 'DASH-001',
  title: 'Auth Bug',
  status: 'complete',
  progress: 100,
  confidence: 9.5,
  phase: 'Phase 6',
  timestamp: Date.now(),
  onClick: handler,
  onDelete: deleteHandler
})

// StatCard - Metrics display
WorkrailUI.StatCard({
  label: 'Progress',
  value: '75%',
  icon: 'trending-up',
  trend: '+15%',
  variant: 'success'
})

// ProgressRing - Circular progress
WorkrailUI.ProgressRing({
  value: 75,                   // 0-100
  size: 'lg',                  // sm|md|lg
  showValue: true,
  color: 'primary'
})

// Timeline - Event timeline
WorkrailUI.Timeline({
  events: [
    { time: '10:30 AM', title: 'Started', type: 'start' },
    { time: '11:45 AM', title: 'Root cause found', type: 'success' }
  ]
})

// DataTable - Sortable tables
WorkrailUI.DataTable({
  columns: ['ID', 'Status', 'Confidence'],
  rows: data,
  sortable: true,
  filterable: true
})

// Badge - Status indicators
WorkrailUI.Badge({
  text: 'Complete',
  variant: 'success',          // success|warning|error|info|neutral
  size: 'md',
  pulse: false                 // Animated pulse
})

// CodeBlock - Syntax highlighted code
WorkrailUI.CodeBlock({
  code: 'const x = 10;',
  language: 'javascript',
  lineNumbers: true,
  copyable: true
})
```

#### **Interactive Components**
```javascript
// Button - All variants
WorkrailUI.Button({
  text: 'Save',
  icon: 'save',
  variant: 'primary',          // primary|secondary|ghost|danger|success
  size: 'md',                  // sm|md|lg
  loading: false,
  disabled: false,
  onClick: handler
})

// IconButton - Icon-only
WorkrailUI.IconButton({
  icon: 'x',
  variant: 'ghost',
  size: 'sm',
  ariaLabel: 'Close',
  onClick: handler
})

// Dropdown - Menu dropdown
WorkrailUI.Dropdown({
  trigger: buttonElement,
  items: [
    { label: 'Delete', icon: 'trash', onClick: deleteHandler },
    { label: 'Archive', icon: 'archive', onClick: archiveHandler }
  ],
  placement: 'bottom-end'
})

// Modal - Dialog boxes
WorkrailUI.Modal({
  title: 'Confirm Delete',
  content: 'Are you sure?',
  actions: [cancelButton, confirmButton],
  onClose: handler
})

// Toast - Notifications
WorkrailUI.Toast.show({
  message: 'Saved successfully',
  type: 'success',             // success|error|warning|info
  duration: 3000
})

// Tabs - Tab navigation
WorkrailUI.Tabs({
  tabs: [
    { id: 'overview', label: 'Overview', content: overviewContent },
    { id: 'details', label: 'Details', content: detailsContent }
  ],
  defaultTab: 'overview'
})

// Accordion - Collapsible sections
WorkrailUI.Accordion({
  sections: [
    { title: 'Section 1', content: content1, expanded: true },
    { title: 'Section 2', content: content2 }
  ],
  allowMultiple: false
})
```

#### **Utility Components**
```javascript
// Skeleton - Loading placeholders
WorkrailUI.Skeleton({
  type: 'card',                // card|text|circle|rectangle
  count: 3,
  animated: true
})

// EmptyState - No data state
WorkrailUI.EmptyState({
  icon: 'inbox',
  title: 'No sessions yet',
  description: 'Create your first session to get started',
  action: createButton
})

// ErrorBoundary - Error handling
WorkrailUI.ErrorBoundary({
  fallback: errorCard,
  onError: errorHandler,
  children: [riskeyComponent]
})

// Portal - Render outside hierarchy
WorkrailUI.Portal({
  target: document.body,
  children: [modalContent]
})
```

### **2. Scaffold System** (Templates)

#### **Dashboard Template**
```javascript
// Create a complete dashboard with one function call
const dashboard = WorkrailUI.createDashboard({
  workflow: 'bug-investigation',
  sessionId: 'DASH-001',
  
  // Automatic layout handling
  layout: {
    type: 'dashboard',         // dashboard|landing|report
    header: {
      title: 'Bug Investigation',
      backButton: true,
      actions: []
    }
  },
  
  // Sections rendered automatically
  sections: [
    {
      type: 'hero',
      data: heroData
    },
    {
      type: 'stats',
      data: { progress: 75, confidence: 9.5, phase: 6 }
    },
    {
      type: 'cards',
      title: 'Investigation Details',
      data: {
        rootCause: rootCauseData,
        hypotheses: hypothesesData,
        timeline: timelineData
      }
    }
  ],
  
  // Real-time updates handled automatically
  dataSource: '/api/sessions/bug-investigation/DASH-001',
  updateInterval: 2000
});

// Render to page
document.getElementById('root').appendChild(dashboard);
```

#### **Landing Page Template**
```javascript
const landingPage = WorkrailUI.createLandingPage({
  hero: {
    title: 'Workrail Dashboard',
    subtitle: 'Real-time workflow tracking'
  },
  
  projectInfo: {
    id: projectId,
    path: projectPath,
    sessions: sessionCount
  },
  
  sessionsList: {
    dataSource: '/api/sessions',
    emptyState: {
      title: 'No active sessions',
      action: { text: 'Learn more', href: '/docs' }
    }
  }
});
```

### **3. Style System Consolidation**

#### **Single CSS Architecture**
```
/assets/
  workrail-ui.css          ← SINGLE source of truth
    ├─ 1. CSS Variables (design tokens)
    ├─ 2. Reset & Base styles
    ├─ 3. Layout utilities
    ├─ 4. Component styles
    ├─ 5. Animation library
    └─ 6. Theme variants
```

#### **CSS Modules** (One per component)
```css
/* /assets/components/Card.css */
.wr-card {
  /* All card styles here */
}

/* /assets/components/Button.css */
.wr-button {
  /* All button styles here */
}
```

**Benefits:**
- No conflicts (BEM naming: `.wr-*`)
- Easy to debug (one component = one file)
- Tree-shakeable (only include what you use)
- Automatic theme support

### **4. Type Safety & Validation**

#### **Runtime Prop Validation**
```javascript
// Components validate props at runtime
WorkrailUI.Card({
  variant: 'invalid'  // ❌ Throws: "Invalid variant 'invalid'. 
                      //    Expected: default|glass|elevated|bordered"
});

// Helpful error messages
WorkrailUI.Button({
  onClick: 'not a function'  // ❌ Throws: "onClick must be a function, got string"
});

// Required props enforced
WorkrailUI.SessionCard({});  // ❌ Throws: "Missing required prop: sessionId"
```

#### **JSDoc Type Hints** (IDE autocomplete)
```javascript
/**
 * @typedef {Object} ButtonProps
 * @property {string} text - Button label
 * @property {'primary'|'secondary'|'ghost'|'danger'} [variant='primary'] - Button style
 * @property {'sm'|'md'|'lg'} [size='md'] - Button size
 * @property {() => void} [onClick] - Click handler
 */

/**
 * @param {ButtonProps} props
 * @returns {HTMLButtonElement}
 */
WorkrailUI.Button = function(props) { ... }
```

### **5. Testing Framework**

#### **Visual Regression Tests**
```javascript
// /tests/visual/Button.test.js
test('Button renders all variants correctly', async () => {
  const variants = ['primary', 'secondary', 'ghost', 'danger'];
  
  for (const variant of variants) {
    const button = WorkrailUI.Button({ text: 'Test', variant });
    await expectMatchesSnapshot(button, `button-${variant}`);
  }
});

test('Button respects dark mode', async () => {
  document.documentElement.setAttribute('data-theme', 'dark');
  const button = WorkrailUI.Button({ text: 'Test' });
  await expectMatchesSnapshot(button, 'button-dark-mode');
});
```

#### **Unit Tests**
```javascript
// /tests/unit/Card.test.js
test('Card calls onClick when clicked', () => {
  const onClick = jest.fn();
  const card = WorkrailUI.Card({ title: 'Test', onClick });
  
  card.click();
  
  expect(onClick).toHaveBeenCalledOnce();
});

test('Card is expandable when expandable=true', () => {
  const card = WorkrailUI.Card({ title: 'Test', expandable: true });
  
  expect(card.querySelector('.expand-icon')).toBeTruthy();
});
```

#### **Integration Tests**
```javascript
// /tests/integration/dashboard.test.js
test('Dashboard updates in real-time', async () => {
  const dashboard = WorkrailUI.createDashboard({
    workflow: 'bug-investigation',
    sessionId: 'TEST-001',
    dataSource: mockDataSource
  });
  
  document.body.appendChild(dashboard);
  
  // Trigger update
  mockDataSource.emit('update', { progress: 75 });
  
  await waitFor(() => {
    expect(dashboard.querySelector('.progress-value').textContent).toBe('75%');
  });
});
```

### **6. Documentation System**

#### **Interactive Component Browser**
```
http://localhost:3456/components/

- Live preview of all components
- Props editor (change values in real-time)
- Code snippet generator
- Dark/light mode toggle
- Responsive preview
- Accessibility checker
```

#### **Generated API Docs**
```javascript
// Auto-generated from JSDoc comments
// Searchable, filterable, with examples
```

### **7. Developer Experience**

#### **CLI Tool for Scaffolding**
```bash
# Generate a new dashboard
$ npm run workrail:create-dashboard my-workflow

✓ Created /workflows/my-workflow/
  ├─ dashboard.html      (uses template)
  ├─ dashboard.js        (pre-configured)
  ├─ styles.css          (minimal, only custom overrides)
  └─ README.md           (documentation)

# Generate a new component
$ npm run workrail:create-component MyComponent

✓ Created /assets/components/MyComponent.js
✓ Created /assets/components/MyComponent.css
✓ Created /tests/unit/MyComponent.test.js
✓ Added to component library index
```

#### **Live Reload & Hot Module Replacement**
```javascript
// Changes to components immediately visible
// No manual refresh needed
```

#### **Error Messages**
```
❌ WorkrailUI Error: Invalid prop 'variant'
   
   Expected: 'primary' | 'secondary' | 'ghost' | 'danger'
   Received: 'importante'
   
   Did you mean 'primary'?
   
   Component: Button
   File: dashboard.js:45
   
   Documentation: http://localhost:3456/components/Button
```

## 📋 **Implementation Plan**

### **Phase 1: Foundation** (Week 1)
- [ ] Consolidate CSS into single system
- [ ] Create layout components (DashboardLayout, Grid, Stack)
- [ ] Set up testing framework
- [ ] Build component browser UI

### **Phase 2: Core Components** (Week 2)
- [ ] Complete all data display components
- [ ] Complete all interactive components
- [ ] Add prop validation
- [ ] Write tests for each component

### **Phase 3: Scaffolding** (Week 3)
- [ ] Build dashboard template system
- [ ] Create CLI tool
- [ ] Set up live reload
- [ ] Migrate existing dashboards

### **Phase 4: Polish** (Week 4)
- [ ] Visual regression tests
- [ ] Accessibility audit
- [ ] Performance optimization
- [ ] Documentation completion

## 🎯 **Success Metrics**

1. **Zero Layout Bugs**
   - No more padding/margin issues
   - No more fixed header problems
   - Perfect responsive behavior

2. **Developer Velocity**
   - Create new dashboard in < 30 minutes
   - Zero styling required
   - Copy-paste examples work first time

3. **Code Quality**
   - 100% test coverage for components
   - No CSS conflicts
   - No runtime errors

4. **Maintainability**
   - Single source of truth for each component
   - Easy to update design system
   - Breaking changes caught by tests

## 🚀 **Next Steps**

1. **Review this proposal** - Feedback on approach?
2. **Prioritize components** - Which are most critical?
3. **Start Phase 1** - Begin implementation?

---

**Would you like me to start implementing this system?**




## 🎯 **Goal**: Make it impossible to create buggy dashboards

### **Core Principle**
> "If you can write it wrong, the system is broken."

## 📊 **Current State Analysis**

### ❌ **Problems Identified**

1. **Inconsistent Usage**
   - Some dashboards use components
   - Some use raw HTML/CSS
   - No enforcement mechanism

2. **Incomplete Component Library**
   - Missing critical components (layouts, grids, etc.)
   - No composition patterns
   - No validation/testing

3. **CSS Chaos**
   - Styles scattered across 5+ files
   - Duplicate definitions
   - Conflicting rules
   - No single source of truth

4. **Manual Layout Management**
   - Padding/margin bugs
   - Fixed header positioning issues
   - Responsive breakpoints inconsistent

5. **No Testing**
   - Components have no tests
   - Visual regression not caught
   - Breaking changes go unnoticed

## ✅ **Proposed Solution: The Bulletproof System**

### **1. Complete Component Library** (50+ components)

#### **Layout Components** (The Foundation)
```javascript
// DashboardLayout - Handles all layout concerns
WorkrailUI.DashboardLayout({
  header: headerContent,      // Automatically fixed/sticky
  sidebar: sidebarContent,     // Optional, auto-responsive
  main: mainContent,           // Auto-padding, max-width
  footer: footerContent        // Optional
})

// PageContainer - Consistent spacing
WorkrailUI.PageContainer({
  maxWidth: '1200px',          // Default
  padding: 'responsive',       // Auto-adjusts for mobile
  children: [...]
})

// Grid - Responsive grid system
WorkrailUI.Grid({
  columns: 'auto-fit',         // Or: 1, 2, 3, 4, 'auto-fill'
  gap: 'md',                   // Uses design tokens
  children: [card1, card2, card3]
})

// Stack - Vertical/horizontal layout
WorkrailUI.Stack({
  direction: 'vertical',       // or 'horizontal'
  gap: 'md',
  align: 'start',              // start|center|end|stretch
  children: [...]
})

// Spacer - Consistent spacing
WorkrailUI.Spacer('md')        // Uses design system tokens
```

#### **Data Display Components**
```javascript
// Hero - Page headers
WorkrailUI.Hero({
  title: 'Bug Investigation',
  subtitle: 'Real-time progress',
  status: 'in_progress',
  badge: { text: 'DASH-001', variant: 'primary' },
  actions: [button1, button2]
})

// Card - All card variants
WorkrailUI.Card({
  variant: 'default',          // default|glass|elevated|bordered
  title: 'Root Cause',
  icon: 'target',
  status: 'success',
  expandable: true,
  children: [content]
})

// SessionCard - Specialized
WorkrailUI.SessionCard({
  sessionId: 'DASH-001',
  title: 'Auth Bug',
  status: 'complete',
  progress: 100,
  confidence: 9.5,
  phase: 'Phase 6',
  timestamp: Date.now(),
  onClick: handler,
  onDelete: deleteHandler
})

// StatCard - Metrics display
WorkrailUI.StatCard({
  label: 'Progress',
  value: '75%',
  icon: 'trending-up',
  trend: '+15%',
  variant: 'success'
})

// ProgressRing - Circular progress
WorkrailUI.ProgressRing({
  value: 75,                   // 0-100
  size: 'lg',                  // sm|md|lg
  showValue: true,
  color: 'primary'
})

// Timeline - Event timeline
WorkrailUI.Timeline({
  events: [
    { time: '10:30 AM', title: 'Started', type: 'start' },
    { time: '11:45 AM', title: 'Root cause found', type: 'success' }
  ]
})

// DataTable - Sortable tables
WorkrailUI.DataTable({
  columns: ['ID', 'Status', 'Confidence'],
  rows: data,
  sortable: true,
  filterable: true
})

// Badge - Status indicators
WorkrailUI.Badge({
  text: 'Complete',
  variant: 'success',          // success|warning|error|info|neutral
  size: 'md',
  pulse: false                 // Animated pulse
})

// CodeBlock - Syntax highlighted code
WorkrailUI.CodeBlock({
  code: 'const x = 10;',
  language: 'javascript',
  lineNumbers: true,
  copyable: true
})
```

#### **Interactive Components**
```javascript
// Button - All variants
WorkrailUI.Button({
  text: 'Save',
  icon: 'save',
  variant: 'primary',          // primary|secondary|ghost|danger|success
  size: 'md',                  // sm|md|lg
  loading: false,
  disabled: false,
  onClick: handler
})

// IconButton - Icon-only
WorkrailUI.IconButton({
  icon: 'x',
  variant: 'ghost',
  size: 'sm',
  ariaLabel: 'Close',
  onClick: handler
})

// Dropdown - Menu dropdown
WorkrailUI.Dropdown({
  trigger: buttonElement,
  items: [
    { label: 'Delete', icon: 'trash', onClick: deleteHandler },
    { label: 'Archive', icon: 'archive', onClick: archiveHandler }
  ],
  placement: 'bottom-end'
})

// Modal - Dialog boxes
WorkrailUI.Modal({
  title: 'Confirm Delete',
  content: 'Are you sure?',
  actions: [cancelButton, confirmButton],
  onClose: handler
})

// Toast - Notifications
WorkrailUI.Toast.show({
  message: 'Saved successfully',
  type: 'success',             // success|error|warning|info
  duration: 3000
})

// Tabs - Tab navigation
WorkrailUI.Tabs({
  tabs: [
    { id: 'overview', label: 'Overview', content: overviewContent },
    { id: 'details', label: 'Details', content: detailsContent }
  ],
  defaultTab: 'overview'
})

// Accordion - Collapsible sections
WorkrailUI.Accordion({
  sections: [
    { title: 'Section 1', content: content1, expanded: true },
    { title: 'Section 2', content: content2 }
  ],
  allowMultiple: false
})
```

#### **Utility Components**
```javascript
// Skeleton - Loading placeholders
WorkrailUI.Skeleton({
  type: 'card',                // card|text|circle|rectangle
  count: 3,
  animated: true
})

// EmptyState - No data state
WorkrailUI.EmptyState({
  icon: 'inbox',
  title: 'No sessions yet',
  description: 'Create your first session to get started',
  action: createButton
})

// ErrorBoundary - Error handling
WorkrailUI.ErrorBoundary({
  fallback: errorCard,
  onError: errorHandler,
  children: [riskeyComponent]
})

// Portal - Render outside hierarchy
WorkrailUI.Portal({
  target: document.body,
  children: [modalContent]
})
```

### **2. Scaffold System** (Templates)

#### **Dashboard Template**
```javascript
// Create a complete dashboard with one function call
const dashboard = WorkrailUI.createDashboard({
  workflow: 'bug-investigation',
  sessionId: 'DASH-001',
  
  // Automatic layout handling
  layout: {
    type: 'dashboard',         // dashboard|landing|report
    header: {
      title: 'Bug Investigation',
      backButton: true,
      actions: []
    }
  },
  
  // Sections rendered automatically
  sections: [
    {
      type: 'hero',
      data: heroData
    },
    {
      type: 'stats',
      data: { progress: 75, confidence: 9.5, phase: 6 }
    },
    {
      type: 'cards',
      title: 'Investigation Details',
      data: {
        rootCause: rootCauseData,
        hypotheses: hypothesesData,
        timeline: timelineData
      }
    }
  ],
  
  // Real-time updates handled automatically
  dataSource: '/api/sessions/bug-investigation/DASH-001',
  updateInterval: 2000
});

// Render to page
document.getElementById('root').appendChild(dashboard);
```

#### **Landing Page Template**
```javascript
const landingPage = WorkrailUI.createLandingPage({
  hero: {
    title: 'Workrail Dashboard',
    subtitle: 'Real-time workflow tracking'
  },
  
  projectInfo: {
    id: projectId,
    path: projectPath,
    sessions: sessionCount
  },
  
  sessionsList: {
    dataSource: '/api/sessions',
    emptyState: {
      title: 'No active sessions',
      action: { text: 'Learn more', href: '/docs' }
    }
  }
});
```

### **3. Style System Consolidation**

#### **Single CSS Architecture**
```
/assets/
  workrail-ui.css          ← SINGLE source of truth
    ├─ 1. CSS Variables (design tokens)
    ├─ 2. Reset & Base styles
    ├─ 3. Layout utilities
    ├─ 4. Component styles
    ├─ 5. Animation library
    └─ 6. Theme variants
```

#### **CSS Modules** (One per component)
```css
/* /assets/components/Card.css */
.wr-card {
  /* All card styles here */
}

/* /assets/components/Button.css */
.wr-button {
  /* All button styles here */
}
```

**Benefits:**
- No conflicts (BEM naming: `.wr-*`)
- Easy to debug (one component = one file)
- Tree-shakeable (only include what you use)
- Automatic theme support

### **4. Type Safety & Validation**

#### **Runtime Prop Validation**
```javascript
// Components validate props at runtime
WorkrailUI.Card({
  variant: 'invalid'  // ❌ Throws: "Invalid variant 'invalid'. 
                      //    Expected: default|glass|elevated|bordered"
});

// Helpful error messages
WorkrailUI.Button({
  onClick: 'not a function'  // ❌ Throws: "onClick must be a function, got string"
});

// Required props enforced
WorkrailUI.SessionCard({});  // ❌ Throws: "Missing required prop: sessionId"
```

#### **JSDoc Type Hints** (IDE autocomplete)
```javascript
/**
 * @typedef {Object} ButtonProps
 * @property {string} text - Button label
 * @property {'primary'|'secondary'|'ghost'|'danger'} [variant='primary'] - Button style
 * @property {'sm'|'md'|'lg'} [size='md'] - Button size
 * @property {() => void} [onClick] - Click handler
 */

/**
 * @param {ButtonProps} props
 * @returns {HTMLButtonElement}
 */
WorkrailUI.Button = function(props) { ... }
```

### **5. Testing Framework**

#### **Visual Regression Tests**
```javascript
// /tests/visual/Button.test.js
test('Button renders all variants correctly', async () => {
  const variants = ['primary', 'secondary', 'ghost', 'danger'];
  
  for (const variant of variants) {
    const button = WorkrailUI.Button({ text: 'Test', variant });
    await expectMatchesSnapshot(button, `button-${variant}`);
  }
});

test('Button respects dark mode', async () => {
  document.documentElement.setAttribute('data-theme', 'dark');
  const button = WorkrailUI.Button({ text: 'Test' });
  await expectMatchesSnapshot(button, 'button-dark-mode');
});
```

#### **Unit Tests**
```javascript
// /tests/unit/Card.test.js
test('Card calls onClick when clicked', () => {
  const onClick = jest.fn();
  const card = WorkrailUI.Card({ title: 'Test', onClick });
  
  card.click();
  
  expect(onClick).toHaveBeenCalledOnce();
});

test('Card is expandable when expandable=true', () => {
  const card = WorkrailUI.Card({ title: 'Test', expandable: true });
  
  expect(card.querySelector('.expand-icon')).toBeTruthy();
});
```

#### **Integration Tests**
```javascript
// /tests/integration/dashboard.test.js
test('Dashboard updates in real-time', async () => {
  const dashboard = WorkrailUI.createDashboard({
    workflow: 'bug-investigation',
    sessionId: 'TEST-001',
    dataSource: mockDataSource
  });
  
  document.body.appendChild(dashboard);
  
  // Trigger update
  mockDataSource.emit('update', { progress: 75 });
  
  await waitFor(() => {
    expect(dashboard.querySelector('.progress-value').textContent).toBe('75%');
  });
});
```

### **6. Documentation System**

#### **Interactive Component Browser**
```
http://localhost:3456/components/

- Live preview of all components
- Props editor (change values in real-time)
- Code snippet generator
- Dark/light mode toggle
- Responsive preview
- Accessibility checker
```

#### **Generated API Docs**
```javascript
// Auto-generated from JSDoc comments
// Searchable, filterable, with examples
```

### **7. Developer Experience**

#### **CLI Tool for Scaffolding**
```bash
# Generate a new dashboard
$ npm run workrail:create-dashboard my-workflow

✓ Created /workflows/my-workflow/
  ├─ dashboard.html      (uses template)
  ├─ dashboard.js        (pre-configured)
  ├─ styles.css          (minimal, only custom overrides)
  └─ README.md           (documentation)

# Generate a new component
$ npm run workrail:create-component MyComponent

✓ Created /assets/components/MyComponent.js
✓ Created /assets/components/MyComponent.css
✓ Created /tests/unit/MyComponent.test.js
✓ Added to component library index
```

#### **Live Reload & Hot Module Replacement**
```javascript
// Changes to components immediately visible
// No manual refresh needed
```

#### **Error Messages**
```
❌ WorkrailUI Error: Invalid prop 'variant'
   
   Expected: 'primary' | 'secondary' | 'ghost' | 'danger'
   Received: 'importante'
   
   Did you mean 'primary'?
   
   Component: Button
   File: dashboard.js:45
   
   Documentation: http://localhost:3456/components/Button
```

## 📋 **Implementation Plan**

### **Phase 1: Foundation** (Week 1)
- [ ] Consolidate CSS into single system
- [ ] Create layout components (DashboardLayout, Grid, Stack)
- [ ] Set up testing framework
- [ ] Build component browser UI

### **Phase 2: Core Components** (Week 2)
- [ ] Complete all data display components
- [ ] Complete all interactive components
- [ ] Add prop validation
- [ ] Write tests for each component

### **Phase 3: Scaffolding** (Week 3)
- [ ] Build dashboard template system
- [ ] Create CLI tool
- [ ] Set up live reload
- [ ] Migrate existing dashboards

### **Phase 4: Polish** (Week 4)
- [ ] Visual regression tests
- [ ] Accessibility audit
- [ ] Performance optimization
- [ ] Documentation completion

## 🎯 **Success Metrics**

1. **Zero Layout Bugs**
   - No more padding/margin issues
   - No more fixed header problems
   - Perfect responsive behavior

2. **Developer Velocity**
   - Create new dashboard in < 30 minutes
   - Zero styling required
   - Copy-paste examples work first time

3. **Code Quality**
   - 100% test coverage for components
   - No CSS conflicts
   - No runtime errors

4. **Maintainability**
   - Single source of truth for each component
   - Easy to update design system
   - Breaking changes caught by tests

## 🚀 **Next Steps**

1. **Review this proposal** - Feedback on approach?
2. **Prioritize components** - Which are most critical?
3. **Start Phase 1** - Begin implementation?

---

**Would you like me to start implementing this system?**



