# Animation Bug Postmortem

## Summary
Card entrance and flash animations were being unintentionally retriggered, causing visual glitches (unwanted flashes and "jumps").

## Root Cause
A global CSS rule in `/web/assets/styles.css`:
```css
.card {
    animation: fadeIn 0.3s ease-out;
}
```

This rule applied a `fadeIn` animation to **all cards globally**. Because the `animation` property was always present on the `.card` class, any DOM manipulation (adding/removing classes) caused the browser to re-evaluate styles and **retrigger the animation**.

## Symptoms

### Issue A: Flash After Entrance
1. Card loads with `.new-section` class → `slideInFade` plays
2. After 450ms, `.new-section` is removed
3. Browser detects DOM change, re-evaluates `.card` styles
4. Sees `animation: fadeIn` → **retriggers fadeIn animation** ❌

### Issue B: Jump After Scroll-to-Flash
1. User clicks "View Root Cause Details"
2. `scrollToCard()` adds `.card-flash` → `cardFlash` plays (outline pulse)
3. After 2000ms, `.card-flash` is removed
4. Browser detects DOM change, re-evaluates `.card` styles
5. Sees `animation: fadeIn` → **retriggers fadeIn animation** ❌

## Evidence
Console logs showed:
```
[ANIMATION-EVENT] root-cause-card - animationend: slideInFade
[CARD-ANIM] After removal, classes: card card-expanded card-highlight
[ANIMATION-EVENT] root-cause-card - animationstart: fadeIn  👈 UNEXPECTED
```

And after flash:
```
[ANIMATION-EVENT] root-cause-card - animationend: cardFlash
[SCROLL-TO-CARD] After removal: card card-expanded card-highlight
[ANIMATION-EVENT] root-cause-card - animationstart: fadeIn  👈 UNEXPECTED
```

## Fix
Removed the global animation from `.card` in `/web/assets/styles.css`:
```css
/* Note: Removed global .card animation as it was causing unwanted retriggering
   when card classes changed. Workflow-specific dashboards handle their own
   entrance animations (e.g. .new-section in bug investigation dashboard) */
```

Workflow-specific dashboards (like the bug investigation dashboard) handle their own entrance animations using specific classes like `.new-section`, which is more predictable and doesn't conflict with other DOM manipulations.

## Lessons Learned

1. **Avoid global animation properties on base classes** - They can be retriggered by any DOM change
2. **Use specific animation classes** - Apply animations via dedicated classes (e.g., `.new-section`, `.card-flash`) that are added/removed intentionally
3. **Instrument early** - Comprehensive logging quickly revealed the exact animation sequence
4. **Listen to animation events** - `animationstart` and `animationend` events are invaluable for debugging timing issues

## Testing
After fix:
- ✅ Cards enter with smooth `slideInFade` animation
- ✅ No unwanted flash after entrance animation completes
- ✅ Scroll-to-card shows purple outline pulse
- ✅ No jump/replay of entrance animation after flash
- ✅ All timing is predictable and controlled

