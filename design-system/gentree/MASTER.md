# Gentree — Design System Master: **Swiss Archive**

> **Scope of this file.** Design research and token contract for the alternate
> visual language. Nothing under `desktop/ui/src` or `desktop/apps` is changed by
> this document; implementation lands in a second stage, on the integration
> branch, as an *extension* of the existing theme — never as a parallel theme
> system.
>
> When building or reviewing a screen, read this file first. Page-specific
> deviations live in `design-system/gentree/pages/<page>.md` and override this
> file.

- **Project:** Gentree desktop (Tauri 2 + React/Vite + Fluent UI + Medeo)
- **Style axis value:** `data-style="swiss"` (absence = today's look)
- **Mode axis:** existing `data-theme="light" | "dark"`
- **Stage:** implemented as an opt-in style, 2026-11-01 (classic remains the
  default; see "Status" below)
- **Generated with:** `ui-ux-pro-max` design-system query
  `"genealogy family archive desktop data tool swiss typography"`
  (`--variance 3 --motion 2 --density 7`), then constrained by the repository
  invariants (self-hosted Medeo, no CDN, WCAG AA, Russian/Ukrainian/English UI).
- **Evidence:** [`contrast-report.md`](./contrast-report.md) (62 measured pairs),
  [`preview.html`](./preview.html) (offline preview, light + dark).

---

## 0. Status

The style ships as `app.style` (`classic` | `swiss`, default `classic`) next to
`app.theme`. It is applied as `data-style` on `<html>` before the first paint
(`src/lib/style.ts`, cached under `gentree.style`) and selected in
**Settings → Appearance**; the shared **Save** button writes it to the config.
`GENTREE_APP_STYLE` overrides it for tests. The Fluent theme is chosen by the
pair (scheme, style) in `src/app/theme.ts`, and all CSS refinements live in
`src/swiss.css`, scoped by `:root[data-style="swiss"]` so classic is untouched.

Migrated to the Swiss style: shell/sidebar, people table + person card with the
vertical timeline, events table and form classes, settings panels, dialogs,
filters/chips, chat and help chrome (token- and shape-level). Not re-laid-out:
component structure, form fields, graph/timeline canvases (they follow the
tokens but keep their layout).

## 1. Direction

### Chosen: Minimalism & Swiss Style (catalog id `minimalism-and-swiss-style`)

The catalog entry is explicit about the mechanics we need: grid-based layout,
essential elements only, a single accent, `--border-radius: 0px`,
`--shadow: none`, clear type hierarchy, high contrast, and a low accessibility
risk profile (`contrast-text-4.5, keyboard, visible-focus, reduced-motion`).
It is listed as best for "enterprise apps, dashboards, documentation sites,
professional tools" — which is exactly a dense master–detail archive.

Adapted for Gentree, the language becomes **"archive card / finding aid"**:

- the screen is a **sheet of paper with rules**, not a stack of floating cards;
- hierarchy comes from **type size, weight, letter-spacing and 1px rules**, not
  from elevation, colour blocks or rounded containers;
- **one accent** (the product's existing teal) marks *interaction and state*
  (links, focus, selected row edge, active tab) and is never used as wallpaper;
- **numbers, dates and IDs are monospaced/tabular**, so a column of years reads
  as a column;
- corners are **square**; controls get a 2px radius only so they do not look
  like plain text.

### Why not the alternatives (catalog-checked)

| Candidate | Why rejected for Gentree |
|---|---|
| **Brutalism** (`brutalism` / neo-brutalism) | Thick borders and oversized type break dense tables and long forms; readability of 13px date/place columns collapses. The repository's core screen is a 5-column table plus an inline event form. |
| **Editorial Grid / Magazine** (`editorial-grid-magazine`) | Built for long-form reading: pull quotes, drop caps, asymmetric hero images. A genealogy *tool* has no article body; the metaphor adds decoration without function. |
| **Glassmorphism / Aurora / Gradient** | Translucent surfaces destroy the 3:1 boundary budget and make 1px rules unmeasurable; also conflicts with the "no purple-pink gradients" rule. |
| **Bento Grid** | Designed for marketing tiles; wastes vertical space that the master–detail table needs. |
| **Neumorphism / Soft UI** | Low-contrast by construction — fails 1.4.11 on every boundary. |
| **Dark-mode-first / Terminal** | A family archive is read in daylight and printed; the dark mode must be a peer, not the origin. |

The catalog's default palette for this style is inbox blue `#2563EB` + Inter.
**Both are rejected**: the product already ships a teal brand ramp
(`desktop/ui/src/app/theme.ts`) and self-hosted Medeo. Replacing them would be a
rebrand, not a restyle. The Swiss *structure* is adopted; the palette is
re-grounded on the existing teal and a paper/ink neutral ramp.

### What stays

Fluent UI components, Fluent icons, Medeo Sans/Mono, the existing
`data-theme` switch, all i18n keys, all IPC. This is a surface-and-token change.

---

## 2. Character

| Axis | Decision |
|---|---|
| Metaphor | archival index card, typeset finding aid |
| Temperature | neutral paper in light, neutral ink in dark; teal is the only hue |
| Density | high — a desktop research tool, not a landing page |
| Edges | square (0) for structure, 2px for controls; no pills |
| Separation | 1px rules and surface steps; **no elevation** |
| Rhythm | strict 4px grid, 34px table rows |
| Voice | labels in sentence case; eyebrows in uppercase mono |
| Motion | state feedback only (90–180ms); no entrance choreography |
| Forbidden | purple/pink gradients, emoji-as-icon, identical rounded cards with soft shadows, default Segoe/Arial/Inter as the primary face, CDN assets |

---

## 3. Palette

Two modes, one accent. Values are the ones measured in
[`contrast-report.md`](./contrast-report.md).

### Light — "Paper"

| Token | Value | Role |
|---|---|---|
| `--background` | `#f2f3ef` | app canvas, page behind panels |
| `--card` | `#fbfbf8` | table/list/card surface |
| `--popover` | `#fbfbf8` | menus, popovers |
| `--raised` *(new)* | `#ffffff` | dialogs only, one step above `--card` |
| `--muted` | `#e7e9e4` | table header, sunken wells, hover on muted rows |
| `--foreground` | `#12161a` | primary text, icons |
| `--fg-secondary` *(new)* | `#3a4247` | table body secondary lines, labels |
| `--muted-foreground` | `#5b6469` | meta, hints, placeholders |
| `--border` | `#d3d7cf` | **decorative** hairline: row dividers, panel outline |
| `--input` | `#767f7a` | **3:1 control boundary**: field borders, chip borders, table header rule |
| `--primary` | `#0b6577` | link, icon accent, active marker, selected-row edge |
| `--primary-solid` *(new)* | `#0b6577` | primary button fill |
| `--primary-solid-hover` *(new)* | `#0a5867` | primary button hover |
| `--on-primary-solid` *(new)* | `#ffffff` | label on primary fill |
| `--accent` | `#dce8e6` | selection tint, quiet highlight |
| `--accent-foreground` | `#12161a` | text on `--accent` |
| `--ring` | `#0b6577` | focus outline |
| `--destructive` | `#a3231a` | error text, destructive outline |
| `--destructive-solid` *(new)* | `#a3231a` | destructive confirm fill |
| `--on-destructive-solid` *(new)* | `#ffffff` | label on destructive fill |
| `--success` *(new)* | `#1f6b3a` | "жив(а)" / valid state |
| `--warning` *(new)* | `#7a4f00` | validation warnings, chat banner |
| `--text-disabled` *(new)* | `#868e89` | disabled label (exempt, kept ≥3:1) |
| `--scrim` *(new)* | `rgba(18, 22, 26, 0.55)` | dialog backdrop |

### Dark — "Ink"

| Token | Value | Role |
|---|---|---|
| `--background` | `#111415` | canvas |
| `--card` | `#181c1d` | surface |
| `--popover` | `#181c1d` | menus |
| `--raised` *(new)* | `#1f2425` | dialogs |
| `--muted` | `#212627` | table header, wells |
| `--foreground` | `#e9ebe8` | primary text |
| `--fg-secondary` *(new)* | `#b4bab7` | secondary text |
| `--muted-foreground` | `#8f9795` | meta, hints |
| `--border` | `#2b3132` | decorative hairline |
| `--input` | `#68716e` | 3:1 control boundary |
| `--primary` | `#5fd6ec` | link, icon accent, selected-row edge |
| `--primary-solid` *(new)* | `#127a90` | primary fill (white label, 4.99:1) |
| `--primary-solid-hover` *(new)* | `#0e6b7e` | primary hover |
| `--on-primary-solid` *(new)* | `#ffffff` | label on primary fill |
| `--accent` | `#1d2b2d` | selection tint |
| `--accent-foreground` | `#e9ebe8` | text on `--accent` |
| `--ring` | `#8ce6f7` | focus outline |
| `--destructive` | `#ff8f85` | error text |
| `--destructive-solid` *(new)* | `#b3352b` | destructive confirm fill |
| `--on-destructive-solid` *(new)* | `#ffffff` | label |
| `--success` *(new)* | `#7fd3a0` | living / valid |
| `--warning` *(new)* | `#e8c46a` | warnings |
| `--text-disabled` *(new)* | `#727a77` | disabled label |
| `--scrim` *(new)* | `rgba(5, 8, 9, 0.72)` | dialog backdrop |

### Colour rules

1. **One hue.** Teal only for accent/state. No second accent. Status hues
   (danger/success/warning) appear only with a status, never as decoration.
2. **Never white text on `--primary` in dark.** `--primary` is a *text/line*
   colour there (10:1 on surface); `--primary-solid` is the fill token.
3. **`--border` is decorative** (1.3–1.4:1). Anything that is the only visible
   boundary of an interactive control uses `--input` (≥3:1).
4. **No colour-mix chains for state.** Hover/pressed values are explicit
   tokens; the 29 existing `color-mix(in oklab, var(--primary) 45%, …)` call
   sites collapse to `--accent` / `--primary-solid-hover`.
5. **Selected ≠ coloured text.** Selection is a tinted row + a 2px `--primary`
   left edge; text keeps its normal ink colour.

---

## 4. Typography

Fonts stay **Medeo Sans** (variable 100–900, self-hosted) and **Medeo Mono**
(`desktop/ui/src/fonts.css`, SIL OFL 1.1, licence at
`desktop/ui/src/assets/fonts/OFL.txt`). No new family is introduced: the style
is carried by scale, weight, tracking and case. Medeo Pixel stays unused in
this style.

### Scale (desktop)

| Role | Token | Size / line-height | Weight | Tracking | Case |
|---|---|---|---|---|---|
| Display (empty state, onboarding) | `--text-display` | 32 / 1.08 | 600 | −0.02em | sentence |
| Page title | `--text-2xl` | 24 / 1.2 | 600 | −0.015em | sentence |
| Card / dialog title | `--text-xl` | 20 / 1.25 | 600 | −0.01em | sentence |
| Section title | `--text-lg` | 16 / 1.35 | 600 | 0 | sentence |
| Body (forms, reading) | `--text-md` | 14 / 1.5 | 400 | 0 | sentence |
| UI body (tables, nav, controls) | `--text-sm` | 13 / 1.45 | 400/500 | 0 | sentence |
| Caption / meta | `--text-xs` | 11.5 / 1.35 | 400 | 0.01em | sentence |
| Eyebrow / table header | `--text-2xs` | 10.5 / 1.2 | 500 | **0.09em** | UPPERCASE |
| Numeric column | `--text-sm` | 13 / 1.4 | 400 | 0.02em | `tabular-nums` |
| Code / ID / checksum | `--font-mono` | 12 / 1.4 | 400 | 0 | as stored |

Weights in use: **400** body, **500** labels/table headers, **600** titles,
**700** reserved for the single app wordmark. No 300 (too thin at 13px).

### Type rules

- **Eyebrows are the only uppercase text.** Never uppercase a person's name,
  place, or an event type: the UI must survive Cyrillic transliteration and
  long German compounds (locale set includes `de`, `es`, `be`, `uk`).
- Dates, years, ages, counts: `font-variant-numeric: tabular-nums` in Medeo
  Sans. Full dates in timelines use `--font-mono` for the year gutter.
- Long-form body text caps at **68ch**; card description cells at **52ch**.
- No letter-spacing on Cyrillic body text; negative tracking only at ≥20px.
- Line-height never below 1.35 for wrapped UI text (prevents clipped
  descenders in `de`/`uk` at 13px).
- Do not fake small caps, italics, or condensed widths — Medeo Sans is variable
  but the app must stay legible at 100% Windows scaling.

---

## 5. Geometry, rules and elevation

| Token | Value | Applies to |
|---|---|---|
| `--radius-none` *(new)* | `0` | panels, cards, tables, dialogs, chips, badges, timeline markers |
| `--radius-control` *(new)* | `2px` | buttons, inputs, selects, textareas, segmented controls |
| `--radius-sm` *(remapped)* | `0` | existing Tailwind `rounded-sm` call sites |
| `--radius-md` *(remapped)* | `0` | existing Tailwind `rounded-md` call sites |
| `--radius-lg` *(remapped)* | `0` | existing Tailwind `rounded-lg` call sites |
| `--bw-hairline` *(new)* | `1px` | all dividers and outlines |
| `--bw-emphasis` *(new)* | `2px` | selected row edge, active tab, focus |
| `--shadow-none` *(new)* | `none` | everything |
| `--shadow-overlay` *(new)* | `none` | dialogs too — separation is the scrim + 1px `--input` border |

Implementation note: Fluent's `Theme` object also carries radii. Set
`borderRadiusSmall/Medium/Large/XLarge = "0"` and `borderRadiusCircular = "2px"`
in the Swiss theme, otherwise Fluent `Button`, `Input`, `Dialog`, `Switch` and
`Table` keep 4/6/8px corners and the language breaks.

**Rule hierarchy**

1. `--border` hairline — row separators, panel outline, section top rules.
2. `--input` 1px — interactive boundaries: field, chip, sortable header, dialog.
3. `--primary` 2px — state: selected row, active tab, active filter, resize
   handle on hover.

There is no fourth weight: no 3px borders, no dashed "decoration" except the
intentional dashed placeholder (graph node, empty state) which stays dashed.

---

## 6. Spacing and density

4px base. Scale: `4 8 12 16 24 32 48 64` (`--space-1 … --space-8`).

| Context | Value |
|---|---|
| Page padding (≥1280) | 24px |
| Page padding (768–1279) | 16px |
| Page padding (<768) | 12px |
| Panel padding | 16px (12px at <768) |
| Stack gap in a panel | 12px |
| Form label → control | 4px |
| Form field → field | 14px |
| Section top rule → content | 12px |
| Table cell padding | 8px horizontal, 0 vertical (height-driven) |
| Table row height | 34px default, 30px compact, 40px comfortable |
| Header row height | 38px |
| Control height | 32px default, 26px small, 36px large (44px on touch) |
| Icon button | 32×32 (hit area 36×36 via padding) |
| Sidebar width | 264px expanded, 72px rail (matches today) |

Density dial for this product is **7/10**: information-dense, but every row
still has 34px of vertical air. Do not go below 30px.

---

## 7. States

All states are token-driven; no ad-hoc `color-mix` in components.

| State | Light | Dark |
|---|---|---|
| Hover (neutral row/button) | background `#e7e9e4` (`--muted`), text unchanged | background `#212627` |
| Hover (primary button) | `--primary-solid-hover` `#0a5867` | `#0e6b7e` |
| Hover (link/icon accent) | `--primary` + underline on text links | same |
| Active / pressed | `--accent` fill + 1px `--primary` inset bottom rule | `--accent` |
| Selected (row, tab, chip) | `--accent` fill + 2px `--primary` edge | same |
| Focus (`:focus-visible`) | 2px `--ring` outline, **offset 2px** (native inputs/selects: offset 1px so the ring sits on the field border, not over the label) | same |
| Invalid | 1px `--destructive` border + 12px `--destructive` message | same |
| Disabled | `--text-disabled` label, `--border` outline, `--muted` fill, `cursor: not-allowed` | same |
| Read-only | no border, `--muted` fill, `--fg-secondary` text | same |

Rules:

- **Hover never moves layout.** No `translateY`, no scale, no shadow growth.
- **Focus is never removed.** A component that needs the ring to be hidden
  (e.g. a custom checkbox) must move it to the wrapper, not delete it.
- Fluent components keep their own token-driven inner indicator (`--ring`
  colour); the Swiss layer adds the 2px outer ring on native `input`, `select`,
  `textarea` and `button` so the indicator is unambiguous on paper and at 200%
  zoom.
- **Disabled controls keep their label readable** (≥3.24:1 light, 3.90:1 dark)
  but drop all hover/active feedback.
- **Selection is not hover.** The two must be visually distinct: hover is a
  washed `--muted`; selection is `--accent` + a 2px edge.

---

## 8. Motion

| Token | Value | Use |
|---|---|---|
| `--duration-1` *(new)* | `90ms` | colour/opacity on hover, pressed |
| `--duration-2` *(new)* | `140ms` | focus ring, chip selection |
| `--duration-3` *(new)* | `180ms` | disclosure, panel resize snap-back |
| `--ease-standard` *(new)* | `cubic-bezier(0.2, 0, 0, 1)` | all of the above |

- Animate only `color`, `background-color`, `border-color`, `opacity`, and the
  width of the resize handle. Never animate `box-shadow` (repaint) or layout.
- No entrance animations, no scroll reveals, no parallax. Panning/zooming the
  graph and timeline stays transform-based and immediate.
- `@media (prefers-reduced-motion: reduce)` sets every duration to `0.01ms`
  (keep the state change, drop the transition).

---

## 9. Component rules

### 9.1 Application shell

- Sidebar: `--card` surface, 1px `--border` right rule, no shadow. Brand
  wordmark 15px/700 with 0.02em tracking; nav items 13px/500, 32px tall,
  icon 20px, 10px gap.
- Active nav: `--accent` fill + 2px `--primary` left edge, label `--foreground`.
  Not a filled pill.
- Rail mode at ≤900px: 72px, icons only, labels in tooltips (existing behaviour).
- Content: `--background`, 24px padding, 12px stack gap. No page-level card.

### 9.2 Tables (people list, events list)

- Header: `--muted` fill, `--text-2xs` uppercase mono-ish tracking, `--fg-secondary`,
  1px `--input` bottom rule, sticky, 38px tall.
- Body: 13px, 34px rows, `--border` row rules only (no vertical rules, no zebra).
- Numeric/date columns right-aligned, `tabular-nums`, no truncation of the year.
- Hover: row `--muted`. Selected: row `--accent` + 2px `--primary` left edge
  drawn **inside** the row so nothing shifts.
- Sortable header: label + 12px triangle; active sort keeps `--foreground`.
- Column resize handle: 8px hit area, visible 2px `--primary` line only on
  hover/focus/drag (existing behaviour, radius → 0).
- Long names wrap to a second line; never ellipsize a person's name — the age,
  years and actions columns are the ones that may truncate.

### 9.3 Person card + vertical timeline

- Card: `--card`, 1px `--border`, radius 0, **no shadow**. Head: square avatar
  (initials in `--font-mono`, 1px `--input` border, `--muted` fill), title
  20px/600, years 13px tabular `--fg-secondary`, status tag square.
- Facts: `<dl>` grid, 13px, `dt` `--fg-secondary` 120px min, `dd` ink; 4px row gap.
- Sections: 1px `--border` top rule + uppercase 10.5px eyebrow. Accordion
  chevron 16px, rotates 90° in 140ms.
- Timeline: 1px vertical rule at a 72px gutter; year in `--font-mono` 12px
  `--fg-secondary`, right-aligned in the gutter, 24px above its node; node =
  5×5px square `--primary` for the focused/life event, `--fg-secondary` for
  others (no circles); event type 13px/500, place 12px `--fg-secondary`,
  participants as text links; 20px vertical gap. Never a coloured dot per type.
- Empty timeline: hairline dashed well + one ghost "add event" action.

### 9.4 Forms (event form, person form)

- Label above control, 12px/500 `--fg-secondary`; required `*` in
  `--destructive`; hint 11.5px `--muted-foreground`.
- Control: 32px, 1px `--input`, `--card` fill, radius 2, 8px horizontal padding,
  13px text. Placeholder `--muted-foreground` (5.83:1).
- Date precision row: date input + precision select + qualifier select on one
  line ≥640px, stacked below (existing `person-date-row`).
- Error: border `--destructive`, message 11.5px below, `aria-invalid` +
  `aria-describedby`. Errors never replace the label.
- Form sections: `<fieldset>` with a 1px `--border` frame, legend 10.5px
  uppercase `--muted-foreground`. One border level only.
- Primary submit sits right, secondary left; no sticky footer.

### 9.5 Dialogs

- Backdrop `--scrim`; surface `--raised`, 1px `--input`, radius 0, **no shadow**.
- Width 560px (single form), 720px (merge/compare); max-height 88vh; header
  16px/600 with 1px bottom rule; footer right-aligned with 1px top rule.
- Title is `h2` and receives focus on open; Escape closes; focus is trapped and
  returns to the trigger. Scrim click closes only non-destructive dialogs.
- Dark mode: the surface/scrim step is only 1.26:1, so the **1px border is the
  edge** (3.12:1). Do not remove it.

### 9.6 Buttons, chips, tags

- Button: 32px (26 sm / 36 lg), padding 0 12px, 13px/500, radius 2.
  - **Primary:** `--primary-solid` fill, `--on-primary-solid` label.
  - **Secondary:** `--card` fill, 1px `--input`, ink label.
  - **Ghost:** transparent, `--fg-secondary` label, `--muted` on hover.
  - **Danger:** transparent + 1px `--destructive` border + danger label; the
    *confirm* button in a destructive dialog is `--destructive-solid` filled.
  - **Icon-only:** 32×32, `aria-label` mandatory, 16/20px icon.
- Chip (event type filters): 24px tall, radius 2, 1px `--input`, 12px/500.
  Selected: `--accent` fill, 1px `--primary` border, 12px check icon. **Not a
  pill** (today's `999px` chips are the most visible break from the language).
- Tag/badge ("жив(а)", counts, "адопция"): radius 0, 1px `--border`, 10.5px
  uppercase, `--muted` fill, `--fg-secondary` text. Pills are forbidden.

### 9.7 Icons

- Family: Fluent System Icons, already a dependency. No emoji, no mixed sets.
- Sizes: 16 (inline), 20 (nav, toolbar), 24 (empty state). Stroke weight is the
  family's; do not fake a thinner stroke.
- Colour inherits `currentColor`; meaningful icons use `--fg-secondary` or
  `--primary`, never `--muted-foreground` below 3:1 for a control.
- Decorative icons next to a visible label: `aria-hidden="true"`. Icon-only
  controls: `aria-label` + `title`. Selected/expanded state in ARIA, not only
  colour.

---

## 10. Responsive behaviour

Breakpoints are the app's existing ones plus one new table breakpoint:

| Width | Shell | Persons / events |
|---|---|---|
| **375** | sidebar becomes a drawer (trigger 32px); content padding 12px | table becomes stacked record rows (name + years on line 1, parents/age on line 2, actions right); card fills width; timeline gutter 56px |
| **768** | icon rail 72px, no drawer; padding 16px | master–detail stacks (list above, card below); table still tabular but horizontal scroll allowed |
| **1024** | sidebar 264px; padding 16px | split 55/45 with visible splitter |
| **1440** | sidebar 264px; padding 24px | split 58/42; card min-width 420px; content max 1400px |

Verified in `preview.html` with the width switcher (375 / 768 / 1024 / 1440),
implemented with container queries so the frame can be narrowed without
resizing the window; production uses the equivalent media queries above.

---

## 11. Theme axes

Keep **two independent axes**:

```html
<html data-theme="dark" data-style="swiss">
```

- `data-theme` — `light` | `dark` (existing; `system` resolves before paint).
- `data-style` — **new**; absent = current product look, `swiss` = this system.

Why a separate axis instead of overloading `data-theme`:

1. **Orthogonality.** Mode (light/dark) and visual language are independent;
   `swiss-light`/`swiss-dark` values still live under one style.
2. **No flash, no duplication.** `applyInitialTheme` keeps painting from the
   local cache; the style attribute is applied in the same pre-render step.
3. **Safe rollout.** Removing the attribute returns the app to today's look —
   useful for screenshots, A/B review, and bisecting visual regressions.
4. **Future styles.** A second style is another `[data-style]` block, not a
   fork of the theme resolver.

CSS structure (single file, no parallel system):

```css
/* palette: mode decides light/dark */
:root[data-style="swiss"][data-theme="light"] { /* §3 light values */ }
:root[data-style="swiss"][data-theme="dark"]  { /* §3 dark values  */ }

/* geometry + type: style decides, independent of mode */
:root[data-style="swiss"] {
  --radius-none: 0; --radius-control: 2px;
  --radius-sm: 0; --radius-md: 0; --radius-lg: 0;
  --bw-hairline: 1px; --bw-emphasis: 2px;
  --shadow-none: none; --shadow-overlay: none;
  /* §4 and §6 type/space tokens */
}

/* Fluent bridge: must follow the style, not the mode. */
```

The existing `.app-theme-root` rule (theme.css, line ~172) re-points the app
tokens at Fluent properties and has higher specificity than `:root`. Under
`data-style="swiss"` it must be split into per-mode blocks that map the app
tokens to the Swiss values, otherwise Fluent's neutral grey wins inside the
provider no matter what the palette block says.

Preference plumbing (shipped):

- `src/lib/style.ts` — `StylePreference = "classic" | "swiss"`, `applyStyle`,
  storage key `gentree.style`, mirroring `src/lib/theme.ts` so it is testable
  without a DOM.
- Settings screen: a `select` labelled `settings:style`, options
  `settings:styleClassic` / `settings:styleSwiss`; config key `app.style`
  (validated like `app.theme`). It is part of the draft and applied by the
  shared Save, not on change. All labels exist in the six locale dictionaries.
- Fluent `Theme` is selected by **(resolvedTheme, style)**:
  `swissLightTheme` / `swissDarkTheme` live next to the classic two in
  `app/theme.ts`, which stays the only theme factory.
- Rust config: `Style` enum (`classic` default, `swiss`), `app.style` in the
  known-keys list, `GENTREE_APP_STYLE` in `apply_env`, and contract tests for
  the default, the patch round-trip and an invalid value.

---

## 11b. Preview

`preview.html` is the offline reference implementation of this document. It has
no build step, no CDN and no network calls: the Medeo WOFF2 files are referenced
by relative path from `desktop/ui/src/assets/fonts/`, verified to load from a
`file://` page in Chromium.

- Open by double-click, or `start design-system/gentree/preview.html`.
- Toolbar: light/dark, frame width 375 / 768 / 1024 / 1440 / fit, and a toggle
  that shows or hides the focus rings on the sample controls.
- Deep links for review: `preview.html?w=375&theme=dark&view=settings`,
  `...&view=events`, `...&view=kit`, `...&view=tokens`, plus `&dialog=1` and
  `&nav=open`.
- Sidebar items switch screens; the width presets work because the frame is a
  CSS container (`@container app`) — production uses the media queries in §10.
- Rendered and checked at all four widths in both themes; the drawer, the
  dialog (Escape/scrim/focus return) and the switches are interactive.

## 12. Accessibility budget

Measured evidence: [`contrast-report.md`](./contrast-report.md) — 62 pairs, all
PASS. Headlines:

- Body text 14.32–17.53:1; muted text 4.95–6.19:1 (worst case: muted on the
  table header in light, 4.95:1).
- Links/icon accent 6.00–10.85:1.
- Button labels 4.99–7.47:1; the *lowest* is the dark primary fill (4.99:1),
  which is why dark uses `#127a90`, not `#5fd6ec`, as a fill.
- Focus ring 5.32–13.02:1 against all four adjacent surfaces.
- Control/table borders 3.05–3.98:1 (1.4.11). The old tokens were 1.35–1.43:1 —
  this is the largest measurable fix of the whole redesign.
- Dialog border 3.12–4.13:1 and dialog surface 1.26–4.37:1 against the scrimmed
  canvas.

Non-colour requirements:

- Keyboard: every table row action, sort header, splitter and timeline node is
  reachable; the splitter is an ARIA separator with arrow-key steps; focus
  order follows the visual order (sidebar → filters → table → card).
- Target size: 32×32 desktop minimum; form controls 32px tall but the row
  height is 34px, so the effective hit area is ≥32px. At ≤768px controls grow
  to 44px.
- Text resize: layout must survive 200% zoom (no fixed-height text containers;
  34px row is a minimum, not a clamp).
- Reduced motion: state changes stay, transitions drop to 0.01ms.
- Do not rely on colour alone: selected rows get an edge + `aria-selected`;
  living status gets a text tag, not only green; validation gets an icon+text.

---

## 13. Migration plan

### 13.1 What is reused as-is

`--background`, `--card`, `--popover`, `--foreground`, `--card-foreground`,
`--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`,
`--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`,
`--accent-foreground`, `--destructive`, `--border`, `--input`, `--ring`,
`--radius-sm/md/lg`, `--font-sans`, `--font-mono`, `--font-medeo-*`.

Components already read these through `var(--token)` in every screen CSS, so
steps 1–2 restyle most of the app without touching a component.

### 13.2 What is added

| Group | New tokens |
|---|---|
| Semantics | `--fg-secondary`, `--raised`, `--text-disabled` |
| Fill pairs | `--primary-solid`, `--primary-solid-hover`, `--on-primary-solid`, `--destructive-solid`, `--on-destructive-solid` |
| Status | `--success`, `--warning` |
| Overlay | `--scrim` |
| Geometry | `--radius-none`, `--radius-control`, `--bw-hairline`, `--bw-emphasis`, `--shadow-none`, `--shadow-overlay` |
| Type | `--text-display/2xl/xl/lg/md/sm/xs/2xs`, `--weight-medium/semibold/bold`, `--tracking-tight/normal/eyebrow` |
| Space | `--space-1…8` |
| Density | `--row-h-compact/default/comfortable`, `--control-h-sm/md/lg` |
| Motion | `--duration-1/2/3`, `--ease-standard` |

`--primary-foreground` is **kept** (Fluent uses it for `colorNeutralForegroundOnBrand`);
it maps to `--on-primary-solid` in the Swiss style.

### 13.3 Order of work (each step independently verifiable)

1. **Tokens + axes.** Add the `[data-style="swiss"]` blocks to `theme.css`,
   `src/lib/style.ts`, config key `app.style`, settings control, all locales.
   No visual change while `data-style` is absent. `applyInitialStyle` runs next
   to `applyInitialTheme` before React renders (same cache-first strategy, no
   flash). Test: screenshot parity with the attribute removed.
2. **Fluent bridge.** Add `swissLightTheme`/`swissDarkTheme` in
   `app/theme.ts` (brand ramp → ink/teal neutrals; radii 0/2; fonts unchanged),
   select by theme+style in `providers.tsx`, and rewrite `.app-theme-root`
   bridges to read the Swiss primitives. This unlocks every Fluent `Table`,
   `Input`, `Switch`, `Dialog`, `Button`.
3. **Kit primitives** (`components/ui/button.tsx`, `chip.tsx`, `field.tsx`,
   `dialog.tsx`, `menu.tsx`, `toast.tsx`, `ui.css`): kill pills, shadows,
   radius 6/8; switch to `--primary-solid` / `--input` / `--radius-control`.
4. **Persons screen** (`features/persons/persons.css`, `PersonsPage`,
   `PersonCard`): table header, row height, selection edge, splitter, card,
   timeline. This is the reference screen — freeze it before continuing.
5. **Events screen + EventForm** (`features/events/*`): form grid, date row,
   table, type accent.
6. **Shell** (`styles.css` legacy layer, `sidebar-project.css`, `App.tsx`):
   sidebar, breadcrumb, page headers, `input/select/button` element rules —
   ideally delete the legacy element rules once every screen uses the kit.
7. **Remaining screens**: projects, import, search, path, graph, timeline,
   chat. Mostly token-driven; each has a short list of hardcoded values.
8. **Cleanup + guards.** Remove unused `--legacy-*` colours (or keep them as
   aliases for one release), extend `src/lib/contrast.test.ts` with the new
   pairs and the `--input` 3:1 assertion, add a lint/grep guard against new
   `border-radius: 999px`, raw hex, and `box-shadow` outside `--shadow-*`.

### 13.4 Known hardcoded styles to migrate

| File | What | Action |
|---|---|---|
| `src/styles.css` | 20 radii (6/8/10px), 2 shadows, `rgb(0 0 0 / 0.72)` dialog scrim, `.badge` 999px ×2, `.graph-node.selected` shadow ring | replace with `--radius-*`, `--scrim`, `--bw-emphasis` |
| `src/theme.css` | 25 `--legacy-*` keys × 3 blocks (75 declarations) incl. hex values; `--input` 1.43:1 | remap to Swiss tokens; keep names one release |
| `src/app/theme.ts` | 34 hex (16 brand + 18 dark neutrals); no radius overrides | add Swiss theme factory, radius overrides |
| `src/features/persons/persons.css` | 12 radii, 999px ×4 (splitter, living badge, resize handle), `--radius-lg`, `0 1px 2px` panel shadow, `oklch()` fallback for living age, 9 `color-mix` | radius 0 for tag/splitter, no shadow |
| `src/features/events/events.css` | 5 radii, 999px ×2 (anomaly tag, resize), `inset 0 -1px` sticky header shadow | square tags, 1px rule |
| `src/features/chat/chat.css` | 11 radii, 999px ×2, 14 `color-mix` state fills | tokens for message/chip/notice states |
| `src/components/filters/filters.css` | 5 radii incl. `0.5rem` and 999px, `0 1px 2px rgb(0 0 0 / .25)` thumb shadow | radius 2 / 0, no shadow |
| `src/components/sidebar-project.css` | 6px radii, `inset 2px 0 0` active edge | radius 0, keep 2px edge |
| `src/components/ui/ui.css` | `--radius-md` empty state, `--radius-sm` skeleton | radius 0 |
| `src/features/projects/projects.css` | `--radius-lg` + `0 1px 2px` cards | radius 0, no shadow |
| `src/features/persons/persons-search.css` | 999px search field | radius 2 |
| `src/features/settings/SettingsPage.tsx` | inline `borderRadius: 6` | `--radius-control` |
| `src/features/timeline/EventPopover.tsx`, `LineCanvas.tsx` | `tokens.shadow16`, `shadow8`, `0 0 0 2px` focus halos | Swiss `shadow*` tokens = none; focus halo → `--ring` |

Inline `style={{ color: tokens.* }}` usages are **fine** — they already read the
Fluent theme and will follow the Swiss theme object. Only raw numbers
(`borderRadius: 6`) and raw shadows need edits.

### 13.5 Guardrails for the implementation

- Do not add a second set of CSS variables ("swiss-*") for anything that already
  has a semantic token. The style block **redefines** the existing names.
- Do not fork components per style. If a component needs a different shape, it
  needs a token, not a variant tree.
- Do not delete `--legacy-*` in the same PR that migrates screens; alias them
  first, remove after `make check` and a visual pass.
- Any change to the event/date/relation model is out of scope and still needs
  HITL approval.

---

## 14. Anti-patterns (hard no)

- Purple/pink gradients, aurora blobs, glass panels.
- Emoji as a structural icon; mixed icon families; emoji inside chips.
- Every surface as a rounded card with a soft shadow, all at the same
  elevation.
- Pills for filters, tags and badges (`border-radius: 999px`).
- Segoe UI / Arial / Inter as the primary face; CDN-hosted fonts or images.
- Placeholder-as-label, colour-only validation, colour-only selection.
- Hover animations that move layout; removing focus outlines; 200ms+ delays on
  state feedback.
- Decorative uppercase for names/places/event types.
- Inventing a second accent hue for "secondary actions".

---

## 15. Decisions (resolved)

1. **Style switch in Settings.** `app.style` is a normal config setting like
   `app.theme`; no format approval is needed because it does not touch the
   project format.
2. **Default style.** `classic` stays the default; `swiss` is opt-in for at
   least one release. The classic palette is unchanged (its 1.35:1 boundary
   contrast is recorded as known debt in the contrast report).
3. **Legacy palette lifetime.** `--legacy-*` stays as aliases that resolve to
   Swiss values under `data-style="swiss"`; removal is a follow-up release.
4. **Living-status colour.** No text tag in this stage; out of scope.
5. **Printed output.** Out of scope; a print stylesheet remains a follow-up.
6. **Medeo Pixel.** Not used by the Swiss style.

Open follow-ups: remove the legacy aliases after one release; decide whether
`swiss` becomes the default; add a print stylesheet; re-measure the classic
Fluent strokes before any accessibility pass on the classic look.
