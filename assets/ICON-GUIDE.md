# WorkRail Icon & Logo Guide

## Overview

WorkRail uses **Amber** (#F59E0B) as its primary brand color. This guide outlines which icon files to use in different contexts.

---

## Icon Files Reference

### Documentation & Marketing Logos

Located in `/assets/`

#### `logo.svg` (Primary)
- **Use for:** README files, documentation, GitHub social preview
- **Format:** SVG (scalable)
- **Color:** Amber (#F59E0B)
- **Size:** Optimized vector
- **Background:** Transparent

#### `logo-dark.svg`
- **Use for:** Dark backgrounds, dark mode documentation
- **Format:** SVG (scalable)
- **Color:** White/Light
- **Size:** Optimized vector
- **Background:** Transparent

#### `logo.png`
- **Use for:** Raster fallback, presentations, social media
- **Format:** PNG
- **Color:** Amber (#F59E0B)
- **Size:** High resolution
- **Background:** Transparent

---

### Web Application Icons

Located in `/web/assets/images/`

#### `icon.svg`
- **Use for:** SVG icon needs in web components
- **Format:** SVG
- **Color:** Amber (#F59E0B)
- **Size:** Optimized vector
- **Background:** Transparent

#### `icon-192.png`
- **Use for:** PWA manifest, apple-touch-icon
- **Format:** PNG
- **Size:** 192x192px
- **Color:** Amber (#F59E0B)
- **Purpose:** Progressive Web App icon

#### `icon-512.png`
- **Use for:** PWA manifest (larger displays)
- **Format:** PNG
- **Size:** 512x512px
- **Color:** Amber (#F59E0B)
- **Purpose:** Progressive Web App icon

#### `favicon.ico`
- **Use for:** Browser tab icon (all browsers)
- **Format:** ICO (multi-size)
- **Sizes:** 16x16, 32x32, 48x48
- **Color:** Amber (#F59E0B)
- **Purpose:** Legacy browser compatibility

#### `favicon-16.png`
- **Use for:** Small browser tab icon
- **Format:** PNG
- **Size:** 16x16px
- **Color:** Amber (#F59E0B)
- **Purpose:** Modern browser favicon

#### `favicon-32.png`
- **Use for:** Standard browser tab icon
- **Format:** PNG
- **Size:** 32x32px
- **Color:** Amber (#F59E0B)
- **Purpose:** Modern browser favicon

---

## Usage Examples

### In README.md
```markdown
<img src="./assets/logo.svg" alt="WorkRail Logo" width="200" />
```

### In HTML Head
```html
<!-- Favicon -->
<link rel="icon" type="image/x-icon" href="/assets/images/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/images/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/images/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/images/icon-192.png">
<link rel="manifest" href="/manifest.json">
```

### In manifest.json
```json
{
  "name": "WorkRail Dashboard",
  "theme_color": "#F59E0B",
  "icons": [
    {
      "src": "/assets/images/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/assets/images/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
```

---

## Brand Guidelines

### Color Specifications

**Primary Brand Color: Amber**
- Hex: `#F59E0B`
- RGB: `rgb(245, 158, 11)`
- HSL: `hsl(38, 92%, 50%)`

**Dark Background Variant: White**
- Hex: `#FFFFFF`
- RGB: `rgb(255, 255, 255)`
- Use: Only for `logo-dark.svg` on dark backgrounds

### Icon Design Principles

1. **Simplicity:** Icons should be clean and recognizable at small sizes
2. **Consistency:** All icons use the same amber brand color
3. **Scalability:** SVG format preferred for flexibility
4. **Accessibility:** Sufficient contrast against backgrounds
5. **Performance:** Optimized file sizes without quality loss

---

## Updating Icons

### When to Update

- Rebranding or color scheme changes
- Icon design improvements
- New platform requirements (e.g., new PWA icon sizes)

### How to Update

1. **Generate new icons** in the amber color scheme
2. **Test across platforms:**
   - Modern browsers (Chrome, Firefox, Safari, Edge)
   - Mobile browsers (iOS Safari, Android Chrome)
   - PWA installation on mobile devices
3. **Update this guide** if specifications change
4. **Validate:** Ensure all icon files are properly optimized
5. **Commit** with a clear description of changes

### Icon Generation Tools

Recommended tools for creating icons:
- **Figma/Sketch:** Design tool for creating SVG logos
- **ImageMagick:** CLI tool for PNG resizing
- **SVGO:** SVG optimization
- **Real Favicon Generator:** Generate all favicon sizes ([realfavicongenerator.net](https://realfavicongenerator.net))

---

## File Structure

```

├── assets/
│   ├── logo.svg              # Primary logo (amber)
│   ├── logo-dark.svg         # Dark background variant (white)
│   ├── logo.png              # Raster fallback
│   └── ICON-GUIDE.md         # This file
└── web/assets/images/
    ├── icon.svg              # SVG icon
    ├── icon-192.png          # PWA icon (192x192)
    ├── icon-512.png          # PWA icon (512x512)
    ├── favicon.ico           # Multi-size ICO
    ├── favicon-16.png        # Small favicon
    └── favicon-32.png        # Standard favicon
```

---

## Questions?

For questions about icon usage or branding guidelines, please refer to:
- This guide (ICON-GUIDE.md)
- The standardization audit (ICON-STANDARDIZATION-AUDIT.md)
- WorkRail project maintainers

---

**Last Updated:** November 20, 2025


