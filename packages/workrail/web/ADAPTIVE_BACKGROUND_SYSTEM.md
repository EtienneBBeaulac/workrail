# 🎨 Adaptive Background Intensity System

## Overview

Workrail now uses **adaptive background intensity** to provide:
- **Engaging, vibrant backgrounds** on landing pages (welcome, explore)
- **Subtle, ambient backgrounds** on dashboards (focus on data, not distraction)
- **Minimal/no backgrounds** for ultra-clean pages (optional)

---

## 🎯 Modes

### **1. Default (Full Intensity)**
**Used on:** Homepage, marketing pages, onboarding

**Characteristics:**
- ✨ 8+ animated particles
- 🌈 Bright orbs (opacity: 0.25-0.4)
- 🔵 Visible workflow rails
- 🎪 Interactive cursor effects
- 📜 Scroll parallax

**How to use:**
```html
<html lang="en">
  <!-- No attribute needed - this is the default -->
</html>
```

---

### **2. Subtle Mode**
**Used on:** Bug investigation dashboard, workflow dashboards

**Characteristics:**
- ✨ 4 animated particles (50% fewer)
- 🌈 Dimmed orbs (opacity: 0.15)
- 🔵 Barely visible rails (opacity: 0.05)
- ❌ No interactive cursor effects
- ❌ No scroll parallax
- 🎯 Focus on content, not background

**How to use:**
```html
<html lang="en" data-bg-intensity="subtle">
  <!-- Background is present but very subtle -->
</html>
```

**Performance notes:**
- 50% fewer particles = lower CPU usage
- No interaction detection = lower event processing
- No parallax = faster scrolling
- Perfect for data-heavy dashboards

---

### **3. Minimal Mode** (Optional)
**Used on:** Print-friendly pages, accessibility mode

**Characteristics:**
- ❌ No background effects at all
- 🤍 Clean white/dark background
- ⚡ Maximum performance
- ♿ Ideal for accessibility

**How to use:**
```html
<html lang="en" data-bg-intensity="minimal">
  <!-- No background effects rendered -->
</html>
```

---

## 📦 What's Included in Each Page

### **Homepage (Full Intensity)**
```html
<!-- All effects enabled -->
<link rel="stylesheet" href="/assets/background-effects.css">
<script src="/assets/particle-generator.js"></script>
<script src="/assets/background-interaction.js"></script>
<script src="/assets/scroll-parallax.js"></script>
<script src="/assets/time-of-day-theme.js"></script>

<!-- Background elements -->
<svg class="bg-orbs">...</svg>
<div class="bg-rails">...</div>
<div class="workflow-node">...</div>
<div id="particle-container"></div>
<div class="bg-grain"></div>

<script>
  generateParticles(8); // 8 particles
</script>
```

---

### **Dashboard (Subtle Mode)**
```html
<!-- Minimal scripts -->
<link rel="stylesheet" href="/assets/background-effects.css">
<script src="/assets/particle-generator.js"></script>
<script src="/assets/time-of-day-theme.js"></script>

<!-- Background elements (same HTML, different CSS) -->
<svg class="bg-orbs">...</svg>
<div class="bg-rails">...</div>
<div class="workflow-node">...</div>
<div id="particle-container"></div>
<div class="bg-grain"></div>

<script>
  generateParticles(4); // 4 particles (50% fewer)
</script>

<!-- NO interactive effects -->
<!-- NO scroll parallax -->
```

---

## 🎨 Visual Comparison

| Element | Default | Subtle | Minimal |
|---------|---------|--------|---------|
| **Orbs** | Opacity 0.25-0.4 | Opacity 0.25 | Hidden |
| **Rails** | Visible | Subtle (0.12) | Hidden |
| **Nodes** | Pulsing (2s) | Slow pulse (4s) | Hidden |
| **Particles** | 8, fast | 4, slow (25s) | Hidden |
| **Grain** | Subtle | Very subtle | Hidden |
| **Interactions** | ✅ Yes | ❌ No | ❌ No |
| **Parallax** | ✅ Yes | ❌ No | ❌ No |

---

## 🚀 Adding to New Pages

### **New Homepage/Marketing Page:**
```html
<html lang="en"> <!-- Default intensity -->
<head>
  <link rel="stylesheet" href="/assets/background-effects.css">
  <script src="/assets/theme-manager.js"></script>
  <script src="/assets/particle-generator.js"></script>
  <script src="/assets/background-interaction.js"></script>
  <script src="/assets/scroll-parallax.js"></script>
</head>
<body>
  <!-- Copy background elements from index.html -->
  <svg class="bg-orbs">...</svg>
  <div class="bg-rails">...</div>
  <!-- ... etc -->
  
  <!-- Your content here -->
  
  <script type="module">
    import { generateParticles } from '/assets/particle-generator.js';
    generateParticles(8); // Full intensity
  </script>
</body>
</html>
```

---

### **New Dashboard Page:**
```html
<html lang="en" data-bg-intensity="subtle"> <!-- Subtle mode -->
<head>
  <link rel="stylesheet" href="/assets/background-effects.css">
  <script src="/assets/theme-manager.js"></script>
  <script src="/assets/particle-generator.js"></script>
  <!-- NO interaction or parallax scripts -->
</head>
<body>
  <!-- Copy background elements from dashboard-v3.html -->
  <svg class="bg-orbs">...</svg>
  <div class="bg-rails">...</div>
  <!-- ... etc -->
  
  <!-- Your content here -->
  
  <script type="module">
    import { generateParticles } from '/assets/particle-generator.js';
    generateParticles(4); // Subtle mode: fewer particles
  </script>
</body>
</html>
```

---

## 🧪 Testing

1. **Homepage** - `http://localhost:3456/`
   - Should see: Bright orbs, visible rails, 8 particles, interactive effects
   
2. **Dashboard** - `http://localhost:3456/workflows/bug-investigation/dashboard-v3.html?workflow=...&id=...`
   - Should see: Very subtle orbs, barely visible rails, 4 particles, no interactions

3. **Toggle dark mode** on both pages
   - Background should smoothly transition colors
   - Orbs should adapt to dark theme

---

## 📝 Design Philosophy

### **Why Subtle Mode?**
- Users spend **90% of their time on dashboards**, not the homepage
- Dashboards are **data-heavy** (charts, timelines, hypotheses)
- Background should **enhance, not compete** with content
- Maintains **brand identity** without **distraction**

### **Why Not Just Remove It?**
- A **completely blank page** feels generic and lifeless
- **Subtle ambient effects** create warmth and personality
- **Visual continuity** between pages improves UX
- Users subconsciously associate the background with Workrail

---

## 🔧 Customization

Want to tweak the intensity? Edit `/assets/background-effects.css`:

```css
/* Make subtle mode even more subtle */
[data-bg-intensity="subtle"] .bg-orbs circle {
  opacity: 0.08 !important; /* Even dimmer */
}

/* Make particles slower */
[data-bg-intensity="subtle"] .particle {
  animation-duration: 45s; /* Slower movement */
}

/* Add a custom "focus" mode */
[data-bg-intensity="focus"] .bg-orbs {
  display: none; /* No orbs at all */
}
[data-bg-intensity="focus"] .rail-path {
  opacity: 0.02; /* Super subtle rails */
}
```

---

## ✅ Summary

✨ **Homepage:** Full intensity, fun and engaging
🎯 **Dashboards:** Subtle mode, focus on data
🤍 **Minimal:** Optional, ultra-clean

All controlled by one HTML attribute: `data-bg-intensity="subtle"`

**Result:** Professional, polished, and performant! 🚀


## Overview

Workrail now uses **adaptive background intensity** to provide:
- **Engaging, vibrant backgrounds** on landing pages (welcome, explore)
- **Subtle, ambient backgrounds** on dashboards (focus on data, not distraction)
- **Minimal/no backgrounds** for ultra-clean pages (optional)

---

## 🎯 Modes

### **1. Default (Full Intensity)**
**Used on:** Homepage, marketing pages, onboarding

**Characteristics:**
- ✨ 8+ animated particles
- 🌈 Bright orbs (opacity: 0.25-0.4)
- 🔵 Visible workflow rails
- 🎪 Interactive cursor effects
- 📜 Scroll parallax

**How to use:**
```html
<html lang="en">
  <!-- No attribute needed - this is the default -->
</html>
```

---

### **2. Subtle Mode**
**Used on:** Bug investigation dashboard, workflow dashboards

**Characteristics:**
- ✨ 4 animated particles (50% fewer)
- 🌈 Dimmed orbs (opacity: 0.15)
- 🔵 Barely visible rails (opacity: 0.05)
- ❌ No interactive cursor effects
- ❌ No scroll parallax
- 🎯 Focus on content, not background

**How to use:**
```html
<html lang="en" data-bg-intensity="subtle">
  <!-- Background is present but very subtle -->
</html>
```

**Performance notes:**
- 50% fewer particles = lower CPU usage
- No interaction detection = lower event processing
- No parallax = faster scrolling
- Perfect for data-heavy dashboards

---

### **3. Minimal Mode** (Optional)
**Used on:** Print-friendly pages, accessibility mode

**Characteristics:**
- ❌ No background effects at all
- 🤍 Clean white/dark background
- ⚡ Maximum performance
- ♿ Ideal for accessibility

**How to use:**
```html
<html lang="en" data-bg-intensity="minimal">
  <!-- No background effects rendered -->
</html>
```

---

## 📦 What's Included in Each Page

### **Homepage (Full Intensity)**
```html
<!-- All effects enabled -->
<link rel="stylesheet" href="/assets/background-effects.css">
<script src="/assets/particle-generator.js"></script>
<script src="/assets/background-interaction.js"></script>
<script src="/assets/scroll-parallax.js"></script>
<script src="/assets/time-of-day-theme.js"></script>

<!-- Background elements -->
<svg class="bg-orbs">...</svg>
<div class="bg-rails">...</div>
<div class="workflow-node">...</div>
<div id="particle-container"></div>
<div class="bg-grain"></div>

<script>
  generateParticles(8); // 8 particles
</script>
```

---

### **Dashboard (Subtle Mode)**
```html
<!-- Minimal scripts -->
<link rel="stylesheet" href="/assets/background-effects.css">
<script src="/assets/particle-generator.js"></script>
<script src="/assets/time-of-day-theme.js"></script>

<!-- Background elements (same HTML, different CSS) -->
<svg class="bg-orbs">...</svg>
<div class="bg-rails">...</div>
<div class="workflow-node">...</div>
<div id="particle-container"></div>
<div class="bg-grain"></div>

<script>
  generateParticles(4); // 4 particles (50% fewer)
</script>

<!-- NO interactive effects -->
<!-- NO scroll parallax -->
```

---

## 🎨 Visual Comparison

| Element | Default | Subtle | Minimal |
|---------|---------|--------|---------|
| **Orbs** | Opacity 0.25-0.4 | Opacity 0.25 | Hidden |
| **Rails** | Visible | Subtle (0.12) | Hidden |
| **Nodes** | Pulsing (2s) | Slow pulse (4s) | Hidden |
| **Particles** | 8, fast | 4, slow (25s) | Hidden |
| **Grain** | Subtle | Very subtle | Hidden |
| **Interactions** | ✅ Yes | ❌ No | ❌ No |
| **Parallax** | ✅ Yes | ❌ No | ❌ No |

---

## 🚀 Adding to New Pages

### **New Homepage/Marketing Page:**
```html
<html lang="en"> <!-- Default intensity -->
<head>
  <link rel="stylesheet" href="/assets/background-effects.css">
  <script src="/assets/theme-manager.js"></script>
  <script src="/assets/particle-generator.js"></script>
  <script src="/assets/background-interaction.js"></script>
  <script src="/assets/scroll-parallax.js"></script>
</head>
<body>
  <!-- Copy background elements from index.html -->
  <svg class="bg-orbs">...</svg>
  <div class="bg-rails">...</div>
  <!-- ... etc -->
  
  <!-- Your content here -->
  
  <script type="module">
    import { generateParticles } from '/assets/particle-generator.js';
    generateParticles(8); // Full intensity
  </script>
</body>
</html>
```

---

### **New Dashboard Page:**
```html
<html lang="en" data-bg-intensity="subtle"> <!-- Subtle mode -->
<head>
  <link rel="stylesheet" href="/assets/background-effects.css">
  <script src="/assets/theme-manager.js"></script>
  <script src="/assets/particle-generator.js"></script>
  <!-- NO interaction or parallax scripts -->
</head>
<body>
  <!-- Copy background elements from dashboard-v3.html -->
  <svg class="bg-orbs">...</svg>
  <div class="bg-rails">...</div>
  <!-- ... etc -->
  
  <!-- Your content here -->
  
  <script type="module">
    import { generateParticles } from '/assets/particle-generator.js';
    generateParticles(4); // Subtle mode: fewer particles
  </script>
</body>
</html>
```

---

## 🧪 Testing

1. **Homepage** - `http://localhost:3456/`
   - Should see: Bright orbs, visible rails, 8 particles, interactive effects
   
2. **Dashboard** - `http://localhost:3456/workflows/bug-investigation/dashboard-v3.html?workflow=...&id=...`
   - Should see: Very subtle orbs, barely visible rails, 4 particles, no interactions

3. **Toggle dark mode** on both pages
   - Background should smoothly transition colors
   - Orbs should adapt to dark theme

---

## 📝 Design Philosophy

### **Why Subtle Mode?**
- Users spend **90% of their time on dashboards**, not the homepage
- Dashboards are **data-heavy** (charts, timelines, hypotheses)
- Background should **enhance, not compete** with content
- Maintains **brand identity** without **distraction**

### **Why Not Just Remove It?**
- A **completely blank page** feels generic and lifeless
- **Subtle ambient effects** create warmth and personality
- **Visual continuity** between pages improves UX
- Users subconsciously associate the background with Workrail

---

## 🔧 Customization

Want to tweak the intensity? Edit `/assets/background-effects.css`:

```css
/* Make subtle mode even more subtle */
[data-bg-intensity="subtle"] .bg-orbs circle {
  opacity: 0.08 !important; /* Even dimmer */
}

/* Make particles slower */
[data-bg-intensity="subtle"] .particle {
  animation-duration: 45s; /* Slower movement */
}

/* Add a custom "focus" mode */
[data-bg-intensity="focus"] .bg-orbs {
  display: none; /* No orbs at all */
}
[data-bg-intensity="focus"] .rail-path {
  opacity: 0.02; /* Super subtle rails */
}
```

---

## ✅ Summary

✨ **Homepage:** Full intensity, fun and engaging
🎯 **Dashboards:** Subtle mode, focus on data
🤍 **Minimal:** Optional, ultra-clean

All controlled by one HTML attribute: `data-bg-intensity="subtle"`

**Result:** Professional, polished, and performant! 🚀

