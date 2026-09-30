# GrowthOS agent team — brand and fulfillment contract

**Source:** [owner's concept image](design/agent-team-reference.jpg), supplied September 30, 2026.
**Scope:** Product identity and an honest agent directory in the local Command Center branch. This is not a production activation or a claim that eight autonomous agents exist.

## Design decision

Use the owner's ink-navy and warm-gold visual system for GrowthOS's platform-owned surfaces. The local `/agent-team` page uses eight individual portraits, the named personas, and the same compact command-center rhythm. The owner confirmed the poster mark was AI-generated and authorized a similar original mark. The new [brand SVG](artifacts/command-center/public/brand/mogulforge-mark.svg) is a clean vector candidate for platform surfaces; [brand guidance](design/brand/BRAND.md) keeps tenant white-label identity separate. No original master or trademark review is implied.

The roster is a set of bounded workflows, not eight independent AI workers. Each action still runs as the authenticated organization/staff identity or approved service principal, with tenant authorization, deterministic policy checks, human approval for consequential actions, and an audit/run ledger. In particular, do not use an LLM for money arithmetic, warranty dates, routing safety, consent, or legal deadlines.

The status vocabulary in the interface is deliberate:

- **In workspace:** a staff-facing workflow is present in the current branch; not proof of deployment or provider delivery.
- **Setup required:** relevant code exists, but tenant/provider/consent/release acceptance is needed before customers are contacted.
- **Planned:** the advertised capability does not exist end-to-end yet.

## Profile-to-product map

| Profile | First useful contractor outcome | Current evidence in the branch | What remains to fulfill the concept |
| --- | --- | --- | --- |
| ESTI | Scope and price a lead without losing the next action | Native estimates and linked leads; staff-reviewed next-best actions | Governed measurements, price books, proposal delivery, and approved follow-up |
| BILL | Keep contractor cash flow visible | No contractor A/R module. `/billing` is **GrowthOS subscription billing only** | Authoritative accounting/payment source, progress billing, reminders, recovery policy, and legally reviewed notice support |
| INVO | Produce accurate invoices and catch exceptions | No customer invoice generator or payment portal | Canonical invoice model, exception queue, accounting reconciliation, customer portal and A/R aging |
| SCHED | Keep appointments visible to the office | Appointment creation/update | Crew/capacity model, job dispatch/routing, conflict engine, safe reschedule and change alerts |
| APPT | Book a visit and prevent a missed handoff | Staff appointment records and reminder configuration | Verified calendar adapter, approved customer confirmation/reminder delivery, no-show recovery |
| CALLIE | Turn a missed call into an owned callback | Tenant-scoped Twilio intake and staff callback tasks in local code; Calls view | Per-client voice binding/live call acceptance, consented automatic SMS, voicemail or AI answering, provider analytics |
| MAINTAIN | Keep warranty/service obligations from being forgotten | Preview/commit service CSV import; obligations create staff tasks | Customer email/SMS reminders, actual booking, equipment checklists, recurring plan rules and completion evidence |
| SCOUT | Recover overlooked opportunities | Revenue Desk suggestions, import/segments/campaign preview and controls | Live consent/provider acceptance, proven results attribution, process recommendations evaluated on real pilot data |

BILL and INVO intentionally do not become two competing ledgers. **INVO owns invoice creation/validation; BILL owns receivables, payment follow-through and policy-governed escalation.** Both consume one canonical invoice/payment history when that foundation exists. Legal lien/notice work must remain human-supervised and jurisdiction-reviewed; do not auto-send or auto-file.

## Build order and release gates

1. Finish the existing paid-beta P0 gates, especially always-on scheduled execution, exact-SHA staging, restore proof, tenant isolation, and provider acceptance. The directory/brand change does not satisfy these gates.
2. Run one isolated roofing/Painless and one isolated HVAC pilot through the shared core. Prove real inbound call → missed classification → staff callback task → response/outcome; prove imported service date → staff task → appointment. Do not share numbers, tenants, customer data, consent, or credentials.
3. Add approved customer-facing automation one path at a time: appointment/warranty reminders and missed-call SMS only after sender registration, consent, STOP/HELP, quiet hours, delivery receipts, failure visibility, kill switch, and end-to-end acceptance. Full AI voice answering is a separate later capability.
4. Expand ESTI and SCOUT only with measured pilot evidence: approved proposals, follow-up, and win-back. Report booked work and recovered revenue from auditable records, not pipeline value alone.
5. Build finance and dispatch on trusted integrations and canonical models. Do not claim BILL, INVO, or SCHED's full poster promises before their money/scheduling sources, reconciliation, approvals, and failure handling are working.

## Definition of fulfilled for each task

Every specialty needs: canonical data ownership, tenant/role permission, validated inputs and deterministic state, human approval where necessary, idempotent connector operation, audit/event trace, failure and reconciliation path, operator documentation, automated tests, and at least one controlled provider-connected acceptance where an external system is involved. A polished card, local mock, or passing unit test alone does not earn “live” status.

## Current boundary

This branch incorporates the approved brand direction and a transparent capability map. The local roster links to working staff pages but does not turn on communications, change a provider account, deploy, send a message, charge a customer, or make legal representations. The mark is authorized as a similar GrowthOS platform candidate; applying it to tenant brands or legal identities is a separate decision.
