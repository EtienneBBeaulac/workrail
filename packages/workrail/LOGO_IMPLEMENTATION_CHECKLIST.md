# WorkRail Logo Implementation Checklist

## ✅ What's Already Done

### Infrastructure Setup
- [x] Created `/assets` directory for root-level logo (README)
- [x] Created `/web/assets/images` directory for web assets
- [x] Updated `README.md` to display logo at top (centered, 200px width)
- [x] Updated `web/index.html` with favicon links
- [x] Updated `web/dashboard.html` with favicon links
- [x] Created `web/manifest.json` for PWA support
- [x] Added manifest links to HTML files
- [x] Created `LOGO_GENERATION_GUIDE.md` with detailed instructions

### Files Ready for Logo
All files are configured and waiting for logo assets:
- `README.md` → Will show logo at top
- `web/index.html` → Will show favicon in browser tab
- `web/dashboard.html` → Will show favicon in browser tab
- `web/manifest.json` → PWA icons configured

---

## 🎯 What You Need to Do

### Step 1: Generate Logo Files with Gemini

Use the prompts below (or from `LOGO_GENERATION_GUIDE.md`) to generate the logo files.

#### Prompt 1: Full Logo SVG (for README)
```
Create an SVG file of a professional logo. The design features two railway 
tracks with crossties (rectangular blocks on tracks) that form a continuous 
"W" shape. Below the W is the wordmark "WorkRail" in a clean, modern 
sans-serif font (similar to Inter or system-ui). Black design (#18181b) 
on transparent background. Geometric, minimal, enterprise quality. 
Make the SVG code clean and optimized. Aspect ratio should be roughly 
1:1.2 to accommodate the text below.
```

**Save as**: `packages/workrail/assets/logo.svg`

#### Prompt 2: Icon Only (for favicons)
```
Create an SVG of just the railway tracks forming a "W" shape (no text). 
This is for use as a favicon/app icon. Square aspect ratio (1:1). 
Black (#18181b) on transparent background. Make sure it's recognizable 
at small sizes - use 3-4 crossties per track. Clean, geometric design.
```

**Save as**: `packages/workrail/web/assets/images/icon.svg`

#### Prompt 3: Generate PNG Sizes

Once you have the SVG icon, use one of these methods:

**Option A: Ask Gemini**
```
Convert the icon SVG to PNG at these exact sizes:
- 16×16 pixels (simplified, fewer crossties for clarity)
- 32×32 pixels
- 192×192 pixels
- 512×512 pixels

Each should be black on transparent background.
```

**Option B: Use Online Tools** (Faster!)
1. Go to https://svgtopng.com/
2. Upload `icon.svg`
3. Export at 16px, 32px, 192px, 512px
4. Also export logo.svg at 512px for social/npm

**Option C: Use ImageMagick** (if you have it)
```bash
cd packages/workrail/web/assets/images

# From icon.svg
convert -background none -resize 16x16 icon.svg favicon-16.png
convert -background none -resize 32x32 icon.svg favicon-32.png
convert -background none -resize 192x192 icon.svg icon-192.png
convert -background none -resize 512x512 icon.svg icon-512.png

# From logo.svg
convert -background none -resize 512x512 ../../assets/logo.svg ../../assets/logo.png
```

#### Prompt 4: Create favicon.ico
Use https://favicon.io/favicon-converter/
1. Upload `favicon-32.png`
2. Download the generated `favicon.ico`
3. Save to `packages/workrail/web/assets/images/favicon.ico`

---

### Step 2: File Placement Checklist

Place the generated files in these exact locations:

```
packages/workrail/
├── assets/
│   ├── logo.svg              ← Full logo with text (for README)
│   └── logo.png              ← 512px raster (for npm, social media)
│
└── web/assets/images/
    ├── icon.svg              ← Icon only, no text
    ├── favicon-16.png        ← 16×16 favicon
    ├── favicon-32.png        ← 32×32 favicon
    ├── favicon.ico           ← Multi-size .ico file
    ├── icon-192.png          ← 192×192 for PWA
    └── icon-512.png          ← 512×512 for PWA
```

### Required Files (Minimum to Ship)
- [ ] `assets/logo.svg` - **REQUIRED** for README
- [ ] `web/assets/images/favicon.ico` - **REQUIRED** for browser tabs
- [ ] `web/assets/images/favicon-16.png`
- [ ] `web/assets/images/favicon-32.png`
- [ ] `web/assets/images/icon-192.png`
- [ ] `web/assets/images/icon-512.png`

### Nice to Have (Can add later)
- [ ] `assets/logo.png` - For npm package listing
- [ ] `assets/logo-dark.svg` - White version for dark backgrounds
- [ ] `web/assets/images/icon-dark.svg` - For dark mode favicon

---

## 🚀 Step 3: Test Everything

After adding the files:

### Test 1: README
```bash
# View README on GitHub or in VS Code preview
# You should see the logo at the top, centered
```

### Test 2: Dashboard Favicon
```bash
# Start the web server
cd packages/workrail
npm run dev

# Open http://localhost:3000
# Check browser tab for favicon
```

### Test 3: File Sizes
```bash
# Check that files aren't too large
ls -lh assets/
ls -lh web/assets/images/

# SVG should be < 50KB
# PNGs should be:
#   - favicon-16.png: < 5KB
#   - favicon-32.png: < 10KB
#   - icon-192.png: < 30KB
#   - icon-512.png: < 100KB
```

### Test 4: Visual Quality
- [ ] Logo is crisp at README size (~200px)
- [ ] Favicon is recognizable at 16×16px
- [ ] Transparent backgrounds work
- [ ] No white halos or artifacts

---

## 📦 Step 4: Update Package Files (Optional)

### Add to package.json (for npm listing)
Currently the package.json doesn't have an icon field, but npm does show 
README images. Your logo in the README will show on npmjs.com automatically.

If you want to add it explicitly:
```json
{
  "icon": "./assets/logo.png"
}
```

### Update .gitignore Check
Make sure these files are NOT ignored:
```bash
# Check if images are ignored
git check-ignore assets/logo.svg
git check-ignore web/assets/images/favicon.ico

# If they're ignored, update .gitignore
```

---

## 🎨 Step 5: Dark Mode Version (Future)

When you want to add dark mode support:

1. Generate white version: Same logo but white (#ffffff) on transparent
2. Save as `logo-dark.svg` and `icon-dark.svg`
3. Update HTML to use `prefers-color-scheme`:

```html
<link rel="icon" href="/assets/images/icon.svg" 
      media="(prefers-color-scheme: light)">
<link rel="icon" href="/assets/images/icon-dark.svg" 
      media="(prefers-color-scheme: dark)">
```

---

## 📝 Quick Start Summary

**Absolute minimum to ship:**

1. Generate 2 files with Gemini:
   - `logo.svg` (full logo with text)
   - `icon.svg` (icon only)

2. Convert icon to PNGs using https://svgtopng.com/:
   - Export at 16, 32, 192, 512 px

3. Convert to .ico using https://favicon.io/

4. Place files in the directories shown above

5. Commit and push!

Everything is already wired up and ready to display your logo! 🎉

---

## 🐛 Troubleshooting

### Logo not showing in README
- Check file path: `./assets/logo.svg` (relative to README location)
- Verify file exists: `ls packages/workrail/assets/logo.svg`
- Try PNG instead: Change README to use `logo.png` if SVG has issues

### Favicon not showing in browser
- Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)
- Clear cache
- Check browser console for 404 errors
- Verify file path: `/assets/images/favicon.ico`

### Logo looks blurry
- Make sure you're using SVG for scalable graphics
- PNGs should be high-res (2x actual size)
- Check that transparent background is preserved

### File too large
- Optimize SVG: Use https://jakearchibald.github.io/svgomg/
- Compress PNG: Use https://tinypng.com/
- Target sizes: SVG < 50KB, PNGs < 100KB

---

## ✨ Done!

Once you've added the files, your logo will appear:
- ✅ At the top of your README (GitHub, npm)
- ✅ In browser tabs (favicon)
- ✅ As app icon on mobile (PWA)
- ✅ In social media previews

Questions? See `LOGO_GENERATION_GUIDE.md` for more details!

