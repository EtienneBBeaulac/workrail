# Card Animation Architecture

## Overview
This document describes the final, working approach for card entrance and highlight animations in the bug investigation dashboard.

## Key Principles

1. **No Global Animations on Base Classes**
   - Base classes like `.card` should NOT have `animation` properties
   - Global animations get retriggered by any DOM manipulation
   - Use specific animation classes instead

2. **Dedicated Animation Classes**
   - `.new-section` - For entrance animations (slideInFade)
   - `.card-flash` - For scroll-to-card highlight (outline pulse)
   
3. **Non-Conflicting Properties**
   - Entrance uses: `opacity` + `transform: translateY()`
   - Flash uses: `outline` + `outline-offset`
   - These properties don't conflict with each other or base styles

## Implementation Details

### Entrance Animation (`.new-section`)

**When it's added:**
```javascript
// Only when card is first created
if (!card) {
  card = createElement(...);
  card.classList.add('new-section');
  card.dataset.animated = 'false';
}
```

**When it's removed:**
```javascript
// After 450ms (animation is 400ms)
setTimeout(() => {
  card.classList.remove('new-section');
  card.dataset.animated = 'true';
}, 450);
```

**CSS:**
```css
.new-section {
    animation: slideInFade 400ms ease-out;
}

@keyframes slideInFade {
    from {
        opacity: 0;
        transform: translateY(20px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}
```

### Flash Animation (`.card-flash`)

**When it's added:**
```javascript
// When user clicks "View Root Cause Details" etc.
function scrollToCard(cardId) {
  // ... scroll logic ...
  
  // Only flash if entrance animation is done
  if (card.dataset.animated === 'true') {
    card.classList.remove('card-flash'); // Clean slate
    
    requestAnimationFrame(() => {
      card.classList.add('card-flash');
      
      setTimeout(() => {
        card.classList.remove('card-flash');
      }, 2000);
    });
  }
}
```

**CSS:**
```css
.card-flash {
    animation: cardFlash 2s ease-out;
}

@keyframes cardFlash {
    0%, 100% { 
        outline: 0px solid transparent;
        outline-offset: 0px;
    }
    10%, 30% { 
        outline: 3px solid var(--primary-color);
        outline-offset: 2px;
    }
}
```

**Why `outline` instead of `box-shadow` or `border`?**
- Doesn't conflict with existing `box-shadow` on `.card-highlight`
- Doesn't affect layout (no reflow)
- Drawn outside the element (with offset for visual appeal)
- Not affected by `.card { transition: all }` rule

## State Tracking

### `dataset.animated`

Used to prevent race conditions between entrance and flash animations:

- `'false'` - Card is currently playing entrance animation
- `'true'` - Card entrance is complete, safe to flash

**Why needed?**
If user clicks "View Details" immediately after page load, we need to wait for the entrance animation to complete before starting the flash animation.

## Scroll Offset

**CSS Variable:**
```css
:root {
    --scroll-padding: 100px; /* header height + visual padding */
}
```

**JavaScript:**
```javascript
const scrollPadding = parseInt(
  getComputedStyle(document.documentElement)
    .getPropertyValue('--scroll-padding')
) || 100;
```

**Why?**
Ensures scrolled card appears below the sticky header with comfortable padding.

## Common Pitfalls (Avoid These!)

### ❌ Global Animation on `.card`
```css
/* DON'T DO THIS */
.card {
    animation: fadeIn 0.3s ease-out;
}
```
**Problem:** Gets retriggered by any class add/remove operation.

### ❌ Using `box-shadow` for Flash
```css
/* DON'T DO THIS */
@keyframes cardFlash {
    box-shadow: 0 0 0 3px blue;
}
```
**Problem:** Conflicts with existing `.card-highlight { box-shadow: ... }` and triggers transitions.

### ❌ Using `void card.offsetWidth` for Reflows
```javascript
/* DON'T DO THIS */
card.classList.remove('card-flash');
void card.offsetWidth; // Force reflow
card.classList.add('card-flash');
```
**Problem:** Aggressive reflows can cause visual artifacts and performance issues. Use `requestAnimationFrame` instead.

### ❌ `transition: none !important` Hacks
```css
/* DON'T DO THIS */
.card-flash {
    transition: none !important;
}
```
**Problem:** Bandaid that doesn't address root cause. Fix the animation conflict instead.

## Testing Checklist

- [ ] Fresh page load - cards slide in smoothly, no extra flashes
- [ ] Click "View Root Cause Details" - smooth scroll, purple outline pulse
- [ ] No jump or replay of entrance animation after flash completes
- [ ] Double-click button - graceful handling, no visual glitches
- [ ] Multiple cards - all animations independent, no conflicts

## Future Enhancements

If adding new card animations:
1. Use a dedicated class (e.g., `.card-pulse`, `.card-bounce`)
2. Choose properties that don't conflict with existing styles
3. Test with entrance and flash animations active
4. Document the new animation here

