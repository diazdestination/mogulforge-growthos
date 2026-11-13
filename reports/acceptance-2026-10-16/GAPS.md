# Contractor acceptance gaps: prioritized fix list (October 16, 2026)

**October 27 scope correction:** For CSS, the `OWNER-DEFERRED` G-01 labels below
were based on superseded October 2 guidance. The October 9 private owner intake
requires payment collection preparation for the switch; deposits, progress
payments, financing and signed approval remain distinct requirements. This
correction changes the scope classification, not the dated test results or any
provider authority. Use [current CSS readiness](../css-onboarding-readiness-2026-10-27.md).

This list comes from package C's local run of the 33 cases (`CASES.md`) and a
read-only staging smoke. The private evidence is in
`C:\Forge\artifacts\growthos-launch-claude-20261016\acceptance\`.

The same file is kept at
`C:\Forge\artifacts\growthos-launch-claude-20261016\acceptance-gaps.md` for gap
triage and routing.

**Priorities**

- **P0** blocks launch or blocks running the acceptance cases at all.
- **P1** is needed before the first paying contractor uses GrowthOS day to day.
- **P2** is an engineering priority only. It does not waive an unresolved
  company-required workflow or authorize onboarding without its evidence/ruling.

Contractor card/bank collection G-01, including deposit collection, is explicitly
**OWNER-DEFERRED for initial launch** under repository AGENTS.md. It is not a new
P0/P1 implementation request. G-02 signed-scope approval remains separate from
collecting money. Invoices, delivery, balances and truthful staff-recorded external
receipts remain required on their own evidence. No payment processor is needed
to pass the permitted P-I/H-I accounting slice.

**Owners**

- **ROOT** is the WILLOWFORGE Codex backend, schema and production work.
- **GEEKOM** is the GEEKOM Codex UI work.
- **OWNER** means it needs Adam or a company decision or account. No code alone closes it.

**Sizes**

- **S** is under half a day.
- **M** is 1–2 days.
- **L** is more than 2 days.

No product code was changed in this package.

## P0: launch or acceptance blockers

| ID | Cases | Observed | Likely files | Owner | Size |
| --- | --- | --- | --- | --- | --- |
| GAP-01 | All workday cases on staging (P-A…P-J, H-A…H-K, G04-*, G06-*) | Staging (PR63 `02306ef` image) returns 500 for authenticated `GET /api/v1/settings`, `/onboarding`, `/contractor/today`, `/appointments` and `/projects`. Every Command Center page also logs a 500 from `/api/v1/onboarding`. The cause is the missing 0019 columns `appointments.scheduling_reservation`, `org_settings.scheduling_policy` and `projects.scheduling_reservation` (Codex README). Estimates, invoices, contacts, leads, work-checklists, smart-site readiness and staff-push reads return 200. **Production V2 gets the same 142-table schema, so the cutover must include 0019, or the same pages will fail in production.** | `reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql:1-6`; the V2 schema-apply tooling (package A) | ROOT (needs a scope-freeze reconciliation decision) | S to apply; M with review, backup and evidence |
| GAP-03 | P-I, P-J, H-C, G06-01 (also N-03) | Nothing reaches a customer by email until each company connects a sender. Estimate delivery preview returns 409 `estimate_sender_unavailable`. Invoice delivery preview returns 409 ("Select a company customer-email sender…"). Standing reminder preview returns 409 `sender_identity_required`. Preview is impossible without a connected Gmail or Microsoft mailbox, so the held email preview could not be exercised anywhere. | `api/services/estimate-delivery*.ts`, `invoice-delivery.ts`, `service-standing-policy.ts:113-125` | OWNER (O-04 Google OAuth app/test users, O-05 Azure) + ROOT for the staging OAuth config | S code / owner-gated |

## P1: needed for the first paying contractor

| ID | Cases | Observed | Likely files | Owner | Size |
| --- | --- | --- | --- | --- | --- |
| GAP-02 | P-D, H-K (S-09) | A website inquiry that explicitly consents to `sms` still gets **"Reply from your phone" blocked with `no_sms_consent`** (it also blocks the lead-page SMS drafts). Smart-site intake stores consent only on the submission row (scope `respond-to-this-inquiry`). It does not write a `consent_records` row. Manual SMS drafts and the send gate read only `consent_records`. Painless's chosen reply path is manual phone texting (G-18), so every Painless website lead needs a manual consent step first. A scoped design decision is needed: should inquiry-scoped consent unlock manual drafts for that inquiry? | `artifacts/api-server/src/services/smart-sites.ts:552-573`, `send-gate.ts:150-165, 289-292`, `manual-sms.ts:113-114` | ROOT (design + backend), GEEKOM (lead panel copy) | M |
| GAP-04 | P-I, R4.1 | Painless's shared Yahoo inbox cannot be the invoice/estimate sender (**G-19**). Painless cannot email an invoice until it picks a supported Gmail or Microsoft mailbox. | `mailbox-integrations.ts` | OWNER decision (choose mailbox), ROOT if Yahoo/IMAP-SMTP support is wanted | S (decision) / L (new provider) |
| GAP-05 | P-A, H-A, C1.2, R1.2 | The HCP **customer** import works: preview, import with no leads, re-import with 0 new, changed email flagged as "needs review". Jobs, estimates, invoices, equipment, appointments and media history **cannot be imported** (**G-05**). Both companies want old jobs and values visible after cutover (CSS:178-181). | lead-import (`routes/v1/reactivation.ts`), `financial-migration.ts` | ROOT | L |
| GAP-06 | P-C, H-J | Missed-call/CALLIE paths, after-hours texts to owners (**G-11**), urgent dual alert (**G-10**) and phone/mailto leads (**G-20**) are untestable without a voice/SMS provider binding. The local routing slice passed: the after-hours policy selects only the after-hours owner. | `twilio-voice.ts`, `callie*.ts`, `staff-push-policy.ts` | OWNER (O-07/O-08 binding, Telnyx decision) + ROOT | L |
| GAP-07 | CSS card (C4.13, C4.17, C4.18, C4.3, C4.5, C2.4) | **G-01 card/bank and deposit money collection is OWNER-DEFERRED for initial launch.** Separately unresolved: G-02 signed-scope approval, estimate follow-up cadence (**G-07**), appointment yes/no confirmation (**G-08**), "on the way" texts and payment follow-ups (**G-16**), SMS+email reminders (**G-14**). Their company requirement/evidence rulings remain open; this register neither implements them nor waives them. | separate scoped decisions/features | ROOT + GEEKOM, after owner/company scope (O-17, O-18) | per separate scope |
| GAP-08 | G06-02, G06-03, I-06 | There is no text/SMS estimate or invoice delivery, and no photos or assessment report with the document (**G-06/G-13**). Email preview is the only supported path. | estimate/invoice delivery | ROOT + GEEKOM | L |
| GAP-09 | G04-01, G04-05, C4.1-C4.2 | Company scheduling values are not set: durations, travel buffer, helper/crew capacity (**G-04**). The overlap refusal works (409 `resource_conflict`). Travel buffer and helper capacity could not be tested because no company policy exists. The CSS helper has no account. | `scheduling-policy.ts`, Settings → Scheduling | OWNER (values) + GEEKOM (capture UI if missing) | S–M |

## P2: engineering ordering; company acceptance unresolved

| ID | Cases | Observed | Likely files | Owner | Size |
| --- | --- | --- | --- | --- | --- |
| GAP-10 | P-I, H-I | The invoice page shows a raw UUID to contractors: "Existing-customer work · 137a8881-…". The revenue workspace does the same. | `artifacts/command-center/src/pages/invoices.tsx:767`, `components/revenue-workspace.tsx:1492` | GEEKOM | S |
| GAP-11 | P-B, P-D | Smart-site intake accepts phone numbers that pass "≥10 digits" but are not valid NANP numbers (e.g. exchange `010`). Manual SMS later rejects them as "incomplete or invalid". Validate at intake, or show the problem on the lead. | `services/smart-site-contract.ts:129-131` vs `manual-sms.ts:39-49` | ROOT | S |
| GAP-12 | P-C, A-01/A-02 | Owner-alert routing uses the server capture time (`lead.createdAt`), not `x-smart-site-received-at`. A Sunday submission buffered by the site and delivered Monday 09:00 alerts the business-hours owners. This is probably intended, but should be documented for owners. | `services/staff-push.ts:262` | ROOT (doc/decision) | S |
| GAP-13 | tooling | The disposable preview server only allows ports 4192/4193 (`runtime-preview-server.ts:22-26`), so parallel agents collide. Two preview fixtures also conflict when combined: the CALLIE fixture violates `twilio_client_binding_org_uq` after the standing-service fixture, and the returning-customer fixture asserts on a non-empty org. | `artifacts/api-server/src/test-helpers/runtime-preview-server.ts`, `scripts/callie-preview-fixture.mjs`, `scripts/returning-customer-recovery-fixture.mjs` | ROOT | S |
| GAP-14 | staging run | The original staging TEST owner belonged to one org. The two-company run needs ROOT's separately authorized TEST setup and fresh bound manifest. The selected cross-org platform provisioning/key route requires platform admin; owner/admin settings.manage can manage its own tenant's sites and keys. Office users do not gain that permission. | staging fixtures | ROOT | S |
| GAP-15 | CSS card | Engineering-order gaps with company requirement/sign-off still unresolved: office review before issuing a multi-repair invoice (**G-12**), due-date shift / plan billing (**G-15**), customer self-service correction form (**G-09**), monitored Gmail replies (**G-17**). P2 is not a company-scope waiver. | — | ROOT + GEEKOM + company ruling | M–L |

## Verified working in the local run (not gaps)

Both TEST companies were checked separately:

- client provisioning through the platform API
- site key issuance, credential check and activation
- website inquiry → one lead, a replay returns a duplicate, both owners in alert coverage
- one-claim rule
- after-hours owner-only routing
- cross-tenant 404
- customer/property identifiers observed; exact duplicate/lineage proof was not established by the original fallback predicate
- lead estimate
- native visit/conflict API observations and author-recorded one active visit; the original <=2 predicate was weaker than exact no-duplicate/window proof
- equipment asset with warranty dates and source
- checklist from starter: preview → approve
- visit work API entry/completion 200 evidence; completion UI is NOT_RUN/unverified (the original image used an invalid link)
- note-only correction
- invoice with equipment/warranty snapshot (N-01)
- original N-02 label survival observation; whole issued-document equality is required by the corrected future predicate
- staff-recorded partial receipt, balance $230.00 of $330.00
- service date with a 6-month recurrence
- HCP customer import through the onboarding UI (N-05…N-07)
- returning-customer estimate with no new lead

No sends occurred anywhere. The outbound hold was on and communications were disabled.

The preceding list and original counts describe ef52778's dated local synthetic
slice, not a new run or current provider state. Original evidence is retained;
none of its weaker assertions is retroactively changed to a product FAIL. Fresh
results must use STAGING-RUN.md's exact source/frontend/schema/fixture provenance
and immutable run IDs. This correction ran pure guard tests only, not the 33 cases.
