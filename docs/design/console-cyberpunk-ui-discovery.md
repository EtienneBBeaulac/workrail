# Discovery: Cyberpunk UI Design Language Gap Analysis

**Status:** Complete  
**Date:** 2026-04-05  
**Path:** `landscape_first` -- dominant need is understanding existing patterns and comparing against current state  

---

## Context / Ask

The WorkRail developer console already has a cyberpunk-adjacent aesthetic (dark navy, amber accent, cyan for live states, cut corners, monospace ALL-CAPS labels, blueprint grid). The question is: compared to Cyberpunk 2077 and peer games in the high-tech dystopian genre, what specific visual elements are missing that would make the console feel authentically "cyberpunk" rather than merely "dark developer tool"?

**Desired outcome:** Concrete, implementable CSS/design changes ranked by impact.

**Anti-goals:**
- No full UI rebuild -- changes should layer onto existing foundations
- No game-level visual complexity (the tool must remain readable and functional)
- No decorative noise that impairs information density

---

## Landscape Packet

### Cyberpunk 2077 UI Design Language (CD Projekt Red, 2020-2023)

CD Projekt RED's art director on the UI, Filipe Duarte Pinto, described the design as "brutalist constructivism meets tech noir" -- a system that feels like it was designed by a corporation that no longer cares if you understand it.

#### Color Palette -- Precise Usage

CP2077 does NOT use amber/yellow everywhere uniformly. The palette has strict role separation:

| Color | Hex approx. | Role |
|---|---|---|
| Yellow-amber | `#f5e642` / `#ffd700` | **Primary interactive** -- buttons, active selections, key data values, your HP bar |
| Bright cyan | `#00e5ff` / `#00d4f0` | **Tech/netrunner** -- Quickhacks menu, scanner overlay, data shard readouts, network topology |
| Hot magenta/pink | `#ff2d78` / `#e91e8c` | **Hostile/danger** -- enemy indicators, Maelstrom gang interfaces, breach protocol threats |
| Desaturated orange | `#c87941` | **Corporate/Militech** -- Arasaka terminals use warm amber-orange, not pure yellow |
| Cold white | `#e8e8f0` | Body text, neutral readouts |
| Deep navy-black | `#0a0d1a` | Primary background -- even darker than our `#0f131f` |
| Mid-dark slate | `#141824` | Secondary panels |

**Key insight the console is missing:** CP2077 uses magenta/pink as the danger/hostile signal. The console's `--blocked` state uses `#ff4444` (pure red), which reads as "error" not "threat." A shift toward hot pink-red would add genre authenticity. More critically, the console uses **no pink/magenta at all** -- this absence makes the palette feel incomplete for the genre.

#### Typography -- Precise Characteristics

CP2077 main UI font: **Rajdhani** (weight 600-700) for headers, **Share Tech Mono** or similar for data readouts.

What makes it distinctive:
- **Extreme tracking on uppercase labels**: `letter-spacing: 0.3em` to `0.5em` on category headers -- much wider than typical UIs
- **Weight contrast is violent**: body text is often Regular (400), while section headers jump straight to Bold (700) or ExtraBold (800) -- no Medium weights in between
- **Number/value fields use tabular lining figures** in a condensed monospace -- values feel like live data instruments
- **Percentages and units are smaller**: a health value shows `78` large, `HP` small and muted beside it -- the value dominates, the unit is secondary
- **Slash separators between metadata**: `THREAT // MEDIUM` or `DMG / 47-62` -- double-slash is a CP2077 signature
- **ALL CAPS is selective**: body text is mixed case; only labels, categories, and system-level identifiers are ALL CAPS

The console already does ALL-CAPS labels with tracking. **What's missing:**
- The tracking is not aggressive enough (currently `tracking-[0.18em]`, should push to `0.28-0.40em` for label text)
- No aggressive weight contrast (no ExtraBold/800 weight on key values)
- No `//` separator pattern in metadata chips

#### Shape Language

1. **Clip paths everywhere, not just corners**: CP2077 uses clip-path cuts on all four corners, on progress bars, on text input fields, on dialog boxes. The cut is not always top-left -- it rotates. The console clips top-left only.

2. **Parallel diagonal lines as decorative elements**: Groups of 3-4 parallel diagonal lines (45 degrees) fill dead space in corners or beside progress bars. Pure decoration.

3. **Chevron separators `>>`**: Used as breadcrumb and section dividers in the game's menu system. More genre-specific than a `|` or `/`.

4. **Bracket notation `[ ]` around values**: Status values in CP2077 are often wrapped in square brackets -- `[HOSTILE]`, `[ONLINE]`, `[LOCKED]`. The console uses plain text or colored pills.

5. **Horizontal scan-line rule**: A thin horizontal rule that "scans" across a panel on load (an animated line that sweeps downward once, then holds). Used as a panel initialization signal.

6. **Diamond bullet points `◆`**: Instead of round dots, section bullets and list markers use filled diamonds.

#### Texture and Noise

1. **Scanlines overlay**: A repeating `linear-gradient` pattern of 1px semi-transparent dark lines every 2-3px, at ~3-5% opacity. Covers the entire UI or individual panels. CP2077 is subtle -- not retro-CRT heavy. This is the single most impactful "cheap" texture effect.

2. **Chromatic aberration on hover/glitch**: On state transitions (entering combat, taking damage), text and borders briefly show a 1-2px RGB channel separation -- a red ghost to the left, blue to the right. Implementable with `filter: blur(0.3px)` + pseudo-elements with `mix-blend-mode: screen`. Should be reserved for state changes only (not ambient).

3. **Noise grain texture**: A subtle SVG noise filter or `background-image: url(noise.svg)` at 2-4% opacity over dark backgrounds. Prevents the backgrounds from being "flat digital" -- they feel like worn surfaces.

4. **Vignette**: Radial gradient darkening at screen edges, extremely subtle (5-8% opacity dark overlay). Creates a sense of depth and focus on center content.

5. **Panel edge highlight**: A 1px highlight along the top edge of panels (`border-top: 1px solid rgba(255,255,255,0.06)`), simulating a light source from above. The console uses uniform border color on all sides.

#### Animation Patterns

1. **Text reveal / data-stream animation**: When a panel or value loads, characters are revealed character-by-character from left to right at ~40ms/char, or with a "scramble" effect where random characters precede the final value. This is ubiquitous in cyberpunk UIs (also: Deus Ex, Horizon, Alien: Isolation).

2. **Loading state: "scanning" bar**: Instead of a spinner, loading states use a horizontal bar that sweeps left-to-right repeatedly, with a trailing glow. The console shows static text "Loading sessions..."

3. **Wipe transitions**: Panel content transitions use a horizontal wipe (clip-path expanding from left) rather than opacity fade. This is the genre norm.

4. **Subtle flicker on appear**: On mount, elements briefly flicker (two rapid opacity 1->0->1 cycles in ~80ms total) simulating analog power-on. The console has no mount animation.

5. **Data pulse**: Key numeric values pulse their glow once every few seconds, as if sampling a live feed.

6. **Glitch frames**: Very rarely (1-2% chance per session), a horizontal strip of the UI shifts by 3-5px horizontally for a single frame (16ms), then corrects. Called a "glitch frame." In CP2077 this is tied to save/load transitions.

#### Information Density and Layout Patterns

1. **"Instrument cluster" layout for stats**: Groups of 3-4 metrics arranged in a compact horizontal band with separators between them, like a car dashboard. The console's metadata chips are close but use rounded pills (soft) rather than tight rectangular strips (hard).

2. **Progress bars instead of badge pills for numeric states**: Health, progress, completion -- all use thin (3-4px tall) horizontal bars with a flat fill, not rounded badges.

3. **Side-rule ticks on scales**: Numeric ranges (1-10) use small vertical tick marks on a horizontal axis. Not seen in console at all.

4. **"UPLINK ESTABLISHED" / status broadcast messages**: Temporary banner-style messages that slide in from an edge, display 2-3 seconds, then animate out. Used for system state changes. The console has no transient notification system.

5. **Hierarchical ID prefixes**: Data identifiers include a prefix/namespace visible in the UI -- `[NET::] 192.168.0.1`, `[SYS::] kernel_v2`. Our session IDs are plain UUIDs displayed mono with no visual hierarchy or namespace prefix.

#### Border and Frame Treatments

1. **Double-line borders**: Some CP2077 panels use a thin outer border + a slightly brighter inner border, 1-2px apart. Creates a "framed CRT screen" feel.

2. **Corner brackets instead of full borders**: Some UI elements show only the four corners (L-shaped line segments, ~8-12px long) rather than a full border rectangle. This is lighter and more distinctive than a full border.

3. **Border that's part amber, part cyan**: For "active" panels, the border color cycles around the perimeter -- top and left edges use the accent color, bottom and right use a muted version. Or: the current-node highlight uses an amber top border + transparent side/bottom.

4. **Dashed or dotted segments on inactive borders**: Elements that are "ready but not selected" use `border-style: dashed` with large `border-dash-gap`. Active/selected elements flip to solid.

5. **Diagonal corner mark in the opposite corner from the cut**: The top-left cut is balanced by a small accent-colored corner bracket in the bottom-right. The console has no such counterpoint.

#### Icon and Symbol Vocabulary

1. **Circuit trace decorations**: SVG paths that look like PCB traces -- right-angle lines that end in small filled squares. Used as spacers and borders between sections.

2. **Hexagonal frames for avatars / entity icons**: The game wraps profile pics and faction icons in a hexagonal clip-path with a glowing border. The console has round and square shapes only.

3. **Warning triangle with internal grid**: Hazard icons have a triangular outer shape filled with a 3x3 grid of small squares. Different from a generic `⚠`.

4. **Signal strength / network topology icons**: Small icon language showing bars (like wifi/cellular) to indicate connection quality or data flow. The console's branch/graph chips use GitHub-style SVG icons.

5. **Corporate logo watermarks**: Lightly watermarked faction logos appear in panel corners at 3-5% opacity. For the console: a faint WorkRail logomark in the corner of key panels would translate this idiom.

---

### Comparable Games: UI Design Language Survey

#### Deus Ex: Human Revolution / Mankind Divided (Eidos-Montreal, 2011/2016)

**Designer:** Jonathan Jacques-Belletête (Art Director)

**Signature characteristics:**
- **Golden amber + black** -- even more committed to amber than CP2077. The amber is darker and more bronze: `#c8860a` to `#e8a010`. No cyan at all in the base palette.
- **Hexagonal geometry everywhere**: HUD elements, menu borders, loading screens, objective markers. The hexagon is a modular grid unit.
- **"Sarif Industries" tech aesthetic**: Corporate, premium, not street-level. UI feels engineered, not hacked.
- **Flat fills with sharp edges**: No gradients. Fills are solid -- either opaque or 0. The "layer" effect comes from overlapping flat shapes.
- **Animated amber glow on focus**: Selected items emit a directional amber glow, not a radial one. The glow bleeds toward the reading direction (left-to-right).
- **Typography: Orbitron / Eurostile**: Geometric, slightly condensed. Heavier on headers than CP2077.

**What the console could borrow:**
- The hex grid as a background or section divider element
- The directional glow (glow that bleeds left from a selected item, not radial from center)
- Bronze-amber as a variant of the current `#f4c430` -- the console's amber is slightly too yellow/bright; darkening to `#daa018` would feel more Deus Ex / premium

#### Observer (Bloober Team, 2017)

**Signature characteristics:**
- **VHS/CRT texture as primary aesthetic**: Heavy scanlines, interlacing artifacts, color bleed. More distorted than CP2077.
- **Green phosphor as accent**: Instead of amber, uses `#00ff41` matrix-green for system data.
- **Horror-tech fusion**: UI elements degrade when in disturbing areas -- borders corrupt, text fragments.
- **Hand-drawn elements mixed with digital**: Annotations and post-it notes overlaid on clean digital UI.

**What the console could borrow:**
- The idea of **UI degradation as state signal** (a session with `blocked` status could apply heavier noise/glitch treatment)

#### Ghostrunner (One More Level, 2020)

**Signature characteristics:**
- **Cyan + white on black**: Very limited palette. The one accent color (cyan) is used for everything interactive.
- **Minimal, speed-optimized UI**: Almost no HUD during play. When UI appears it's instant-on with sharp wipe animation.
- **Katakana/Japanese character sets as decoration**: Mixed into purely decorative contexts (not meaningful). Gives a Blade Runner 2049 atmosphere.
- **No borders -- only cuts and clips**: Shapes are defined by their clip-path, not by borders. Backgrounds clip against each other.

**What the console could borrow:**
- Using clip-paths as the sole shape definer for some elements (no visible border, just background color clipped to shape)
- Decorative unicode or character-set elements (would need careful restraint in a developer tool)

#### Horizon Zero Dawn / Forbidden West (Guerrilla Games, 2017/2022)

**Signature characteristics:**
- **Teal + orange**: Complementary pair, consistent with nature/tech fusion theme.
- **Holographic projection aesthetic**: UI elements appear as floating light projections -- translucent, with visible "projection edges."
- **Organic shapes mixed with angular**: Unlike pure cyberpunk, Horizon's UI has some curved paths.
- **"Focus" device aesthetic**: The in-universe interface device explains the UI's appearance -- tribal markings meeting tech.

**What the console could borrow:**
- The translucent panel aesthetic: panels have background-color at 60-70% opacity + backdrop-filter blur, creating "frosted hologram" depth

#### Dead Space (Visceral Games, 2008)

**Signature characteristics:**
- **All UI is diegetic**: Health bar on Isaac's back, ammo in the gun. Nothing on-screen that isn't "in world."
- **Red as primary danger signal**: Deep red for critical health, not just for error states.
- **Ultra-minimal information**: If it can be removed, it is. Every remaining element is load-bearing.
- **Sound design does UI work**: Audio stingers replace visual notifications for most events.

**What the console could borrow:**
- The "if it can be removed, it should" discipline -- some current UI chrome could be stripped

---

### Common Patterns Across All Genre UIs

1. **Color serves semantic roles, not aesthetic ones**: Every color signals a specific system-state. There is no decorative color usage.

2. **Scanlines or noise texture at low opacity**: Every one of these games uses some form of analog texture to break up flat digital surfaces. This is the single most cross-cutting element.

3. **Aggressive typography contrast**: Large values, tiny labels, no medium sizes. The jump is always large -> tiny, never large -> medium.

4. **Cut/clipped geometry over border-radius**: None of these games use rounded corners. All use clips, cuts, hex shapes, or squared edges.

5. **Animation as state signal**: Animations are purposeful and tied to state changes (power-on, data-load, error, threat-increase). They are not ambient decoration.

6. **Bracket / frame notation for status strings**: `[ONLINE]`, `[HOSTILE]`, `[LOCKED]` -- text status values are wrapped in bracket notation.

7. **Monospace for all data/values**: Even non-numeric data (IDs, names of system entities) uses monospace in these UIs. It signals "this is system data, not human prose."

8. **Horizontal progress indicators over circular**: Loading rings and spinners are rare. Horizontal sweeping bars are the genre norm.

---

## Problem Frame Packet

**Users:** Developer using WorkRail console to monitor and interact with AI agent workflows.

**Jobs / outcomes:** Read session status at a glance, navigate to sessions and steps efficiently, feel trust in the system (the aesthetic communicates "this is a real system, not a prototype").

**Tensions:**
- Cyberpunk UI elements like heavy glitch/scanlines can impair readability for dense text
- Animation (text scramble, flicker) has accessibility implications
- Over-theming risks making the tool feel like a gimmick

**Success criteria:** A developer who opens the console thinks "this was designed deliberately" -- not "someone threw dark mode on a generic UI."

**Assumptions:** Changes are CSS/component additions, not a full rebuild.

---

## Gap Analysis: What the Current Console Is Missing

Ranked by estimated authenticity-impact vs. implementation cost.

### Tier 1: Highest Impact, Low Cost (1-4 hours each)

#### 1. Scanlines texture overlay
**What:** A `::before` pseudo-element on the root layout covering the full viewport with a repeating gradient:
```css
background-image: repeating-linear-gradient(
  transparent,
  transparent 2px,
  rgba(0, 0, 0, 0.03) 2px,
  rgba(0, 0, 0, 0.03) 3px
);
```
Set `pointer-events: none; position: fixed; inset: 0; z-index: 9999`.

**Impact:** This single change makes a flat dark UI feel like it exists in a physical medium. All 5 surveyed games use this.

**Current state:** No scanlines. Backgrounds are perfectly flat.

---

#### 2. Letter-spacing on labels pushed to genre-standard
**What:** The current `tracking-[0.18em]` is modest. Genre standard is `0.28em` to `0.40em` for all-caps label text.

CSS change: Update all instances of `font-mono text-[10px] uppercase tracking-[0.18em]` to `tracking-[0.30em]`.

**Impact:** Immediately more CP2077-like. No visual structure changes, pure typography.

**Current state:** `tracking-[0.18em]` -- correct direction but undershooting.

---

#### 3. `//` separator in metadata chips
**What:** The chip component currently renders `{children}` as plain text. Metadata combinations like `"wr.discovery · 12 steps"` should render as `"wr.discovery // 12 steps"` -- the double-slash is a CP2077 signature separator that instantly telegraphs the genre.

Also applies to breadcrumbs (currently `Workflows / Tag` -- should be `WORKFLOWS // TAG`).

**Current state:** Uses `·` (middle dot) or `/` separators.

---

#### 4. Corner brackets instead of full borders on some elements
**What:** The `CutCornerBox` component gives a full clipped border. An additional variant (or wrapper utility class) shows only the four corner segments -- L-shaped lines of 8-10px length. This is lighter, more distinctive, and very CP2077.

```css
.corner-frame {
  position: relative;
}
.corner-frame::before,
.corner-frame::after {
  content: '';
  position: absolute;
  width: 10px;
  height: 10px;
  border-color: var(--accent);
  border-style: solid;
}
.corner-frame::before {
  top: 0; left: 0;
  border-width: 1px 0 0 1px;
}
.corner-frame::after {
  bottom: 0; right: 0;
  border-width: 0 1px 1px 0;
}
```

The top-left cut corner handles one corner; the `::after` handles the bottom-right; two additional pseudo-elements (or children) handle the other two. This creates the "floating bracket" look.

**Current state:** Either full border or the cut-corner box (also full border). No corner-bracket variant.

---

#### 5. Bracket notation for status values
**What:** The `StatusBadge` component renders "In Progress", "Dormant", etc. as rounded pills. Replace with bracket-wrapped ALL CAPS: `[ IN PROGRESS ]`, `[ DORMANT ]`, `[ BLOCKED ]`.

Visual: `font-mono`, no background fill, bracket characters in accent color, status text in accent color, tight padding.

This removes the `rounded` class and the background fill -- the brackets do the visual work instead.

**Current state:** Rounded pill with background fill. Reads as "modern SaaS" not "cyberpunk terminal."

---

### Tier 2: Medium Impact, Medium Cost (half-day to full-day each)

#### 6. Loading state: horizontal sweep bar
**What:** Replace "Loading sessions..." text with an animated horizontal bar that sweeps left-to-right.

```css
@keyframes scan-sweep {
  from { transform: translateX(-100%); }
  to   { transform: translateX(400%); }
}
.loading-sweep {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: scan-sweep 1.2s ease-in-out infinite;
}
```

**Current state:** Static text. Generic.

---

#### 7. Panel-on mount flicker animation
**What:** When a panel or list appears, apply a brief flicker (rapid opacity cycle):

```css
@keyframes panel-on {
  0%   { opacity: 0; }
  20%  { opacity: 0.8; }
  25%  { opacity: 0.2; }
  30%  { opacity: 1; }
  100% { opacity: 1; }
}
```
Duration: ~180ms. Applied via a class added on mount and removed afterward.

**Current state:** No mount animation. Content appears instantly (or with Tailwind transitions that are gentle fades).

---

#### 8. Noise grain texture on panel backgrounds
**What:** Add an SVG turbulence filter or a 64x64 noise tile at 2-3% opacity over `--bg-card` panels.

Simplest implementation: base64-encoded PNG noise tile as a data URI in CSS, applied to `.bg-[var(--bg-card)]` at `opacity: 0.03`:

```css
.bg-card-panel {
  background-image: url("data:image/png;base64,...[noise_tile]...");
  background-repeat: repeat;
}
```

**Current state:** Flat solid backgrounds. Feels "digital perfect" rather than "worn tech."

---

#### 9. Text data-stream reveal on panel open
**What:** When a session card or detail panel loads, text content reveals character-by-character. Implementable with a short JS animation (~30ms/char for title text only -- not body content) using `textContent` slice + `requestAnimationFrame`.

Alternatively: a simpler CSS approach -- text starts at full opacity but in a "scramble" state (mix of current chars and random placeholder chars), then resolves over 300ms.

**Current state:** Text appears instantly with no character-level animation.

---

#### 10. Status color: blocked/threat to pink-magenta
**What:** Change `--blocked: #ff4444` to `--blocked: #ff2070`.

`#ff2070` reads as "hostile/threat" in the CP2077 idiom. Pure red `#ff4444` reads as "error" -- a different semantic. Blocked workflows are not errors, they are threats to progress.

Also introduce `--hostile: #e91e8c` as a new semantic token for the most severe state (currently absent from the palette).

**Current state:** `--blocked: #ff4444` (pure red). No pink/magenta in the palette at all.

---

### Tier 3: Higher Cost, High Authenticity (multi-day)

#### 11. Progress bars replacing pill badges for numeric values
**What:** The "N nodes / E edges" chip and the node count would be more genre-authentic as thin horizontal bars showing relative fill rather than text chips.

```jsx
<div className="flex items-center gap-1.5">
  <span className="font-mono text-[9px] text-[var(--text-muted)]">NODES</span>
  <div className="h-[3px] w-[40px] bg-[var(--bg-secondary)] relative">
    <div style={{ width: `${pct}%` }} className="h-full bg-[var(--accent)]" />
  </div>
  <span className="font-mono text-[10px] tabular-nums text-[var(--text-primary)]">{count}</span>
</div>
```

**Current state:** Text chips with round corners.

---

#### 12. `[ SYS:: ]` namespace prefix on session IDs
**What:** Currently session IDs show as a raw UUID fragment in mono text. Adding a namespace prefix signals that this is an addressable system entity:

`[SYS::] …e7f3a9c2b41d` instead of `…e7f3a9c2b41d`

The `SYS::` prefix in amber, the ID itself in muted mono.

**Current state:** Plain ID string. No namespace visual hierarchy.

---

#### 13. Directed glow from selected state (Deus Ex idiom)
**What:** When a session card is selected/hovered, the glow bleeds to the right (reading direction), not radially outward. Implement with:

```css
.session-card:hover {
  box-shadow: 4px 0 24px rgba(244, 196, 48, 0.2), 0 0 0 1px rgba(244, 196, 48, 0.3);
}
```

The horizontal offset `4px 0` instead of `0 0` creates direction.

**Current state:** Radial `border-color` change on hover. Symmetric.

---

#### 14. Diagonal decorative rule lines in dead panel space
**What:** Panels with empty lower portions (e.g., the workflow description panel when the description is short) could display a group of 3-4 parallel diagonal lines (45-degree hairlines) in the lower-right corner at 4% opacity.

Pure CSS with `linear-gradient` at a 45-degree angle.

**Current state:** Empty space.

---

## Decision Log

### Why `landscape_first` over `full_spectrum`

The problem is well-framed: a specific tool, a specific aesthetic target, a known baseline. There is no risk of "solving the wrong problem" -- the ask is explicit. `full_spectrum` would add reframing steps that produce no additional value here.

### Why this order of priorities

The ranking is: cheapest-per-unit-of-genre-authenticity first. Scanlines and letter-spacing are pure CSS changes touching no components. Bracket notation requires component edits but changes no logic. Progress bars require new components and data shape changes.

### What is intentionally NOT recommended

- **Heavy glitch/chromatic aberration as ambient effect**: These are reserved for state transitions in CP2077, not as constant effects. As ambient effects they impair readability and feel cheap.
- **Replacing the font**: The current `-apple-system` / `Roboto` stack is readable at small sizes. Introducing Rajdhani or Orbitron risks readability regression at 10px label sizes on non-retina displays.
- **Katakana/Japanese decorative characters**: Acceptable in Ghostrunner because combat speed hides the lack of semantic meaning. In a developer tool where text is information, random unicode decorations would confuse more than delight.
- **Audio stingers for state changes**: Dead Space idiom. Not appropriate for a developer tool.

---

## Final Summary

The current console has the right structural bones: the color palette is correct, the cut corners are authentic, the typography direction is right, the grid background is correct. The gaps are primarily in **texture** (no scanlines, no noise, flat surfaces), **animation** (no mount flicker, no sweep loader, no data reveal), **typography weight/spacing** (undershooting letter-spacing), and **symbol vocabulary** (no `//` separators, no bracket notation, no corner-frame variant, no namespace prefixes).

The single highest-leverage change is scanlines. The second is letter-spacing. Together they require under 2 hours and would make the console feel measurably more "in genre." The third is bracket notation for status badges -- this is a component change but a small one, and it eliminates the one element that currently reads as "SaaS app" rather than "cyberpunk terminal."

### Prioritized implementation list

| # | Change | Impact | Cost |
|---|---|---|---|
| 1 | Scanlines texture overlay | Very High | 30 min |
| 2 | Letter-spacing 0.18em -> 0.30em on labels | High | 20 min |
| 3 | `//` separators in chips and breadcrumbs | High | 45 min |
| 4 | Corner bracket frames (CSS utility) | High | 1 hr |
| 5 | Bracket notation for StatusBadge | High | 1 hr |
| 6 | Horizontal sweep loader | Medium | 1 hr |
| 7 | Panel mount flicker animation | Medium | 1 hr |
| 8 | Noise grain on panel backgrounds | Medium | 1.5 hr |
| 9 | Data-stream text reveal | Medium | 3 hr |
| 10 | `--blocked` to pink-magenta `#ff2070` | Low-Med | 15 min |
| 11 | Thin progress bars for numeric values | Medium | 3 hr |
| 12 | `[SYS::]` namespace prefix on IDs | Low-Med | 1.5 hr |
| 13 | Directional hover glow (Deus Ex) | Low-Med | 30 min |
| 14 | Diagonal decorative rules in dead space | Low | 1 hr |

**Confidence:** High on items 1-5 (pure CSS or small component changes, low regression risk). Medium on items 6-10 (require testing across all panel types). Lower on items 11-14 (data shape or interaction model changes).

**Residual risk:** Some of these changes (scanlines, noise) degrade on low-DPI displays. Test on a 1080p non-retina screen before shipping opacity values.
