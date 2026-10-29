# Professional character theme — October 9, 2026

> **Current context — October 29, 2026:** The technical contract and dated results below describe their recorded feature checkpoint. Current main includes later contractor, scheduling, service, mailbox and Twilio work; use the current inventory for implemented features and pending live acceptance. Older branch names, test totals and approvals do not become current by this documentation refresh.
> See [current build](CURRENT-BUILD.md) and [documentation map](docs/DOCUMENTATION-MAP.md).


final result: passed

The owner supplied the eight-specialist image as a general reference and explicitly requested improved text and a professional SaaS presentation. This is an adaptation of the existing product, not a pixel-for-pixel poster recreation. Source and the latest directory capture were opened together in one comparison input. Reference width1280, rendered desktop1280; the implementation is taller to support larger readable copy. Mobile was checked at390 CSS pixels (375 content width with scrollbar on directory/site).

## Findings and repairs

- P2 portrait framing: initial78px portraits showed too much of the full-body image, making faces difficult to recognize. Fixed with head-and-shoulder CSS framing using the unchanged original images; revised desktop/mobile captures inspected.
- P2 website portrait sharpness: optimized small thumbnails softened the zoomed faces. Fixed by serving the existing512px WebP portraits directly; all eight loaded at full source width, with a new desktop capture.
- P2 guide access: the first implementation opened a controlled sheet without a native trigger. Fixed with the existing SheetTrigger and accessible Tabs; automated focus-return checks and real mobile focus return passed.
- P2 mobile close target: increased the sheet close target to44x44; measured in rendered mobile UI.

## Required visual surfaces

Typography: existing Outfit product typography and Barlow Condensed/Manrope website typography retained. Business roles are primary, aliases secondary. Larger descriptions and intentional wraps replace the cramped reference text.

Spacing/layout: four columns desktop, two tablet and one mobile. Directory portraits are restrained; business descriptions receive more room. Within workspaces the actual SpecialistContext component is compact, above the existing page contents. The QA-only workspace fixture is explicitly illustrative and has no customer data; it is not a production route or data proof.

Colors: restored navy/silver/signal-green identity retained. Shared workspace guidance inherits light/dark product tokens and readable controls. Existing semantic warning/error colors were not changed.

Imagery: all eight approved portraits reused byte-for-byte in both projects. Headshot framing is CSS-only. No replacement logo, invented uniform patch, generated character, placeholder portrait or game artwork was introduced. The reference uniform patches were not copied because this is a general design reference and the approved assets are reused.

Copy: specialist roles now describe actual work areas. Customer invoices and recorded receipts are separated from GrowthOS subscription billing and future payment collection. Connection/setup and planned features are distinguishable. Stale invoice-not-built statements and numbered character badges were removed. Website examples are labelled illustrative.

Interactions/accessibility: directory business-category filters, profile selection, selected heading focus, sign-in links, guide opening, financial-specialist tabs, close/focus return, route-change close and homepage-to-all-eight journey verified. Buttons retain native semantics/focus indication; guide uses existing dialog/tab primitives. Mobile guide close measured44x44. Mobile directory, guide and website showed no horizontal overflow. Workspace-guide and website warn/error consoles were empty.

## Validation and limits

25 focused UI/navigation tests passed across specialist context, directory, contractor navigation and shell role gating. Product TypeScript and final frontend build passed. Marketing TypeScript, lint and final production build passed. The local design fixture is absent from the production build output. No production release, live customer workflow, backend/schema change, provider activation, form submission or customer contact was exercised or authorized by this visual work.

No unresolved P0/P1/P2 finding remains. P3: the directory could later offer a denser list view for frequent users; it does not block this theme pass.

---

## Preserved earlier product QA record

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
