# New manual appointments: choosing a customer property

October 5, 2026. Bounded operator guide for the source change defined in
[the implementation contract](manual-appointment-property-contract-2026-10-05.md).
This guide is not a deployment, provider-delivery or contractor-acceptance receipt.
Use the integration/release report for the exact verified source and test results.

## When to use this

In **Appointments**, use **Schedule appointment** (the **Schedule** button on a
wide screen or the plus button on a phone) to create a new visit for an existing customer.
Choose the actual customer, then optionally choose a linked property for that
specific visit. A customer who only receives ongoing service does not need a new
sales lead. The related lead remains optional; do not create a fictitious lead to
make the form work or guess a property from an address, name or lead.

1. Confirm the company and customer, appointment type, start/end window and staff
   assignment. Times use the timezone displayed in the schedule.
2. The property choice starts at **No property linked**, even when the customer
   has only one property. Leave it unlinked if the worksite has not been confirmed.
3. Choose a property only after its customer-property page loads successfully.
   **Load more customer properties** retrieves another page; the initial list
   must not be treated as all properties when more results are available.
4. If selecting a related lead, ensure it belongs to the same customer and does
   not contradict the intended worksite. Changing the customer or lead clears the
   property choice; review and select it again. Nothing is selected automatically.
5. Review the notes and exact window, then choose **Save Appt**. Existing
   staff/resource conflicts, inspection capacity and past-start checks still apply.

## Refresh, changed access and failures

- **Refresh properties and clear selection** deliberately clears the worksite.
  Review the refreshed choices and explicitly select again if appropriate.
- An unavailable or invalid property response is an error, not proof that the
  customer has no properties. Use the retry control; never substitute another
  customer's property or assume a previous selection remains valid.
- Changing company, member identity, role or active access invalidates the form.
  Reopen it under verified current access. An unchanged background access check
  does not itself discard a valid draft.
- The server rechecks the actual customer, optional lead and selected property
  when saving. If one has moved, disappeared or no longer matches, creation is
  refused. Refresh the customer context and review it before another save; do not
  change identities merely to bypass the refusal.
- If the save response is lost or ambiguous, inspect the current appointment
  list before trying again; set **Start date**, **Show** and **Team member** so
  the intended visit is within the displayed range. This slice adds no new
  lost-acknowledgment replay key.

## Existing history and communications

The new property picker is for **new manual appointments only**. The existing
appointment editor is not a property-relinking or historical-backfill tool. Its
original record, notes and optimistic version remain the source of truth; a
redacted customer-workspace card must not be used to reconstruct the edit.
Creating a new visit does not rewrite earlier appointments or service history.

This uses the existing native appointment and reminder path. Saving a visit does
not activate Twilio, email or push, grant consent, prove delivery, complete service
or establish warranty coverage. Provider holds and separately approved recipient,
sender and channel requirements remain in force. It does not change the separate
Service Desk or CALLIE customer-confirmation workflows into autonomous booking.

## Acceptance boundary

This source slice requires focused UI/runtime tests, independent PostgreSQL16
writer-barrier checks, a synthetic built-UI walkthrough, and fresh candidate and
exact-main CI. PGlite cannot prove the independent row-lock races. Do not infer
that those checks passed merely because this guide exists; record actual results
in the integration/release evidence.

Hosted release and schema/backup acceptance, live approved email/SMS tests, actual
phone notifications and each contractor's workday acceptance remain separate.
There is no new schema, equipment checklist, manufacturer/warranty interpretation,
data-migration mapping, payment processing or Housecall Pro cancellation in this
change. No real customer data or provider traffic is needed for its synthetic QA.
