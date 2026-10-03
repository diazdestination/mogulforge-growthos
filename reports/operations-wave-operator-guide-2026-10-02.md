# Operations wave — operator walkthrough

October 2, 2026. This guide describes the current candidate screens and their
controls. It is not a release approval, evidence of live sending, or acceptance
of either contractor's Housecall Pro replacement. Use fictional records in the
approved isolated rehearsal until the release and company gates below pass.

| Open | Use it for | Who acts |
| --- | --- | --- |
| Service Desk, `/service` → **MAINTAIN · Service watch** | Assign and track office follow-up on actual service exceptions | Accepted active staff; changes require customer-work permission |
| Reactivation, `/reactivation` → **Reviewed source cutover & recovery email** | Adopt reviewed imported opportunities, record separate permission, and review a small email batch | Accepted active owner/admin; the email workflow also requires the company's recovery capability |
| Invoices → **Import invoice history**, or `/financial-migrations` | Review and import normalized historical invoices and balances | Accepted active, verified owner/admin; saved reviews belong to their reviewer |

Stay in the correct company's account. An administrator's approval is not
permission to use another company's customers, sender, documents or devices.

## 1. Service watch: give the office a clear next action

1. Open the watch queue. Review **Needs attention / office plan / held**; use
   **Resolved history** for earlier cases and the page controls for more rows.
   A message that services await their first monitor check means an empty queue
   is not an all-clear. A loading error is not an empty schedule.
2. Select **Review service watch**. Check the customer, equipment, actual due
   date and reasons. Reasons include a reminder needing review, no response
   *recorded* three days after provider acceptance, an overdue service, a
   cancelled/no-show visit, a missed office deadline, or a blocked/unknown send.
   The monitor does not read warranty contracts or invent customer responses.
3. Choose **Responsible staff** and write a useful office action. **Assign
   responsible staff only** changes ownership. To commit a plan, enter a future
   follow-up deadline within 30 days, check the review box and select
   **Acknowledge and save office plan**. This does not postpone the service due
   date, contact the customer or book an appointment. The case can reopen when
   its deadline is missed or its underlying facts change.
4. For customer contact, select **Open customer care & booking**. Review the
   exact recipient, selected email sender/channel, message and current service
   agreement; **Approve one reminder** queues one reviewed reminder for this
   occurrence. It is not a booking. SMS needs the separately approved
   customer-care consent and sender; this review does not grant either SMS or
   marketing permission. Holds and sending windows are checked again later.
5. After an actual conversation, use **Record customer response** with its
   time, channel, outcome and evidence. This is staff-recorded evidence, not an
   automatically verified inbox reply. A fresh **Ready to arrange the visit**
   response allows the separate **Book confirmed visit** step: review the
   exact start/end, accepted staff assignment and customer confirmation.
   Conflicts/capacity are checked. Completion remains a later explicit service
   action; a reminder, booking or completion entry does not prove warranty
   coverage. Cancelled/missed visits require fresh confirmation before rebooking.
6. On a stale or unconfirmed save, **Refresh and review watch** (or **Refresh
   and review** in customer care). Inspect the retained result before another
   action. An unknown send requires operator reconciliation, not another
   request, channel or reminder.

Dates/times must be reviewed in the timezone shown. The watch uses the company's
configured service timezone for calendar dates and warns when it falls back to
UTC; entry controls display the browser's scheduling timezone.

Phone alerts are optional, not a substitute for reviewing the queue. Separately
enable **Notify assigned service owners about follow-up exceptions** in alert
settings, and have that actual owner opt in on a supported signed-in device in
**My Profile → GrowthOS on your phone**. Service alerts can occur outside the
new-lead routing hours. Unassigned work is never broadcast. Payloads are generic;
opening the alert reauthenticates into the permitted service. Provider acceptance
does not prove device receipt or staff action; global/company holds still apply.

## 2. Imported opportunities: adoption is not consent

Before this screen, an operator must reconcile an approved source export with
stable opportunity IDs and preserve the original source/date/status/reply history.
Do not describe the upload date as a new inquiry or use guessed vendor mappings.

1. Choose an **Imported opportunity**. Use **More opportunities** for later
   pages; selection is not restricted to the first 100. Check the current
   customer/address, original date, source snapshot and management status.
2. Under **Review source management**, supply the source verification time,
   completed cutover time, expiry and reconciliation evidence. Verify current
   status and outstanding replies, and actually stop the old workflow from
   sending for this opportunity before attesting. The current contract requires
   a source review within the last 30 days and an approval expiry within the
   next 30 days. **Preview adoption decision**, review it, then **Approve source
   management**. Exact previews expire after ten minutes; refresh a stale one.
   Approval adopts management only. It neither sends nor enables generic
   playbooks, SMS or a new-lead notification.
3. Under **Record independent email permission**, record when and how this
   customer explicitly permitted promotional email from this business to this
   exact current address. Confirm it, then choose **Record explicit permission**
   or **Record permission withdrawn**, as the evidence warrants. An import,
   prior purchase, service agreement or adoption approval is not this permission.
   The UI labels the evidence as staff-recorded, not independently verified.
4. If the source is no longer approved, give a reason and **Revoke source
   approval**. Changed sources/recipients, unresolved replies, opt-outs, expiry
   and other holds require review; do not create another import to evade them.

## 3. Reviewed email batch: preview, approve, then explicitly send

This is one bounded email touch, not an ongoing automated sequence.

1. Select up to **10** currently adopted, independently permitted opportunities
   across the opportunity pages. Only one opportunity per email address can be
   included. Enter the company's actual mailing address and exact subject/body.
   Choose days, the displayed timezone, hours within the supported 08:00–20:00
   envelope, a company rolling 24-hour cap of 1–25 (at least the batch size), and
   an expiry within 24 hours and no later than source approval expiry. Stricter
   company sending rules still apply.
2. Select **Preview complete emails**. Inspect every exact recipient, selected
   existing Gmail/Microsoft sender, subject, body, business identification,
   mailing address and generated unsubscribe link. There is no silent sender
   fallback or AI rewriting after approval. Missing sender readiness, permission,
   eligible scope, HTTPS unsubscribe configuration or current eligibility blocks
   this workflow; the guide does not authorize removing those holds.
3. Check the exact-review box, then **Approve exact emails — does not send**.
   Next, and only when separately authorized for those recipients, confirm and
   select **Send approved emails**. This explicit send handles remaining
   eligible items; it is not a future recurring campaign. Outside the reviewed
   window nothing sends. Review saved status before deciding whether an
   unclaimed remainder may be sent within the original approval.
4. Read each result. **Provider accepted — delivery unconfirmed** is not a
   reply, booking, delivered email or revenue. On an unconfirmed result select
   **Check saved status**. Use **Saved campaign** / **Older campaigns and
   evidence** to recover earlier receipts. **Revoke remaining campaign sends**
   stops unsent work; it cannot recall a message already handed off.

The first claimed touch permanently owns both the opportunity and its email
address within this company's initial source-outreach workflow. Accepted,
unknown, and held-after-reservation outcomes do **not** free that slot. Even a
crash before a provider receipt can leave an uncertain reservation. Reconcile
the original evidence; do not clone a batch, change an ID, reimport, or delete a
receipt to resend. Resolving uncertainty does not itself authorize another touch.

## 4. Historical invoices: normalize, reconcile, then commit

The **Bring over invoice history** screen accepts normalized JSON version 1,
not a Housecall Pro CSV/PDF adapter. It needs existing same-company customer/
opportunity mappings. An operator prepares the normalized file only after
inspecting an approved actual export and original documents.

1. Agree the cutoff and one authoritative writer; preserve the original export,
   documents and reconciliation evidence in approved storage. The importer
   retains normalized review data and a raw-file hash, not the original file.
2. Load **Normalized JSON file** or paste **Normalized source JSON**, then
   **Preview and reconcile**. Limits: 50 invoices, 200 receipts, 100 lines per
   invoice and 512,000 bytes. Fix every displayed exception. Unsupported credits,
   write-offs, negative lines, rounding/tax differences, overpayments, unapplied
   cash or cross-opportunity receipt relationships are not silently skipped or
   replaced with invented lines.
3. Review every mapped customer, original number/issue date/document, receipt
   evidence/allocation, duplicate count, totals, cutoff, digest and expiry.
   **Full evidenced history** needs actual dated payment/refund evidence and
   exact reconciliation. **Opening receivable — prior cash unknown** needs the
   complete original document and its outstanding amount at cutoff, with no
   historical receipt allocations to that invoice. Never infer cash by
   subtracting the opening balance from the original total.
4. Check both confirmations: exact financial review, and source frozen at the
   cutoff with one agreed writer/company approval. Within the 30-minute review
   window select **Approve and import exact review**. All rows commit together
   or roll back. Original identities/numbers/dates are preserved. Identical
   records deduplicate across files/reviews; changed historical identity/content
   or numbering conflicts require reconciliation, not renaming to force success.
5. Use **Check saved review** and **Your recent reviews** if acknowledgment is
   lost. Do not start another import under a different identity. After a confirmed
   commit, open the resulting invoices and reconcile balances again. Post-commit
   corrections preserve history; there is no delete-import, automatic cash
   refund, bank verification or payment collection. Later deltas need a separate
   reconciled decision. Opening-basis allocations accept only evidenced
   post-cutoff receipts, not fabricated historical payments.

### Complete fictional opening-receivable example

Training only: every name, identity and amount below is fictional. Replace
`11111111-1111-4111-8111-111111111111` with an existing **same-company mapped lead
UUID** in an approved synthetic rehearsal. As-is it is a schema-valid placeholder,
not a provisioned customer; preview will reject an unavailable mapping. Do not
use the example for a real client or treat its zero tax as tax advice. Actual
imports must preserve the actual source's document, identity and amounts.

```json
{
  "format": "growthos-financial-migration",
  "version": 1,
  "sourceSystem": "fictional_legacy",
  "sourceAccount": "training_company",
  "cutoffAt": "2026-09-30T23:59:59Z",
  "invoices": [
    {
      "externalId": "demo-invoice-0042",
      "invoiceNumber": "DEMO-2026-0042",
      "leadId": "11111111-1111-4111-8111-111111111111",
      "issuedAt": "2026-08-20T12:00:00Z",
      "basis": "opening_receivable",
      "balanceAtCutoffCents": 45000,
      "document": {
        "title": "Fictional equipment service",
        "currency": "USD",
        "issuerName": "Fictional Training Contractor",
        "issuerAddress": null,
        "customerName": "Fictional Training Customer",
        "customerAddress": null,
        "dueDate": "2026-09-19",
        "notes": "Fictional training example of an original source document.",
        "lineItems": [
          {
            "description": "Fictional service labor",
            "quantity": "1",
            "unitPriceCents": 95000,
            "totalCents": 95000
          },
          {
            "description": "Fictional replacement part",
            "quantity": "1",
            "unitPriceCents": 30000,
            "totalCents": 30000
          }
        ],
        "subtotalCents": 125000,
        "taxCents": 0,
        "totalCents": 125000
      }
    }
  ],
  "receipts": [],
  "controlTotals": {
    "invoiceCount": 1,
    "documentTotalCents": 125000,
    "openingReceivableCents": 45000,
    "balanceDueCents": 45000,
    "paymentCents": 0,
    "refundCents": 0
  }
}
```

This represents a $1,250 original document with a $450 opening receivable and
**zero imported payment/refund entries**. The $800 difference is unexplained
historical activity, not an $800 payment or GrowthOS-generated revenue.
The example passed the current `normalizeFinancialSource` contract locally on
October 2, 2026, without database access or provider calls. That validates its
format/arithmetic only, not a customer mapping or an actual import.

## Before either real contractor uses these workflows

- Obtain approved actual exports/documents/agreements, mapping and exception
  decisions, source control totals, original numbering, cutoff/freeze/one-writer
  plan and later-delta reconciliation. The owner/accountant must accept the actual
  balances and evidence. Synthetic examples prove none of that.
- Complete exact-candidate CI, reviewed schema/backup/restore and held-staging
  application acceptance. An earlier image's recovery proof does not attest
  this wave. Obtain applicable deployment/schema/credential authority separately.
- Confirm the correct approved Gmail or Microsoft identity, scopes, selected
  sender and test recipients; prove send, refresh, revoke, visible failures,
  receipt/reply handling and unsubscribe/suppression with authorized tests.
  Azure first sign-in remains an owner-return task, not an assumed connection.
  SMS additionally needs the client's approved Twilio sender/use case, consent
  and callback/STOP tests. This email batch does not enable SMS marketing.
- Test the actual staff phones, installation/opt-in, correct-company notification
  links, holds and missed/expired-device behavior. Then rehearse the real office
  service, customer response/booking, invoice/balance and source-recovery work
  with the approved staff and website routing.
- Record separate Painless and HVAC replacement acceptance. Payment collection
  remains deferred; staff-recorded external receipts are not settlement proof.
  Keep the old systems until the complete company cutover is accepted. Cancelling
  their subscriptions is a separate owner action.

Implementation references: [service-watch lane](operations-wave-service-watch-2026-10-02.md),
[financial lane](operations-wave-financial-2026-10-02.md),
[wave contract](operations-wave-contract-2026-10-02.md),
[customer-care integration](customer-care-integration-2026-10-02.md), and
[company replacement gate](../HOUSECALL-PRO-REPLACEMENT-GATE.md).
