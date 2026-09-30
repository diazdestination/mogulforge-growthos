# GrowthOS agent team — design QA

**Source visual truth:** `design/agent-team-reference.jpg` (owner-supplied, 1280 × 853 pixels).
**Implementation:** local Command Center `/agent-team`; browser-rendered screenshot `design/qa/agent-team-final-1280.png` (1280 × 853 pixels).
**Viewport/state:** 1280 × 853 CSS pixels, desktop, unauthenticated public route, all eight profiles visible, no profile expanded. Chrome devicePixelRatio = 1; source and implementation are both 1× and needed no density scaling.
**Full-view comparison:** `design/qa/agent-team-comparison-final.png` (source left, implementation right).
**Focused comparison:** `design/qa/agent-team-card-comparison-final.png` (ESTI card from each source, normalized to 608 × 546 per side).
**Responsive evidence:** `design/qa/agent-team-mobile-final-390.png` at 390 × 844 CSS pixels, DPR 1; 800-pixel tablet screenshots were inspected during QA.
**Interactive evidence:** `design/qa/agent-team-selected-callie-final-1280.png`; keyboard activation of BILL, profile selection, filters, and public navigation were also tested in-browser. Chrome console errors: none observed.
**Owner-approved similar mark check:** `design/brand/mogulforge-mark-in-context.png` shows the clean SVG on the local agent-team page. Browser confirmed the asset loaded, no horizontal overflow, and no console errors after replacement.

## Findings

No actionable P0, P1, or P2 design defects remain in the local prototype.

- **P3 — Cross-platform identity remains scoped.** The owner confirmed there is no editable master and approved a similar mark. The first raster draft was replaced with a clean SVG and visually inspected in the local page; it is for platform-owned surfaces only, not tenant brands. Trademark review was not performed.
- **P3 — Source and implementation portraits differ in likeness.** Individual generated portraits match each role, navy workwear, dark backdrop, amber edge light, and close crop. They are not pixel-identical renderings of the concept characters. This is acceptable for a product directory, subject to owner preference.

## Required fidelity surfaces

- **Fonts/typography:** The page uses loaded Outfit (verified through `document.fonts.check`) with heavy white display type and gold `OS`, closely matching the concept hierarchy. Role headings, bullets, and compact card density are preserved. The expanded capability panel uses larger text for practical reading. The exact source typeface is not available as an editable asset.
- **Spacing/layout rhythm:** Four columns by two rows at the source's 1280-pixel viewport; cards begin at roughly the same vertical position, with comparable borders, gaps, and footer placement. The mobile layout becomes one column and the tablet layout two columns without horizontal overflow. The filter row is an intentional functional addition.
- **Colors/tokens:** Ink-navy background, navy card panels, restrained blue-gray strokes, gold accent and near-white text match the concept. The page now fills the viewport; no lower white band remains. Public landing colors and mark were aligned to the same direction.
- **Image quality/assets:** All eight roles have individual, compressed WebP portraits rather than placeholders or sprite crops. The approved-direction M is a clean SVG drawn from a generated concept; browser verified it and every visible portrait loaded. Portrait framing was enlarged to match the concept's waist-up emphasis.
- **Copy/content:** All eight names and thirty-two specialties are represented. The original's “always on,” “secure/compliant,” connected finance/calendar, and automatic-action language was not copied as fact because those release and provider gates are not proven. Cards show readiness status; selecting one explains the real implementation and remaining work.
- **Icons/interaction:** Existing product navigation remains functional. Feather outline icons suit the reference's thin industrial symbols. Filters show all, workspace-linked, or still-in-build profiles; selecting a card shows task-level readiness and a valid workspace or exploration link. Native buttons and focus-visible styles support keyboard access.

## Comparison history

1. `design/qa/agent-team-v1-1280.png` showed the roster too low and an expanded detail panel displacing the source footer. Collapsing the explanatory intro and starting with no selected profile brought the two-row grid and footer into the source's first-view composition; see `design/qa/agent-team-v5-1280.png`.
2. `design/qa/agent-team-v5-1280.png` showed a white strip below the dark canvas and specialty copy that was too small. The canvas was changed to `min-height: 100dvh`, specialty type was increased, and WebP assets were verified; see `design/qa/agent-team-final-v2-1280.png`.
3. `design/qa/agent-team-final-v2-1280.png` still showed smaller, full-body portraits than the source. A clipped image frame and closer crop improved face/torso scale without covering the copy; see the final screenshot and focused comparison above.

## Limits and open questions

This is local visual and interaction QA, not evidence of a deployed release or live provider/customer workflow. The authenticated tenant-shell version is route-wired and typechecked, but the browser pass used the public route because no customer session was needed or changed. Contrast/focus and narrow viewport were visually checked; a formal accessibility audit and 200% zoom were not performed. There is no original editable logo master; tenant-specific identity remains a separate decision.

## Implementation checklist

- [x] Preserve the supplied reference and build one image asset per role.
- [x] Connect the roster to public discovery and authenticated navigation.
- [x] Make task capability status and missing release gates inspectable.
- [x] Verify desktop, tablet, mobile, filters, card selection, keyboard activation, images, and console.
- [x] Pass Command Center tests, typecheck, and production build.
- [x] Replace the provisional raster mark with the owner-authorized similar SVG.

**final result: passed**
