# WorkRail Official Brand Guidelines

**Version:** 1.0  
**Date:** November 6, 2024  
**Status:** Official

---

## 🎨 Official Brand Color

### Primary Brand Color: **Amber**

```css
--workrail-brand-amber: #F59E0B
```

**Hex:** `#F59E0B`  
**RGB:** `245, 158, 11`  
**HSL:** `43°, 93%, 50%`

---

## Why Amber? 🚦

**Amber represents WorkRail's core function:**

In railway signaling systems:
- 🔴 **RED** = Stop, danger, blocked
- 🟡 **AMBER** = Proceed with awareness, guided, structured ← **WorkRail**
- 🟢 **GREEN** = Clear, validated, complete

**WorkRail is the amber signal** - guiding AI from chaos to structure.

### Brand Positioning:
> "WorkRail is the amber signal for AI development - guiding agents through structured workflows, ensuring they proceed thoughtfully, not recklessly. The gold standard for AI workflow orchestration."

---

## Logo Versions 📁

### 1. Black Logo (Primary - Light Backgrounds)
**File:** `assets/logo.svg`  
**Use on:** White, light gray, light backgrounds  
**Format:** SVG (vector, scales infinitely)

### 2. White Logo (Dark Backgrounds)
**File:** `assets/logo-white.svg`  
**Use on:** Dark mode, #18181B, black, dark backgrounds  
**Format:** SVG (vector, scales infinitely)

### 3. Amber Logo (Brand Moments on Dark)
**File:** `assets/logo-amber.svg`  
**Use on:** Dark backgrounds for branding/marketing  
**Format:** SVG (vector, scales infinitely)  
**Note:** AAA accessibility on dark backgrounds!

### Icon Versions (No Text)
- `web/assets/images/icon.svg` - Black icon
- `web/assets/images/icon-white.svg` - White icon
- `web/assets/images/icon-amber.svg` - Amber icon

---

## Logo Usage Rules ✅

### DO:
✅ Use black logo on light backgrounds  
✅ Use white logo on dark backgrounds  
✅ Use amber logo on dark backgrounds (marketing/hero)  
✅ Maintain clear space around logo (minimum: logo height ÷ 2)  
✅ Use SVG format when possible for crisp scaling  
✅ Ensure logo is legible (minimum width: 120px)

### DON'T:
❌ Use amber logo on white/light backgrounds (fails accessibility)  
❌ Stretch or distort the logo  
❌ Add effects (shadows, glows, etc.)  
❌ Place logo on busy backgrounds  
❌ Use low-resolution versions  
❌ Rotate the logo  
❌ Change the colors (except approved versions)

---

## Color Palette

### Primary
```css
--brand-amber: #F59E0B;     /* Primary brand color */
```

### Secondary Colors
```css
--brand-slate: #64748B;     /* Professional gray */
--brand-blue: #3B82F6;      /* Trust, technology */
--brand-green: #10B981;     /* Success, validation */
```

### Amber Color Scale (for UI)
```css
--amber-50:  #FFFBEB;   /* Lightest - backgrounds */
--amber-100: #FEF3C7;   /* Very light */
--amber-200: #FDE68A;   /* Light */
--amber-300: #FCD34D;   /* Light-medium */
--amber-400: #FBBF24;   /* Medium-light */
--amber-500: #F59E0B;   /* PRIMARY BRAND COLOR ⭐ */
--amber-600: #D97706;   /* Medium-dark - hover states */
--amber-700: #B45309;   /* Dark */
--amber-800: #92400E;   /* Very dark */
--amber-900: #78350F;   /* Darkest */
```

---

## Typography

### Logo Wordmark
**Font:** Custom (embedded in logo SVG)  
**Do not recreate** - always use official logo files

### Brand Fonts (for other materials)
**Primary:** System fonts  
```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 
             Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
```

**Monospace:** For code/technical content  
```css
font-family: 'SF Mono', Monaco, 'Cascadia Code', 
             'Roboto Mono', Consolas, monospace;
```

---

## Color Usage Guidelines

### Amber Brand Color

**✅ USE for:**
- Buttons and CTAs (on any background)
- Hover states
- Active/selected states
- Badges and labels
- Progress indicators
- Focus rings
- Icons (on dark backgrounds)
- Section headers (on dark backgrounds)
- Logo (on dark backgrounds only)

**❌ DON'T USE for:**
- Body text on white
- Small text on light backgrounds
- Logo on white backgrounds

### Accessibility Requirements

**Amber on White:** 2.15:1 ❌ (FAILS - don't use)  
**Amber on Dark (#18181B):** 8.25:1 ✅ (AAA - perfect!)  
**White on Dark:** 17.72:1 ✅ (AAA - perfect!)

**Rule:** Amber requires dark backgrounds for text/logos.

---

## Responsive Logo Implementation

### Auto-Switching Logo (HTML)
```html
<!-- Automatically adapts to user's theme preference -->
<picture>
  <source srcset="./assets/logo-white.svg" 
          media="(prefers-color-scheme: dark)">
  <img src="./assets/logo.svg" 
       alt="WorkRail Logo" 
       width="200">
</picture>
```

### Theme-Aware Favicon
```html
<link rel="icon" 
      href="/assets/images/favicon-32.png" 
      media="(prefers-color-scheme: light)">
<link rel="icon" 
      href="/assets/images/favicon-white-32-clean.png" 
      media="(prefers-color-scheme: dark)">
```

---

## File Structure

```
packages/workrail/
├── assets/
│   ├── logo.svg                    ← Black (primary)
│   ├── logo-white.svg              ← White (dark mode)
│   ├── logo-amber.svg              ← Amber (brand moments)
│   ├── logo.png                    ← Raster version (512×512)
│   ├── logo-white-clean.png        ← White raster
│   └── logo-amber-clean.png        ← Amber raster
│
└── web/assets/images/
    ├── icon.svg                    ← Black icon
    ├── icon-white.svg              ← White icon
    ├── icon-amber.svg              ← Amber icon
    ├── favicon-32.png              ← Black favicon
    ├── favicon-white-32-clean.png  ← White favicon
    └── icon-512.png                ← App icon
```

---

## Brand Voice & Messaging

### Tagline
"Transform chaotic AI interactions into structured, reliable workflows"

### Key Messages
1. **Guidance:** "The amber signal that guides AI onto the right track"
2. **Structure:** "Building order from chaos, one workflow at a time"
3. **Quality:** "The gold standard for AI workflow orchestration"
4. **Railway:** "Rails that keep AI agents on track"

### Brand Personality
- **Thoughtful** (not reckless)
- **Structured** (not chaotic)
- **Guiding** (not controlling)
- **Premium** (gold standard)
- **Action-oriented** (not passive)

---

## Examples & Use Cases

### 1. Website Header (Light Mode)
```html
<header style="background: white;">
  <img src="assets/logo.svg" alt="WorkRail" width="150">
</header>
```

### 2. Website Header (Dark Mode)
```html
<header style="background: #18181B;">
  <img src="assets/logo-white.svg" alt="WorkRail" width="150">
</header>
```

### 3. Hero Section (Dark, Show Brand)
```html
<section style="background: #0F172A;">
  <!-- Use amber to show brand color! -->
  <img src="assets/logo-amber.svg" alt="WorkRail" width="200">
</section>
```

### 4. README Badge
```markdown
[![WorkRail](https://img.shields.io/badge/Powered_by-WorkRail-F59E0B.svg)](https://github.com/you/workrail)
```

### 5. Social Media
- Profile picture: Amber logo on dark background
- Cover image: Black logo on light or amber logo on dark
- Posts: Use appropriate version for background

---

## Quick Reference Card

| Scenario | Logo Version | File |
|----------|--------------|------|
| Light website | Black | `logo.svg` |
| Dark website | White | `logo-white.svg` |
| Dark hero/marketing | Amber | `logo-amber.svg` |
| Light presentation | Black | `logo.svg` |
| Dark presentation | Amber or White | `logo-amber.svg` |
| Favicon (light) | Black | `favicon-32.png` |
| Favicon (dark) | White | `favicon-white-32-clean.png` |
| App icon | Black or Amber | `icon-512.png` |

---

## Brand Assets Checklist

### Essential Files
- [x] Black logo SVG
- [x] White logo SVG
- [x] Amber logo SVG
- [x] Favicon (black)
- [x] Favicon (white)
- [x] App icons (all sizes)
- [x] Brand guidelines (this document)
- [x] Accessibility guide

### Optional Files
- [ ] Brand presentation deck
- [ ] Social media templates
- [ ] Email signature template
- [ ] Business card design
- [ ] T-shirt / swag designs

---

## Tools & Resources

### Accessibility Checkers
- WebAIM Contrast Checker: https://webaim.org/resources/contrastchecker/
- Colorable: https://colorable.jxnblk.com/
- WAVE Extension: https://wave.webaim.org/extension/

### Design Tools
- Figma: Stark plugin for accessibility
- VS Code: axe Accessibility Linter
- Browser: DevTools accessibility features

### Documentation
- `ACCESSIBILITY_GUIDE.md` - Detailed accessibility rules
- `LOGO_FILES_CLEAN.md` - Technical file documentation
- `AMBER_THE_ANSWER.md` - Brand color rationale

---

## Version History

**v1.0 (November 6, 2024)**
- Initial brand guidelines
- Amber selected as official brand color
- Logo suite finalized (black, white, amber)
- Accessibility guidelines established

---

## Contact & Questions

For brand guidelines questions or logo requests:
- See documentation in `packages/workrail/` directory
- Refer to accessibility guide for technical details
- All logo files available in `assets/` and `web/assets/images/`

---

**WorkRail** 🟡 - The amber signal for AI workflow orchestration

