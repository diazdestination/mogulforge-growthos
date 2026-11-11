# Specialist acceptance map

What each of the eight specialists is said to do on mogulforge.ai (read 2026-11-11), and the test that proves it
through the real HTTP API. All tests are in
`artifacts/api-server/src/acceptance/specialist-roster.acceptance.test.ts`. They use synthetic companies, real
sessions, and provider doubles only: a Zapier MCP client double, a Stripe Connect double, a stubbed mail
transport and signed synthetic Twilio webhooks. No test reaches a real provider.

Run:

```
cd artifacts/api-server && source <envfile> && LOG_LEVEL=silent pnpm exec vitest run src/acceptance --maxWorkers=2
```

## Claim to proving test

| Specialist | Claim | Test (`describe` > `it`) |
| --- | --- | --- |
| ESTI | Estimate from job scope and the price book; flags lines below target margin | ESTI > builds an estimate from job scope and the price book, flags lines below target margin, ... |
| ESTI | Tracks estimates awaiting the customer's answer | ESTI > tracks estimates awaiting a customer answer separately from drafts and decisions |
| ESTI | Team reviews and sends | ESTI > only sends a proposal after an office member reviews the exact preview and confirms it |
| BILL | Amounts owed and recorded payments per invoice; staff-recorded check/cash/external card; no money moves | BILL > tracks what is owed and staff-recorded check/cash/card receipts by invoice without moving money |
| BILL | Stripe sandbox Checkout link records a confirmed test payment | BILL > records a confirmed Stripe sandbox Checkout payment on the invoice |
| INVO | Drafts and issues documents; delivery history keeps failed attempts visible | INVO > drafts and issues invoice documents and keeps a delivery history where a failed attempt stays visible |
| INVO | QuickBooks export through Zapier needs approval | INVO > sends an issued invoice to QuickBooks through Zapier only after a reviewed approval |
| SCHED | Visits, working windows, crew assignments | SCHED > shows the day's visits with working windows and crew assignments |
| SCHED | Daily routes; suggests a shorter order for review | SCHED > maps a crew member's daily route and suggests a shorter order for review without moving any booked time |
| SCHED | Requests a crew member's day sheet through Zapier with approval | SCHED > requests a named crew member's day sheet through the business-number connection only with approval |
| APPT | Links customer, property, visit details and confirmation | APPT > links the customer, property, visit details and confirmation |
| APPT | Texts need consent and a verified connection | APPT > refuses an appointment text without consent and parks a consented one for approval; APPT > requires a verified business-number connection before any appointment text is requested |
| APPT | Can request a calendar event | APPT > requests a calendar event for a booked appointment with approval |
| CALLIE | Missed calls become callback tasks with caller details; team reviews the next step | CALLIE > turns missed calls into callback tasks with caller details and parks the text-back for review |
| CALLIE | Text-back requires a verified business-number connection | CALLIE > does not text a missed caller back without a verified business-number connection |
| MAINTAIN | Installed equipment, warranty terms, service due dates | MAINTAIN > tracks installed equipment, warranty terms and service due dates |
| MAINTAIN | Service-due texts need a supported business-number connection | MAINTAIN > texts a service-due reminder only through a supported business number, with approval, and only once |
| MAINTAIN | Replies and opt-outs are recorded | MAINTAIN > records a customer's STOP and reply on the business number and refuses later service texts; MAINTAIN > refuses a service text after staff record an opt-out on the customer |
| SCOUT | Ranks opportunities on Today; follows up undecided estimates and quiet leads; records completed actions | SCOUT > ranks revenue opportunities on Today, ...; SCOUT > follows up on an estimate that is awaiting the customer's answer even before the pipeline stage is updated |
| SCOUT | Marketplace connections bring in leads; review connections create tasks; no review replies posted | SCOUT > brings in marketplace leads and turns new reviews into tasks without posting replies |
| All | No customer-facing send without approval | Cross-cutting > never sends to a customer from a binding alone, an off policy, or the staging hold, ... |
| All | Another company cannot see or act | An "other company" check inside every test above, plus Cross-cutting > keeps estimates, price books and invoices private to their company |

## Product fixes made while proving these claims

- SCOUT only followed up an estimate when someone moved the lead to the `estimate_sent` stage. A lead with an
  estimate marked sent, still at an earlier stage, got a generic follow-up instead. `services/next-best-action.ts`
  now treats a sent estimate on a pre-decision lead as awaiting the customer's answer.
- Rejecting another company's Zapier execution returned 409 "not pending". Approve already returned 404.
  `rejectZapierAction` now returns not found for an id outside the caller's company.

## Not proven here, or needs live setup

- **Zapier.** Every Zapier flow is proven against a client double that answers the agentic MCP tools. Before a
  live test, connect a real Zapier MCP server, bind each capability to the contractor's app, and run one read and
  one approved write per capability.
- **Quo/OpenPhone or Twilio sender registration.** Business-number texts need a registered sender (A2P 10DLC or
  toll-free verification). Built-in GrowthOS texting needs a Twilio client binding with a real auth token.
- **Replies to own-number texts.** Replies and STOPs to a text sent from the contractor's own number through Zapier
  go to the contractor's phone app, not GrowthOS. GrowthOS records them on its own only for built-in Twilio
  texting (proven with a signed synthetic webhook). For own-number texts, staff must record the opt-out on the
  customer (proven: later texts are refused).
- **Gmail OAuth.** Estimate and invoice email go through a stubbed mail transport here. A live test needs a
  Google OAuth client and a connected staff mailbox.
- **Stripe sandbox keys.** Checkout is proven with a Stripe double. A live sandbox test needs Connect test keys,
  a test connected account and the Connect webhook secret. Live-mode sessions are refused by design.
- **Route map.** Route ordering uses saved property coordinates. Geocoding of new addresses is not exercised.
- **CALLIE keypad/voice intake and human handoff.** These are marked as setup-only pilots on the roster and are
  not covered here.

## Owner decisions surfaced

- An owner can switch any Zapier write capability, customer texts included, to automatic. After that, texts go
  out without per-message approval. Consent, opt-out and do-not-contact checks still apply at dispatch. Every
  capability starts switched off after binding.
- A CALLIE text-back to a missed caller does not check SMS consent (the caller phoned first). It still needs the
  business-number connection and staff approval. Decide whether that matches your compliance stance.
- A staff-recorded receipt keeps its method (check, cash, external card) only in the free-text reference.
  There is no structured method field.
