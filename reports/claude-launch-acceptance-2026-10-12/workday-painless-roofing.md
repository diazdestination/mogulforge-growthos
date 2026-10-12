# Full-workday acceptance script — Painless Roofing and Water Restoration

**Card status: NOT ACCEPTED** (`HOUSECALL-PRO-REPLACEMENT-GATE.md:102-123`).

Workflow sources:

- **Confirmed decisions.** `HOUSECALL-PRO-REPLACEMENT-GATE.md:106-111`.
- **Owner routing record.** `...\release-package\owner-contact-and-routing-2026-10-05.md`, cited as `PR-route:N`.

The routing record contains real names, phone numbers and email addresses. Never copy them into this packet, a screenshot caption or a chat log.

Roles used in this script:

| Role | Responsibility |
| --- | --- |
| **Owner A** | Co-owner. Daytime responder. |
| **Owner B** | Co-owner. Daytime responder. |
| **After-hours owner** | The designated owner named in the private intake. Do not re-ask the company or substitute another person (`HOUSECALL-PRO-REPLACEMENT-GATE.md:109`). |
| **Office** | Office staff. Not confirmed as a GrowthOS user. Include only if an account is approved (O-24). |
| **Field/crew** | Field staff. Not confirmed as GrowthOS users. Include only if accounts are approved (O-24). |
| **Test customer** | A labeled, consented test person. |

Confirmed facts:

- Normal hours are Monday–Saturday, 09:00–18:00, America/New_York.
- The company offers 24-hour service.
- 24-hour service is not guaranteed emergency dispatch.
- 24-hour service does not authorize contacting customers overnight (`HOUSECALL-PRO-REPLACEMENT-GATE.md:108-110`).

Before starting, these inputs must be in place: O-12, O-21, O-22, O-23, O-24 and O-25. Record any step whose input is missing as **Blocked-on-owner**.

Add a Status column to each table using the legend in [README.md](README.md).

## Card line 1 — Migration reconciles the required records (`HOUSECALL-PRO-REPLACEMENT-GATE.md:117`)

Required records: customers and properties, repeat jobs, photos and documents, open estimates, jobs and appointments, service promises, and opening balances.

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| R1.1 | Adam + Owner A | Off-system export inventory | Every export listed in O-12 is received and its counts are recorded. | Private export manifest | — |
| R1.2 | Operator | Win-back CSV, Service Desk CSV, Financial migrations | Contacts and properties load with provenance. Opening balances reconcile to the cent. Existing customers do not become acquisition leads. | Import and exception reports | **G-05**: no loader for open jobs, appointments, media or documents |
| R1.3 | Owner A | Customer workspace | Spot-check 10 repeat customers who have several properties. There are no duplicate people. | Redacted screenshots | **G-05** |

## Card line 2 — Website and missed-call inquiries reach the right staff (`HOUSECALL-PRO-REPLACEMENT-GATE.md:118`, `PR-route:20-25`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| R2.1 | Operator | Smart Sites / Launch Guard | The correct tenant and fixed site pass a fresh handshake. Owners A and B show as accepted responders. | Launch Guard screenshot | — |
| R2.2 | Test customer | Painless website form, during business hours | Exactly one lead, one consent receipt and one follow-up task are created. | Lead ID | — |
| R2.3 | Owners A and B | iPhone lock screens | Both owners are alerted (P-02 to P-04). The coverage screen lists both. | Coverage and lock-screen photos | — |
| R2.4 | Owner A, then Owner B | Notification, then lead page | Owner A taps the alert, opens the exact lead and claims it. Owner B sees it as claimed and cannot take it over. The claim and the first attempt are audited (P-06, P-07). | Ownership panel and audit ID | — |
| R2.5 | Owner A | Lead, then **Reply from your phone** | The three drafts open in Messages, or the Copy fallback is used. Owner A reviews and sends one approved test reply (S-09). | Handset screenshot | **G-18**: replies and STOP on the handset are logged by hand |
| R2.6 | Test customer | Form, after 18:00 or on Sunday | Only the after-hours owner is alerted (A-01, A-02). | Coverage | — |
| R2.7 | Test customer | Resubmits the same form | No duplicate lead and no second alert (P-10). | Lead count | — |
| R2.8 | Test customer, then Calls | Main line, unanswered | The CALLIE missed-call path runs (V-02 to V-08). One office task is created with an owner. No SMS is sent unless the keypad conditions are met. | Task ID | — |
| R2.9 | Test customer | Clicks the website phone or `mailto:` link | Clicking does **not** create a lead (`PR-route:22`). Record which manual logging path the owners chose. | Logged record | **G-20** |
| R2.10 | Owners | — | A response target and an overdue escalation are defined and exercised (`PR-route:23`). | Overdue escalation visible | Decision O-21 |

## Card line 3 — Office and field complete the job without coaching (`HOUSECALL-PRO-REPLACEMENT-GATE.md:119`)

Steps: find today's work, quote, schedule a roofing job, handle a conflict or reschedule, finish the work, and prepare the correct invoice.

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| R3.1 | Owner A | Today | Today's work shows the correct company, date and timezone, with overdue items openable. | Screenshot and time taken | — |
| R3.2 | Owner A | Appointments → new inspection → select the property explicitly | The inspection is booked with an accepted staff member. A conflicting booking is refused with an explanation. | Appointment ID | — |
| R3.3 | Field | Appointment → **Open visit work** | Roof areas are recorded as assets. The approved roofing checklist is used. Photos (JPEG, PNG or WebP) are attached to checklist items. | Entry and photo status | — |
| R3.4 | Owner A | Customer → estimate (customer work), or the pipeline estimate | A line-item estimate is created with exact totals. | Estimate ID | — |
| R3.5 | Owner A | — | The estimate is delivered to the test customer. | — | **G-06** |
| R3.6 | Test customer | — | The customer approves the quote. Native e-signature is absent; record how approval is captured. Whether Painless needs e-signature is O-23. | Approval record | **G-02** if e-signature is required |
| R3.7 | Owner A | Projects | A multi-day roofing job is scheduled with crew windows. A crew conflict is refused. A reschedule keeps local times and does not duplicate the job. | Project ID | — |
| R3.8 | Owner A | Projects, Appointments | A cancellation or no-show is handled. Obsolete reminders are invalidated. | History | — |
| R3.9 | Field | Open visit work → Complete saved visit work | One reviewed completion is recorded. The invoice-preparation task appears once. | Completion record and task | — |
| R3.10 | Owner A | Invoices → draft → issue | The customer, scope and tax are reviewed. The invoice number stays stable. "Issued" is shown as distinct from "sent". | Invoice ID | — |

## Card line 4 — Customer receives the invoice; external receipts reconcile (`HOUSECALL-PRO-REPLACEMENT-GATE.md:120`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| R4.1 | Owner A | Invoices → delivery | The invoice is emailed from the selected supported mailbox and arrives (I-01 to I-04). | Inbox screenshot | **G-19**: the shared Yahoo inbox cannot be the sender |
| R4.2 | Owner A | Invoices → payments, refunds, allocations | A partial external receipt, a refund and a correction produce the correct balance. Staff-recorded evidence is labeled as distinct from settlement (I-05). | Balance screenshots | — |
| R4.3 | — | — | In-app collection. Painless's need for it is not confirmed after the October 9 scope change (O-23). Take no payment. | — | **G-01** if required |

## Card line 5 — Warranty and service paths (`HOUSECALL-PRO-REPLACEMENT-GATE.md:121`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| R5.1 | Owner A | Service Desk | Each **actual** Painless warranty or service promise from O-23 is recorded with its evidence. Nothing is invented. | Service record | Blocked until O-23 |
| R5.2 | System, then Test customer | Standing or individual reminder | The approved reminder is sent and the reply is linked or held. The office then books a visit, the visit is completed and the next date is set (as in CSS C2.2–C2.6). | Records | — |
| R5.3 | Owner A | — | Warranty dates are shown on the invoice, if Painless requires this. | — | **G-03** if required |

## Card line 6 — Email and phones (`HOUSECALL-PRO-REPLACEMENT-GATE.md:122`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| R6.1 | Owners A and B | My Profile → My Connections | The selected mailbox passes receipt, reply and revocation tests: E-01 to E-05, or E-07 to E-09. The Microsoft mailbox was **assumed** for Painless and is not verified (`HOUSECALL-PRO-REPLACEMENT-GATE.md:113`). | Case results | **G-17** |
| R6.2 | Owners A and B | iPhones | Notification, deep link, logout and manual SMS checks (P-01 to P-09, S-09) each pass on both phones. | Case results | — |
| R6.3 | Operator | Failure states | Each injected failure (for example, a disconnected sender) shows a visible owner and a next action. | Screenshot | — |

## Card line 7 — Cutover and sign-off (`HOUSECALL-PRO-REPLACEMENT-GATE.md:123`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| R7.1 | Adam + owners | — | The source of truth, cutover and delta, one writer per domain, and the rollback/export path are rehearsed (O-14). | Signed record | — |
| R7.2 | Owners, office and field representatives, Adam | — | Each required workflow is accepted in writing, or each manual substitute is accepted explicitly. Cancelling Housecall Pro is a separate owner action. | Signed record | — |
