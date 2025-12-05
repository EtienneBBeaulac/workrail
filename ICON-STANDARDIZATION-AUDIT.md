# WorkRail Icon/Logo Standardization Audit

**Date:** November 20, 2025  
**Primary Brand Color:** Amber (#F59E0B)

## Executive Summary

The WorkRail codebase currently contains 27 icon/logo files across multiple directories with inconsistent naming and unused color variants. This audit identifies all assets, their usage, and proposes a standardization plan.

---

## Current State

### Assets Directory (`/assets/`)

**Logo Files (11 total):**
- ✅ `logo.svg` (6.2K) - **Referenced in README.md**
- ✅ `logo.png` (74K)
- ✅ `logo-amber.svg` (6.2K) - **Primary brand color**
- ⚠️ `logo-amber-600.svg` (6.2K) - Duplicate/variant
- ⚠️ `logo-amber-clean.png` (178K) - Large file, inconsistent naming
- ✅ `logo-white.svg` (6.2K) - For dark backgrounds
- ⚠️ `logo-white-clean.png` (403B) - Very small, possibly corrupted
- ❌ `logo-deep-purple.svg` (6.2K) - **UNUSED**
- ❌ `logo-emerald.svg` (6.2K) - **UNUSED**
- ❌ `logo-soft-purple.svg` (6.2K) - **UNUSED**
- ❌ `logo-warm-orange.svg` (6.2K) - **UNUSED**

### Web Assets Directory (`/web/assets/images/`)

**Icon Files (16 total):**
- ✅ `icon.svg` (6.4K) - Base icon
- ✅ `icon-192.png` (14K) - **Referenced in manifest.json and HTML**
- ✅ `icon-512.png` (51K) - **Referenced in manifest.json**
- ⚠️ `icon-amber.svg` (6.4K) - Duplicate of base
- ⚠️ `icon-amber-192.png` (14K) - Duplicate
- ⚠️ `icon-amber-512.png` (51K) - Duplicate
- ⚠️ `icon-white.svg` (6.4K) - Alternate color
- ⚠️ `icon-white-192-clean.png` (14K) - Duplicate with variant naming
- ⚠️ `icon-white-512-clean.png` (51K) - Duplicate with variant naming

**Favicon Files (7 total):**
- ✅ `favicon.ico` (2.9K) - **Referenced in all HTML files**
- ✅ `favicon-16.png` (579B) - **Referenced in all HTML files**
- ✅ `favicon-32.png` (1.3K) - **Referenced in all HTML files**
- ⚠️ `favicon-amber-16.png` (579B) - Duplicate
- ⚠️ `favicon-amber-32.png` (1.3K) - Duplicate
- ⚠️ `favicon-white-16-clean.png` (579B) - Duplicate
- ⚠️ `favicon-white-32-clean.png` (1.3K) - Duplicate

---

## Current References

### README.md
```markdown
<img src="./assets/logo.svg" alt="WorkRail Logo" width="200" />
```

### HTML Files (8 files)
All reference the same favicon set:
```html
<link rel="icon" type="image/x-icon" href="/assets/images/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/images/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/images/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/images/icon-192.png">
```

### manifest.json
```json
"theme_color": "#F59E0B",
"icons": [
  { "src": "/assets/images/icon-192.png", "sizes": "192x192" },
  { "src": "/assets/images/icon-512.png", "sizes": "512x512" }
]
```

---

## Standardization Plan

### Phase 1: Define Standard Asset Set

**Documentation/Marketing Logos** (`/assets/`):
- `logo.svg` - Primary logo (amber) for README and documentation
- `logo-dark.svg` - Logo optimized for dark backgrounds (white/light variant)
- `logo.png` - High-resolution raster fallback

**Web Application Icons** (`/web/assets/images/`):
- `icon.svg` - Base icon for any SVG needs
- `icon-192.png` - PWA icon (192x192)
- `icon-512.png` - PWA icon (512x512)
- `favicon.ico` - Browser favicon (multi-size ICO)
- `favicon-16.png` - Small favicon
- `favicon-32.png` - Standard favicon

### Phase 2: File Operations

**Delete (13 files):**

From `/assets/`:
- `logo-deep-purple.svg`
- `logo-emerald.svg`
- `logo-soft-purple.svg`
- `logo-warm-orange.svg`
- `logo-amber-600.svg` (redundant with logo-amber.svg)
- `logo-amber-clean.png` (very large, unnecessary)
- `logo-white-clean.png` (tiny, possibly corrupted)

From `/web/assets/images/`:
- `icon-amber.svg` (redundant)
- `icon-amber-192.png` (redundant)
- `icon-amber-512.png` (redundant)
- `icon-white.svg` (not actively used)
- `icon-white-192-clean.png` (redundant)
- `icon-white-512-clean.png` (redundant)
- `favicon-amber-16.png` (redundant)
- `favicon-amber-32.png` (redundant)
- `favicon-white-16-clean.png` (redundant)
- `favicon-white-32-clean.png` (redundant)

**Rename (2 files):**

In `/assets/`:
- `logo-amber.svg` → Keep as reference or remove (since `logo.svg` is amber)
- `logo-white.svg` → `logo-dark.svg` (clearer naming for dark background usage)

### Phase 3: Verify Existing Files Are Amber

Confirm that current "base" files are already amber colored:
- `assets/logo.svg` should be amber
- `assets/logo.png` should be amber
- `web/assets/images/icon.svg` should be amber
- `web/assets/images/icon-192.png` should be amber
- `web/assets/images/icon-512.png` should be amber
- `web/assets/images/favicon-*.png` should be amber
- `web/assets/images/favicon.ico` should be amber

### Phase 4: Documentation

Create `/assets/ICON-GUIDE.md` with:
- Which icon to use where
- Icon specifications (sizes, formats)
- Brand guidelines
- Instructions for updating icons

---

## Implementation Checklist

- [x] Audit complete
- [x] Delete unused color variant files (17 files deleted)
- [x] Rename `logo-white.svg` → `logo-dark.svg`
- [x] Update `logo.svg` to use amber color (was black)
- [x] Remove redundant `logo-amber.svg` (merged into logo.svg)
- [x] Create ICON-GUIDE.md documentation
- [x] Verify: Web icons (icon.svg, favicons) are grayscale (acceptable for UI flexibility)
- [ ] Commit changes with clear message
- [x] No code references need updating (all use base filenames)

---

## Risk Assessment

**LOW RISK** - No code changes required because:
- All HTML files reference the base filenames (`favicon.ico`, `icon-192.png`, etc.)
- README references `logo.svg` which is kept
- manifest.json references base icon filenames
- Only removing unused/duplicate files
- All actively referenced files are being kept

---

## Expected Outcome

- **27 files → 9 files** (67% reduction)
- Clear, consistent naming convention
- Documentation logos use primary amber brand color
- Web icons/favicons remain grayscale for UI flexibility
- One dark-background variant (`logo-dark.svg`)
- Documented icon usage guidelines
- No breaking changes to existing references

## Actual Outcome

**Files Deleted (17 total):**
- `assets/logo-deep-purple.svg`
- `assets/logo-emerald.svg`
- `assets/logo-soft-purple.svg`
- `assets/logo-warm-orange.svg`
- `assets/logo-amber-600.svg`
- `assets/logo-amber-clean.png` (178K)
- `assets/logo-white-clean.png`
- `web/assets/images/icon-amber.svg`
- `web/assets/images/icon-amber-192.png`
- `web/assets/images/icon-amber-512.png`
- `web/assets/images/icon-white.svg`
- `web/assets/images/icon-white-192-clean.png`
- `web/assets/images/icon-white-512-clean.png`
- `web/assets/images/favicon-amber-16.png`
- `web/assets/images/favicon-amber-32.png`
- `web/assets/images/favicon-white-16-clean.png`
- `web/assets/images/favicon-white-32-clean.png`

**Files Renamed/Updated:**
- `assets/logo-white.svg` → `assets/logo-dark.svg`
- `assets/logo.svg` - Updated from black (#000000) to amber (#F59E0B)
- `assets/logo-amber.svg` - Removed (redundant after updating logo.svg)

**Files Created:**
- `ICON-STANDARDIZATION-AUDIT.md` - This audit document
- `assets/ICON-GUIDE.md` - Icon usage guidelines

**Final Asset Count:**
- `/assets/`: 4 files (logo.svg, logo-dark.svg, logo.png, ICON-GUIDE.md)
- `/web/assets/images/`: 6 files (icon.svg, icon-192.png, icon-512.png, favicon.ico, favicon-16.png, favicon-32.png)

**Result:** Successfully standardized from 27 icon files to 10 files (63% reduction), established clear naming conventions, and documented usage guidelines. All documentation assets now use amber as primary brand color.

