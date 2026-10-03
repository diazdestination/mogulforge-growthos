# L7 preparation: customer work record and return-to-work navigation

Date: 2026-10-03. Status: **read-only source assessment; not an implementation contract or launch acceptance**.

This handoff compares the current canonical work surfaces with `LAUNCH-COMPLETION.md` L7 and `HOUSECALL-PRO-REPLACEMENT-GATE.md`. It does not start another wave, promise broad Housecall Pro parity, or change the current release gates. No provider, customer-data, schema, application-code or configuration changes were made. No fresh visual audit or contractor workday rehearsal was performed.

## Source-confirmed gaps

1. **There is no customer-level work/history destination.** `artifacts/command-center/src/pages/contacts.tsx` is a searchable, paged directory with basic contact editing. `App.tsx` has `/contacts` and `/leads/:id`, but no `/contacts/:id` screen. The existing `routes/v1/contacts.ts` GET-by-ID and `services/crm.ts` `getContact` return the contact, not related work. `pages/lead-detail.tsx` already brings together one opportunity's estimates, project and activity/messages; that does not show the customer's other properties or service-only work.

2. **The records needed for a bounded projection already exist.** Properties reference contacts; leads reference customer/property; estimates, projects and invoices link through a required lead; appointments can directly reference contact/property without a lead. `lib/db/src/schema/service-obligations.ts` requires a contact and supports an optional property, appointment, task, completion and recurrence lineage. These are not reasons to introduce another customer entity, duplicate work records, or fabricate acquisition leads. Several existing work-list APIs are lead/company-oriented or capped, so a new screen must not load a company's first page and filter it in the browser while presenting the result as complete history.

3. **Multi-property service entry has a concrete UI gap.** The service-obligation POST accepts and validates a property's company/customer relationship, but `pages/service-desk.tsx` creates with contact, kind, equipment label, due date and notice days only. `components/service-obligation-editor.tsx` also has no property selector. Existing null-property obligations must remain visibly unlinked, not silently assigned to a guessed property. Separately, Today already has useful customer IDs, but its service rows open the broad `/service` screen; the service screen supports an exact `serviceObligationId`/organization deep link. Do not invent an appointment deep-link contract without checking and adding its destination behavior.

## Recommended bounded next slice

Prepare a **customer work record** over existing data, with a proposed `/contacts/:id` page and a bounded server read model such as `GET /contacts/:id/workspace`. These names are proposals, not approved API contracts.

- Show identity, explicitly linked properties, open work/upcoming visits, service history, related opportunities/jobs/estimates/invoices, and paged typed activity. A service-only repeat customer must work without a lead.
- Preserve company and parent relationships on every join, existing role/financial visibility, stable ordering and section pagination. Clearly distinguish no records, unlinked records, and additional pages. Avoid unbounded company fetches, guessed identity from shared email/phone, and misleading partial totals.
- Link to existing native edit, completion, booking, invoice and communication screens; do not duplicate their mutations. Add customer navigation from Contacts and appropriate existing work surfaces while retaining exact primary work links.
- Keep raw provider/approval metadata, private object URLs and unrestricted email bodies out of a new general history projection. Financial summaries, if included, must reuse authoritative exact-cent semantics; accepted email is not delivery, and an imported balance is not a new cash receipt.
- Consider the small explicit-property selector for **new** service work in the frozen slice. It must use the selected customer's authorized properties. Repairing historical links is a separate reviewed action, not a read-side effect.

Likely files: new API `services/customer-workspace.ts` and a scoped contact route; new UI customer-detail page; `App.tsx`, `pages/contacts.tsx`, `pages/lead-detail.tsx`, `pages/today.tsx`; the service desk/editor only if the property-entry companion is approved. No new business table is inherently required for the read projection. Any necessary index or migration requires separate schema review.

## Tests to freeze with that slice

New service/route/UI suites should prove tenant and malformed-parent isolation; a customer with no acquisition lead; one customer with two properties and unrelated work; same-name/email people remaining separate; null-property truthfulness; old history beyond page boundaries; permission boundaries; and read-only GET behavior. Check exact links, back/reload state, stale-company response rejection and empty/error states. Reuse `contacts-search-scope.test.ts`, `contacts-pagination.test.ts`, `service-history-list.test.ts`, `contractor-today.test.ts`, `native-customer-export.test.ts`, and existing Today/service/lead-mobile UI suites. A later browser pass must check narrow phone widths and actual record navigation. **No tests were run for this documentation-only assessment.**

## Needs a contractor sample, not invented requirements

Confirm HVAC equipment/serial/model fields, warranty terms, checklist/evidence requirements and maintenance-package facts against an actual service day. Confirm repeat billable work and multi-property job creation semantics: estimates/jobs/invoices currently require an opportunity, but that alone does not authorize creating a new acquisition lead or redesigning the job model. Ask the actual office/technician about financial visibility, retained documents and required scheduling details. Validate a roofing day and an HVAC repeat-service day before closing L7. Neither this proposal nor a unified page establishes replacement acceptance or permits cancellation of an incumbent subscription.
