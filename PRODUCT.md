# Product

## Register

product

## Users

Anyone tracking food, training, and body progress day to day — worldwide, general public, not a closed friends-and-family circle. Registration is open; there's a shared public demo account (`demo@fittracker.app`) for prospective users to try before creating a real account. Users are on phones first (PWA, standalone/installed), often mid-task (about to eat, just finished a workout, checking in on weight) — sessions are short and frequent, not long browsing sessions. The interface is in Serbian.

## Product Purpose

Fit Tracker is a single-person-maintained fitness/nutrition PWA: daily food logging against macro goals, training log, body measurements/composition/blood work tracking, a weekly meal plan, and a progress dashboard (trends, streaks, insights). Success looks like a fast, low-friction daily check-in loop (log a meal, mark a workout, glance at remaining calories) that a first-time stranger — not just the original builder — can pick up without a tutorial.

## Brand Personality

Warm, earthy, quietly confident — not clinical, not gamified, not corporate-SaaS. Three words: **grounded, premium, calm.** Light mode carries an earthy sage-green + clay/cream identity (Fraunces display serif + Manrope/system-sans body). Dark mode is a distinct "luxe warm graphite + gold" register — warm graphite surfaces in OKLCH, a single gold accent, no green in dark.

## Anti-references

- Generic fitness-app look: neon accents, aggressive/loud gamification (badge walls, XP/leveling, streak-shaming), flat corporate SaaS blue-and-white. Note: small decorative emoji as a warm human touch (🔥 streak count, 💧 water, 🍽 meals) IS the established voice — this is not an anti-reference, don't flag it as one.
- AI-slop tells: gradient text, glassmorphism-as-decoration, hero-metric-template layouts, identical card grids, side-stripe colored borders (absolute ban already established).
- Green tint bleeding into **brand/decorative** dark-mode elements — nav, CTAs, the calorie ring, progress bars, borders (explicitly rejected twice before landing on gold-luxe dark). This does NOT extend to functional status semantics: `--status-success-text` is deliberately green in dark mode too (`oklch(0.82 0.1 150)`) and is used app-wide (`.pill--success`) — that's precedent, not a regression.

## Design Principles

- **Flatten nesting.** No card-in-card; rows are hairline-divided, not boxed. Max ~2 levels of containment.
- **One dominant hero number per screen.** Remaining-calories ring is the memorable focal point; everything else recedes (size/weight/font).
- **Semantic color carries meaning, not decoration.** Macro bars and states (ok/near/over) map to color; color is never just applied to fill space.
- **Progressive disclosure over walls of options.** Create-forms collapse behind toggles; secondary tabs fold into "Više"; complexity reveals on demand, not upfront.
- **Premium through restraint, not richness.** Elevation ladder (bg darker than cards), quiet typography scale, one accent — not more ornamentation.

## Accessibility & Inclusion

Standard reasonable-effort a11y: aria-labels on icon-only controls and checkboxes, a persistent live region for announcements, `prefers-reduced-motion` respected everywhere motion is used, XSS-safe rendering (escape at all render sinks). No specific WCAG level or additional requirement beyond this baseline.
