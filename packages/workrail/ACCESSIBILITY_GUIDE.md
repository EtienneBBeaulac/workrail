# WorkRail Logo & Color Accessibility Guide 🎯

## Contrast Ratio Test Results

### Amber `#F59E0B` Contrast Ratios:
| Background | Contrast | WCAG Rating | Use? |
|------------|----------|-------------|------|
| White `#FFFFFF` | 2.15:1 | ❌ FAIL | **NO** |
| Light Gray `#F5F5F4` | 1.97:1 | ❌ FAIL | **NO** |
| Dark `#18181B` | 8.25:1 | ✅ AAA | **YES** |
| Black `#000000` | 9.78:1 | ✅ AAA | **YES** |

### White `#FFFFFF` Contrast Ratios:
| Background | Contrast | WCAG Rating | Use? |
|------------|----------|-------------|------|
| Dark `#18181B` | 17.72:1 | ✅ AAA | **YES** |
| Black `#000000` | 21.00:1 | ✅ AAA | **YES** |

---

## What This Means 💡

### For Logos:

**❌ Don't use amber logo on light backgrounds**
- Fails WCAG contrast (only 2.15:1)
- Hard to see, poor visibility
- **Use BLACK logo instead** on white/light backgrounds

**✅ Amber logo works GREAT on dark backgrounds**
- Excellent contrast (8.25:1 - AAA rated!)
- Highly visible
- Shows brand color beautifully

**✅ White logo perfect for dark backgrounds**
- Perfect contrast (17.72:1)
- Maximum visibility
- Classic look

---

## Logo Usage Strategy 🎨

### Light Backgrounds (White, Light Gray):
```
Use: BLACK logo (assets/logo.svg - original)
Why: Maximum visibility and contrast
```

### Dark Backgrounds (Dark mode, #18181B, black):
```
Option A: WHITE logo (assets/logo-white.svg)
  - Maximum contrast (17.72:1)
  - Classic, always works
  - Recommended for body content areas

Option B: AMBER logo (assets/logo-amber.svg) ⭐
  - Great contrast (8.25:1 AAA)
  - Shows brand color
  - Perfect for hero sections, headers
  - Recommended for marketing/branding
```

**Pro tip:** Use white logo in UI, amber logo in marketing!

---

## Brand Color Usage (Amber)

### ✅ Where to USE amber:

**UI Elements (works great!):**
- Buttons and CTAs
- Hover states
- Active/selected states  
- Badges and labels
- Progress bars
- Focus rings
- Icons (on dark backgrounds)
- Section headers (on dark backgrounds)

**Marketing:**
- Hero sections (dark backgrounds)
- Feature highlights (dark backgrounds)
- Logos on dark slides
- Social media (dark backgrounds)

### ❌ Where NOT to use amber:

**Avoid on light backgrounds:**
- Body text on white (use black/gray)
- Small text on white
- Logos on white (use black logo)
- Icons on white (use black)

**Exception:** Large elements on white can use amber as accent (like big buttons), just not for small text or logos.

---

## Complete Logo Set for All Scenarios

### 1. Light Mode Website/Docs
```
Logo: assets/logo.svg (BLACK)
Reason: Maximum visibility on white
```

### 2. Dark Mode Website/Docs
```
Logo: assets/logo-white.svg (WHITE)
Reason: Maximum readability
```

### 3. Dark Mode Marketing/Hero
```
Logo: assets/logo-amber.svg (AMBER) ⭐
Reason: Show brand color, still AAA rated
```

### 4. Favicon (Light Browsers)
```
Icon: web/assets/images/favicon-32.png (BLACK)
Reason: Works on light browser tabs
```

### 5. Favicon (Dark Browsers)
```
Icon: web/assets/images/favicon-white-32-clean.png (WHITE)
Reason: Works on dark browser tabs
```

### 6. Presentations (Light Slides)
```
Logo: assets/logo.svg (BLACK)
```

### 7. Presentations (Dark Slides)
```
Logo: assets/logo-amber.svg (AMBER) or logo-white.svg
Reason: Brand color shines!
```

---

## Responsive Logo Setup (Auto-switches)

### HTML for Auto Dark/Light Mode:

```html
<!-- Automatically switches based on user's theme -->
<picture>
  <source srcset="./assets/logo-white.svg" 
          media="(prefers-color-scheme: dark)">
  <img src="./assets/logo.svg" 
       alt="WorkRail Logo">
</picture>
```

### Favicon with Theme Detection:

```html
<!-- Light mode favicon -->
<link rel="icon" 
      href="/assets/images/favicon-32.png" 
      media="(prefers-color-scheme: light)">

<!-- Dark mode favicon -->
<link rel="icon" 
      href="/assets/images/favicon-white-32-clean.png" 
      media="(prefers-color-scheme: dark)">
```

---

## Accessibility Tools Recommendations

### Online Tools:
1. **WebAIM Contrast Checker**
   - https://webaim.org/resources/contrastchecker/
   - Check any color combination
   - WCAG 2.1 compliant

2. **Colorable**
   - https://colorable.jxnblk.com/
   - Real-time contrast testing
   - Color palette testing

3. **Contrast Ratio**
   - https://contrast-ratio.com/
   - Simple, quick checks
   - By Lea Verou

4. **WAVE Browser Extension**
   - https://wave.webaim.org/extension/
   - Chrome/Firefox extension
   - Tests entire pages

### Design Tools:
1. **Figma Plugins:**
   - "Stark" - Accessibility checker
   - "Contrast" - Quick contrast checks
   - "A11y - Color Contrast Checker"

2. **VS Code Extensions:**
   - "Color Highlight"
   - "axe Accessibility Linter"

### Command Line:
```bash
# Install colorable cli
npm install -g colorable-cli

# Check contrast
colorable --fg "#F59E0B" --bg "#FFFFFF"
```

---

## WCAG Standards Reference

### Contrast Requirements:

**Normal Text (< 18pt):**
- AA: 4.5:1 minimum
- AAA: 7:1 minimum

**Large Text (≥ 18pt or ≥ 14pt bold):**
- AA: 3:1 minimum
- AAA: 4.5:1 minimum

**Graphical Objects & UI Components:**
- AA: 3:1 minimum

**Logos:**
- No contrast requirement (exempt)
- But should be visible!

---

## Summary & Recommendations ✅

### What We Have:
- ✅ Black logo for light backgrounds
- ✅ White logo for dark backgrounds  
- ✅ Amber logo for dark backgrounds (brand moments)
- ✅ All pass accessibility when used correctly

### Strategy:
1. **Default:** Black on light, white on dark
2. **Brand moments:** Amber on dark (hero sections, marketing)
3. **UI elements:** Amber for buttons, accents, highlights
4. **Never:** Amber logo on white backgrounds

### Files Ready:
```
Light backgrounds → assets/logo.svg (black)
Dark backgrounds  → assets/logo-white.svg (white)
Dark + branding   → assets/logo-amber.svg (amber) ⭐
```

---

## Test Checklist

Before shipping, test:
- [ ] Black logo visible on white
- [ ] White logo visible on dark
- [ ] Amber logo visible on dark
- [ ] Amber buttons readable on white
- [ ] Focus states have 3:1 contrast
- [ ] Active states distinguishable
- [ ] Test with colorblind simulators
- [ ] Test at different zoom levels

---

**Result:** You have all the versions needed for full accessibility! 🎉

