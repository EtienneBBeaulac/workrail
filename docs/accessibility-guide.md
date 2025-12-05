# Accessibility Guide

The dashboard is built to be accessible to everyone, following WCAG 2.1 Level AA standards.

## Features

### ✅ WCAG 2.1 AA Compliance

- **Keyboard Navigation**: Full keyboard support
- **Screen Readers**: Tested with NVDA, JAWS, VoiceOver
- **Color Contrast**: Minimum 4.5:1 for normal text, 3:1 for large text
- **Touch Targets**: Minimum 44x44px (mobile: 48x48px)
- **Semantic HTML**: Proper landmarks, headings, ARIA labels
- **Focus Indicators**: High-visibility focus outlines
- **Alt Text**: All images and icons have descriptive text

### 🎹 Keyboard Navigation

**Global Shortcuts:**
- `Tab` / `Shift+Tab` - Navigate between interactive elements
- `Enter` / `Space` - Activate buttons and links
- `Escape` - Close modals/dialogs
- `/` - Focus search (when implemented)
- `Cmd/Ctrl+K` - Open command palette (when implemented)

**Arrow Keys:**
- Navigate through lists and menus
- Expand/collapse sections

**Skip Links:**
- `Tab` from page load - Access skip links
- Skip to main content
- Skip to dashboard data

### 📢 Screen Reader Support

**Live Regions:**
- Dashboard loading announced
- Updates announced when data changes
- Errors announced immediately

**Semantic Structure:**
- Proper heading hierarchy (h1 → h2 → h3)
- Landmarks: `<header>`, `<main>`, `<nav>`
- Lists for grouped content
- Tables for tabular data

**ARIA Labels:**
- Descriptive labels for all interactive elements
- Status announcements for state changes
- Progress indicators with aria-valuenow

**Example Screen Reader Output:**
```
"Skip to main content, link"
"Back to Home, link"
"Bug Investigation: Auth Token Issue, heading level 1"
"Status: In Progress, Status badge"
"Progress: 45%, Progress ring 45 of 100"
"Hypotheses, heading level 2"
"First hypothesis: Token expiration misconfigured, list item"
```

### 🎨 High Contrast Mode

Automatically detected via `prefers-contrast: high`:

```css
@media (prefers-contrast: high) {
  /* Black text on white backgrounds */
  /* White text on black backgrounds (dark mode) */
  /* Increased border widths for visibility */
  /* Simplified color palette */
}
```

### 🎬 Reduced Motion

Respects `prefers-reduced-motion: reduce`:

- Disables animations
- Disables transitions
- Maintains smooth scrolling option
- Stagger animations removed

```javascript
import { prefersReducedMotion } from '@workrail/utils/accessibility';

if (prefersReducedMotion()) {
  // Skip animations
}
```

### 📱 Mobile Responsive

**Breakpoints:**
- Mobile: < 768px
- Tablet: 769px - 1024px
- Desktop: > 1025px

**Mobile Optimizations:**
- 48x48px minimum touch targets
- Font size minimum 16px (prevents zoom on iOS)
- Single column layout
- Collapsible sections
- Swipe gestures (future)

### 🎯 Focus Management

```javascript
import { focusManager } from '@workrail/utils/accessibility';

// Save current focus
focusManager.saveFocus();

// Open modal
openModal();

// Trap focus within modal
const releaseFocus = focusManager.trapFocus(modalElement);

// Close modal
closeModal();
releaseFocus();

// Restore previous focus
focusManager.restoreFocus();
```

### 🔊 Live Announcements

```javascript
import { liveAnnouncer } from '@workrail/utils/accessibility';

// Polite announcement (non-interrupting)
liveAnnouncer.announcePolite('Dashboard updated');

// Assertive announcement (interrupting)
liveAnnouncer.announceAssertive('Error loading data');
```

## Testing

### Keyboard Navigation

1. **Tab through the page**:
   - ✅ All interactive elements reachable
   - ✅ Logical tab order
   - ✅ Focus indicator visible
   - ✅ No keyboard traps

2. **Use shortcuts**:
   - ✅ Skip links work
   - ✅ Escape closes dialogs
   - ✅ Arrow keys navigate lists

### Screen Reader

**Testing with NVDA (Windows):**
```bash
# Download: https://www.nvaccess.org/download/
# Start: Ctrl+Alt+N
# Navigate: Arrow keys
# Read: Insert+Down arrow
```

**Testing with VoiceOver (Mac):**
```bash
# Enable: Cmd+F5
# Navigate: Ctrl+Option+Arrow keys
# Read: Ctrl+Option+A
```

**Testing with JAWS (Windows):**
```bash
# Commercial software
# Navigate: Arrow keys
# Read: Insert+Down arrow
```

### Color Contrast

**Tools:**
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- Chrome DevTools Lighthouse
- [WAVE Browser Extension](https://wave.webaim.org/extension/)

**Requirements:**
- Normal text: 4.5:1 minimum
- Large text (18pt+): 3:1 minimum
- UI components: 3:1 minimum

### Automated Testing

**Lighthouse:**
```bash
# Run in Chrome DevTools
# Accessibility score should be 95+
```

**axe DevTools:**
```bash
# Install browser extension
# Run accessibility scan
# Fix all critical and serious issues
```

## Best Practices

### 1. Semantic HTML

**✅ Good:**
```html
<button onclick="save()">Save</button>
<nav aria-label="Main navigation">
  <a href="/">Home</a>
</nav>
<main>
  <h1>Page Title</h1>
  <section aria-labelledby="section-1">
    <h2 id="section-1">Section Title</h2>
  </section>
</main>
```

**❌ Bad:**
```html
<div onclick="save()">Save</div>
<div class="nav">
  <span onclick="goHome()">Home</span>
</div>
<div>
  <span class="title">Page Title</span>
  <div>
    <span class="subtitle">Section Title</span>
  </div>
</div>
```

### 2. Keyboard Support

**✅ Good:**
```javascript
button.addEventListener('click', handleClick);
button.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    handleClick();
  }
});
```

**❌ Bad:**
```javascript
div.addEventListener('click', handleClick);
// No keyboard support!
```

### 3. ARIA Labels

**✅ Good:**
```html
<button aria-label="Close dialog">
  <i data-lucide="x"></i>
</button>

<div role="progressbar" aria-valuenow="45" aria-valuemin="0" aria-valuemax="100">
  45%
</div>
```

**❌ Bad:**
```html
<button>
  <i data-lucide="x"></i>
  <!-- No label! -->
</button>

<div class="progress-bar" style="width: 45%">
  <!-- No ARIA attributes! -->
</div>
```

### 4. Focus Management

**✅ Good:**
```javascript
// Modal opens
focusManager.saveFocus();
const releaseFocus = focusManager.trapFocus(modal);
firstButton.focus();

// Modal closes
modal.remove();
releaseFocus();
focusManager.restoreFocus();
```

**❌ Bad:**
```javascript
// Modal opens
modal.style.display = 'block';
// Focus not managed!

// Modal closes
modal.style.display = 'none';
// Previous focus lost!
```

### 5. Color Contrast

**✅ Good:**
```css
/* 4.5:1 contrast */
.text {
  color: #333;
  background: #fff;
}

/* 7:1 contrast (AAA) */
.important-text {
  color: #000;
  background: #fff;
}
```

**❌ Bad:**
```css
/* 2:1 contrast - fails WCAG */
.text {
  color: #999;
  background: #fff;
}
```

## API Reference

### FocusManager

```javascript
import { focusManager } from '@workrail/utils/accessibility';

// Save current focus
focusManager.saveFocus();

// Restore focus
focusManager.restoreFocus();

// Trap focus in element
const release = focusManager.trapFocus(element);

// Get focusable elements
const elements = focusManager.getFocusableElements(container);
```

### LiveAnnouncer

```javascript
import { liveAnnouncer } from '@workrail/utils/accessibility';

// Polite announcement
liveAnnouncer.announcePolite('Operation complete');

// Assertive announcement
liveAnnouncer.announceAssertive('Error occurred');

// Direct announce
liveAnnouncer.announce('Message', 'polite' | 'assertive');
```

### KeyboardNav

```javascript
import { keyboardNav } from '@workrail/utils/accessibility';

// Listen for escape
keyboardNav.on('escape', (e) => {
  closeModal();
});

// Listen for search
keyboardNav.on('search', (e) => {
  openSearch();
});

// Listen for arrows
keyboardNav.on('arrow', ({ direction, event }) => {
  navigate(direction); // 'up', 'down', 'left', 'right'
});
```

### ARIA Helpers

```javascript
import { aria } from '@workrail/utils/accessibility';

// Set label
aria.label(button, 'Close dialog');

// Set expanded
aria.expanded(details, true);

// Set hidden
aria.hidden(element, true);

// Create description
const desc = aria.createDescription('desc-1', 'Additional information');
document.body.appendChild(desc);
element.setAttribute('aria-describedby', 'desc-1');
```

### ContrastChecker

```javascript
import { contrastChecker } from '@workrail/utils/accessibility';

// Check contrast
const color1 = contrastChecker.hexToRgb('#333333');
const color2 = contrastChecker.hexToRgb('#ffffff');
const ratio = contrastChecker.getContrastRatio(color1, color2);

// Check WCAG compliance
const passesAA = contrastChecker.meetsWCAG(ratio, 'AA', 'normal');
const passesAAA = contrastChecker.meetsWCAG(ratio, 'AAA', 'normal');

console.log(`Contrast: ${ratio.toFixed(2)}:1`);
console.log(`WCAG AA: ${passesAA ? '✅' : '❌'}`);
console.log(`WCAG AAA: ${passesAAA ? '✅' : '❌'}`);
```

## Resources

**WCAG Guidelines:**
- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
- [WebAIM Checklist](https://webaim.org/standards/wcag/checklist)

**Testing Tools:**
- [WAVE](https://wave.webaim.org/)
- [axe DevTools](https://www.deque.com/axe/devtools/)
- [Lighthouse](https://developers.google.com/web/tools/lighthouse)

**Screen Readers:**
- [NVDA](https://www.nvaccess.org/) (Windows, free)
- [JAWS](https://www.freedomscientific.com/products/software/jaws/) (Windows, commercial)
- VoiceOver (macOS/iOS, built-in)
- [ChromeVox](https://chrome.google.com/webstore/detail/chromevox/kgejglhpjiefppelpmljglcjbhoiplfn) (Chrome extension)

**Learning:**
- [MDN Accessibility](https://developer.mozilla.org/en-US/docs/Web/Accessibility)
- [A11y Project](https://www.a11yproject.com/)
- [WebAIM](https://webaim.org/)






