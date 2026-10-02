# Contractor customer-care engineering contract

Owner continuation on October 2, 2026: payment collection inside GrowthOS is a
future add-on; continue toward a usable replacement for both contractors.
Base: `ae6b6e4f5a1d4203f40a8b494a6990518cf8b188`, with runtime source `47aca5b`.
Branch: `agent/growthos-customer-care-20261002`. This is local implementation,
review and synthetic acceptance, not a hosted release or customer activation.

## Bounded outcomes

1. Service due: a reviewed, expected reminder with current permission and
   delivery controls; visible reply/no-response handling; office-confirmed
   scheduling using existing conflict checks; completion retains recurrence.
2. Invoices: preview the immutable issued document, approve the exact recipient
   and contents, dispatch through the selected existing sender, and distinguish
   accepted, delivered, failed and uncertain evidence. No payment link, processor,
   bank action, automatic collection or unsupported settlement claim.
3. Missed calls: controlled customer-care response for eligible reviewed callers,
   visible accountable staff/lead handoff, and clear held/uncertain states.
   Caller ID alone never grants SMS consent. Default-off behavior remains.

## Ownership

- Service worker: service-care modules, service obligations/routes and service
  desk UI/tests, `customer-care-service-2026-10-02.md` report.
- Invoice worker: invoice-delivery modules, invoice routes/contracts and invoice
  UI/tests, `customer-care-invoices-2026-10-02.md` report.
- Calls worker: missed-call care/handoff, bounded voice-route additions, Calls
  UI/tests, `customer-care-calls-2026-10-02.md` report.
- Coordinator: shared router/schema/OpenAPI/transport integration, product scope,
  cross-review, regression/release checks, Git operations and durable checkpoint.

Only the coordinator commits or pushes. Workers use disjoint files and report
shared needs first. The existing untracked `pnpm-workspace.yaml.bak` is unrelated.

## Non-negotiable controls

Tenant IDs and canonical records come from authenticated server context; no
cross-company links or arbitrary recipients. Recheck active member permissions,
exact approved version/payload, current lifecycle/global holds, consent and
suppression immediately before effects. Imported history is not current source
authorization. No warranty promise or confirmed visit is inferred from a reminder.

Durable ownership must cover one logical send, not only a caller-generated key.
Retries, different keys and racing clicks cannot escape an uncertain or accepted
effect. A held action is not a sent action; provider acceptance is not delivery.
No silent alternate mailbox, automatic replay of a timeout, or fabricated receipt.
Use the existing shared controls rather than introducing parallel CRM records.

## Verification and release boundary

Focused API tests use `artifacts/api-server/scripts/test-scheduler-isolated.mjs`
with selected test files. Each invocation creates a fresh in-memory PGlite database
on an ephemeral loopback port and strips provider/hosted credentials. It does not
prove independent PostgreSQL session/advisory-lock behavior; full CI must do that.
UI tests, typechecks, builds, regressions and adversarial cross-review are required.

The earlier approved recovery exercise is complete and its temporary cluster is
deleted. Never replay its retired operators. Existing staging remains held and
production stopped; upgrading/rotating staging still requires the separate
requested authorization. No new resource, spending, live message or processor
activation is included. Azure first sign-in remains a return-to-desk item.

Both contractor acceptance cards remain unaccepted until actual required
workflows and the separate release/provider/device/staff checks pass. A completed
local engineering slice must not be called a complete Housecall Pro replacement.
