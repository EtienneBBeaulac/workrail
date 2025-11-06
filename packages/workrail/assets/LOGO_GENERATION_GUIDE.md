# WorkRail Logo Generation Guide

## 🎨 What to Generate

Use Gemini (or any AI image generator) to create these versions of the WorkRail logo.

## Base Design

The logo you've already created:
- Railway tracks forming a "W" shape
- Crossties/sleepers on the tracks
- "WorkRail" wordmark below
- Clean, geometric, professional

## Required Files

### 1. Full Logo with Wordmark

**File: `logo.svg`**
- The complete logo (W rails + "WorkRail" text)
- Black on transparent background
- Vector format (SVG)
- Use for: README, documentation, light backgrounds

**File: `logo-dark.svg`**
- Same as above but white on transparent
- Use for: Dark mode websites, dark presentations

**File: `logo.png`**
- Raster version, 512×512px
- Black on transparent
- High resolution
- Use for: npm package, social media

### 2. Icon Only (No Wordmark)

**File: `icon.svg`**
- Just the W rails (no text)
- Black on transparent
- Square aspect ratio
- Use for: Favicons, app icons

**File: `icon-dark.svg`**
- Same as above but white on transparent

### 3. Favicon Sizes

**Small sizes for browser favicons:**

**File: `favicon-16.png`**
- 16×16px
- May need simplified version (fewer crossties)
- Black on transparent

**File: `favicon-32.png`**
- 32×32px
- Black on transparent

**File: `favicon.ico`**
- Multi-resolution .ico file (16px + 32px combined)
- Use online converter: https://favicon.io/

### 4. Web App Icons

**File: `icon-192.png`**
- 192×192px
- Black on transparent
- For web app manifest

**File: `icon-512.png`**
- 512×512px
- Black on transparent
- For web app manifest

## Gemini Prompts

### For Full Logo (SVG)
```
Create a professional logo in SVG format. The design features two railway 
tracks with crossties forming a "W" shape. Below the W is the wordmark 
"WorkRail" in clean modern sans-serif font. Black design on transparent 
background. Geometric, minimal, enterprise quality. Output as SVG code.
```

### For Dark Version
```
Same logo as before, but white on transparent background instead of black. 
SVG format.
```

### For Icon Only
```
Create just the "W" made from railway tracks (no text), square composition, 
black on transparent, SVG format. This will be used as a favicon so make 
sure it's clearly recognizable at small sizes.
```

### For Small Favicon (16×16)
```
Simplified version of the railway W logo, 16×16 pixels. Reduce the number 
of crossties to 2-3 total for clarity at tiny size. Black on transparent. 
PNG format.
```

## Where Files Go

After generating, save files to:

```
packages/workrail/
├── assets/
│   ├── logo.svg              (for README)
│   ├── logo.png              (for npm, social)
│   └── logo-dark.svg         (for dark backgrounds)
└── web/assets/images/
    ├── icon.svg              (favicon)
    ├── icon-dark.svg
    ├── favicon-16.png
    ├── favicon-32.png
    ├── favicon.ico
    ├── icon-192.png
    └── icon-512.png
```

## Verification

After generating, check:
- [ ] SVG files open in browser correctly
- [ ] Transparent backgrounds work
- [ ] Logo is readable at 16×16px
- [ ] Dark versions look good on dark backgrounds
- [ ] PNG files are crisp and not blurry

## Alternative: Use Online Tools

If Gemini won't output proper files:

1. **SVG Export**: 
   - Ask Gemini for high-res PNG
   - Use https://vectorizer.ai/ to convert to SVG

2. **Favicon Generator**:
   - Upload your icon SVG/PNG to https://favicon.io/
   - Download complete favicon package

3. **Resize PNGs**:
   - Use https://imageresizer.com/
   - Create all required sizes from one master PNG

## Quick Start (Minimum Viable)

If you want to ship fast with minimum files:

**Essential files only:**
1. `assets/logo.svg` - for README
2. `web/assets/images/favicon.ico` - for browsers

Everything else can be added later!

