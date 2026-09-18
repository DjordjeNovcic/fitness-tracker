---
name: Fit Tracker
description: Earthy sage-green nutrition & training PWA that turns gold-luxe graphite at night
colors:
  bg: "#efe9dd"
  bg-strong: "#e1d9ca"
  surface-elevated: "#ffffff"
  ink: "#17201d"
  muted: "#5d6963"
  line: "rgba(24, 33, 30, 0.085)"
  accent: "#1f5f75"
  accent-strong: "#164757"
  accent-soft: "#dbe9ef"
  secondary: "#2b6d7d"
  teal: "#2b6d7d"
  clay: "#efe2d6"
  bar-ok: "linear-gradient(90deg, #27738c 0%, #4fa3bd 100%)"
  bar-near: "linear-gradient(90deg, #e0a83a 0%, #cf8a26 100%)"
  bar-over: "linear-gradient(90deg, #df7a48 0%, #c8442c 100%)"
  status-warning-text: "#72571b"
  status-error-text: "#7a4e38"
typography:
  display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "clamp(3.2rem, 13vw, 4.2rem)"
    fontWeight: 600
    lineHeight: 1
  headline:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
  body:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
  label:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 700
rounded:
  sm: "14px"
  md: "20px"
  lg: "24px"
  xl: "32px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#fbf8ef"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-secondary:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-ghost:
    backgroundColor: "rgba(255, 251, 245, 0.98)"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
---

# Design System: Fit Tracker

## 1. Overview

**Creative North Star: "The Grounded Ledger"**

Fit Tracker reads like a well-kept paper food-and-training journal that happens to be digital: warm cream-and-clay paper tones, a serif hand for the numbers that matter, restrained sage green doing the work of meaning (not decoration). By night it doesn't just invert to a generic dark theme — it becomes a different, deliberately premium object: warm graphite with a single gold thread running through it, like a journal bound in better material after dark. The system explicitly rejects the two things this category defaults to: neon/gamified fitness-app cheer, and flat corporate-SaaS blue-on-white. It also rejects the easy "just tint dark mode green" answer — twice rejected by the user in favor of the gold register.

**Key Characteristics:**
- One hero number per screen (the calorie ring), everything else recedes
- Flat, hairline-divided rows over boxed cards — nesting is capped at ~2 levels
- Color is semantic (macro/goal state), never decorative filler
- Light and dark are not the same palette inverted — they are two different moods on one structure

## 2. Colors

The palette is a single warm neutral family (paper cream in light, graphite in dark) carrying one accent hue that itself changes identity between modes.

### Primary
- **Petrol** (`#1f5f75`, `--accent`): primary CTAs, active nav marker, "ok" progress-bar state, single hero numerals in light mode. In dark mode the same role is carried by **Steel Blue** (`oklch(0.76 0.09 231)`). Chosen 2026-09-18 over the previous pine-green/gold pair: a cool accent on a warm ground, and — unlike gold or copper — it can never be confused with the amber/red "near / over budget" status colours.

### Secondary
- **Deep Teal-Blue** (`#2b6d7d`, `--secondary` / `--teal`): secondary buttons, "target"-kind macro bars (protein) when under goal, informational pills.

### Named Rule: accent discipline
One accent moment per region — active navigation, the primary action, and progress/status. Repeated figures in a list (food kcal, per-serving recipe kcal, streak counts in rows) are **ink**, not accent; only a single hero number per card takes the accent. Before this rule a food list showed 87 accent-coloured numbers and nothing read as important.

### Neutral
- **Paper Cream** (`#efe9dd`, `--bg`) / **Deeper Clay** (`#e1d9ca`, `--bg-strong`): page background — deliberately darker than any card so cards visibly float (elevation ladder). The page itself is one clean vertical gradient (`#f4efe6 → #ebe3d6`); the old radial colour blobs on the page and on cards are gone (2026-09-17, direction "B").
- **Warm White** (`#ffffff`, `--surface-elevated`) and translucent cream surfaces (`--surface`, `--surface-panel` at 88-96% opacity): card backgrounds.
- **Deep Ink** (`#17201d`, `--ink`): primary text. **Soft Sage-Grey** (`#65716c`, `--muted`): secondary text.
- **Hairline** (`rgba(24,33,30,0.085)`, `--line`): all dividers — never a boxed border.
- In dark mode the neutral family is a four-level graphite ladder (2026-09-17): page `#0d0c0a` → chrome (sidebar, tab bar) `#100e0b` → sections/cards `#181511` → nested rows, empty states, inputs `#1e1a15`, with dialogs/toasts one step higher at `#24201a`. Dividers are neutral white hairlines (`rgba(255,255,255,0.08)` / `0.12`), ink `#f2ede5`, muted `#a69f95`. Separation between levels is tonal plus a hairline — no white "sheen" gradients, no stacked shadows.

### Named Rules
**The One-Accent Rule.** Both themes carry exactly one brand accent — petrol blue in light, steel blue in dark. Green survives only as the semantic success colour (`--status-success-*`, the consistency heatmap, "on target" pills); amber and red stay reserved for "near" and "over". No third brand hue.

**The Semantic-Only Rule.** Color is never applied to a surface just to add visual interest. Every non-neutral color maps to a state: `ok`/`near`/`over` macro status, success/info/warning/error pills, or the one permitted brand accent. If a color can't name the state it represents, it shouldn't be there.

## 3. Typography

**Display Font:** Fraunces (with Georgia, serif fallback)
**Body Font:** Manrope, with a system-first stack (`-apple-system`, SF Pro Text) so iOS renders native SF Pro and Manrope is the fallback, not the default

**Character:** A serif with warmth and a little editorial weight for the numbers that matter, paired with a body sans that gets out of the way and feels native on-device rather than "webby."

### Hierarchy
Fraunces appears in exactly two places per screen: the hero number (calorie ring, goal kcal, onboarding kcal) and the page title (`Danas`, `Hrana`, the account name). Everything else — section headings, collapsible titles, meal and recipe kcal, macro values — is Manrope. Chosen 2026-09-17 ("B — dorada") over keeping serif on every heading (A) and over an all-sans rebrand (C).
- **Display** (Fraunces 600, `clamp(3.2rem, 13vw, 4.2rem)`, line-height 1): the remaining-calories ring number only — the one hero number per screen.
- **Page title** (Fraunces 700, `1.375–1.5rem`): the tab/page `h1`.
- **Section heading** (Manrope 700, `1.0625rem`, letter-spacing −0.012em): `section-header h2`, disclosure titles, collapsible `<details>` titles.
- **Figures** (Manrope 700–800, tabular-nums): meal totals, recipe kcal, macro values, streak counts.
- **Body** (500, `1rem`): all running text, form labels, list rows.
- **Label** (700, `0.85rem`, often uppercase-tracked): eyebrows, pill labels, macro-grid headers.

### Named Rules
**The One-Hero Rule.** Only one number per screen renders in Fraunda-display scale. Macro values recede to sans, ≤600 weight, never 800 — heavier weights are reserved for the single hero, not for supporting numbers.

## 4. Elevation

Hybrid: mostly flat, tonal-layered surfaces (paper-on-paper via the bg → surface → surface-elevated ladder) with soft ambient shadows reserved for cards that need to visibly float above the page background — never used to fake a border or separate list rows (those use hairlines instead).

### Shadow Vocabulary
- **shadow-tight** (`0 10px 22px rgba(25,34,31,0.055)`): small floating elements (chips, compact controls).
- **shadow-card** (`0 18px 34px rgba(25,34,31,0.075)`): standard card elevation.
- **shadow-soft** (`0 18px 40px rgba(25,34,31,0.085)`): larger panels.
- **shadow** (`0 28px 70px rgba(22,32,29,0.12)`): hero-level elevation (the calorie ring card, modals).

### Named Rules
**The Hairline-Not-Border Rule.** Rows within a list (meal entries, routine rows) are separated by a 1px hairline (`--line`) with no surrounding box — a bordered/boxed row inside an already-elevated card is the nesting violation this system explicitly avoids.

## 5. Components

### Buttons
- **Shape:** 15px radius (`--radius-sm`), consistent across all button variants.
- **Primary:** petrol vertical gradient (`linear-gradient(180deg, #27738c, #1f5f75)`) in light / gold gradient in dark, cream/graphite text, 800 font-weight, `10px 16px` padding, soft ambient shadow + inset highlight for a slightly tactile (not flat) press-feel.
- **Secondary:** olive gradient, same shape/weight as primary — used when a screen needs two calls to action without implying a hierarchy the copy doesn't support.
- **Ghost:** near-white translucent background, ink text, hairline border — the default for dismiss/cancel/"manage" actions.
- **Danger:** pale clay/cream background with a warm brown text/border (not a saturated red) — deliberately quiet, reserved for destructive actions that already get a confirming undo-toast.
- **Hover/Focus/Active:** spring scale-down on `:active` (`cubic-bezier(0.34, 1.56, 0.64, 1)`), gated behind `prefers-reduced-motion`.

### Chips / Pills
- **Style:** `--pill-bg` translucent cream fill, hairline border, fully rounded.
- **State:** a distinct `pill-strong` (accent-soft tinted) variant for selected/emphasized pills, `pill-note` (olive-tinted) for secondary annotations.

### Cards / Containers
- **Corner Style:** 20-32px radius depending on hierarchy level (`--radius-md`/`--radius-lg`/`--radius-xl` — bigger radius for bigger, more hero-like containers).
- **Background:** translucent warm-cream surfaces layered over the page bg (opaque white gradient overlays in a few major cards — these must be explicitly overridden per-token in dark mode, not just relying on CSS variable swap).
- **Shadow Strategy:** see Elevation — cards get shadow, contained rows get hairlines only, never both.
- **Internal Padding:** generous (component-dependent, roughly 16-28px) — flattened forms (e.g. the food-editor card) go to `padding: 0` deliberately and must disable any decorative top-stripe `::before` when doing so.

### Inputs / Fields
- **Style:** hairline border, cream/elevated-surface background, 15px radius to match buttons.
- **Focus:** border/ring shift toward accent color, no glow-blur effect.

### Navigation
- **Mobile (< 900px):** frosted-glass fixed bottom tab bar, 4 primary tabs + a "Više" (more) button; the active tab shows a soft accent capsule behind its icon (never a dot or underline). Secondary tabs and account actions live in a compact anchored sheet (`renderMoreSheet`), not a full-screen slide-out.
- **Desktop (≥ 900px):** persistent left sidebar replaces the tab bar entirely.

### Calorie Ring (signature component)
A circular Oura/Apple-style progress ring is the one memorable focal point of the whole app: remaining kcal centered in Fraunces display, eaten/goal + percentage below, ring color tracking the ok/near/over semantic state. On tab-entry it does a one-shot count-up animation (reduced-motion safe). This is the component every other screen's hierarchy defers to.

## 6. Do's and Don'ts

### Do:
- **Do** keep light and dark as two distinct moods on one structure — sage/clay by day, warm-graphite/gold by night — not one palette with inverted lightness.
- **Do** use hairlines (`--line`) to separate rows inside a card; reserve shadows for the card boundary itself.
- **Do** map every non-neutral color to a semantic state (macro ok/near/over, status success/info/warning/error, or the one brand accent).
- **Do** keep exactly one Fraunces-display-scale hero number per screen.
- **Do** gate all motion behind `prefers-reduced-motion`.

### Don't:
- **Don't** introduce neon accents, badge/confetti gamification, or flat corporate-SaaS blue — the explicit category anti-reference for this product.
- **Don't** introduce a second brand hue. Steel blue is the only dark-mode accent and petrol the only light-mode one; green appears solely as the success status colour.
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent stripe on any card, row, or callout — an absolute, already-established ban in this codebase.
- **Don't** nest a card inside a card, or box a list row that already lives inside an elevated container.
- **Don't** use gradient text, glassmorphism as decoration, or the generic hero-metric-template layout (big number + small label + supporting stats + gradient accent) — these are the AI-slop tells this system is built to avoid.
