# Integrated coverage and specialist browser QA

Root inspected the actual LeadAlertCoverage component in a synthetic local Vite fixture at http://127.0.0.1:4793/design/coverage.html. The native lead-detail page mounts this component beside the existing Smart Site inquiry ownership UI. This fixture isolates the coverage panel; it does not prove a signed-in native lead journey or connected push delivery.

Observed with Codex In-app Browser on October 9, 2026:

- Default desktop viewport 1280 wide: readable recipient rows and receipt labels; document width 1265 with no horizontal overflow.
- Phone viewport 390 x 844: stacked content, readable wrapping, document width375 with no horizontal overflow. Temporary viewport override reset after inspection.
- Original three-person cohort includes a queued owner, a staff member without an eligible device, and an unavailable staff member whose name is absent. Current receipts distinguish provider acceptance and missing receipts.
- Historical gap clears previous recipients, says coverage was not recorded, and does not derive history from current routing/devices.
- Read-unavailable scenario clears old evidence, describes a failed read without claiming a failed alert, and offers only Retry coverage read. Retry increases the fixture read count; every request is GET.
- Partial coverage can be reopened after the error. SCOUT remains a restrained pipeline guide; its optional drawer opens with capability/setup copy and closes.
- No browser error/warning logs were observed in the inspected fixture.

Screenshots saved in the calling task outputs: integrated-coverage-desktop.jpg and integrated-coverage-mobile.jpg. All staff names, identities and timestamps are illustrative. No actual customer records, sign-in, provider requests, sends, device registration or routing changes occurred. Production build includes neither this fixture entry nor its fetch stub.
