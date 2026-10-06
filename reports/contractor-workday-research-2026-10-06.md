# Common HVAC and roofing workday patterns — researched baseline

October 6, 2026. Owner authorized research and implementation before client
exports arrive. These findings guide configurable source design, not actual
client data, approved warranty terms or a universal migration adapter.

## Method and limits

Exa reviewed 40 requested search-result slots across four workstreams: platform
records/forms, HVAC maintenance records, roofing field records, and adoption
evidence. The results contained 40 distinct URLs, with semantic duplicates and
non-primary marketing material filtered. Eight selected primary pages were
fetched for validation; long-page excerpts use the provider's default limit.
Technical capabilities come from official help documentation. Promotional
rankings, a third-party automation blueprint and mirrored standards were not
used as implementation requirements. TREG was not connected/installed; connected
Exa was used without installing a service, new sign-in or paid catalog calls.

No reviewed source establishes that one vendor or one export layout serves a
majority of both US HVAC and roofing firms. ServiceTitan's sponsored 2024 survey
covers multiple commercial trades, not a current two-trade vendor-market-share
census. Its sample/software-adoption findings cannot prove a majority for a
specific product. A newer vendor-sponsored AI survey expressly limits population
generalization. Build around convergent workflows, not an unsupported ranking.
[Original commercial survey publication](https://investors.servicetitan.com/node/6611/pdf).

## Validated common patterns

1. **Property-owned equipment.** Housecall Pro records item type/name and optional
   make, model, serial, installation date and notes at a service address, with
   multiple items per address. ServiceTitan also attaches location equipment to
   specific booked work. This supports explicit customer/property assets; it does
   not justify matching existing records by label or predicting replacement dates.
   [Housecall Pro Property Profile](https://help.housecallpro.com/en/articles/3703307-property-profile),
   [ServiceTitan job-specific equipment](https://help.servicetitan.com/docs/attach-equipment-to-a-job).
2. **Equipment and agreements are explicit associations.** Housecall Pro links
   a recorded property item to a selected service plan. The relationship is not
   proof of a manufacturer's coverage. Our first slice records exact visit/service
   associations; existing agreement and standing-send authority stay separate.
   [Housecall Pro plan linkage](https://help.housecallpro.com/en/articles/5512745-attaching-a-property-profile-item-to-a-service-plan).
3. **Customizable field forms.** Jobber and JobNimbus document configurable
   questions, required flags, observations and photos attached to work. We will
   use a small typed form schema with immutable reviewed revisions and snapshots,
   rather than let later field renames change previous reports or copy old answers.
   [Jobber checklists](https://help.getjobber.com/en/articles/checklists/),
   [JobNimbus forms](https://support.jobnimbus.com/how-do-i-use-the-forms-feature).
4. **HVAC visit documentation varies by system.** ENERGY STAR gives general
   professional maintenance categories including controls, airflow, drainage and
   system-specific observations. These inform original editable prompts, not
   repair instructions, inspection frequencies or universal safety thresholds.
   Actual work must follow the company's qualified procedures and equipment terms.
   [ENERGY STAR maintenance overview](https://www.energystar.gov/saveathome/heating-cooling/maintenance-checklist).
5. **Roof records retain scope and evidence.** GAF's commercial-roof guidance
   describes qualified inspections, condition observations, drainage, weather
   exposure and retained reports/repair records. Its enhanced-guarantee examples
   are not universal residential warranty terms. A roofing starter therefore
   gathers recorded scope, observations, photos and office follow-up, with no
   automatic certification or guaranteed coverage claim.
   [GAF maintenance-record guidance](https://www.gaf.com/en-us/document-library/documents/brochures-&-literature/maximize_the_life_of_your_roof_proactive_maintenance_checklist__resgn777c.pdf).

## Source-design decision

Reuse native appointments for returning-customer visits. Add explicit assets,
company-reviewed editable checklists, saved progress, immutable work completion
and exact visit-owned private photos. Suggested starters are deliberately short
and original; no licensed checklist, technical threshold or full trade standard
is reproduced. Optional descriptive fields support later contractor-specific
information, but actual sample reconciliation remains required before migration.

Do not fake a lead to attach service photos or invoices. Native projects,
estimates and invoices still have their original opportunity lineage; this
appointment-based slice does not claim contact-only billable jobs are solved.
No client acceptance, installed-phone/provider/hosted proof follows from research.
