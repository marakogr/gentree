# Gentree — Swiss Archive design system

Design system and token contract for the **Swiss Archive** visual language of
the Gentree desktop app.

**Status: implemented as an opt-in style.** `app.style` (`classic` | `swiss`,
default `classic`) is a second axis next to light/dark. It is applied as
`data-style` on `<html>`, selected in **Settings → Appearance** and stored in
the config; the runtime contract lives in
`desktop/ui/src/swiss.css` and `desktop/ui/src/app/theme.ts`. The classic look
is unchanged. See [`MASTER.md` §0](./MASTER.md#0-status).

## Files

| File | What it is |
|---|---|
| [`MASTER.md`](./MASTER.md) | The system: direction, palette, type scale, geometry, states, component rules, responsive behaviour, theme axes, migration plan, open questions. |
| [`preview.html`](./preview.html) | Offline preview of the language on real Gentree patterns: shell + people table, person card with vertical timeline, event form, settings, component states, palette. Light + dark, interactive. |
| [`contrast-report.md`](./contrast-report.md) | 62 measured WCAG pairs for both modes, plus the audit of the current tokens and the focus rules. |
| [`verify-contrast.mjs`](./verify-contrast.mjs) | The script that produces the report; exits non-zero on a failing pair. |

## Open the preview

Double-click `preview.html`, or:

```powershell
start design-system/gentree/preview.html
```

No build, no server, no network. Fonts are the app's self-hosted Medeo files,
referenced by relative path (`../../desktop/ui/src/assets/fonts/`).

Toolbar: light/dark · frame width 375 / 768 / 1024 / 1440 / fit · focus-ring
toggle. Deep links: `?w=375&theme=dark&view=settings`, `&view=events`,
`&view=kit`, `&view=tokens`, `&dialog=1`, `&nav=open`.

The preview is a static document: fixture names, dates and places are synthetic,
and the Russian strings are illustrative. In the app every string lives in
`src/i18n/locales/*` — do not copy text out of the preview into components.

## Re-measure contrast

```powershell
node design-system/gentree/verify-contrast.mjs
# or, from the UI package:
npm --prefix desktop/ui run contrast:check
```

Exit code `0` means every pair meets its threshold. The script also reads the
shipped palette from `desktop/ui/src/swiss.css` and fails on any drift, so a
token edit must be reflected in both places. After a palette change, paste the
new table into `contrast-report.md` and update the numbers quoted in
`MASTER.md` §3 and §12.

## How the design system was generated

```powershell
python <skills>/ui-ux-pro-max/scripts/search.py `
  "genealogy family archive desktop data tool swiss typography" `
  --design-system --variance 3 --motion 2 --density 7 -p "gentree" `
  --persist --output-dir . -f markdown
```

The generator resolved **Minimalism & Swiss Style** (`minimalism-and-swiss-style`)
with a blue `#2563EB` / Inter palette. The structure was kept; the palette was
re-grounded on the product's existing teal brand ramp and the self-hosted Medeo
family, because replacing either would be a rebrand and would violate the
repository rules (no external fonts, no CDN).

## Attribution

Medeo Sans / Medeo Mono / Medeo Pixel — © Timur Akhimov and dnf.dev for
prtner.ai, SIL Open Font License 1.1. Licence text:
`desktop/ui/src/assets/fonts/OFL.txt`. Upstream: https://prtner.ai/font/ and
https://github.com/DNFDEVS/medeo-font (build-time reference only; the app loads
local files).
