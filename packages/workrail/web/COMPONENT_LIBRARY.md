# Workrail Component Library

**Like Jetpack Compose for the Web** - Define components once, use them everywhere with guaranteed design system compliance.

## 📦 Installation

Include the component library in your HTML:

```html
<!-- After design system CSS -->
<link rel="stylesheet" href="/assets/design-system.css">
<link rel="stylesheet" href="/assets/components.css">
<link rel="stylesheet" href="/assets/animations.css">

<!-- Component library JS -->
<script src="/assets/components.js"></script>

<!-- Lucide icons (required for icons) -->
<script src="https://unpkg.com/lucide@latest"></script>
```

## 🎯 Philosophy

### **Before (Manual HTML)**
```html
<!-- Inconsistent, error-prone, hard to maintain -->
<div class="card card-glass" style="border-left-color: #8b5cf6;">
  <h3 style="font-size: var(--text-lg); margin-bottom: var(--space-4);">Title</h3>
  <p style="color: var(--text-secondary);">Content</p>
</div>
```

###  **After (Component Library)**
```javascript
// Consistent, type-safe, automatically follows design system
const card = WorkrailComponents.Card({
  title: "Title",
  content: "Content",
  variant: "glass",
  borderColor: "var(--accent-purple)"
});
document.getElementById('container').appendChild(card);
```

## 📚 Components

### 1. Button

```javascript
const button = WorkrailComponents.Button({
  text: "Click Me",
  icon: "rocket",          // Lucide icon name
  variant: "primary",      // primary|secondary|ghost|danger|glass
  size: "md",              // sm|md|lg
  spring: true,            // Add spring animation
  disabled: false,
  onClick: () => console.log('Clicked!')
});
```

**Variants:**
- `primary` - Bold primary action
- `secondary` - Secondary action with border
- `ghost` - Transparent, minimal
- `danger` - Destructive action (red)
- `glass` - Glassmorphism effect

### 2. Card

```javascript
const card = WorkrailComponents.Card({
  title: "Card Title",
  content: "Card content text or HTML element",
  footer: "Optional footer",
  variant: "glass",        // default|glass|float|workflow
  borderColor: "var(--accent-cyan)",
  animate: true,           // Entrance animation
  onClick: () => console.log('Card clicked!')
});
```

**Variants:**
- `default` - Standard card
- `glass` - Glassmorphism with blur
- `float` - Floating animation
- `workflow` - Workflow-themed with colored border

### 3. Session Card (Specialized)

```javascript
const sessionCard = WorkrailComponents.SessionCard({
  sessionId: "DASH-001",
  title: "Session description",
  status: "in_progress",   // in_progress|complete
  progress: 75,            // 0-100
  confidence: 8.5,         // 0-10
  phase: "Phase 3",
  updated: "2 minutes ago",
  borderColor: "var(--accent-purple)",
  onClick: () => navigateToSession('DASH-001'),
  onDelete: (id) => deleteSession(id)
});
```

### 4. Status Badge

```javascript
const badge = WorkrailComponents.StatusBadge({
  status: "success",       // success|active|pending|error|info
  text: "COMPLETE",
  glow: true              // Add glow effect
});
```

### 5. Hero Section

```javascript
const hero = WorkrailComponents.Hero({
  title: "Workrail Dashboard",
  subtitle: "Real-time workflow tracking",
  icon: "rocket",          // Lucide icon
  gradient: "linear-gradient(135deg, #667eea, #764ba2)"
});
```

### 6. Stat Card

```javascript
const statCard = WorkrailComponents.StatCard({
  value: 24,
  label: "Active Sessions",
  icon: "bar-chart-3",
  color: "#06b6d4",
  gradient: true,          // Use gradient background
  float: true              // Add floating animation
});
```

### 7. Progress Ring

```javascript
const progressRing = WorkrailComponents.ProgressRing({
  progress: 75,            // 0-100
  size: 120,               // Diameter in pixels
  strokeWidth: 8,
  color: "var(--primary-500)",
  showPercentage: true
});
```

### 8. Modal

```javascript
const modal = WorkrailComponents.Modal({
  title: "Confirm Delete",
  content: "Are you sure you want to delete this session?",
  actions: [
    {
      text: "Cancel",
      variant: "secondary",
      onClick: () => modal.hide()
    },
    {
      text: "Delete",
      variant: "danger",
      onClick: () => {
        performDelete();
        modal.hide();
      }
    }
  ],
  onClose: () => console.log('Modal closed')
});

// Show the modal
modal.show();
```

## 🎨 Complete Example

```javascript
// Create a session card
const card = WorkrailComponents.SessionCard({
  sessionId: "BUG-042",
  title: "Authentication token expiration issue",
  status: "in_progress",
  progress: 60,
  confidence: 7.5,
  phase: "Phase 2",
  updated: "5 minutes ago",
  borderColor: "var(--accent-cyan)",
  onClick: () => window.location.href = `/dashboard?session=BUG-042`,
  onDelete: async (id) => {
    const modal = WorkrailComponents.Modal({
      title: "Delete Session",
      content: `Delete ${id}? This cannot be undone.`,
      actions: [
        { text: "Cancel", variant: "secondary", onClick: () => modal.hide() },
        { text: "Delete", variant: "danger", onClick: async () => {
          await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
          card.remove();
          modal.hide();
        }}
      ]
    });
    modal.show();
  }
});

// Add to page
document.getElementById('sessions-grid').appendChild(card);
```

## 🔄 Migrating Existing Code

### Before (Manual HTML):
```javascript
async function loadSessions() {
  const sessions = await fetch('/api/sessions').then(r => r.json());
  const grid = document.getElementById('sessions-grid');
  
  sessions.forEach(session => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="session-header">
        <span class="session-id">${session.id}</span>
        <span class="session-status status-${session.status}">${session.status}</span>
      </div>
      <div class="session-title">${session.title}</div>
      <!-- ...more manual HTML... -->
    `;
    grid.appendChild(card);
  });
}
```

### After (Component Library):
```javascript
async function loadSessions() {
  const sessions = await fetch('/api/sessions').then(r => r.json());
  const grid = document.getElementById('sessions-grid');
  
  sessions.forEach(session => {
    const card = WorkrailComponents.SessionCard({
      sessionId: session.id,
      title: session.title,
      status: session.status,
      progress: session.progress,
      confidence: session.confidence,
      phase: session.phase,
      updated: session.updated,
      borderColor: getBorderColor(session),
      onClick: () => openSession(session.id),
      onDelete: (id) => deleteSession(id)
    });
    grid.appendChild(card);
  });
}
```

## ✅ Benefits

1. **Design System Compliance** - Components automatically use design tokens
2. **Type Safety** - Clear parameter contracts
3. **Consistency** - Same component looks identical everywhere
4. **Maintainability** - Fix once, applies everywhere
5. **Developer Experience** - Cleaner, more readable code
6. **Performance** - No HTML parsing, direct DOM creation
7. **Testability** - Components can be unit tested

## 🚀 Advanced Usage

### Custom Styling

Components accept inline styles for customization:

```javascript
const card = WorkrailComponents.Card({
  title: "Custom Card",
  content: "Content",
  borderColor: "var(--accent-pink)"
});

// Add custom styles if needed
card.style.maxWidth = "400px";
card.dataset.workflowType = "bug-investigation";
```

### Composition

Components can be nested:

```javascript
const cardContent = createElement('div', [], {}, [
  WorkrailComponents.StatCard({ value: 100, label: "Complete" }),
  WorkrailComponents.Button({ text: "View Details", variant: "primary" })
]);

const card = WorkrailComponents.Card({
  title: "Statistics",
  content: cardContent,
  variant: "glass"
});
```

### Event Handling

All click handlers receive the event object:

```javascript
const button = WorkrailComponents.Button({
  text: "Save",
  onClick: (event) => {
    event.stopPropagation();
    console.log('Button clicked, not bubbling');
  }
});
```

## 📝 Adding New Components

To add a new component to the library:

1. Follow the existing pattern in `components.js`
2. Use `createElement` helper for consistency
3. Accept a config object with sensible defaults
4. Return a DOM element
5. Document it in this file

Example:

```javascript
/**
 * Badge Component
 * @param {Object} config
 * @param {string} config.text - Badge text
 * @param {string} config.variant - success|warning|error
 */
WorkrailComponents.Badge = function(config) {
  const { text, variant = 'info' } = config;
  return createElement('span', ['badge', `badge-${variant}`], {}, [text]);
};
```

## 🎯 Migration Checklist

- [ ] Include `components.js` in all HTML pages
- [ ] Replace manual session card creation with `SessionCard` component
- [ ] Replace button HTML with `Button` component
- [ ] Replace modal HTML with `Modal` component
- [ ] Replace hero sections with `Hero` component
- [ ] Test all interactive features
- [ ] Verify design system compliance
- [ ] Remove redundant inline styles

## 🐛 Troubleshooting

**Icons not showing?**
- Ensure Lucide is loaded: `<script src="https://unpkg.com/lucide@latest"></script>`
- Icons are initialized automatically, but you can manually trigger: `lucide.createIcons()`

**Styles not applied?**
- Ensure CSS is loaded before `components.js`
- Check that design system CSS is included

**Components not found?**
- Check console for `[Workrail Components] Library loaded`
- Ensure `components.js` loads without errors

---

**Version**: 1.0.0  
**Last Updated**: October 2, 2025  
**Maintained By**: Workrail Team




**Like Jetpack Compose for the Web** - Define components once, use them everywhere with guaranteed design system compliance.

## 📦 Installation

Include the component library in your HTML:

```html
<!-- After design system CSS -->
<link rel="stylesheet" href="/assets/design-system.css">
<link rel="stylesheet" href="/assets/components.css">
<link rel="stylesheet" href="/assets/animations.css">

<!-- Component library JS -->
<script src="/assets/components.js"></script>

<!-- Lucide icons (required for icons) -->
<script src="https://unpkg.com/lucide@latest"></script>
```

## 🎯 Philosophy

### **Before (Manual HTML)**
```html
<!-- Inconsistent, error-prone, hard to maintain -->
<div class="card card-glass" style="border-left-color: #8b5cf6;">
  <h3 style="font-size: var(--text-lg); margin-bottom: var(--space-4);">Title</h3>
  <p style="color: var(--text-secondary);">Content</p>
</div>
```

###  **After (Component Library)**
```javascript
// Consistent, type-safe, automatically follows design system
const card = WorkrailComponents.Card({
  title: "Title",
  content: "Content",
  variant: "glass",
  borderColor: "var(--accent-purple)"
});
document.getElementById('container').appendChild(card);
```

## 📚 Components

### 1. Button

```javascript
const button = WorkrailComponents.Button({
  text: "Click Me",
  icon: "rocket",          // Lucide icon name
  variant: "primary",      // primary|secondary|ghost|danger|glass
  size: "md",              // sm|md|lg
  spring: true,            // Add spring animation
  disabled: false,
  onClick: () => console.log('Clicked!')
});
```

**Variants:**
- `primary` - Bold primary action
- `secondary` - Secondary action with border
- `ghost` - Transparent, minimal
- `danger` - Destructive action (red)
- `glass` - Glassmorphism effect

### 2. Card

```javascript
const card = WorkrailComponents.Card({
  title: "Card Title",
  content: "Card content text or HTML element",
  footer: "Optional footer",
  variant: "glass",        // default|glass|float|workflow
  borderColor: "var(--accent-cyan)",
  animate: true,           // Entrance animation
  onClick: () => console.log('Card clicked!')
});
```

**Variants:**
- `default` - Standard card
- `glass` - Glassmorphism with blur
- `float` - Floating animation
- `workflow` - Workflow-themed with colored border

### 3. Session Card (Specialized)

```javascript
const sessionCard = WorkrailComponents.SessionCard({
  sessionId: "DASH-001",
  title: "Session description",
  status: "in_progress",   // in_progress|complete
  progress: 75,            // 0-100
  confidence: 8.5,         // 0-10
  phase: "Phase 3",
  updated: "2 minutes ago",
  borderColor: "var(--accent-purple)",
  onClick: () => navigateToSession('DASH-001'),
  onDelete: (id) => deleteSession(id)
});
```

### 4. Status Badge

```javascript
const badge = WorkrailComponents.StatusBadge({
  status: "success",       // success|active|pending|error|info
  text: "COMPLETE",
  glow: true              // Add glow effect
});
```

### 5. Hero Section

```javascript
const hero = WorkrailComponents.Hero({
  title: "Workrail Dashboard",
  subtitle: "Real-time workflow tracking",
  icon: "rocket",          // Lucide icon
  gradient: "linear-gradient(135deg, #667eea, #764ba2)"
});
```

### 6. Stat Card

```javascript
const statCard = WorkrailComponents.StatCard({
  value: 24,
  label: "Active Sessions",
  icon: "bar-chart-3",
  color: "#06b6d4",
  gradient: true,          // Use gradient background
  float: true              // Add floating animation
});
```

### 7. Progress Ring

```javascript
const progressRing = WorkrailComponents.ProgressRing({
  progress: 75,            // 0-100
  size: 120,               // Diameter in pixels
  strokeWidth: 8,
  color: "var(--primary-500)",
  showPercentage: true
});
```

### 8. Modal

```javascript
const modal = WorkrailComponents.Modal({
  title: "Confirm Delete",
  content: "Are you sure you want to delete this session?",
  actions: [
    {
      text: "Cancel",
      variant: "secondary",
      onClick: () => modal.hide()
    },
    {
      text: "Delete",
      variant: "danger",
      onClick: () => {
        performDelete();
        modal.hide();
      }
    }
  ],
  onClose: () => console.log('Modal closed')
});

// Show the modal
modal.show();
```

## 🎨 Complete Example

```javascript
// Create a session card
const card = WorkrailComponents.SessionCard({
  sessionId: "BUG-042",
  title: "Authentication token expiration issue",
  status: "in_progress",
  progress: 60,
  confidence: 7.5,
  phase: "Phase 2",
  updated: "5 minutes ago",
  borderColor: "var(--accent-cyan)",
  onClick: () => window.location.href = `/dashboard?session=BUG-042`,
  onDelete: async (id) => {
    const modal = WorkrailComponents.Modal({
      title: "Delete Session",
      content: `Delete ${id}? This cannot be undone.`,
      actions: [
        { text: "Cancel", variant: "secondary", onClick: () => modal.hide() },
        { text: "Delete", variant: "danger", onClick: async () => {
          await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
          card.remove();
          modal.hide();
        }}
      ]
    });
    modal.show();
  }
});

// Add to page
document.getElementById('sessions-grid').appendChild(card);
```

## 🔄 Migrating Existing Code

### Before (Manual HTML):
```javascript
async function loadSessions() {
  const sessions = await fetch('/api/sessions').then(r => r.json());
  const grid = document.getElementById('sessions-grid');
  
  sessions.forEach(session => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="session-header">
        <span class="session-id">${session.id}</span>
        <span class="session-status status-${session.status}">${session.status}</span>
      </div>
      <div class="session-title">${session.title}</div>
      <!-- ...more manual HTML... -->
    `;
    grid.appendChild(card);
  });
}
```

### After (Component Library):
```javascript
async function loadSessions() {
  const sessions = await fetch('/api/sessions').then(r => r.json());
  const grid = document.getElementById('sessions-grid');
  
  sessions.forEach(session => {
    const card = WorkrailComponents.SessionCard({
      sessionId: session.id,
      title: session.title,
      status: session.status,
      progress: session.progress,
      confidence: session.confidence,
      phase: session.phase,
      updated: session.updated,
      borderColor: getBorderColor(session),
      onClick: () => openSession(session.id),
      onDelete: (id) => deleteSession(id)
    });
    grid.appendChild(card);
  });
}
```

## ✅ Benefits

1. **Design System Compliance** - Components automatically use design tokens
2. **Type Safety** - Clear parameter contracts
3. **Consistency** - Same component looks identical everywhere
4. **Maintainability** - Fix once, applies everywhere
5. **Developer Experience** - Cleaner, more readable code
6. **Performance** - No HTML parsing, direct DOM creation
7. **Testability** - Components can be unit tested

## 🚀 Advanced Usage

### Custom Styling

Components accept inline styles for customization:

```javascript
const card = WorkrailComponents.Card({
  title: "Custom Card",
  content: "Content",
  borderColor: "var(--accent-pink)"
});

// Add custom styles if needed
card.style.maxWidth = "400px";
card.dataset.workflowType = "bug-investigation";
```

### Composition

Components can be nested:

```javascript
const cardContent = createElement('div', [], {}, [
  WorkrailComponents.StatCard({ value: 100, label: "Complete" }),
  WorkrailComponents.Button({ text: "View Details", variant: "primary" })
]);

const card = WorkrailComponents.Card({
  title: "Statistics",
  content: cardContent,
  variant: "glass"
});
```

### Event Handling

All click handlers receive the event object:

```javascript
const button = WorkrailComponents.Button({
  text: "Save",
  onClick: (event) => {
    event.stopPropagation();
    console.log('Button clicked, not bubbling');
  }
});
```

## 📝 Adding New Components

To add a new component to the library:

1. Follow the existing pattern in `components.js`
2. Use `createElement` helper for consistency
3. Accept a config object with sensible defaults
4. Return a DOM element
5. Document it in this file

Example:

```javascript
/**
 * Badge Component
 * @param {Object} config
 * @param {string} config.text - Badge text
 * @param {string} config.variant - success|warning|error
 */
WorkrailComponents.Badge = function(config) {
  const { text, variant = 'info' } = config;
  return createElement('span', ['badge', `badge-${variant}`], {}, [text]);
};
```

## 🎯 Migration Checklist

- [ ] Include `components.js` in all HTML pages
- [ ] Replace manual session card creation with `SessionCard` component
- [ ] Replace button HTML with `Button` component
- [ ] Replace modal HTML with `Modal` component
- [ ] Replace hero sections with `Hero` component
- [ ] Test all interactive features
- [ ] Verify design system compliance
- [ ] Remove redundant inline styles

## 🐛 Troubleshooting

**Icons not showing?**
- Ensure Lucide is loaded: `<script src="https://unpkg.com/lucide@latest"></script>`
- Icons are initialized automatically, but you can manually trigger: `lucide.createIcons()`

**Styles not applied?**
- Ensure CSS is loaded before `components.js`
- Check that design system CSS is included

**Components not found?**
- Check console for `[Workrail Components] Library loaded`
- Ensure `components.js` loads without errors

---

**Version**: 1.0.0  
**Last Updated**: October 2, 2025  
**Maintained By**: Workrail Team



