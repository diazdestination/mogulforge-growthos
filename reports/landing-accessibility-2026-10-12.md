# Public landing accessibility hardening — 2026-10-12

Branch `agent/growthos-landing-a11y-20261012` (based on PR #35 head `87adc3e`).
Scope: `artifacts/command-center/index.html`, `src/pages/landing.tsx`,
`src/pages/landing.test.tsx`. No shared design tokens or theme files changed;
MogulForge brand colors (`#05111e`, `#0b1b2b`, `#baf000`, `#d6f877`), logo and
copy are unchanged.

## Findings

Source: `C:\Forge\bootstrap\local-dev-2026-10-10\growthos-browser.log` (axe 4.13,
`http://127.0.0.1:4193/`, desktop and mobile).

| Rule | Impact | Count | Cause identified |
| --- | --- | --- | --- |
| `color-contrast` | serious | 3 per viewport | `text-zinc-500` on `#05111e`: the hero disclaimer ("Start with sample data…") and the two footer spans (app name, copyright). |
| `meta-viewport` | moderate | 1 per viewport | `index.html` viewport had `maximum-scale=1`, blocking pinch zoom (WCAG 1.4.4). |

The log reported `horizontalOverflow: false`, but a local 320px inspection showed
the header nav (`Meet the team` / `Sign in` / `Explore`, `whitespace-nowrap`)
extending to x=441 in a 320px viewport. The root's `overflow-x-hidden` masked
it: "Sign in" and "Explore" were clipped off-screen and "Meet the team"
overlapped the wordmark. This also occurred at 390px.

## Fixes

1. `index.html`: viewport is now `width=device-width, initial-scale=1.0`
   (removed `maximum-scale=1`).
2. `landing.tsx`: `text-zinc-500` changed to `text-zinc-400` for the hero
   disclaimer and the footer. `zinc-400` is already the landing page's body-copy
   shade, so this is a shade adjustment within the existing palette.
3. `landing.tsx`: the header is now `min-h-16 py-2 flex flex-wrap … gap-x-4 gap-y-1`
   (was fixed `h-16`), and the nav container is a labelled `<nav aria-label="Primary">`
   with `flex-wrap justify-end`. Under about 500px the nav wraps below the
   wordmark. At `md` and above it stays on one row as before.

## Contrast ratios (WCAG 2.1 relative luminance; Tailwind v4 oklch → sRGB)

| Element | Before | After | Requirement |
| --- | --- | --- | --- |
| Hero disclaimer, 12px, on `#05111e` | zinc-500 `#71717b` **3.94:1** (fail) | zinc-400 `#9f9fa9` **7.24:1** | 4.5:1 |
| Footer app name / ©, 14px, on `#05111e` | zinc-500 **3.94:1** (fail) | zinc-400 **7.24:1** | 4.5:1 |

Unchanged elements, all of which already passed:

| Element | Ratio |
| --- | --- |
| Body copy zinc-400 on `#05111e` / card `#0b1b2b` | 7.24 / 6.64 |
| zinc-200 specialist roles on card | 13.72 |
| zinc-300 "Sign in" nav on `#05111e` | 12.85 |
| `#d6f877` links/labels on `#05111e` | 15.88 |
| `#d6f877` on badge (`#baf000`/10 over canvas) | 13.07 |
| `#d6f877` icon on icon tile (`#baf000`/15 over card) | 10.14 |
| `#baf000` accent text on card | 12.90 |
| `#05111e` text on `#baf000` primary CTA / `#d6f877` hover | 14.07 / 15.88 |
| `#baf000` outline-button border on card (UI component) | 12.90 |

## Evidence

- Local Vite dev server on `127.0.0.1:5281` with the built-in browser. An in-page
  script composited each text node's foreground over its nearest opaque
  background and found **no text below 4.5:1 (or 3:1 for large text)** at 320px.
  The computed disclaimer and footer colors are `oklch(0.705 0.015 286.067)`
  (zinc-400), and the served viewport meta is `width=device-width, initial-scale=1.0`.
- Overflow scan (all elements' bounding boxes against the viewport): no element
  outside the viewport at 320px or 390px, and root `scrollWidth` equals the
  viewport width. Screenshots show all three nav links visible at 320px, and the
  desktop header is unchanged on one row.
- `landing.test.tsx` has 3 new tests: the viewport meta allows zoom, no
  `text-zinc-500`/`600` text remains and the fixed elements use zinc-400, and
  the header and nav wrap with all three links present.
- `pnpm --filter @workspace/command-center test`: 116 files / 1038 tests passed.
  The first full run had 1 failure in an unrelated file that could not be
  identified because the output was truncated. Two later full runs were clean.
- `pnpm --filter @workspace/command-center run build`: passed (2619 modules).
- `pnpm run typecheck`: passed (api-server, command-center, scripts).

## Not changed

- Secondary CTA and decorative card borders (`white/15`, `white/10`, about 1.5:1).
  The secondary CTA is identified by its zinc-200 label (13.7:1), so WCAG 1.4.11
  does not require a 3:1 border. Changing it would be a visual redesign.
- No re-run of axe itself, because axe-core is not installed in this workspace.
  The ratios were computed directly as shown above.
