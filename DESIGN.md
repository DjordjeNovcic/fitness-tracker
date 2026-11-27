---
name: Fit Tracker
description: Calm petrol-on-paper nutrition & training PWA (Fit Tracker 2.0), one accent, cool graphite at night
colors:
  bg: "#F4F5F2"
  surface: "#FFFFFF"
  surface-sunken: "#EAF0EF"
  ink: "#182522"
  muted: "#566762"
  line: "#DCE3E0"
  line-strong: "#C6D1CD"
  accent: "#17657A"
  accent-strong: "#10495A"
  accent-soft: "#E1F0F4"
  on-accent: "#FFFFFF"
  block-bg: "#0A4A59"
  block-bg-deep: "#073C49"
  block-ink: "#FFFFFF"
  block-muted: "#B7D1D5"
  macro-protein: "#206448"
  macro-carbs: "#26658F"
  macro-fat: "#8C641B"
  status-success: "#28724F"
  status-warning: "#946515"
  status-error: "#B4443C"
  dark-bg: "#101719"
  dark-surface: "#192326"
  dark-surface-raised: "#243236"
  dark-ink: "#F3F7F5"
  dark-accent: "#74C7DE"
typography:
  hero-number:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "1.75rem (ring) / 2.6rem (goal kcal)"
    fontWeight: 800
    lineHeight: 1
  page-title:
    fontFamily: "Manrope"
    fontSize: "1.875rem"
    fontWeight: 800
  section-heading:
    fontFamily: "Manrope"
    fontSize: "1.125rem"
    fontWeight: 700
  body:
    fontFamily: "Manrope"
    fontSize: "1rem"
    fontWeight: 500
  label:
    fontFamily: "Manrope"
    fontSize: "0.8rem (12px floor)"
    fontWeight: 600-700
rounded:
  sm: "10px"
  md: "14px"
  lg: "20px"
  xl: "26px"
  pill: "999px"
spacing:
  scale: "4 / 8 / 12 / 16 / 20 / 24 (--ft-space-1..6)"
  phone-gutter: "16px"
  desktop-gutter: "24px, content max 1320px"
controls:
  height: "44px (--ft-h-control), 36px small / pills / chips (--ft-h-control-sm), 48px rows"
---

# Design System: Fit Tracker (2.0)

## 1. Overview

**North star: "Calm instrument."** A daily check-in tool used in short, frequent sessions on a phone: log a meal, tick a workout, glance at what is left. The interface is quiet paper (cool off-white, white cards, hairline rows) with exactly one committed colour moment per screen, a deep petrol block that carries the day's key number. Everything else recedes so that block reads first.

Fit Tracker 2.0 (shipped 2026-11-23 → 11-27) replaced the earlier sage/clay + gold-at-night identity and the Fraunces serif. Tokens live in two places in `styles.css`: the `--ft-*` system (phase 1) and the 2.0 palette block that maps roles onto the older variable names (`--bg`, `--accent`, `--block-*`, `--macro-*`, `--status-*`). Later blocks at the end of `styles.css` are numbered phases/passes ("Faza 3", "(5)…(23)") and each starts with a comment saying what it fixes and why.

**Key characteristics**
- One hero number per screen, inside the one petrol block; the rest is calm.
- Flat, hairline-divided rows; never a card inside a card.
- Colour is semantic (macro, ok/near/over, success/warning/error) or the single accent.
- Light and dark share one structure and one accent hue; dark is cool graphite, not an inverted light theme.
- Motion conveys state (ring fills, numbers count, check pops, day slides), always behind `prefers-reduced-motion`.

## 2. Colors

### Neutrals
- **Page** `#F4F5F2` (`--bg`) / dark `#101719`. **Cards** `#FFFFFF` (`--surface`) / dark `#192326`, raised `#243236`. **Sunken** `#EAF0EF` for tracks and skeletons.
- **Ink** `#182522`, **muted** `#566762` (dark `#F3F7F5` / `#B4C3BF`). **Hairline** `#DCE3E0`, strong `#C6D1CD`.

### Accent (one per theme, same hue)
- **Petrol** `#17657A` (`--accent`), strong `#10495A`, soft `#E1F0F4`; dark `#74C7DE`, soft `#203D46`. Used for primary actions, the active tab, selected filter chips, focus rings, the "ok" state. Repeated figures in lists are ink, never accent.

### The petrol block
- `--block-bg-deep #073C49 → --block-bg #0A4A59` (cards use `--rd-card-a → --rd-card-b`), white type with `--block-muted #B7D1D5`. Ring and macro bars inside use the light macro variants (`--rd-mint`, `--rd-sky`, `--rd-sand`).

### Semantic
- Macros: protein `#206448`, carbs `#26658F`, fat `#8C641B` (dark: mint / sky / sand). The `renderMacroSplitBar` strip (protein·carbs·fat share of kcal) uses exactly these.
- Status: success `#28724F`, warning `#946515`, error `#B4443C`, each with a 10–14% tinted background.

### Named rules
**The Petrol Block Rule.** Each main screen has at most one deep-petrol block. Danas: the day overview card (ring + eaten/plan + macros). Trening and Rutina: the day card (`renderDayCard`, ring of done/total, title, short stats) under a paper day bar. Napredak: Uvidi. Trčanje: the 7-day summary. Hrana and Ciljevi: none. Everything else is paper.

**The One-Accent Rule.** No second brand hue. Green exists only as success; amber and red only as near/over.

**The Semantic-Only Rule.** A non-neutral colour must name a state or be the accent.

## 3. Typography

Manrope only (system stack fallback). No serif anywhere since 2.0.
- **Page title** 1.875rem / 800, same position on every screen (phone: 16px gutter, 22px from top; desktop: 24px).
- **Hero number** 800, tabular: ring value 1.75rem, Ciljevi goal kcal larger. One per screen.
- **Section heading** 1.125rem / 700.
- **Figures** 700–800 tabular-nums; the unit after a number is lighter (`.num-unit`: 500, muted, "197 kcal").
- **Labels** 0.8rem (12px floor; nothing smaller except the ring label at 11.25px), 600–700.
- Serbian copy is Latin script; never use `Intl` with `sr-RS` for month/day names (returns Cyrillic). Decimal comma ("87,9 kg").

## 4. Elevation & shape

Flat and tonal. Cards: white, 1px hairline, radius 20px (`--ft-radius-lg`), a very soft shadow in light and none in dark. Rows inside cards are separated by hairlines, never boxed. Radii: 10 / 14 / 20 / 26 / pill. Sticky surfaces (day bar, dialog footers) sit on the page/surface colour with a hairline, not a shadow stack.

## 5. Components

- **Buttons.** Primary: solid petrol, 44px, radius 14px, 700. Secondary/soft: accent-soft fill, accent-strong text. Ghost: hairline outline. Danger: quiet red text on a faint red tint. Disabled: sunken grey with muted text (not faded petrol).
- **Header "add" action.** One shape everywhere: a 36px soft-accent pill, icon left (Brzi unos, Sastavi, Dodaj naviku / zadatak / nalaz / analizu / sliku). It sits on the section title line, open or closed. Full-row forms (Dodaj trčanje / merenje) stay rows.
- **Segmented control.** All sub-tabs and Ova/Sledeća: grey track (ink 6%) + white thumb (dark: white 16%), ink text. Four items fill the width on phones.
- **Row actions.** A ⋯ button (`renderRowMenu`) opens labelled actions under the row (Izmeni / Obriši / Počni ispočetka). Same in foods, habits, streaks, tasks, runs, measurements, supplements, labs, body composition, training notes. A collapsible holding an open menu stays open.
- **Checks.** Round 30px check, 1.5px border at ≥3:1 contrast; done = petrol fill. Exercise picker circles follow the same rule.
- **Inputs.** 44px, radius 14px, hairline border, accent focus ring. Date/time inputs use `appearance: none`, full cell width, left-aligned, with a calendar/clock icon (iOS otherwise gives them an intrinsic width that overflows grids). Number inputs have no spinners.
- **Dialogs / sheets.** White surface; long sheets keep their primary actions in a sticky footer so they are visible on a 664px-tall iPhone.
- **Loading.** A skeleton of the Danas screen (title, date, seven days, petrol card with ring, rows), identical in `index.html` and `renderLoadingShell()`.
- **Day card / ring.** `.today-ring` (110px, stroke 10, r 52) is shared by Danas, Trening and Rutina.

## 6. Motion

150–300ms, ease-out curves, all behind `prefers-reduced-motion`.
- Tab entry: content fades in; rings fill (`ring-fill`) and the ring/macro numbers count up.
- Value change on the same tab and day: rings, macro bars and integers slide from the old value to the new one (`captureValueMotion` / `replayValueMotion`).
- Check-off: the check pops (`check-pop`), plus an 8ms vibration where supported.
- Day/week change: content slides left (next) or right (previous) via View Transitions while title, day bar and navigation stay put.
- Progress charts: pointer scrubbing shows a line, a dot and "value · date".

## 7. Do's and Don'ts

**Do**
- Keep one petrol block and one hero number per screen.
- Use hairlines inside cards; shadows only on the card edge.
- Map every non-neutral colour to a state or the accent.
- Verify on WebKit with iPhone emulation and with every collapsible open, not only Chromium default views.

**Don't**
- Neon, gamified badge walls, corporate SaaS blue-on-white.
- A second brand hue, gradient text, glassmorphism, side-stripe borders, card-in-card.
- Floating buttons over the Danas list.
- Per-row pencil + trash pairs; use the ⋯ menu.
