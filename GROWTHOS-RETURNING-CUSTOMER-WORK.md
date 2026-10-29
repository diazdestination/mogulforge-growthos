# Existing-customer work and invoices

> **Current context — October 29, 2026:** The technical contract and dated results below describe their recorded feature checkpoint. Current main includes later contractor, scheduling, service, mailbox and Twilio work; use the current inventory for implemented features and pending live acceptance. Older branch names, test totals and approvals do not become current by this documentation refresh.
> See [current build](CURRENT-BUILD.md) and [documentation map](docs/DOCUMENTATION-MAP.md).


Source implementation guide, October 6, 2026. This is not provider activation,
production migration, bank settlement or contractor replacement acceptance.
See `reports/returning-customer-work-contract-2026-10-06.md` for engineering scope
and the private release receipt for exact verified source identities.

## The contractor workflow

Open **Customers & Jobs**, select the customer and use the existing Estimates,
Jobs or Invoices section. New work may use a real opportunity or an existing
customer; a returning service call does not require a fabricated sales lead.

1. Create a customer estimate, explicitly choose the worksite or no property,
   enter the scope/prices and review the source before saving. Additional
   property pages are loaded without replacing a dirty draft.
2. Edit the exact saved estimate to record its staff-reviewed acceptance. This
   does not send an estimate or provide a customer signature.
3. Start the job from that accepted estimate, or create a direct customer job.
   The saved customer/worksite is fixed. Schedule/crew checks use the native
   calendar; the office's crew notes remain in the native job.
4. Open the job's invoices. Use an existing invoice when appropriate, or prepare
   another explicitly approved document. Enter/review the actual invoice lines,
   Bill to, tax amount and terms. Billing address and progress-billing amounts
   are human decisions, not inferred from the service address or estimate.
5. Review and issue the saved draft. Numbering and the issued document are
   retained. Issuing does not email it, charge a customer or mark work performed.
6. Record a payment received outside GrowthOS with its original receipt/check/
   processor reference and occurrence date. Never enter bank/card credentials.
   A refund correction records an external refund against that exact original
   receipt; it does not issue a processor refund. Allocation reversal changes
   where the record is applied, not the cash fact.
7. Review invoice email separately. Returning work uses the explicitly selected
   company-default Gmail/Microsoft staff mailbox. Provider acceptance is not
   inbox delivery, payment, reply monitoring or consent to a campaign.

Standalone customer invoices deliberately get their own work identity. Two jobs
for the same customer have separate receipt pools. Multiple approved invoices on
one job may share reviewed allocations within that exact job, not across jobs.
No returning job is counted as a newly acquired or recovered lead.

## Saved work, changed versions and an unknown result

Use exact record links from the customer history or Today. They can open old
work outside a recent page or current status filter. Do not substitute the first
similar customer, property, estimate or job.

Unchanged profile/list refresh preserves human drafts. A changed saved version
requires explicit discard/load and renewed review; accepted-estimate conversion
reloads that exact estimate and verifies its original customer/worksite and
accepted state. Polling does not adopt a new version for an old draft.

If acknowledgment is lost, the submitted request is retained privately in the
current browser tab. Reconcile **that original request**; no mount replay or new
request/reference is automatic. An access error does not establish that the
earlier action did not commit. Invoice email additionally has a permanent server
attempt owner: unknown/reconciled effects cannot be reset with another preview,
sender, source mode or request ID. Five lifetime attempts remain one chain.

Roles remain distinct: work writers can manage native work, invoice managers
can issue and reconcile billing, and readers cannot reconcile by issuing writes.
Current active accepted/verified membership and effective permissions are checked
again at mutation/admission, not only when the screen initially opens.

## History and corrections

Returning estimate/job/customer identity cannot be reparented or deleted to
repair history. After conversion, accepted estimate price/acceptance is retained;
issued invoice text is immutable. Record a genuine correction or new work.
Legacy invoice/cash-backed parent links also refuse ownership changes/merges
that would detach financial history. Address corrections and ordinary job notes
remain possible; they do not rewrite earlier issued documents.

Business value includes validated returning receipts once, with separate source
totals. Missing costs are unknown; recorded contribution is not profit or causal
ROI. An inconsistent returning refund cohort holds the entire report for
reconciliation, even outside the selected reporting period.

Core export includes closed business lineage, work versions, original issued
digest and a separate redacted-projection digest. Original staff commands,
sender approvals and uncertain-send ownership stay in complete inventory/backups,
not replayable customer exports. Financial-import v1 stays lead-mapped and
literal; no returning history or contractor mapping is guessed from absent files.

## Operator acceptance still required

Two additive lineage/command tables bring the reviewed source inventory to 141.
The 0017 SQL is offline review only; it performs no historical DML/backfill.
Do not run it on hosted databases without the separately reviewed schema,
backup/restore and staging acceptance.

Source tests, fictional responsive previews and disposable PG16 races are
separate from exact candidate/main CI, hosted recovery, real sender/inbox/call/
device tests, actual source exports and each contractor's workday/cutover.
Payment processing, accounting sync, public returning invoice portals, customer
e-signatures and general returning cost-entry UI are not enabled by this wave.
The existing incumbent subscription remains until real replacement acceptance.
